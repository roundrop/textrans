import { isRecord, type HandshakeMessage, type PairMode, type Role } from '../../shared/protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (value: string) => encoder.encode(value);
export const text = (value: Uint8Array) => decoder.decode(value);
// Fresh ArrayBuffers keep the DOM WebCrypto types precise (no SharedArrayBuffer).
const buffer = (value: Uint8Array) => Uint8Array.from(value).buffer;
export const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export function unbase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid-base64');
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
export const secret = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const sha = async (value: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(value)));
async function hmac(key: Uint8Array, value: Uint8Array) {
  const imported = await crypto.subtle.importKey(
    'raw',
    buffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, buffer(value)));
}
function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Commit-before-reveal SAS key verification, with transcript/role binding.
// Protocol rationale, trust boundaries, and review status: docs/SECURITY.md.
export class Pairing {
  private pair!: CryptoKeyPair;
  private key = '';
  private nonce = '';
  private commitment = '';
  private peerCommit?: string;
  private peerReveal?: { key: string; nonce: string };
  private revealed = false;
  private result?: { channel: SecureChannel; sas: string };
  private constructor(
    readonly room: string,
    readonly role: Role,
    readonly mode: PairMode,
    private qrSecret?: string,
  ) {}
  static async create(room: string, role: Role, mode: PairMode, qrSecret?: string) {
    if (mode === 'qr' && (!qrSecret || unbase64(qrSecret).length !== 32))
      throw new Error('missing-qr-secret');
    const self = new Pairing(room, role, mode, qrSecret);
    self.pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
    self.key = base64(new Uint8Array(await crypto.subtle.exportKey('raw', self.pair.publicKey)));
    self.nonce = secret();
    self.commitment = base64(await sha(self.material(role, self.key, self.nonce)));
    return self;
  }
  private material(role: Role, key: string, nonce: string) {
    return utf8(JSON.stringify(['textrans-pair-v1', this.room, this.mode, role, key, nonce]));
  }
  get commit(): HandshakeMessage {
    return { type: 'commit', value: this.commitment, mode: this.mode };
  }
  async receive(
    message: HandshakeMessage,
  ): Promise<{ reply?: HandshakeMessage; channel?: SecureChannel; sas?: string }> {
    if (!isRecord(message)) throw new Error('invalid-handshake');
    if (message.type === 'commit') {
      if (
        message.mode !== this.mode ||
        typeof message.value !== 'string' ||
        unbase64(message.value).length !== 32
      )
        throw new Error('invalid-commit');
      if (this.peerCommit && this.peerCommit !== message.value) throw new Error('changed-commit');
      this.peerCommit = message.value;
      this.revealed = true;
      const proof =
        this.mode === 'qr'
          ? base64(
              await hmac(unbase64(this.qrSecret!), this.material(this.role, this.key, this.nonce)),
            )
          : '';
      return { reply: { type: 'reveal', key: this.key, nonce: this.nonce, proof } };
    }
    if (message.type !== 'reveal' || !this.peerCommit || !this.revealed)
      throw new Error('unexpected-reveal');
    if (
      typeof message.key !== 'string' ||
      typeof message.nonce !== 'string' ||
      typeof message.proof !== 'string'
    )
      throw new Error('invalid-reveal');
    if (unbase64(message.key).length !== 65 || unbase64(message.nonce).length !== 32)
      throw new Error('invalid-key');
    const peerRole = this.role === 'host' ? 'guest' : 'host';
    const material = this.material(peerRole, message.key, message.nonce);
    if (!equal(await sha(material), unbase64(this.peerCommit))) throw new Error('commit-mismatch');
    if (
      this.mode === 'qr' &&
      !equal(await hmac(unbase64(this.qrSecret!), material), unbase64(message.proof))
    )
      throw new Error('qr-mismatch');
    if (
      this.peerReveal &&
      (this.peerReveal.key !== message.key || this.peerReveal.nonce !== message.nonce)
    )
      throw new Error('changed-key');
    this.peerReveal = { key: message.key, nonce: message.nonce };
    if (this.result) return {};
    const remote = await crypto.subtle.importKey(
      'raw',
      buffer(unbase64(message.key)),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: remote },
      this.pair.privateKey,
      256,
    );
    const host = this.role === 'host' ? this.material('host', this.key, this.nonce) : material;
    const guest = this.role === 'guest' ? this.material('guest', this.key, this.nonce) : material;
    const transcript = await sha(utf8(JSON.stringify([text(host), text(guest)])));
    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const derive = async (label: string, length: number) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: buffer(transcript),
            info: buffer(utf8(`textrans-v1:${label}`)),
          },
          hkdfKey,
          length * 8,
        ),
      );
    const sasBytes = await derive('sas', 6);
    const sas = [0, 2, 4]
      .map((i) => (1000 + (((sasBytes[i] << 8) | sasBytes[i + 1]) & 8191)).toString())
      .join(' · ');
    const hostKey = await derive('host-to-guest', 32);
    const guestKey = await derive('guest-to-host', 32);
    const channel = await SecureChannel.create(
      this.role === 'host' ? hostKey : guestKey,
      this.role === 'host' ? guestKey : hostKey,
      transcript,
    );
    this.result = { channel, sas };
    // PSK never persists beyond the in-memory pairing object.
    return this.result;
  }
}

export class SecureChannel {
  private sent = 0n;
  private received = 0n;
  private constructor(
    private sendKey: CryptoKey,
    private receiveKey: CryptoKey,
    private transcript: Uint8Array,
  ) {}
  static async create(send: Uint8Array, receive: Uint8Array, transcript: Uint8Array) {
    const sendKey = await crypto.subtle.importKey('raw', buffer(send), 'AES-GCM', false, [
      'encrypt',
    ]);
    const receiveKey = await crypto.subtle.importKey('raw', buffer(receive), 'AES-GCM', false, [
      'decrypt',
    ]);
    return new SecureChannel(sendKey, receiveKey, transcript);
  }
  async encrypt(plain: Uint8Array): Promise<ArrayBuffer> {
    const sequence = ++this.sent;
    if (sequence >= 2n ** 64n) throw new Error('sequence-exhausted');
    const header = new Uint8Array(9);
    header[0] = 1;
    new DataView(header.buffer).setBigUint64(1, sequence);
    const iv = new Uint8Array(12);
    iv.set(header.subarray(1), 4);
    const aad = new Uint8Array(this.transcript.length + header.length);
    aad.set(this.transcript);
    aad.set(header, this.transcript.length);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        this.sendKey,
        buffer(plain),
      ),
    );
    const result = new Uint8Array(header.length + encrypted.length);
    result.set(header);
    result.set(encrypted, header.length);
    return result.buffer;
  }
  async decrypt(packet: ArrayBuffer): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(packet);
    if (bytes.length < 25 || bytes[0] !== 1) throw new Error('invalid-packet');
    const sequence = new DataView(packet).getBigUint64(1);
    if (sequence <= this.received) return null;
    const iv = new Uint8Array(12);
    iv.set(bytes.subarray(1, 9), 4);
    const aad = new Uint8Array(this.transcript.length + 9);
    aad.set(this.transcript);
    aad.set(bytes.subarray(0, 9), this.transcript.length);
    const decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        this.receiveKey,
        buffer(bytes.subarray(9)),
      ),
    );
    this.received = sequence;
    return decrypted;
  }
}
