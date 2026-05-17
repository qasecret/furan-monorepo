import { classifyRegions } from "./classify.js";
import { runL1 } from "./l1.js";
import { runL2 } from "./l2.js";
import {
  DEFAULT_ENGINE_CONFIG,
  type DiffResult,
  type ProjectDiffConfig,
  type DiffRegion,
} from "./types.js";

export interface RunDiffInput {
  baseline: { image: Buffer; dom?: string };
  candidate: { image: Buffer; dom?: string };
  config: ProjectDiffConfig;
}

export async function runDiff(input: RunDiffInput): Promise<DiffResult> {
  const engine = input.config.engine ?? "odiff";
  const engineConfig = input.config.engineConfig ?? DEFAULT_ENGINE_CONFIG;
  const t0 = performance.now();
  const l1 = await runL1(
    input.baseline.image,
    input.candidate.image,
    input.config.ignoreAreas,
    engine,
    engineConfig,
  );
  const t1 = performance.now();

  const shouldRunL2 =
    input.config.l2Enabled &&
    l1.diffPercent >= input.config.diffThreshold * 100 &&
    input.baseline.dom !== undefined &&
    input.candidate.dom !== undefined;

  let l2Regions: DiffRegion[] = [];
  let l2Duration: number | null = null;
  if (shouldRunL2) {
    const t2 = performance.now();
    l2Regions = await runL2(input.baseline.dom!, input.candidate.dom!);
    l2Duration = performance.now() - t2;
  }

  const allRegions = classifyRegions([...l1.regions, ...l2Regions]);

  return {
    passed: l1.pixelMismatchCount === 0,
    diffPercent: l1.diffPercent,
    pixelMismatchCount: l1.pixelMismatchCount,
    diffImageBytes: l1.diffImageBytes,
    regions: allRegions,
    ranTiers: shouldRunL2 ? ["l1", "l2"] : ["l1"],
    durationMs: { l1: t1 - t0, l2: l2Duration },
  };
}
