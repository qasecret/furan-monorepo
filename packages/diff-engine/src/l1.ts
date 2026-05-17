import { runL1LooksSame } from "./l1-looks-same.js";
import { runL1Odiff } from "./l1-odiff.js";
import { runL1Pixelmatch } from "./l1-pixelmatch.js";
import type { DiffRegion, EngineConfig, ImageComparison } from "./types.js";

export interface L1Result {
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageBytes: Buffer;
  regions: DiffRegion[];
}

/**
 * Dispatches to the configured L1 backend. Exhaustive switch — adding
 * a fourth engine (e.g. VLM) without a case here fails typecheck.
 */
export async function runL1(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engine: ImageComparison,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  switch (engine) {
    case "odiff":
      return runL1Odiff(baseline, candidate, ignoreAreas, engineConfig);
    case "pixelmatch":
      return runL1Pixelmatch(baseline, candidate, ignoreAreas, engineConfig);
    case "looks_same":
      return runL1LooksSame(baseline, candidate, ignoreAreas, engineConfig);
    default: {
      const _exhaustive: never = engine;
      throw new Error(
        `Unknown image comparison engine: ${String(_exhaustive)}`,
      );
    }
  }
}
