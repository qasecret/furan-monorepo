import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import type { L1Result } from "./l1.js";
import { applyIgnoreMask } from "./masking.js";
import type { EngineConfig } from "./types.js";

/** pixelmatch backend. ignoreAreas applied by pre-masking the buffers. */
export async function runL1Pixelmatch(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const baselineBytes = applyIgnoreMask(baseline, ignoreAreas ?? []);
  const candidateBytes = applyIgnoreMask(candidate, ignoreAreas ?? []);
  const b = PNG.sync.read(baselineBytes);
  const c = PNG.sync.read(candidateBytes);

  if (b.width !== c.width || b.height !== c.height) {
    return {
      diffPercent: 100,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const diff = new PNG({ width: b.width, height: b.height });
  const mismatch = pixelmatch(b.data, c.data, diff.data, b.width, b.height, {
    threshold: engineConfig.threshold,
    includeAA: !engineConfig.ignoreAntialiasing,
  });

  if (mismatch === 0) {
    return {
      diffPercent: 0,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const totalPixels = b.width * b.height;
  return {
    diffPercent: (mismatch / totalPixels) * 100,
    pixelMismatchCount: mismatch,
    diffImageBytes: PNG.sync.write(diff),
    regions: [],
  };
}
