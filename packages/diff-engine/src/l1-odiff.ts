import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare } from "odiff-bin";

import type { L1Result } from "./l1.js";
import type { EngineConfig } from "./types.js";

/** odiff backend. Native support for ignoreRegions and antialiasing flag. */
export async function runL1Odiff(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const dir = mkdtempSync(join(tmpdir(), "furan-diff-"));
  const blPath = join(dir, "baseline.png");
  const cdPath = join(dir, "candidate.png");
  const dfPath = join(dir, "diff.png");
  try {
    writeFileSync(blPath, baseline);
    writeFileSync(cdPath, candidate);
    const result = await compare(blPath, cdPath, dfPath, {
      antialiasing: engineConfig.ignoreAntialiasing,
      ignoreRegions:
        ignoreAreas?.map((r) => ({
          x1: r.x,
          y1: r.y,
          x2: r.x + r.width,
          y2: r.y + r.height,
        })) ?? [],
    });
    if (result.match) {
      return {
        diffPercent: 0,
        pixelMismatchCount: 0,
        diffImageBytes: Buffer.alloc(0),
        regions: [],
      };
    }
    if (result.reason !== "pixel-diff") {
      return {
        diffPercent: 100,
        pixelMismatchCount: 0,
        diffImageBytes: Buffer.alloc(0),
        regions: [],
      };
    }
    const diffBytes = readFileSync(dfPath);
    return {
      diffPercent: result.diffPercentage,
      pixelMismatchCount: result.diffCount,
      diffImageBytes: diffBytes,
      regions: [],
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
