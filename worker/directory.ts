import { DurableObject } from 'cloudflare:workers';
import { INVITE_TTL } from '../shared/protocol';
import { digest, randomToken, type Env } from './index';

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, room TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS salts (day INTEGER PRIMARY KEY, value TEXT NOT NULL)',
    );
  }
  private async identity(ip: string): Promise<string> {
    const day = Math.floor(Date.now() / 86_400_000);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO salts VALUES (?, ?)', day, randomToken());
    const salt = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM salts WHERE day = ?', day)
      .one().value;
    return digest(`${salt}:${ip}`);
  }
  private count(key: string, limit: number, duration: number) {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE key = ? AND expires <= ?', key, now);
    const previous =
      this.ctx.storage.sql
        .exec<{ count: number }>('SELECT count FROM counters WHERE key = ?', key)
        .toArray()[0]?.count || 0;
    if (previous >= limit) throw new Error('rate-limit');
    this.ctx.storage.sql.exec(
      'INSERT INTO counters VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1',
      key,
      now + duration,
    );
  }
  private async maintenance() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
  }
  async allocate(roomId: string, ip: string) {
    const identity = await this.identity(ip);
    this.count(`create:${identity}`, 12, 10 * 60_000);
    this.count(`create-day:${Math.floor(Date.now() / 86_400_000)}`, 2000, 86_400_000);
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM invites WHERE expires <= ?', now);
    let code = '';
    for (let attempt = 0; attempt < 32; attempt++) {
      // Rejection sampling avoids modulo bias.
      const ceiling = 4_294_000_000;
      let n: number;
      do {
        n = crypto.getRandomValues(new Uint32Array(1))[0];
      } while (n >= ceiling);
      code = (n % 1_000_000).toString().padStart(6, '0');
      if (
        !this.ctx.storage.sql.exec('SELECT code FROM invites WHERE code = ?', code).toArray().length
      )
        break;
      code = '';
    }
    if (!code) throw new Error('capacity');
    this.ctx.storage.sql.exec(
      'INSERT INTO invites VALUES (?, ?, ?)',
      code,
      roomId,
      now + INVITE_TTL,
    );
    await this.maintenance();
    return { code, expiresAt: now + INVITE_TTL };
  }
  async resolve(code: string, ip: string) {
    const identity = await this.identity(ip);
    this.count(`join:${identity}`, 20, 10 * 60_000);
    await this.maintenance();
    return (
      this.ctx.storage.sql
        .exec<{ room: string }>(
          'SELECT room FROM invites WHERE code = ? AND expires > ?',
          code,
          Date.now(),
        )
        .toArray()[0]?.room || null
    );
  }
  consume(code: string, room: string) {
    this.ctx.storage.sql.exec('DELETE FROM invites WHERE code = ? AND room = ?', code, room);
  }
  async connectionAttempt(ip: string) {
    this.count(`socket:${await this.identity(ip)}`, 120, 10 * 60_000);
    await this.maintenance();
  }
  alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM invites WHERE expires <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM counters WHERE expires <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM salts WHERE day < ?', Math.floor(now / 86_400_000));
    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>(
        'SELECT (SELECT COUNT(*) FROM invites) + (SELECT COUNT(*) FROM counters) AS n',
      )
      .one().n;
    if (remaining) return this.ctx.storage.setAlarm(now + 10 * 60_000);
  }
}
