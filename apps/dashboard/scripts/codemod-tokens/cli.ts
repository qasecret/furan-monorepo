/**
 * Token codemod CLI.
 *
 *   pnpm --filter @furan/dashboard exec tsx scripts/codemod-tokens/cli.ts <dir|file…> [--dry-run]
 *
 * Rewrites light/`dark:` colour-class pairs into semantic token classes (see
 * `map.ts`). With `--dry-run` it prints a unified diff instead of writing.
 * Always prints the residue (`path:line cls (reason)`) and a count line, and
 * exits 0: the residue is the manual-pass worklist, not a failure.
 */
import { spawnSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSource } from "./transform";

const USAGE =
  "usage: tsx scripts/codemod-tokens/cli.ts <dir|file…> [--dry-run]";
const EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx"]);
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".next"]);

export interface Summary {
  files: number;
  changed: number;
  residue: number;
}

class UsageError extends Error {}

function collectFiles(path: string, out: string[]): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      collectFiles(join(path, entry), out);
    }
  } else if (EXTENSIONS.has(extname(path)) && !path.endsWith(".d.ts")) {
    out.push(path);
  }
}

/** `diff -u` of the file on disk against `after` (fed on stdin). */
function unifiedDiff(path: string, after: string): string {
  const r = spawnSync(
    "diff",
    ["-u", "--label", `a/${path}`, "--label", `b/${path}`, path, "-"],
    { input: after, encoding: "utf8" },
  );
  if (r.status === 0) return "";
  if (r.status === 1) return r.stdout.trimEnd();
  return `codemod-tokens: could not diff ${path}: ${r.error?.message ?? r.stderr}`;
}

/** Run the codemod. `log` receives every output line (diff hunks, residue, count). */
export function runCodemod(
  argv: readonly string[],
  log: (line: string) => void = (line) => console.log(line),
): Summary {
  const dryRun = argv.includes("--dry-run");
  const targets = argv.filter((a) => a !== "--dry-run");
  const unknown = targets.find((a) => a.startsWith("--"));
  if (unknown !== undefined) throw new UsageError(`unknown flag ${unknown}`);
  if (targets.length === 0) throw new UsageError("no paths given");

  const files: string[] = [];
  for (const t of targets) collectFiles(t, files);

  let changed = 0;
  const residueLines: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const { out, residue } = transformSource(src, file);
    if (out !== src) {
      changed++;
      if (dryRun) log(unifiedDiff(file, out));
      else writeFileSync(file, out);
    }
    for (const r of residue) {
      residueLines.push(`${file}:${r.line} ${r.cls} (${r.reason})`);
    }
  }

  for (const line of residueLines) log(line);
  log(
    `codemod-tokens: ${files.length} file(s) scanned, ${changed} file(s) ${
      dryRun ? "would change" : "changed"
    }, ${residueLines.length} residue item(s)`,
  );
  return { files: files.length, changed, residue: residueLines.length };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    runCodemod(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`codemod-tokens: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
  }
}
