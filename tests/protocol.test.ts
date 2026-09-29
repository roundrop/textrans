import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_TEXT_BYTES, CHUNK_BYTES, validControl } from '../shared/protocol';
import { decodeEnvelope, encodeChunk, encodeControl } from '../src/lib/codec';
import { utf8 } from '../src/lib/crypto';
const id = '00000000-0000-4000-a000-000000000000';
describe('transfer boundaries', () => {
  it('accepts exactly 10 MB, rejects larger and malformed file offers', () => {
    const offer = { type: 'offer', id, name: 'file.bin', mime: '', size: MAX_FILE_BYTES };
    expect(validControl(offer)).toBe(true);
    expect(validControl({ ...offer, size: 0 })).toBe(true);
    for (const size of [MAX_FILE_BYTES + 1, -1, 0.5, NaN, Infinity, '100'])
      expect(validControl({ ...offer, size })).toBe(false);
    expect(validControl({ ...offer, name: 'x'.repeat(256) })).toBe(false);
  });
  it('counts UTF-8 bytes rather than JS characters', () => {
    expect(validControl({ type: 'text', id, text: 'a'.repeat(MAX_TEXT_BYTES) })).toBe(true);
    expect(
      validControl({ type: 'text', id, text: 'あ'.repeat(Math.ceil(MAX_TEXT_BYTES / 3)) }),
    ).toBe(false);
  });
  it('round trips raw binary, including zero bytes', () => {
    const data = Uint8Array.from({ length: CHUNK_BYTES }, (_, i) => i % 256);
    expect(decodeEnvelope(encodeChunk(id, 17, data))).toEqual({ id, index: 17, bytes: data });
  });
  it('rejects malformed control messages and oversized chunks', () => {
    expect(() => decodeEnvelope(utf8('untrusted'))).toThrow();
    expect(() => encodeChunk(id, 0, new Uint8Array(CHUNK_BYTES + 1))).toThrow();
    const encoded = encodeControl({ type: 'text', id, text: 'hello' });
    expect(decodeEnvelope(encoded)).toEqual({ control: { type: 'text', id, text: 'hello' } });
    expect(validControl({ type: 'accept', id, next: 100_000 })).toBe(false);
    expect(validControl({ type: 'text', id: '<script>', text: 'hello' })).toBe(false);
  });
});
