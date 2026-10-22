import type { NextConfig } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `NEXT_DIST_DIR` is read when `next.config.mjs` is evaluated, so each case
 * loads the module afresh under the environment it is testing.
 */
async function loadConfig(): Promise<NextConfig> {
  vi.resetModules();
  // @ts-expect-error -- next.config.mjs is plain JS with no declaration file.
  const mod = (await import("../next.config.mjs")) as { default: NextConfig };
  return mod.default;
}

describe("next.config distDir", () => {
  const saved = process.env.NEXT_DIST_DIR;

  beforeEach(() => {
    delete process.env.NEXT_DIST_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_DIST_DIR;
    else process.env.NEXT_DIST_DIR = saved;
    vi.resetModules();
  });

  it("is .next-scale when NEXT_DIST_DIR=.next-scale", async () => {
    process.env.NEXT_DIST_DIR = ".next-scale";
    expect((await loadConfig()).distDir).toBe(".next-scale");
  });

  it("is .next when NEXT_DIST_DIR is unset", async () => {
    expect((await loadConfig()).distDir).toBe(".next");
  });

  it("is .next when NEXT_DIST_DIR is empty", async () => {
    process.env.NEXT_DIST_DIR = "";
    expect((await loadConfig()).distDir).toBe(".next");
  });
});
