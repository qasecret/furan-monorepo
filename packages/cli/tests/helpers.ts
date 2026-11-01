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
