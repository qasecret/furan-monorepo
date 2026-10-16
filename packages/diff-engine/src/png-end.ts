/** The 8-byte signature every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** The IEND chunk: length 0, type "IEND", then its CRC. A constant. */
const IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * `bytes` as a complete PNG.
 *
 * odiff writes its diff image without the closing IEND chunk (signature, IHDR
 * and IDAT, nothing more). Node's PNG readers tolerate that; browsers refuse
 * to decode it. A PNG whose last 12 bytes are not IEND gets the constant IEND
 * chunk appended. Anything else comes back untouched: a PNG that is already
 * complete, bytes that are not a PNG, an empty buffer.
 */
export function ensurePngEnd(bytes: Buffer): Buffer {
  if (bytes.length < PNG_SIGNATURE.length) return bytes;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return bytes;
  }
  if (bytes.subarray(-IEND_CHUNK.length).equals(IEND_CHUNK)) return bytes;
  return Buffer.concat([bytes, IEND_CHUNK]);
}
