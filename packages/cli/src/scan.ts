import { promises as fsp, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { FuranInputError, MAX_PNG_BYTES, pngSize } from "@furan/client";

import { readSidecar, type SidecarOptions } from "./sidecar.js";

export interface PlannedStep {
  name: string;
  file: string;
  sidecar: SidecarOptions | null;
  width: number;
  height: number;
}

export interface PlannedTest {
  name: string;
  steps: PlannedStep[];
}

const isPng = (name: string): boolean => /\.png$/i.test(name);
const stem = (path: string): string => path.replace(/\.png$/i, "");
const posix = (path: string): string => path.split(sep).join("/");
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, "en");

/** A found PNG: the folder its test is named from and its path inside it. */
interface Found {
  root: string;
  file: string;
}

/**
 * Map PNG files and folders to tests and steps (spec §5.2). Every PNG's header
 * and sidecar are checked here, before anything is uploaded; only each file's
 * first 33 bytes are read.
 *
 * A step's baseline is identified by its name and viewport (with the branch
 * and labels every step of one upload shares), not by its test, so two
 * screenshots with the same name and viewport anywhere in the upload are
 * refused: they would silently share one baseline. `viewport` is `--viewport`
 * (null: each PNG's size). The same file reached twice is uploaded once.
 */
export async function planUpload(
  paths: string[],
  opts: { test: string | null; viewport?: string | null },
): Promise<PlannedTest[]> {
  const found: Found[] = [];
  for (const path of paths) {
    const stat = await fsp.stat(path).catch(() => null);
    if (stat === null)
      throw new FuranInputError("no such file or folder", path);
    if (stat.isDirectory()) {
      for (const file of await walk(path)) found.push({ root: path, file });
    } else if (isPng(path)) {
      found.push({ root: dirname(path), file: path });
    } else {
      throw new FuranInputError("is not a .png file", path);
    }
  }
  if (found.length === 0) {
    throw new FuranInputError(`no .png files found in ${paths.join(", ")}`);
  }

  const tests = new Map<string, PlannedStep[]>();
  const identities = new Map<string, string>();
  const seenFiles = new Set<string>();
  for (const { root, file } of found) {
    const real = await fsp.realpath(file);
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);
    const rel = posix(relative(root, file));
    const folder = posix(dirname(rel));
    const testName =
      opts.test ?? (folder === "." ? basename(resolve(root)) : folder);
    const { width, height } = await header(file);
    const step: PlannedStep = {
      name: stem(rel),
      file,
      sidecar: await readSidecar(file),
      width,
      height,
    };
    const steps = tests.get(testName) ?? [];
    const clash = steps.find((s) => s.name === step.name);
    if (clash) {
      throw new FuranInputError(
        `two screenshots map to step "${step.name}" in test "${testName}": ${clash.file} and ${file}`,
      );
    }
    const identity = `${step.name}\u0000${opts.viewport ?? `${width}x${height}`}`;
    const twin = identities.get(identity);
    if (twin !== undefined) {
      throw new FuranInputError(
        `${twin} and ${file} both map to step "${step.name}" at the same viewport, so they would share one baseline; pass their parent folder instead, so each step keeps its folder in its name`,
      );
    }
    identities.set(identity, file);
    steps.push(step);
    tests.set(testName, steps);
  }

  return [...tests]
    .map(([name, steps]) => ({ name, steps: steps.sort(byName) }))
    .sort(byName);
}

/** Every PNG under `dir`, without following symlinked folders. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries: Dirent[] = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path)));
    } else if (isPng(entry.name)) {
      // A symlink to a file is taken; a symlink to a folder is not.
      const stat = entry.isSymbolicLink()
        ? await fsp.stat(path).catch(() => null)
        : null;
      if (!entry.isSymbolicLink() || stat?.isFile()) out.push(path);
    }
  }
  return out;
}

/** The PNG's size, from its first 33 bytes; throws for a bad or truncated PNG. */
async function header(
  file: string,
): Promise<{ width: number; height: number }> {
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_PNG_BYTES) {
      throw new FuranInputError("is larger than the 50 MB upload limit", file);
    }
    const bytes = new Uint8Array(33);
    const { bytesRead } = await handle.read(bytes, 0, 33, 0);
    return pngSize(bytes.subarray(0, bytesRead), file);
  } finally {
    await handle.close();
  }
}
