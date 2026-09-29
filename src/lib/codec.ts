import { CHUNK_BYTES, isId, validControl, type Control } from '../../shared/protocol';
import { text, utf8 } from './crypto';
// An encrypted envelope contains either JSON control data or raw file bytes.
export function encodeControl(control: Control): Uint8Array {
  const data = utf8(JSON.stringify(control));
  const result = new Uint8Array(data.length + 1);
  result[0] = 0;
  result.set(data, 1);
  return result;
}
export function encodeChunk(id: string, index: number, bytes: Uint8Array): Uint8Array {
  if (!isId(id) || bytes.length > CHUNK_BYTES || index < 0 || !Number.isInteger(index))
    throw new Error('invalid-chunk');
  const result = new Uint8Array(41 + bytes.length);
  result[0] = 1;
  result.set(utf8(id), 1);
  new DataView(result.buffer).setUint32(37, index);
  result.set(bytes, 41);
  return result;
}
export function decodeEnvelope(
  bytes: Uint8Array,
): { control: Control } | { id: string; index: number; bytes: Uint8Array } {
  if (bytes[0] === 0) {
    const value: unknown = JSON.parse(text(bytes.subarray(1)));
    if (!validControl(value)) throw new Error('invalid-control');
    return { control: value };
  }
  if (bytes[0] !== 1 || bytes.length < 41 || bytes.length > 41 + CHUNK_BYTES)
    throw new Error('invalid-chunk');
  const id = text(bytes.subarray(1, 37));
  if (!isId(id)) throw new Error('invalid-chunk');
  return {
    id,
    index: new DataView(bytes.buffer, bytes.byteOffset).getUint32(37),
    bytes: bytes.slice(41),
  };
}
