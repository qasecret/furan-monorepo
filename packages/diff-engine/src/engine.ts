import { classifyRegions } from "./classify.js";
import { runL1 } from "./l1.js";
import { runL2 } from "./l2.js";
import type { DiffResult, ProjectDiffConfig, DiffRegion } from "./types.js";

export interface RunDiffInput {
  baseline: { image: Buffer; dom?: string };
  candidate: { image: Buffer; dom?: string };
  config: ProjectDiffConfig;
}

export async function runDiff(input: RunDiffInput): Promise<DiffResult> {
  const t0 = performance.now();
  const l1 = await runL1(
    input.baseline.image,
    input.candidate.image,
    input.config.ignoreAreas,
    input.config.engine,
    input.config.engineConfig,
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
    // The pass/fail decision compares L1 diffPercent against the threshold
    // (units: percent vs fraction, hence the *100). diffThreshold is set on
    // the project (`projects.diffThreshold`, default 0.001 = 0.1%) and can
    // be overridden per-run via `runs.setDiffThresholdOverride` — the
    // diff-worker collapses both into `config.diffThreshold` before calling
    // here (apps/diff-worker/src/handler.ts ~L555).
    //
    // The sensitivity slider in the dashboard (SensitivityControl.tsx)
    // exposes presets at 0.1% / 0.5% / 1% / 5% — users expect "set to 1%,
    // any diff under 1% should pass". Earlier this returned
    // `pixelMismatchCount === 0` which silently ignored the threshold for
    // pass/fail (it was only used to gate L2). That was a behavior gap
    // discovered in the v1.0.9 QA pass; auto-approve still handles the
    // strict byte-identical case via `projects.autoApproveFeature`
    // short-circuiting before this engine runs.
    passed: l1.diffPercent <= input.config.diffThreshold * 100,
    diffPercent: l1.diffPercent,
    pixelMismatchCount: l1.pixelMismatchCount,
    diffImageBytes: l1.diffImageBytes,
    regions: allRegions,
    ranTiers: shouldRunL2 ? ["l1", "l2"] : ["l1"],
    durationMs: { l1: t1 - t0, l2: l2Duration },
  };
}
