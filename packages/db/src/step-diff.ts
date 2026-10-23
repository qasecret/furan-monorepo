import { and, eq, inArray, sql } from "drizzle-orm";

import type { DB } from "./client.js";
import { recomputeRunStatus, type Tx } from "./review-status.js";
import { recomputeRunTotals } from "./run-totals.js";
import type { RunStatus } from "./schema/enums.js";
import {
  diffRegions,
  screenshots,
  stepAwaitingDiff,
  testRuns,
} from "./schema/index.js";

/**
 * Why a step's diff failed permanently, as stored in `screenshots.diff_error`
 * (spec 2026-10-23 §6). A fixed set of reason codes: never a message or a
 * stack trace, which the worker logs instead.
 *
 * - `image_unreadable`: the PNG can't be decoded.
 * - `object_missing`: a storage object is not found.
 * - `engine_error`: the pixel engine failed.
 * - `vlm_error`: the vision-model provider failed after its own fallbacks.
 * - `timeout`: a statement or step timeout, or the reconciler gave up.
 * - `internal`: anything else.
 */
export const DIFF_ERROR_CODES = [
  "image_unreadable",
  "object_missing",
  "engine_error",
  "vlm_error",
  "timeout",
  "internal",
] as const;
export type DiffErrorCode = (typeof DIFF_ERROR_CODES)[number];

/**
 * Queues steps of one run for a diff: gives each a new version.
 *
 * One UPDATE bumps `diff_generation`, stamps `diff_queued_at` (the
 * reconciler's stuck clock) and resets `diff_requeues`. It returns the new
 * version of every step it bumped, for the job ids the caller adds after the
 * transaction commits. A version is never reused, so a job queued for an
 * earlier one is stale the moment this commits. Ids that are not steps of
 * `runId` are ignored.
 *
 * Locks: the run row first (`FOR NO KEY UPDATE`, a no-op when the caller
 * already holds it), then the bumped step rows through the UPDATE. That is the
 * pipeline's order, run -> step -> the step's variation, which a diff commit
 * and `markStepDiffFailed` also follow. So call it BEFORE locking or writing
 * any of the run's variations (a caller that wrote a variation first would
 * hold variation -> wait run -> step while a diff commit holds run -> step ->
 * wait that variation: a deadlock), and from a transaction that holds no step
 * of the run (a later `recomputeRunStatus` then finds the run already locked,
 * instead of locking step -> run). An empty `stepIds` locks nothing.
 *
 * `tx` is the caller's transaction: a Drizzle transaction, or the scoped
 * handle `withProjectScope` passes (typed `DB`).
 */
export async function bumpStepGenerations(
  tx: DB | Tx,
  runId: string,
  stepIds: readonly string[],
): Promise<Array<{ id: string; generation: number }>> {
  if (stepIds.length === 0) return [];

  const [run] = await tx
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .for("no key update");
  if (!run) return [];

  return tx
    .update(screenshots)
    .set({
      diffGeneration: sql`${screenshots.diffGeneration} + 1`,
      diffQueuedAt: sql`now()`,
      diffRequeues: 0,
    })
    .where(
      and(eq(screenshots.runId, runId), inArray(screenshots.id, [...stepIds])),
    )
    .returning({ id: screenshots.id, generation: screenshots.diffGeneration });
}

/**
 * Fails ONE step whose diff cannot succeed (a job's final attempt, or the
 * reconciler giving up), and nothing else: the run is never aborted for it.
 *
 * Lock order, taken here: the run row (`FOR NO KEY UPDATE`), then the step
 * (`FOR UPDATE`). The caller must hold no lock of its own on either (nor on
 * the step's variation).
 *
 * If the step's version is no longer `generation`, a newer job owns the step
 * and nothing is written (`applied: false`); so too when the run or the step
 * is gone. With `options.onlyIfAwaitingDiff` (default false) it also requires
 * the step, as it stands once locked, to still await a diff
 * (`stepAwaitingDiff`: not failed, and no result newer than its queue time),
 * so a caller that decided from an earlier scan (the reconciler giving up on a
 * step) can never overwrite a result that committed in between, nor fail a
 * step twice. Otherwise, in the caller's transaction:
 *  - the step gets `verdict = 'unresolved'` (the existing "needs attention"
 *    verdict, so the rollup, the pending filters and the review queue treat it
 *    as such), `verdict_at`, `diff_failed_at` and the reason `diff_error`;
 *  - its regions and its result columns (`diff_percent`,
 *    `pixel_mismatch_count`, `baseline_source`, `vlm_description`,
 *    `diff_signature`, `diff_image_key`, `rule_resolved`) are cleared: they no
 *    longer describe its image, so the step adds nothing to the run totals;
 *  - the run totals and then the run status are recomputed, and the status
 *    change is returned for the caller's events.
 *
 * `tx` is the caller's transaction: a Drizzle transaction, or the scoped
 * handle `withProjectScope` passes (typed `DB`).
 */
export async function markStepDiffFailed(
  tx: DB | Tx,
  args: {
    runId: string;
    stepId: string;
    generation: number;
    code: DiffErrorCode;
  },
  options: { onlyIfAwaitingDiff?: boolean } = {},
): Promise<{
  applied: boolean;
  rollup?: { before: RunStatus; after: RunStatus };
}> {
  const { runId, stepId, generation, code } = args;

  const [run] = await tx
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .for("no key update");
  if (!run) return { applied: false };

  // Both read from the row as locked: a writer that committed while this
  // waited for the lock is what they judge.
  const [step] = await tx
    .select({
      generation: screenshots.diffGeneration,
      awaiting: sql<boolean>`${stepAwaitingDiff(screenshots)} IS TRUE`,
    })
    .from(screenshots)
    .where(and(eq(screenshots.id, stepId), eq(screenshots.runId, runId)))
    .for("update");
  if (!step || step.generation !== generation) return { applied: false };
  if (options.onlyIfAwaitingDiff && !step.awaiting) return { applied: false };

  await tx
    .update(screenshots)
    .set({
      verdict: "unresolved",
      verdictAt: sql`clock_timestamp()`,
      diffFailedAt: sql`now()`,
      diffError: code,
      // Like its regions, the step's earlier result no longer describes its
      // image: clear it, so the failed step adds nothing to the run totals.
      diffPercent: null,
      pixelMismatchCount: null,
      baselineSource: null,
      vlmDescription: null,
      diffSignature: null,
      diffImageKey: null,
      ruleResolved: false,
    })
    .where(eq(screenshots.id, stepId));
  await tx.delete(diffRegions).where(eq(diffRegions.screenshotId, stepId));

  await recomputeRunTotals(tx, runId);
  const { before, after } = await recomputeRunStatus(tx, runId);
  return { applied: true, rollup: { before, after } };
}
