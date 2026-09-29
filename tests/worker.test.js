import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Room } from '../worker/room';
import { digest } from '../worker/index';
import { Directory } from '../worker/directory';
import { INVITE_TTL, IDLE_TTL, SESSION_TTL } from '../shared/protocol';

function context() {
  const data = new Map();
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  return {
    sockets: [],
    ready: Promise.resolve(),
    db,
    blockConcurrencyWhile(fn) {
      this.ready = fn();
    },
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws) {
      this.sockets.push(ws);
    },
    getWebSockets() {
      return this.sockets;
    },
    storage: {
      async get(key) {
        return structuredClone(data.get(key));
      },
      async put(key, value) {
        data.set(key, structuredClone(value));
      },
      async deleteAll() {
        data.clear();
      },
      async deleteAlarm() {
        alarm = null;
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(value) {
        alarm = value;
      },
      sql: {
        exec(query, ...params) {
          const rows = db.prepare(query).all(...params);
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error('not-one');
              return rows[0];
            },
          };
        },
      },
    },
  };
}
function socket(role) {
  let attachment = {
    role,
    total: 0,
    minute: Date.now(),
    bytes: 0,
    messages: 0,
    lastActivity: Date.now(),
  };
  return {
    readyState: 1,
    sent: [],
    serializeAttachment(value) {
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return structuredClone(attachment);
    },
    send(value) {
      this.sent.push(value);
    },
    close() {
      this.readyState = 3;
    },
  };
}
let contexts = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const c of contexts) c.db.close();
  contexts = [];
});
async function room(host = 'host-hash') {
  const ctx = context();
  contexts.push(ctx);
  const value = new Room(ctx, {});
  await ctx.ready;
  await value.initialize(host, Date.now() + INVITE_TTL);
  return { ctx, value };
}

describe('room lifecycle and server limits', () => {
  it('binds only one guest even when claims arrive together', async () => {
    const { value } = await room();
    const claims = await Promise.all([
      value.join('guest-one', 'code'),
      value.join('guest-two', 'code'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('expires an unused invite and clears metadata', async () => {
    const { ctx, value } = await room();
    vi.advanceTimersByTime(INVITE_TTL);
    expect(await value.join('guest', 'code')).toBeNull();
    await value.alarm();
    expect(await ctx.storage.get('state')).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBeNull();
  });
  it('restores participants, counters, and idle deadlines after hibernation', async () => {
    const { ctx, value } = await room();
    await value.join('guest', 'code');
    const host = socket('host'),
      guest = socket('guest');
    ctx.sockets.push(host, guest);
    vi.advanceTimersByTime(IDLE_TTL - 1000);
    await value.webSocketMessage(host, new Uint8Array(40).buffer);
    expect(guest.sent).toHaveLength(1);
    const restored = new Room(ctx, {});
    await ctx.ready;
    vi.advanceTimersByTime(2000);
    await restored.alarm();
    expect(await ctx.storage.get('state')).toBeDefined();
    await restored.webSocketMessage(host, new Uint8Array(50).buffer);
    expect(guest.sent).toHaveLength(2);
    expect(host.deserializeAttachment().total).toBe(90);
    // Payloads are never persisted alongside metadata.
    expect(Object.keys(await ctx.storage.get('state')).sort()).toEqual([
      'expiresAt',
      'guest',
      'host',
      'inviteExpiresAt',
      'lastActivity',
      'mode',
      'usage',
    ]);
    vi.advanceTimersByTime(IDLE_TTL);
    await restored.alarm();
    expect(await ctx.storage.get('state')).toBeUndefined();
    expect(host.readyState).toBe(3);
  });
  it('honors an explicit end queued immediately before the socket closes', async () => {
    const { ctx, value } = await room();
    await value.join('guest', 'code');
    const host = socket('host'),
      guest = socket('guest');
    ctx.sockets.push(host, guest);
    host.readyState = 2;
    await value.webSocketMessage(host, JSON.stringify({ type: 'end' }));
    expect(await ctx.storage.get('state')).toBeUndefined();
    expect(guest.sent.some((message) => message.includes('ended'))).toBe(true);
  });
  it('preserves transfer usage when reconnect arrives before the old close callback', async () => {
    const token = 'A'.repeat(43);
    const { ctx, value } = await room(await digest(token));
    await value.join('guest', 'code');
    const old = socket('host');
    old.readyState = 2;
    old.serializeAttachment({ ...old.deserializeAttachment(), total: 99_999_999 });
    ctx.sockets.push(old);
    vi.stubGlobal(
      'WebSocketPair',
      class {
        constructor() {
          this[0] = socket('host');
          this[1] = socket('host');
        }
      },
    );
    vi.stubGlobal(
      'Response',
      class {
        constructor(body, init) {
          Object.assign(this, init);
        }
      },
    );
    const response = await value.fetch(
      new Request('https://example.test/api/rooms/id/socket', {
        headers: { 'Sec-WebSocket-Protocol': `textrans-v1, ${token}` },
      }),
    );
    expect(response.status).toBe(101);
    const resumed = ctx.sockets.at(-1);
    expect(resumed.deserializeAttachment().total).toBe(99_999_999);
    await value.webSocketMessage(resumed, new Uint8Array(100).buffer);
    expect(await ctx.storage.get('state')).toBeUndefined();
  });
  it('enforces the absolute deadline despite recent traffic', async () => {
    const { ctx, value } = await room();
    await value.join('guest', 'qr');
    const host = socket('host'),
      guest = socket('guest');
    ctx.sockets.push(host, guest);
    vi.advanceTimersByTime(SESSION_TTL - 1);
    host.serializeAttachment({ ...host.deserializeAttachment(), lastActivity: Date.now() });
    vi.advanceTimersByTime(1);
    await value.webSocketMessage(host, new Uint8Array(100).buffer);
    expect(await ctx.storage.get('state')).toBeUndefined();
    expect(
      guest.sent.some((message) => typeof message === 'string' && message.includes('expired')),
    ).toBe(true);
  });
  it('enforces aggregate bytes and message size without reading the plaintext', async () => {
    const { ctx, value } = await room();
    await value.join('guest', 'code');
    const host = socket('host'),
      guest = socket('guest');
    ctx.sockets.push(host, guest);
    host.serializeAttachment({ ...host.deserializeAttachment(), total: 99_999_999 });
    await value.webSocketMessage(host, new Uint8Array(100).buffer);
    expect(await ctx.storage.get('state')).toBeUndefined();
    expect(
      guest.sent.some((message) => typeof message === 'string' && message.includes('rate-limit')),
    ).toBe(true);
  });
});

describe('invitation registry', () => {
  it('issues unique six-digit invitations, consumes once, and expires', async () => {
    const ctx = context();
    contexts.push(ctx);
    const directory = new Directory(ctx, {});
    const one = await directory.allocate('one', '192.0.2.1');
    const two = await directory.allocate('two', '192.0.2.1');
    expect(one.code).toMatch(/^\d{6}$/);
    expect(two.code).not.toBe(one.code);
    expect(await directory.resolve(one.code, '192.0.2.2')).toBe('one');
    directory.consume(one.code, 'wrong-room');
    expect(await directory.resolve(one.code, '192.0.2.2')).toBe('one');
    directory.consume(one.code, 'one');
    expect(await directory.resolve(one.code, '192.0.2.2')).toBeNull();
    vi.advanceTimersByTime(INVITE_TTL);
    expect(await directory.resolve(two.code, '192.0.2.2')).toBeNull();
  });
  it('rate limits guesses including guesses for absent rooms', async () => {
    const ctx = context();
    contexts.push(ctx);
    const directory = new Directory(ctx, {});
    for (let i = 0; i < 20; i++) await directory.resolve('000000', '192.0.2.3');
    await expect(directory.resolve('000000', '192.0.2.3')).rejects.toThrow('rate-limit');
    vi.advanceTimersByTime(10 * 60_000);
    expect(await directory.resolve('000000', '192.0.2.3')).toBeNull();
  });
});
