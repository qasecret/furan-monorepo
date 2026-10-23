import { and, eq, inArray, sql } from "drizzle-orm";

import { recomputeRunStatus, type Tx } from "./review-status.js";
import { recomputeRunTotals } from "./run-totals.js";
import type { RunStatus } from "./schema/enums.js";
import { diffRegions, screenshots, testRuns } from "./schema/index.js";

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
 */
export async function bumpStepGenerations(
  tx: Tx,
  runId: string,
  stepIds: readonly string[],
): Promise<Array<{ id: string; generation: number }>> {
  if (stepIds.length === 0) return [];
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
 * is gone. Otherwise, in the caller's transaction:
 *  - the step gets `verdict = 'unresolved'` (the existing "needs attention"
 *    verdict, so the rollup, the pending filters and the review queue treat it
 *    as such), `verdict_at`, `diff_failed_at` and the reason `diff_error`;
 *  - its regions are deleted: they no longer describe its image;
 *  - the run totals and then the run status are recomputed, and the status
 *    change is returned for the caller's events.
 *
 * The step's other result columns (`diff_percent`, `diff_image_key`, ...) are
 * left as they were: a failed re-diff keeps the result it had until a new one
 * replaces it.
 */
export async function markStepDiffFailed(
  tx: Tx,
  args: {
    runId: string;
    stepId: string;
    generation: number;
    code: DiffErrorCode;
  },
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

  const [step] = await tx
    .select({ generation: screenshots.diffGeneration })
    .from(screenshots)
    .where(and(eq(screenshots.id, stepId), eq(screenshots.runId, runId)))
    .for("update");
  if (!step || step.generation !== generation) return { applied: false };

  await tx
    .update(screenshots)
    .set({
      verdict: "unresolved",
      verdictAt: sql`clock_timestamp()`,
      diffFailedAt: sql`now()`,
      diffError: code,
    })
    .where(eq(screenshots.id, stepId));
  await tx.delete(diffRegions).where(eq(diffRegions.screenshotId, stepId));

  await recomputeRunTotals(tx, runId);
  const { before, after } = await recomputeRunStatus(tx, runId);
  return { applied: true, rollup: { before, after } };
}
