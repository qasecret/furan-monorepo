import type { EvaluationResult } from "@furan/rules-engine";

/**
 * Stable id of a step's region `i`, shared by its rule evaluation, its verdict
 * (`checkpointFails`) and its application persistence
 * (`persistRuleApplications` zips these with the stored region ids). Kept in
 * one place so the encoding can never drift between those call sites.
 *
 * Each step is evaluated on its own, so there is no checkpoint index any more;
 * the `0:` prefix is the shape the ids always had (`0:0`, `0:1`, …).
 */
export const regionEngineId = (i: number) => `0:${i}`;

export interface ViewportStatusInput {
  passed: boolean;
  /** Number of diff regions emitted for this checkpoint. */
  regionCount: number;
}

/**
 * Whether one checkpoint (step) still fails after the auto rules evaluated its
 * regions (ids `regionEngineId(i)`). Pure, so the handler's riskiest branching
 * is unit-testable without a database.
 *
 * - A passed checkpoint never fails.
 * - With no rules, a failed checkpoint stays failed (legacy semantics).
 * - A failed checkpoint with ZERO regions cannot be rule-resolved and stays
 *   failed (otherwise an empty region loop would silently mark it passed).
 * - A failed checkpoint is resolved only if EVERY region was `auto_approve`d.
 */
export function checkpointFails(
  checkpoint: ViewportStatusInput,
  rulesResult: Pick<EvaluationResult, "decisions"> | null,
): boolean {
  if (checkpoint.passed) return false;
  if (!rulesResult) return true;
  if (checkpoint.regionCount === 0) return true;
  const decisionByRegionId = new Map(
    rulesResult.decisions.map((d) => [d.regionId, d]),
  );
  for (let i = 0; i < checkpoint.regionCount; i++) {
    const decision = decisionByRegionId.get(regionEngineId(i));
    if (!decision || decision.finalAction !== "auto_approve") return true;
  }
  return false;
}
