export const MAX_FILE_BYTES = 10_000_000;
export const MAX_TEXT_BYTES = 64 * 1024;
export const CHUNK_BYTES = 32 * 1024;
// JSON may expand a 64 KiB text into six escaped bytes per input byte.
export const MAX_FRAME_BYTES = 400 * 1024;
export const INVITE_TTL = 3 * 60_000;
export const IDLE_TTL = 15 * 60_000;
export const SESSION_TTL = 60 * 60_000;
export const MAX_HISTORY = 20;
export const MAX_HISTORY_BYTES = 30_000_000;
export type Role = 'host' | 'guest';
export type PairMode = 'qr' | 'code';
export interface Connection {
  roomId: string;
  token: string;
  code: string;
  role: Role;
  inviteExpiresAt: number;
  expiresAt: number;
  mode?: PairMode;
}
export type HandshakeMessage =
  | { type: 'commit'; value: string; mode: PairMode }
  | { type: 'reveal'; key: string; nonce: string; proof: string };
export type ServerMessage =
  | { type: 'state'; peer: boolean; paired: boolean; mode?: PairMode; expiresAt: number }
  | { type: 'handshake'; message: HandshakeMessage }
  | { type: 'peer-offline' }
  | { type: 'ended'; reason: string }
  | { type: 'error'; code: string };
export type Control =
  | { type: 'verified' }
  | { type: 'resume' }
  | { type: 'text'; id: string; text: string }
  | { type: 'receipt'; id: string }
  | { type: 'offer'; id: string; name: string; size: number; mime: string }
  | { type: 'accept'; id: string; next: number }
  | { type: 'chunk-ack'; id: string; next: number }
  | { type: 'finish'; id: string; hash: string }
  | { type: 'cancel'; id: string };
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function validControl(value: unknown): value is Control {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'verified' || value.type === 'resume') return true;
  if (!isId(value.id)) return false;
  switch (value.type) {
    case 'text':
      return (
        typeof value.text === 'string' &&
        value.text.length > 0 &&
        new TextEncoder().encode(value.text).length <= MAX_TEXT_BYTES
      );
    case 'receipt':
    case 'cancel':
      return true;
    case 'accept':
    case 'chunk-ack':
      return (
        Number.isInteger(value.next) &&
        Number(value.next) >= 0 &&
        Number(value.next) <= Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)
      );
    case 'finish':
      return typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
    case 'offer':
      return (
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        value.name.length <= 255 &&
        typeof value.mime === 'string' &&
        value.mime.length <= 128 &&
        Number.isInteger(value.size) &&
        Number(value.size) >= 0 &&
        Number(value.size) <= MAX_FILE_BYTES
      );
    default:
      return false;
  }
}
