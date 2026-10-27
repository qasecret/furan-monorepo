import {
  and,
  baselines,
  checkpointDecisions,
  eq,
  gt,
  isNull,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";

/**
 * Why an auto-approved checkpoint keeps the baselines as they are:
 * - `active_decision`: a reviewer decided the checkpoint (an active
 *   `checkpoint_decisions` row); the machine never overrules that.
 * - `own_baseline`: the paired baseline IS the checkpoint's own (variation,
 *   run) row, e.g. a reviewer's approval; rewriting it would clear the approver
 *   and re-stamp its time.
 * - `newer_baseline`: the variation has a baseline on the run's branch created
 *   after the candidate run; writing the candidate's row would make an older
 *   image the current baseline again.
 */
export type AutoApproveBaselineBlock =
  "active_decision" | "own_baseline" | "newer_baseline";

/**
 * Decides whether the diff-worker's auto-approve (hash match, past-baseline
 * match or first-capture auto-seed, ADR-032/036) may write the checkpoint's
 * baseline. A blocked checkpoint still gets the verdict the auto-approve gave
 * it (`passed`, or `new` for a first capture); only the baseline write is
 * skipped.
 *
 * Runs inside a step's commit (`commitStep`), which already holds the run's
 * row and the step's (its run and step locks), and first locks the variation
 * `FOR NO KEY UPDATE`: runs before variations, as every reviewer path locks
 * them, so a concurrent approve of this run or of another run's capture of
 * this variation is either visible here or waits for this write.
 */
export async function autoApproveBaselineBlock(
  tx: DB,
  c: {
    screenshotId: string;
    testVariationId: string;
    runId: string;
    branchName: string;
    /** The run the checkpoint's paired baseline belongs to; null when unpaired. */
    pairedBaselineRunId: string | null;
  },
): Promise<AutoApproveBaselineBlock | null> {
  await tx
    .select({ id: testVariations.id })
    .from(testVariations)
    .where(eq(testVariations.id, c.testVariationId))
    .for("no key update");

  const [decided] = await tx
    .select({ id: checkpointDecisions.id })
    .from(checkpointDecisions)
    .where(
      and(
        eq(checkpointDecisions.screenshotId, c.screenshotId),
        isNull(checkpointDecisions.revertedAt),
      ),
    )
    .limit(1);
  if (decided) return "active_decision";

  if (c.pairedBaselineRunId === c.runId) return "own_baseline";

  // Compared in SQL against the run's own created_at, at full µs precision.
  const runCreatedAt = sql`(SELECT ${testRuns.createdAt} FROM ${testRuns} WHERE ${testRuns.id} = ${c.runId})`;
  const [newer] = await tx
    .select({ id: baselines.id })
    .from(baselines)
    .where(
      and(
        eq(baselines.testVariationId, c.testVariationId),
        eq(baselines.branchName, c.branchName),
        gt(baselines.createdAt, runCreatedAt),
      ),
    )
    .limit(1);
  if (newer) return "newer_baseline";

  return null;
}
