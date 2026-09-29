import { describe, expect, it } from 'vitest';
import { Pairing, secret, utf8, text, base64, unbase64 } from '../src/lib/crypto';
import type { HandshakeMessage, PairMode } from '../shared/protocol';
async function pair(mode: PairMode = 'code', key?: string) {
  const room = crypto.randomUUID();
  const host = await Pairing.create(room, 'host', mode, key);
  const guest = await Pairing.create(room, 'guest', mode, key);
  const hReveal = (await host.receive(guest.commit)).reply!;
  const gReveal = (await guest.receive(host.commit)).reply!;
  const a = await host.receive(gReveal);
  const b = await guest.receive(hReveal);
  return { host, guest, a, b, hReveal, gReveal };
}
describe('peer verification and authenticated encryption', () => {
  it('derives the same SAS and separates sending and receiving keys', async () => {
    const { a, b } = await pair();
    expect(a.sas).toMatch(/^\d{4} · \d{4} · \d{4}$/);
    expect(a.sas).toBe(b.sas);
    const encrypted = await a.channel!.encrypt(utf8('こんにちは 🔒'));
    expect(text((await b.channel!.decrypt(encrypted))!)).toBe('こんにちは 🔒');
    const reverse = await b.channel!.encrypt(utf8('received'));
    expect(text((await a.channel!.decrypt(reverse))!)).toBe('received');
  });
  it('authenticates QR peers with the same out-of-band secret', async () => {
    const { a, b } = await pair('qr', secret());
    expect(a.sas).toBe(b.sas);
  });
  it('rejects QR peers with a different secret', async () => {
    const room = crypto.randomUUID();
    const a = await Pairing.create(room, 'host', 'qr', secret());
    const b = await Pairing.create(room, 'guest', 'qr', secret());
    await a.receive(b.commit);
    const reveal = (await b.receive(a.commit)).reply!;
    await expect(a.receive(reveal)).rejects.toThrow('qr-mismatch');
  });
  it('rejects revealing a key before committing', async () => {
    const a = await Pairing.create(crypto.randomUUID(), 'host', 'code');
    await expect(
      a.receive({ type: 'reveal', key: secret(), nonce: secret(), proof: '' }),
    ).rejects.toThrow('unexpected-reveal');
  });
  it('detects a replaced key and a changed commitment', async () => {
    const { host, guest, gReveal } = await pair();
    const forged = { ...gReveal, nonce: secret() } as HandshakeMessage;
    await expect(host.receive(forged)).rejects.toThrow('commit-mismatch');
    await expect(
      host.receive({ ...guest.commit, value: secret() } as HandshakeMessage),
    ).rejects.toThrow('changed-commit');
  });
  it('refuses QR-to-code downgrade', async () => {
    const host = await Pairing.create(crypto.randomUUID(), 'host', 'qr', secret());
    await expect(host.receive({ type: 'commit', mode: 'code', value: secret() })).rejects.toThrow(
      'invalid-commit',
    );
  });
  it('binds verification to the room and peer roles', async () => {
    const host = await Pairing.create('room-a', 'host', 'code');
    const guest = await Pairing.create('room-b', 'guest', 'code');
    await host.receive(guest.commit);
    const reveal = (await guest.receive(host.commit)).reply!;
    await expect(host.receive(reveal)).rejects.toThrow('commit-mismatch');
  });
  it('rejects tampering without consuming the receive sequence', async () => {
    const { a, b } = await pair();
    const encrypted = await a.channel!.encrypt(utf8('private'));
    const tampered = encrypted.slice(0);
    new Uint8Array(tampered)[15] ^= 1;
    await expect(b.channel!.decrypt(tampered)).rejects.toThrow();
    expect(text((await b.channel!.decrypt(encrypted))!)).toBe('private');
    expect(await b.channel!.decrypt(encrypted)).toBeNull();
  });
  it('handles duplicate handshakes without resetting nonce counters', async () => {
    const { host, guest, a, b, gReveal } = await pair();
    await host.receive(guest.commit);
    expect(await host.receive(gReveal)).toEqual({});
    const one = await a.channel!.encrypt(utf8('one'));
    const two = await a.channel!.encrypt(utf8('two'));
    expect(new DataView(two).getBigUint64(1)).toBe(new DataView(one).getBigUint64(1) + 1n);
    expect(text((await b.channel!.decrypt(two))!)).toBe('two');
    expect(await b.channel!.decrypt(one)).toBeNull();
  });
  it('encodes high entropy secrets without URL punctuation', () => {
    const value = secret();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64(unbase64(value))).toBe(value);
  });
});
