import type { EvaluationResult } from "@furan/rules-engine";

/**
 * Stable per-(checkpoint, region-index) id shared by rule evaluation, status
 * aggregation, and application persistence in the diff handler. Kept in one
 * place so the encoding can never drift between those call sites.
 *
 * Discriminated by the checkpoint's index in `perViewport`, NOT its viewport
 * string: a single run can contain multiple checkpoints at the SAME viewport
 * (e.g. HomePage + searchResult both at 1280x720), so a viewport-keyed id would
 * collide across them and cross-wire decisions/applications.
 */
export const regionEngineId = (checkpointIndex: number, i: number) =>
  `${checkpointIndex}:${i}`;

export interface ViewportStatusInput {
  passed: boolean;
  /** Number of diff regions emitted for this checkpoint. */
  regionCount: number;
}

/**
 * Decide a run's terminal status given per-viewport pixel results and the
 * (optional) auto-rule evaluation. Pure so the handler's riskiest branching is
 * unit-testable without a database.
 *
 * Rules:
 * - A passed viewport never fails the run.
 * - With no rules, any failed viewport fails the run (legacy semantics).
 * - A failed viewport with ZERO regions cannot be rule-resolved and stays
 *   failed (otherwise an empty `some()` would silently mark it passed).
 * - A failed viewport is resolved only if EVERY region was `auto_approve`d.
 * - `resolutionSource` is `"rule"` only when the run actually passed AND a rule
 *   auto-approved ≥1 region — a flag-only match leaves the run unresolved and
 *   must not be attributed to a rule.
 */
export function aggregateRuleStatus(
  viewports: ViewportStatusInput[],
  rulesResult: Pick<EvaluationResult, "decisions" | "counts"> | null,
): { aggregateFailed: boolean; resolutionSource: "rule" | null } {
  const decisionByRegionId = rulesResult
    ? new Map(rulesResult.decisions.map((d) => [d.regionId, d]))
    : null;

  const aggregateFailed = viewports.some((vp, checkpointIndex) => {
    if (vp.passed) return false;
    if (!decisionByRegionId) return true;
    if (vp.regionCount === 0) return true;
    for (let i = 0; i < vp.regionCount; i++) {
      const decision = decisionByRegionId.get(
        regionEngineId(checkpointIndex, i),
      );
      if (!decision || decision.finalAction !== "auto_approve") return true;
    }
    return false;
  });

  const resolutionSource: "rule" | null =
    !aggregateFailed && rulesResult && rulesResult.counts.auto_approve > 0
      ? "rule"
      : null;

  return { aggregateFailed, resolutionSource };
}
