// The Anthropic image block only accepts these four media types, and uploads
// carry no reliable format hint (spec.md Clarifications Q4 — no upload-time
// validation, and a GridFS filename isn't trustworthy). Sniff the real type
// from the file's magic bytes; the vision API rejects a mismatched media_type.
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * Detect an image media type from its leading bytes, or null if the buffer
 * doesn't start with a recognised image signature.
 */
export function detectImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF: "GIF87a" or "GIF89a" — first 3 bytes 47 49 46 are enough to disambiguate here
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }

  // WebP: "RIFF" (52 49 46 46) at 0..3, then a 4-byte file size, then "WEBP" (57 45 42 50) at 8..11
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}
