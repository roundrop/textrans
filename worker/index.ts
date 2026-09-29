import { Directory } from './directory';
import { Room } from './room';
import { isRecord, isId, type PairMode } from '../shared/protocol';
export { Directory, Room };
export interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>;
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
export const randomToken = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new Error('bad-request');
  if (Number(request.headers.get('Content-Length') || 0) > 1024) throw new Error('bad-request');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('bad-request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 1024) {
      await reader.cancel();
      throw new Error('bad-request');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error('bad-request');
  return value;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // APIs and upgrade requests are same-origin only. No bearer credentials in URLs.
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
    const directory = env.DIRECTORY.getByName('directory-v1');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    try {
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        await body(request);
        const roomId = crypto.randomUUID();
        const invite = await directory.allocate(roomId, ip);
        const token = randomToken();
        const room = env.ROOMS.getByName(roomId);
        const state = await room.initialize(await digest(token), invite.expiresAt);
        return json({
          roomId,
          token,
          role: 'host',
          code: invite.code,
          inviteExpiresAt: invite.expiresAt,
          expiresAt: state.expiresAt,
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/join') {
        const input = await body(request);
        if (
          typeof input.code !== 'string' ||
          !/^\d{6}$/.test(input.code) ||
          !['qr', 'code'].includes(String(input.mode))
        )
          return json({ error: 'bad-request' }, 400);
        const roomId = await directory.resolve(input.code, ip);
        if (!roomId) return json({ error: 'invite-unavailable' }, 404);
        const token = randomToken();
        const state = await env.ROOMS.getByName(roomId).join(
          await digest(token),
          input.mode as PairMode,
        );
        if (!state) return json({ error: 'invite-unavailable' }, 404);
        await directory.consume(input.code, roomId);
        return json({
          roomId,
          token,
          role: 'guest',
          code: input.code,
          mode: input.mode,
          inviteExpiresAt: state.inviteExpiresAt,
          expiresAt: state.expiresAt,
        });
      }
      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/socket$/);
      if (match && request.method === 'GET' && isId(match[1])) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
          return json({ error: 'upgrade-required' }, 426);
        await directory.connectionAttempt(ip);
        return env.ROOMS.getByName(match[1]).fetch(request);
      }
      return json({ error: 'not-found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('rate-limit')) return json({ error: 'rate-limit' }, 429);
      if (message.includes('capacity')) return json({ error: 'capacity' }, 503);
      if (message.includes('bad-request') || error instanceof SyntaxError)
        return json({ error: 'bad-request' }, 400);
      // Never log bodies, tokens, file metadata, or pairing codes.
      return json({ error: 'unavailable' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
