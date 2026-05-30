import { classifyRegions } from "./classify.js";
import {
  detectGlobalDisplacement,
  DISPLACEMENT_CONFIDENCE_THRESHOLD,
  shiftImage,
} from "./l1-displacement.js";
import { runL1 } from "./l1.js";
import { runL2 } from "./l2.js";
import type { DiffResult, ProjectDiffConfig, DiffRegion } from "./types.js";

/** Tier 1.4 follow-up: hard caps on detected shift before alignment
 *  is applied. Beyond these, the shift is more likely spurious than
 *  real (a 500px "shift" usually means the page was redesigned, not
 *  moved). */
const MAX_DX = 50;
const MAX_DY = 200;

export interface RunDiffInput {
  baseline: { image: Buffer; dom?: string };
  candidate: { image: Buffer; dom?: string };
  config: ProjectDiffConfig;
  /**
   * Tier 1.4 (Eyes-parity `ignoreDisplacements`): when true, the L2
   * pass drops `relocateGroup` regions for this checkpoint AND the
   * L1 pre-alignment pass detects + corrects a global pixel shift
   * before running the engine. Defaults to false.
   */
  ignoreDisplacements?: boolean;
  /**
   * Optional metrics adapter for the L1 displacement outcome. The
   * diff-worker constructs one that fans out to the
   * `furan_diff_l1_displacement_total` Prometheus counter; tests
   * pass a recording stub. Exactly one outcome is recorded per call
   * to runDiff.
   */
  l1DisplacementMetric?: {
    labels: (l: {
      outcome: "applied" | "low_confidence" | "shift_capped" | "skipped";
    }) => { inc: () => void };
  };
}

export async function runDiff(input: RunDiffInput): Promise<DiffResult> {
  const t0 = performance.now();

  // --- L1 pre-alignment (Tier 1.4 follow-up) ---
  let candidateImage = input.candidate.image;
  let displacementVector:
    | { dx: number; dy: number; confidence: number }
    | undefined;
  if (input.ignoreDisplacements) {
    const det = detectGlobalDisplacement(
      input.baseline.image,
      input.candidate.image,
    );
    if (det === null) {
      // Dimension mismatch or decode failure — treat as skipped.
      input.l1DisplacementMetric?.labels({ outcome: "skipped" }).inc();
    } else if (det.confidence < DISPLACEMENT_CONFIDENCE_THRESHOLD) {
      input.l1DisplacementMetric?.labels({ outcome: "low_confidence" }).inc();
    } else if (Math.abs(det.dx) > MAX_DX || Math.abs(det.dy) > MAX_DY) {
      input.l1DisplacementMetric?.labels({ outcome: "shift_capped" }).inc();
    } else {
      candidateImage = shiftImage(
        input.candidate.image,
        input.baseline.image,
        -det.dx,
        -det.dy,
      );
      displacementVector = det;
      input.l1DisplacementMetric?.labels({ outcome: "applied" }).inc();
    }
  } else {
    input.l1DisplacementMetric?.labels({ outcome: "skipped" }).inc();
  }

  const l1 = await runL1(
    input.baseline.image,
    candidateImage,
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
    l2Regions = await runL2(input.baseline.dom!, input.candidate.dom!, {
      ignoreDisplacements: input.ignoreDisplacements ?? false,
    });
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
    ...(displacementVector ? { displacementVector } : {}),
  };
}
