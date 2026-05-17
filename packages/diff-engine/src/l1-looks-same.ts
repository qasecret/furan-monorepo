import looksSame from "looks-same";
import { PNG } from "pngjs";

import type { L1Result } from "./l1.js";
import { applyIgnoreMask } from "./masking.js";
import type { EngineConfig } from "./types.js";

/**
 * looks-same backend. pixelMismatchCount is approximate (derived from
 * cluster bounding-box areas) — looks-same doesn't expose an exact count.
 */
export async function runL1LooksSame(
  baseline: Buffer,
  candidate: Buffer,
  ignoreAreas:
    | Array<{ x: number; y: number; width: number; height: number }>
    | undefined,
  engineConfig: EngineConfig,
): Promise<L1Result> {
  const baselineBytes = applyIgnoreMask(baseline, ignoreAreas ?? []);
  const candidateBytes = applyIgnoreMask(candidate, ignoreAreas ?? []);

  const bMeta = PNG.sync.read(baselineBytes);
  const cMeta = PNG.sync.read(candidateBytes);
  if (bMeta.width !== cMeta.width || bMeta.height !== cMeta.height) {
    return {
      diffPercent: 100,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const antialiasingTolerance = engineConfig.ignoreAntialiasing ? 4 : 0;

  const cmp = await looksSame(baselineBytes, candidateBytes, {
    strict: false,
    ignoreAntialiasing: engineConfig.ignoreAntialiasing,
    antialiasingTolerance,
    createDiffImage: false,
  });

  if (cmp.equal) {
    return {
      diffPercent: 0,
      pixelMismatchCount: 0,
      diffImageBytes: Buffer.alloc(0),
      regions: [],
    };
  }

  const diffImageBytes = await looksSame.createDiff({
    reference: baselineBytes,
    current: candidateBytes,
    highlightColor: "#ff0000",
    antialiasingTolerance,
    strict: false,
  });

  const totalPixels = bMeta.width * bMeta.height;
  const clusterPixels = (cmp.diffClusters ?? []).reduce((sum, cluster) => {
    const w = cluster.right - cluster.left + 1;
    const h = cluster.bottom - cluster.top + 1;
    return sum + w * h;
  }, 0);

  return {
    diffPercent: (clusterPixels / totalPixels) * 100,
    pixelMismatchCount: clusterPixels,
    diffImageBytes,
    regions: [],
  };
}
