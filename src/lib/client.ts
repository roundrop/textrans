import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_HISTORY,
  MAX_HISTORY_BYTES,
  MAX_TEXT_BYTES,
  type Connection,
  type Control,
  type PairMode,
  type ServerMessage,
} from '../../shared/protocol';
import { Pairing, secret, utf8, type SecureChannel } from './crypto';
import { decodeEnvelope, encodeChunk, encodeControl } from './codec';

export type Phase =
  'home' | 'creating' | 'waiting' | 'verifying' | 'connected' | 'reconnecting' | 'ended';
export interface Entry {
  id: string;
  direction: 'in' | 'out';
  kind: 'text' | 'file';
  text?: string;
  name?: string;
  size?: number;
  url?: string;
  status: 'pending' | 'offered' | 'transferring' | 'delivered' | 'cancelled';
  progress?: number;
}
export interface ViewState {
  phase: Phase;
  connection?: Connection;
  inviteUrl: string;
  peer: boolean;
  paired: boolean;
  sas: string;
  verified: boolean;
  peerVerified: boolean;
  history: Entry[];
  error: string;
  remaining: number;
  incoming?: { id: string; name: string; size: number };
  outgoing: boolean;
}
export const initialState = (): ViewState => ({
  phase: 'home',
  inviteUrl: '',
  peer: false,
  paired: false,
  sas: '',
  verified: false,
  peerVerified: false,
  history: [],
  error: '',
  remaining: 0,
  outgoing: false,
});
interface Incoming {
  id: string;
  name: string;
  size: number;
  mime: string;
  accepted: boolean;
  chunks: Uint8Array<ArrayBuffer>[];
  next: number;
  hash: ReturnType<typeof sha256.create>;
}
interface Outgoing {
  id: string;
  file: File;
  hash: string;
  accepted: boolean;
  next: number;
  lastSent: number;
}

export class TransferClient {
  state = initialState();
  private ws?: WebSocket;
  private pairing?: Pairing;
  private channel?: SecureChannel;
  private qrSecret?: string;
  private receiveChain = Promise.resolve();
  private sendChain = Promise.resolve();
  private pending = new Map<string, { text: string; lastSent: number }>();
  private received = new Set<string>();
  private incoming?: Incoming;
  private outgoing?: Outgoing;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private active = false;
  private pumping = false;
  private lastPing = 0;
  private lastPong = 0;
  private generation = 0;
  constructor(private changed: (state: ViewState) => void) {}
  private emit() {
    this.changed({ ...this.state, history: this.state.history.map((entry) => ({ ...entry })) });
  }
  private entry(id: string) {
    return this.state.history.find((entry) => entry.id === id);
  }
  private add(entry: Entry) {
    this.state.history.unshift(entry);
    this.trim();
    this.emit();
  }
  private trim() {
    let total = this.state.history.reduce((sum, e) => sum + (e.url ? e.size || 0 : 0), 0);
    while (this.state.history.length > MAX_HISTORY || total > MAX_HISTORY_BYTES) {
      // Active transfers and unacknowledged text remain visible.
      const index = this.state.history.findLastIndex(
        (e) => e.status === 'delivered' || e.status === 'cancelled',
      );
      if (index < 0) break;
      const [removed] = this.state.history.splice(index, 1);
      if (removed.url) {
        URL.revokeObjectURL(removed.url);
        total -= removed.size || 0;
      }
    }
  }
  private async api(path: string, input: object): Promise<Connection> {
    const response = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => ({ error: 'unavailable' }));
    if (!response.ok) throw new Error(value.error || 'unavailable');
    return value as Connection;
  }
  async create() {
    this.reset();
    this.state.phase = 'creating';
    this.emit();
    const generation = this.generation;
    try {
      const connection = await this.api('rooms', {});
      if (generation !== this.generation) return;
      this.qrSecret = secret();
      this.state.connection = connection;
      const fragment = new URLSearchParams({ code: connection.code, key: this.qrSecret });
      this.state.inviteUrl = `${location.origin}/#${fragment}`;
      this.start();
    } catch (error) {
      if (generation === this.generation)
        this.failStart(error instanceof Error ? error.message : 'unavailable');
    }
  }
  async join(code: string, key?: string) {
    this.reset();
    this.state.phase = 'creating';
    this.emit();
    const generation = this.generation;
    try {
      this.qrSecret = key;
      const mode: PairMode = key ? 'qr' : 'code';
      const connection = await this.api('join', { code, mode });
      if (generation !== this.generation) return;
      this.state.connection = connection;
      this.start();
    } catch (error) {
      if (generation === this.generation)
        this.failStart(error instanceof Error ? error.message : 'unavailable');
    }
  }
  private failStart(reason: string) {
    // A failed invitation is correctable in the form; no session was established.
    this.reset();
    this.state.error = reason;
    this.emit();
  }
  private start() {
    this.active = true;
    this.state.phase = 'waiting';
    this.tick();
    this.connect();
    this.timer = setInterval(() => this.tick(), 1000);
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    this.emit();
  }
  private wake = () => {
    if (!this.active || document.visibilityState === 'hidden') return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
    else if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastPong > 45_000)
      this.ws.close(4000, 'check-connection');
    this.tick();
  };
  private connect() {
    if (
      !this.active ||
      !this.state.connection ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return;
    clearTimeout(this.retry);
    const c = this.state.connection;
    const url = new URL(`/api/rooms/${c.roomId}/socket`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, ['textrans-v1', c.token]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.retries = 0;
      this.lastPong = Date.now();
    };
    ws.onmessage = (event) => {
      this.receiveChain = this.receiveChain
        .then(async () => {
          if (ws !== this.ws || !this.active) return;
          if (event.data === 'pong') {
            this.lastPong = Date.now();
            return;
          }
          if (typeof event.data === 'string')
            await this.server(JSON.parse(event.data) as ServerMessage);
          else await this.encrypted(event.data as ArrayBuffer);
        })
        .catch(() => {
          if (this.active) this.fail('security');
        });
    };
    ws.onclose = (event) => {
      if (ws !== this.ws || !this.active) return;
      this.state.peer = false;
      this.state.phase = 'reconnecting';
      if ([1008, 1009, 4001].includes(event.code)) {
        this.fail(event.code === 4001 ? 'replaced' : 'unavailable');
        return;
      }
      this.retry = setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retries++));
      this.emit();
    };
    ws.onerror = () => {
      /* close triggers the bounded reconnect loop */
    };
  }
  private sendHandshake() {
    if (this.pairing && this.state.peer && this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type: 'handshake', message: this.pairing.commit }));
  }
  private async server(message: ServerMessage) {
    switch (message.type) {
      case 'state': {
        this.state.peer = message.peer;
        this.state.paired = message.paired;
        if (message.mode && this.state.connection) {
          if (this.state.connection.role === 'guest' && message.mode !== this.state.connection.mode)
            throw new Error('mode-downgrade');
          if (this.pairing && this.pairing.mode !== message.mode) throw new Error('changed-mode');
          this.state.connection.mode = message.mode;
          this.pairing ??= await Pairing.create(
            this.state.connection.roomId,
            this.state.connection.role,
            message.mode,
            this.qrSecret,
          );
          this.sendHandshake();
          if (this.channel && this.state.verified && message.peer) {
            await this.sendControl({ type: 'verified' });
            await this.sendControl({ type: 'resume' });
            await this.resend();
          }
        }
        this.updatePhase();
        this.emit();
        return;
      }
      case 'handshake': {
        if (!this.pairing) throw new Error('unexpected-handshake');
        const result = await this.pairing.receive(message.message);
        if (result.reply && this.ws?.readyState === WebSocket.OPEN)
          this.ws.send(JSON.stringify({ type: 'handshake', message: result.reply }));
        if (result.channel) {
          this.channel = result.channel;
          this.state.sas = result.sas!;
          if (this.pairing.mode === 'qr') await this.verify();
        }
        this.updatePhase();
        this.emit();
        return;
      }
      case 'peer-offline':
        this.state.peer = false;
        this.updatePhase();
        this.emit();
        return;
      case 'ended':
        this.fail(message.reason, false);
        return;
      case 'error':
        this.fail(message.code);
        return;
      default:
        throw new Error('invalid-server-message');
    }
  }
  private updatePhase() {
    if (!this.active) return;
    this.state.phase =
      this.state.verified && this.state.peerVerified
        ? this.state.peer
          ? 'connected'
          : 'reconnecting'
        : this.channel
          ? 'verifying'
          : 'waiting';
  }
  async verify() {
    if (!this.channel) return;
    this.state.verified = true;
    await this.sendControl({ type: 'verified' });
    this.updatePhase();
    this.emit();
  }
  private sendPlain(plain: Uint8Array): Promise<boolean> {
    let sent = false;
    const generation = this.generation;
    const next = this.sendChain.then(async () => {
      if (
        !this.channel ||
        !this.active ||
        !this.state.peer ||
        this.ws?.readyState !== WebSocket.OPEN ||
        generation !== this.generation
      )
        return;
      const ws = this.ws;
      const encrypted = await this.channel.encrypt(plain);
      if (
        ws !== this.ws ||
        ws.readyState !== WebSocket.OPEN ||
        !this.active ||
        generation !== this.generation
      )
        return;
      ws.send(encrypted);
      sent = true;
    });
    this.sendChain = next.catch(() => {
      if (this.active) this.fail('security');
    });
    return next.then(() => sent);
  }
  private sendControl(control: Control) {
    return this.sendPlain(encodeControl(control));
  }
  private async encrypted(packet: ArrayBuffer) {
    if (!this.channel) throw new Error('missing-key');
    const plain = await this.channel.decrypt(packet);
    if (!plain) return;
    const envelope = decodeEnvelope(plain);
    if ('control' in envelope && envelope.control.type === 'verified') {
      this.state.peerVerified = true;
      this.updatePhase();
      this.emit();
      return;
    }
    if (!this.state.verified || !this.state.peerVerified) throw new Error('unverified-peer');
    if ('control' in envelope) await this.control(envelope.control);
    else await this.chunk(envelope.id, envelope.index, envelope.bytes);
  }
  async sendText(value: string) {
    if (this.state.phase !== 'connected' || !value.trim()) return false;
    if (utf8(value).length > MAX_TEXT_BYTES) {
      this.state.error = 'text-too-large';
      this.emit();
      return false;
    }
    if (this.pending.size >= 5) {
      this.state.error = 'pending-limit';
      this.emit();
      return false;
    }
    const id = crypto.randomUUID();
    this.pending.set(id, { text: value, lastSent: Date.now() });
    this.add({ id, kind: 'text', direction: 'out', text: value, status: 'pending' });
    await this.sendControl({ type: 'text', id, text: value });
    return true;
  }
  async sendFile(file: File) {
    if (this.state.phase !== 'connected' || this.outgoing || this.state.outgoing) return;
    if (file.size > MAX_FILE_BYTES) {
      this.state.error = 'file-too-large';
      this.emit();
      return;
    }
    const generation = this.generation;
    this.state.outgoing = true;
    this.emit();
    try {
      const hash = sha256.create();
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        hash.update(new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer()));
        if (generation !== this.generation) return;
      }
      if (generation !== this.generation) return;
      const id = crypto.randomUUID();
      this.outgoing = {
        id,
        file,
        hash: bytesToHex(hash.digest()),
        accepted: false,
        next: 0,
        lastSent: 0,
      };
      this.add({
        id,
        kind: 'file',
        direction: 'out',
        name: file.name.slice(0, 255) || 'file',
        size: file.size,
        progress: 0,
        status: 'offered',
      });
      await this.offer();
    } catch {
      this.state.outgoing = false;
      this.state.error = 'file-read';
      this.emit();
    }
  }
  private async offer() {
    const o = this.outgoing;
    if (!o) return;
    o.lastSent = Date.now();
    await this.sendControl({
      type: 'offer',
      id: o.id,
      name: o.file.name.slice(0, 255) || 'file',
      size: o.file.size,
      mime: o.file.type.slice(0, 128),
    });
  }
  async acceptFile() {
    const input = this.incoming;
    if (!input || this.state.phase !== 'connected') return;
    input.accepted = true;
    this.state.incoming = undefined;
    const entry = this.entry(input.id);
    if (entry) entry.status = 'transferring';
    await this.sendControl({ type: 'accept', id: input.id, next: input.next });
    this.emit();
  }
  async cancelFile(id: string) {
    if (this.incoming?.id === id) {
      this.incoming = undefined;
      this.state.incoming = undefined;
    }
    if (this.outgoing?.id === id) {
      this.outgoing = undefined;
      this.state.outgoing = false;
    }
    const entry = this.entry(id);
    if (entry) entry.status = 'cancelled';
    await this.sendControl({ type: 'cancel', id });
    this.emit();
  }
  private async control(control: Control) {
    switch (control.type) {
      case 'verified':
        return;
      case 'resume':
        await this.resend();
        return;
      case 'text':
        if (!this.received.has(control.id)) {
          this.remember(control.id);
          this.add({
            id: control.id,
            kind: 'text',
            direction: 'in',
            text: control.text,
            status: 'delivered',
          });
        }
        await this.sendControl({ type: 'receipt', id: control.id });
        return;
      case 'receipt': {
        const entry = this.entry(control.id);
        if (entry?.direction !== 'out') return;
        if (this.outgoing?.id === control.id) {
          if (this.outgoing.next !== Math.ceil(this.outgoing.file.size / CHUNK_BYTES))
            throw new Error('early-receipt');
          this.outgoing = undefined;
          this.state.outgoing = false;
        }
        this.pending.delete(control.id);
        entry.status = 'delivered';
        entry.progress = 1;
        this.trim();
        this.emit();
        return;
      }
      case 'offer': {
        if (this.received.has(control.id)) {
          await this.sendControl({ type: 'receipt', id: control.id });
          return;
        }
        if (this.entry(control.id)?.status === 'cancelled') {
          await this.sendControl({ type: 'cancel', id: control.id });
          return;
        }
        if (this.incoming?.id === control.id) {
          if (control.size !== this.incoming.size || control.name !== this.incoming.name)
            throw new Error('changed-file');
          if (this.incoming.accepted)
            await this.sendControl({ type: 'accept', id: control.id, next: this.incoming.next });
          return;
        }
        if (this.incoming) {
          await this.sendControl({ type: 'cancel', id: control.id });
          return;
        }
        this.incoming = { ...control, accepted: false, next: 0, chunks: [], hash: sha256.create() };
        this.state.incoming = { id: control.id, name: control.name, size: control.size };
        this.add({
          id: control.id,
          kind: 'file',
          direction: 'in',
          name: control.name,
          size: control.size,
          status: 'offered',
          progress: 0,
        });
        return;
      }
      case 'accept': {
        if (this.outgoing?.id !== control.id) return;
        if (control.next > Math.ceil(this.outgoing.file.size / CHUNK_BYTES))
          throw new Error('invalid-offset');
        this.outgoing.accepted = true;
        this.outgoing.next = control.next;
        this.outgoing.lastSent = 0;
        const entry = this.entry(control.id);
        if (entry) entry.status = 'transferring';
        await this.pump();
        this.emit();
        return;
      }
      case 'chunk-ack': {
        const output = this.outgoing;
        if (!output || output.id !== control.id || control.next <= output.next) return;
        if (
          control.next !== output.next + 1 ||
          control.next > Math.ceil(output.file.size / CHUNK_BYTES)
        )
          throw new Error('invalid-offset');
        output.next = control.next;
        output.lastSent = 0;
        const entry = this.entry(control.id);
        if (entry)
          entry.progress =
            Math.min(output.next * CHUNK_BYTES, output.file.size) / (output.file.size || 1);
        await this.pump();
        this.emit();
        return;
      }
      case 'finish': {
        if (this.received.has(control.id)) {
          await this.sendControl({ type: 'receipt', id: control.id });
          return;
        }
        const input = this.incoming;
        if (
          !input ||
          input.id !== control.id ||
          !input.accepted ||
          input.next !== Math.ceil(input.size / CHUNK_BYTES)
        )
          throw new Error('incomplete-file');
        if (bytesToHex(input.hash.digest()) !== control.hash) throw new Error('file-integrity');
        // Download-only Blob: never execute/render an untrusted HTML/SVG file.
        const blob = new Blob(input.chunks, { type: 'application/octet-stream' });
        if (blob.size !== input.size) throw new Error('file-size');
        const entry = this.entry(control.id)!;
        entry.url = URL.createObjectURL(blob);
        entry.status = 'delivered';
        entry.progress = 1;
        this.remember(control.id);
        this.incoming = undefined;
        this.state.incoming = undefined;
        await this.sendControl({ type: 'receipt', id: control.id });
        this.trim();
        this.emit();
        return;
      }
      case 'cancel': {
        if (this.incoming?.id === control.id) {
          this.incoming = undefined;
          this.state.incoming = undefined;
        }
        if (this.outgoing?.id === control.id) {
          this.outgoing = undefined;
          this.state.outgoing = false;
        }
        const entry = this.entry(control.id);
        if (entry && entry.status !== 'delivered') entry.status = 'cancelled';
        this.emit();
        return;
      }
    }
  }
  private remember(id: string) {
    this.received.add(id);
    if (this.received.size > 1024) this.received.delete(this.received.values().next().value!);
  }
  private async chunk(id: string, index: number, bytes: Uint8Array<ArrayBufferLike>) {
    const input = this.incoming;
    if (!input || input.id !== id || !input.accepted) {
      if (this.entry(id)?.status === 'cancelled') {
        await this.sendControl({ type: 'cancel', id });
        return;
      }
      throw new Error('unrequested-chunk');
    }
    if (index < input.next) {
      await this.sendControl({ type: 'chunk-ack', id, next: input.next });
      return;
    }
    const expected = Math.min(CHUNK_BYTES, input.size - index * CHUNK_BYTES);
    if (index !== input.next || bytes.length !== expected || expected <= 0)
      throw new Error('invalid-chunk');
    input.chunks.push(Uint8Array.from(bytes));
    input.hash.update(bytes);
    input.next++;
    const entry = this.entry(id);
    if (entry) entry.progress = Math.min(input.next * CHUNK_BYTES, input.size) / input.size;
    await this.sendControl({ type: 'chunk-ack', id, next: input.next });
    this.emit();
  }
  private async pump() {
    const output = this.outgoing;
    if (
      this.pumping ||
      !output?.accepted ||
      this.state.phase !== 'connected' ||
      Date.now() - output.lastSent < 3000
    )
      return;
    this.pumping = true;
    try {
      output.lastSent = Date.now();
      if (output.next === Math.ceil(output.file.size / CHUNK_BYTES))
        await this.sendControl({ type: 'finish', id: output.id, hash: output.hash });
      else {
        const index = output.next;
        const bytes = new Uint8Array(
          await output.file.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).arrayBuffer(),
        );
        if (this.outgoing === output) await this.sendPlain(encodeChunk(output.id, index, bytes));
      }
    } finally {
      this.pumping = false;
    }
  }
  private async resend() {
    if (!this.state.verified || !this.state.peerVerified || !this.state.peer) return;
    for (const [id, item] of this.pending) {
      if (Date.now() - item.lastSent < 3000) continue;
      item.lastSent = Date.now();
      await this.sendControl({ type: 'text', id, text: item.text });
    }
    if (this.outgoing && Date.now() - this.outgoing.lastSent >= 3000) {
      if (this.outgoing.accepted) await this.pump();
      else await this.offer();
    }
  }
  private tick() {
    if (!this.active || !this.state.connection) return;
    const now = Date.now();
    const until = this.state.paired
      ? this.state.connection.expiresAt
      : this.state.connection.inviteExpiresAt;
    this.state.remaining = Math.max(0, Math.ceil((until - now) / 1000));
    if (!this.state.remaining) {
      this.fail('expired');
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (now - this.lastPong > 45_000) this.ws.close(4000, 'heartbeat-timeout');
      else if (now - this.lastPing >= 20_000) {
        this.ws.send('ping');
        this.lastPing = now;
      }
    }
    void this.resend().catch(() => this.fail('unavailable'));
    this.emit();
  }
  clearError() {
    this.state.error = '';
    this.emit();
  }
  private requestEnd() {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    // Let the relay process and acknowledge `end` before closing the transport.
    // Closing immediately can discard queued messages in the server runtime.
    ws.send(JSON.stringify({ type: 'end' }));
    this.ws = undefined;
    ws.onmessage = null;
    ws.onerror = null;
    const cleanup = setTimeout(() => ws.close(1000, 'ended'), 5000);
    ws.onclose = () => clearTimeout(cleanup);
  }
  private fail(reason: string, notify = true) {
    if (notify) this.requestEnd();
    // Explicit remote end clears everything. Other failures preserve only unsent
    // outgoing text so the user can copy it before starting over.
    const unsent =
      reason === 'ended'
        ? []
        : this.state.history.filter(
            (entry) =>
              entry.kind === 'text' && entry.direction === 'out' && entry.status !== 'delivered',
          );
    for (const entry of this.state.history) if (entry.url) URL.revokeObjectURL(entry.url);
    this.stop();
    this.state = {
      ...initialState(),
      phase: 'ended',
      error: reason,
      history: unsent.map((entry) => ({ ...entry, status: 'cancelled' })),
    };
    this.emit();
  }
  end() {
    this.requestEnd();
    this.reset();
    this.emit();
  }
  private stop() {
    this.active = false;
    this.generation++;
    clearInterval(this.timer);
    clearTimeout(this.retry);
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    this.ws?.close();
    this.ws = undefined;
    this.pairing = undefined;
    this.channel = undefined;
    this.qrSecret = undefined;
    this.pending.clear();
    this.incoming = undefined;
    this.outgoing = undefined;
    this.receiveChain = Promise.resolve();
    this.sendChain = Promise.resolve();
    this.pumping = false;
  }
  private reset() {
    this.stop();
    for (const entry of this.state.history) if (entry.url) URL.revokeObjectURL(entry.url);
    this.state = initialState();
    this.received.clear();
    this.lastPing = 0;
    this.retries = 0;
  }
  destroy() {
    this.reset();
  }
}
