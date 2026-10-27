import { DiffEngineError } from "./errors.js";
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
 *
 * Whatever the backend throws leaves as a `DiffEngineError` (stage `engine`)
 * with the original as its cause: the backends throw plain `Error`s, so this
 * is where a caller learns the failure came from the pixel engine.
 */
export async function runL1(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    Array<{ x: number; y: number; width: number; height: number }> | undefined,
  engine: ImageComparison,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  try {
    switch (engine) {
      case "odiff":
        return await runL1Odiff(baseline, candidate, ignoreAreas, engineConfig);
      case "pixelmatch":
        return await runL1Pixelmatch(
          baseline,
          candidate,
          ignoreAreas,
          engineConfig,
        );
      case "looks_same":
        return await runL1LooksSame(
          baseline,
          candidate,
          ignoreAreas,
          engineConfig,
        );
      case "vlm":
        return await runL1Pixelmatch(
          baseline,
          candidate,
          ignoreAreas,
          engineConfig,
        );
      default: {
        const _exhaustive: never = engine;
        throw new Error(
          `Unknown image comparison engine: ${String(_exhaustive)}`,
        );
      }
    }
  } catch (err) {
    throw new DiffEngineError("engine", err);
  }
}
