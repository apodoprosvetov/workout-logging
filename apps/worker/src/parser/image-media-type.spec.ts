import { describe, expect, it } from 'vitest';

import { detectImageMediaType } from './image-media-type.js';

// Pure magic-byte sniffing — no infra, runs in CI (unlike parser.spec.ts, which
// needs a real vision API key). Real minimal files, base64-decoded, not
// hand-typed byte arrays, so the signatures are exactly what an upload carries.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAECAf/EAB8AAAA=', 'base64'); // FF D8 FF E0 ...
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); // "GIF89a"
const WEBP = Buffer.from('UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64'); // "RIFF"..."WEBP"

describe('detectImageMediaType', () => {
  it('recognises each supported format from its leading bytes', () => {
    expect(detectImageMediaType(JPEG)).toBe('image/jpeg');
    expect(detectImageMediaType(PNG)).toBe('image/png');
    expect(detectImageMediaType(GIF)).toBe('image/gif');
    expect(detectImageMediaType(WEBP)).toBe('image/webp');
  });

  it('returns null for non-image / unrecognised bytes', () => {
    expect(detectImageMediaType(Buffer.from('not an image at all'))).toBeNull();
    expect(detectImageMediaType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(detectImageMediaType(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('returns null for a buffer too short to hold a signature', () => {
    expect(detectImageMediaType(Buffer.alloc(0))).toBeNull();
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8]))).toBeNull(); // JPEG needs 3 bytes
    expect(detectImageMediaType(PNG.subarray(0, 4))).toBeNull(); // PNG needs the full 8-byte signature
  });

  it('does not mistake a RIFF container that is not WEBP (e.g. WAV) for an image', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
    expect(detectImageMediaType(wav)).toBeNull();
  });
});
