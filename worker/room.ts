import { DurableObject } from 'cloudflare:workers';
import {
  IDLE_TTL,
  SESSION_TTL,
  MAX_FRAME_BYTES,
  isRecord,
  isToken,
  type PairMode,
  type Role,
  type ServerMessage,
} from '../shared/protocol';
import { digest, json, type Env } from './index';
interface Usage {
  total: number;
  minute: number;
  bytes: number;
  messages: number;
}
interface Attachment extends Usage {
  role: Role;
  lastActivity: number;
  replaced?: boolean;
}
interface State {
  host: string;
  guest?: string;
  mode?: PairMode;
  inviteExpiresAt: number;
  expiresAt: number;
  lastActivity: number;
  usage: Partial<Record<Role, Usage>>;
}
export class Room extends DurableObject<Env> {
  private state: State | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<State>('state');
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async initialize(host: string, inviteExpiresAt: number) {
    if (this.state) throw new Error('already-initialized');
    this.state = {
      host,
      inviteExpiresAt,
      expiresAt: Date.now() + SESSION_TTL,
      lastActivity: Date.now(),
      usage: {},
    };
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(inviteExpiresAt);
    return this.state;
  }
  private expired() {
    const s = this.state;
    const last = Math.max(
      s?.lastActivity || 0,
      ...this.ctx
        .getWebSockets()
        .map((ws) => (ws.deserializeAttachment() as Attachment).lastActivity),
    );
    return (
      !s ||
      Date.now() >= s.expiresAt ||
      (!s.guest && Date.now() >= s.inviteExpiresAt) ||
      Date.now() - last >= IDLE_TTL
    );
  }
  async join(guest: string, mode: PairMode) {
    if (this.expired() || !this.state || this.state.guest) return null;
    this.state.guest = guest;
    this.state.mode = mode;
    this.state.lastActivity = Date.now();
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(Math.min(this.state.expiresAt, Date.now() + IDLE_TTL));
    this.broadcastState();
    return { inviteExpiresAt: this.state.inviteExpiresAt, expiresAt: this.state.expiresAt };
  }
  private sockets(role?: Role) {
    return this.ctx
      .getWebSockets()
      .filter(
        (ws) =>
          ws.readyState === WebSocket.OPEN &&
          (!role || (ws.deserializeAttachment() as Attachment).role === role),
      );
  }
  private send(ws: WebSocket, data: ServerMessage) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* socket closed between events */
    }
  }
  private broadcastState() {
    if (!this.state) return;
    for (const ws of this.sockets()) {
      const role = (ws.deserializeAttachment() as Attachment).role;
      this.send(ws, {
        type: 'state',
        peer: this.sockets(role === 'host' ? 'guest' : 'host').length > 0,
        paired: !!this.state.guest,
        mode: this.state.mode,
        expiresAt: this.state.expiresAt,
      });
    }
  }
  private mergeUsage(previous: Usage | undefined, current: Usage): Usage {
    if (!previous) return current;
    const latest = current.minute >= previous.minute ? current : previous;
    return {
      total: Math.max(previous.total, current.total),
      minute: latest.minute,
      // Counters are monotonic within a window, but reset in a newer window.
      bytes:
        previous.minute === current.minute ? Math.max(previous.bytes, current.bytes) : latest.bytes,
      messages:
        previous.minute === current.minute
          ? Math.max(previous.messages, current.messages)
          : latest.messages,
    };
  }
  async fetch(request: Request) {
    if (this.expired() || !this.state) return json({ error: 'expired' }, 410);
    const protocols =
      request.headers
        .get('Sec-WebSocket-Protocol')
        ?.split(',')
        .map((s) => s.trim()) || [];
    if (protocols.length !== 2 || protocols[0] !== 'textrans-v1' || !isToken(protocols[1]))
      return json({ error: 'unauthorized' }, 401);
    const hash = await digest(protocols[1]);
    // Recheck after async hashing; a join or end may have run in the meantime.
    if (!this.state || this.expired()) return json({ error: 'expired' }, 410);
    const role = hash === this.state.host ? 'host' : hash === this.state.guest ? 'guest' : null;
    if (!role) return json({ error: 'unauthorized' }, 401);
    let previous = this.state.usage[role];
    for (const old of this.ctx.getWebSockets()) {
      const attachment = old.deserializeAttachment() as Attachment;
      if (attachment.role !== role) continue;
      // A reconnect may arrive before a closing socket's close callback saves
      // its counters. Preserve that usage as well, so reconnecting cannot reset
      // the transfer budget.
      previous = this.mergeUsage(previous, attachment);
      // Persist invalidation across hibernation and delayed close callbacks.
      old.serializeAttachment({ ...attachment, replaced: true });
      if (old.readyState === WebSocket.OPEN) old.close(4001, 'replaced');
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const attachment: Attachment = {
      total: previous?.total || 0,
      minute: previous?.minute || Date.now(),
      bytes: previous?.bytes || 0,
      messages: previous?.messages || 0,
      role,
      lastActivity: Date.now(),
    };
    pair[1].serializeAttachment(attachment);
    this.broadcastState();
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': 'textrans-v1' },
    });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (this.expired()) {
      await this.end('expired');
      return;
    }
    const a = ws.deserializeAttachment() as Attachment;
    // An old connection must not send after the same token reconnects.
    // A browser may send `end` immediately before its Close frame. Workerd can
    // expose CLOSING while that queued message is dispatched; still process it.
    // A replaced socket, however, must never act on behalf of the new one.
    if (
      a.replaced ||
      !this.ctx.getWebSockets().includes(ws) ||
      this.sockets(a.role).some((current) => current !== ws)
    )
      return;
    const size =
      typeof message === 'string' ? new TextEncoder().encode(message).length : message.byteLength;
    if (size > MAX_FRAME_BYTES || (typeof message === 'string' && size > 2048)) {
      ws.close(1009, 'too-large');
      return;
    }
    if (Date.now() - a.minute >= 60_000) {
      a.minute = Date.now();
      a.bytes = 0;
      a.messages = 0;
    }
    a.total += size;
    a.bytes += size;
    a.messages++;
    a.lastActivity = Date.now();
    ws.serializeAttachment(a);
    if (a.total > 100_000_000 || a.bytes > 25_000_000 || a.messages > 2500) {
      await this.end('rate-limit');
      return;
    }
    if (typeof message === 'string') {
      let value: unknown;
      try {
        value = JSON.parse(message);
      } catch {
        ws.close(1008, 'invalid-message');
        return;
      }
      if (!isRecord(value)) {
        ws.close(1008, 'invalid-message');
        return;
      }
      if (value.type === 'end') {
        await this.end('ended');
        return;
      }
      if (
        value.type !== 'handshake' ||
        !isRecord(value.message) ||
        !['commit', 'reveal'].includes(String(value.message.type))
      ) {
        ws.close(1008, 'invalid-message');
        return;
      }
    } else if (!this.state?.guest) {
      ws.close(1008, 'not-paired');
      return;
    }
    const peers = this.sockets(a.role === 'host' ? 'guest' : 'host');
    if (!peers.length) {
      this.send(ws, { type: 'peer-offline' });
      return;
    }
    for (const peer of peers) {
      try {
        peer.send(message);
      } catch {
        this.send(ws, { type: 'peer-offline' });
      }
    }
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const a = ws.deserializeAttachment() as Attachment;
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    if (!this.state || this.sockets(a.role).length) return;
    this.state.usage[a.role] = this.mergeUsage(this.state.usage[a.role], a);
    this.state.lastActivity = Math.max(this.state.lastActivity, a.lastActivity);
    await this.ctx.storage.put('state', this.state);
    this.broadcastState();
  }
  webSocketError(ws: WebSocket) {
    return this.webSocketClose(ws, 1011, 'connection-error');
  }
  async alarm() {
    if (this.expired()) return this.end('expired');
    const last = Math.max(
      this.state!.lastActivity,
      ...this.sockets().map((ws) => (ws.deserializeAttachment() as Attachment).lastActivity),
    );
    await this.ctx.storage.setAlarm(
      Math.min(
        this.state!.expiresAt,
        this.state!.guest ? last + IDLE_TTL : this.state!.inviteExpiresAt,
      ),
    );
  }
  private async end(reason: string) {
    for (const ws of this.sockets()) {
      this.send(ws, { type: 'ended', reason });
      ws.close(1000, reason);
    }
    this.state = undefined;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
