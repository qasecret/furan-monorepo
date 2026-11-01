import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCachePath,
  readCachedBuildId,
  writeCachedBuildId,
} from "../src/build-cache.js";

const BUILD = "0e6b8f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const config = {
  apiUrl: "http://h/api",
  projectId: "3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
  ciBuildId: "github-42-1",
};

describe("build cache", () => {
  it("has no path without a ciBuildId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "furan-cache-"));
    expect(buildCachePath({ ...config, ciBuildId: null }, dir)).toBeNull();
  });

  it("keys the path by api, project and ciBuildId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "furan-cache-"));
    const a = buildCachePath(config, dir);
    expect(a).toBe(buildCachePath({ ...config }, dir));
    expect(a).not.toBe(
      buildCachePath({ ...config, ciBuildId: "github-42-2" }, dir),
    );
    expect(a).not.toBe(buildCachePath({ ...config, projectId: "other" }, dir));
    expect(a).not.toBe(
      buildCachePath({ ...config, apiUrl: "http://x/api" }, dir),
    );
  });

  it("round-trips a build id, so a restarted worker skips the build route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "furan-cache-"));
    const path = buildCachePath(config, dir)!;
    expect(readCachedBuildId(path)).toBeNull();
    writeCachedBuildId(path, BUILD);
    expect(readCachedBuildId(path)).toBe(BUILD);
  });

  it("ignores a corrupt or foreign cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "furan-cache-"));
    const path = buildCachePath(config, dir)!;
    await writeFile(path, "{not json");
    expect(readCachedBuildId(path)).toBeNull();
    await writeFile(path, JSON.stringify({ buildId: "not-a-uuid" }));
    expect(readCachedBuildId(path)).toBeNull();
  });
});
