import { FuranInputError } from "./errors.js";
import { MAX_PNG_BYTES } from "./types.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/**
 * The width and height of a PNG, from its IHDR chunk, after checking it is a
 * PNG the api will take (signature, IHDR first, at most 50 MB). Reads only the
 * first 24 bytes, so a header slice of a large file is enough.
 */
export function pngSize(
  bytes: Uint8Array,
  file?: string,
): { width: number; height: number } {
  if (bytes.length > MAX_PNG_BYTES) {
    throw new FuranInputError("is larger than the 50 MB upload limit", file);
  }
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new FuranInputError("is not a PNG (or is truncated)", file);
  }
  if (IHDR.some((b, i) => bytes[12 + i] !== b)) {
    throw new FuranInputError(
      "is not a PNG: its first chunk is not IHDR",
      file,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) {
    throw new FuranInputError("is a PNG with no pixels", file);
  }
  return { width, height };
}
