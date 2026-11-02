import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FuranConfig } from "@furan/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where this machine remembers the build of a pipeline. Playwright restarts a
 * worker after every failed test, so without it each restart would call the
 * (rate-limited) build route again; with it, only the first worker does. Null
 * without a `ciBuildId` (each worker then has its own build anyway).
 */
export function buildCachePath(
  config: Pick<FuranConfig, "apiUrl" | "projectId" | "ciBuildId">,
  dir: string = tmpdir(),
): string | null {
  if (config.ciBuildId === null) return null;
  const key = createHash("sha256")
    .update(`${config.apiUrl}\n${config.projectId}\n${config.ciBuildId}`)
    .digest("hex")
    .slice(0, 24);
  return join(dir, `furan-build-${key}.json`);
}

/** The remembered build id, or null when there is none or it is unusable. */
export function readCachedBuildId(path: string): string | null {
  try {
    const { buildId } = JSON.parse(readFileSync(path, "utf8")) as {
      buildId?: unknown;
    };
    return typeof buildId === "string" && UUID.test(buildId) ? buildId : null;
  } catch {
    return null;
  }
}

/** Remember the build id (written whole, then renamed into place). */
export function writeCachedBuildId(path: string, buildId: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ buildId }));
    renameSync(tmp, path);
  } catch {
    // Best effort: without the cache a restarted worker asks the api again.
  }
}
