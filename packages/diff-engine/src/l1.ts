import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare } from "odiff-bin";

import type { DiffRegion } from "./types.js";

export interface L1Result {
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
}

export async function runL1(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
): Promise<L1Result> {
  const dir = mkdtempSync(join(tmpdir(), "furan-diff-"));
  const blPath = join(dir, "baseline.png");
  const cdPath = join(dir, "candidate.png");
  const dfPath = join(dir, "diff.png");
  try {
    writeFileSync(blPath, baseline);
    writeFileSync(cdPath, candidate);
    const result = await compare(blPath, cdPath, dfPath, {
      antialiasing: true,
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
