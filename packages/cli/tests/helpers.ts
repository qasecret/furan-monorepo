import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A real, valid 1×1 PNG. */
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
    "base64",
  ),
);

/**
 * A temp folder holding `files` (relative path → contents; a `.png` with no
 * contents gets {@link TINY_PNG}). Returns the folder.
 */
export async function tree(
  files: Record<string, string | Uint8Array | null>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "furan-cli-"));
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents ?? TINY_PNG);
  }
  return root;
}

/**
 * The first 33 bytes of a PNG of the given size (signature + IHDR), enough
 * for the scan, which reads only a file's header.
 */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}
