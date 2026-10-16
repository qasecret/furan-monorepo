import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compare } from "odiff-bin";

import type { L1Result } from "./l1.js";
import { ensurePngEnd } from "./png-end.js";
import type { EngineConfig } from "./types.js";

/** odiff backend. Native support for ignoreRegions and antialiasing flag. */
export async function runL1Odiff(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    Array<{ x: number; y: number; width: number; height: number }> | undefined,
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
      // Without this odiff compares only the area both images share, so a page
      // that grew or shrank with a matching top would pass at 0%. With it a
      // size change returns `layout-diff`, which maps to 100% below, like the
      // other engines. A project that turned on "Allow diff dimensions" opted
      // out of that: it gets the shared-area comparison (R30).
      failOnLayoutDiff: !engineConfig.allowDiffDimensions,
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
    return {
      diffPercent: result.diffPercentage,
      pixelMismatchCount: result.diffCount,
      // odiff leaves off the closing IEND chunk, which browsers will not decode.
      diffImageBytes: ensurePngEnd(readFileSync(dfPath)),
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
