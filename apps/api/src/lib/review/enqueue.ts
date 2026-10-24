import {
  and,
  asc,
  bumpStepGenerations,
  eq,
  screenshots,
  type DB,
  type Tx,
} from "@furan/db";
import type { Telemetry } from "@furan/telemetry";

import type { DiffQueueProducer } from "../../trpc/context.js";
import { addDiffJob, stepDiffJob, type DiffTrigger } from "../diff-enqueue.js";

/**
 * Queues steps of `run` for a re-diff (spec 2026-10-23 §7): gives each a new
 * version in the request transaction (`bumpStepGenerations`), then, after it
 * commits, adds one job per step at its version, under the job id
 * `diffJobId(step, version)`. The worker never sees a job before the rows it
 * re-reads (new ignore regions, a threshold override, a reverted verdict) and
 * the version itself are visible. A re-diff keeps each step's current result
 * until the new one replaces it. An empty `stepIds` does nothing.
 *
 * A legacy run (Ruling R6): when any step of the run has a verdict while still
 * at version 0 (diffed before the per-step pipeline), every version-0 step of
 * the run is queued with `stepIds`. The run totals fold the steps' own result
 * columns, which a legacy step does not have, so re-diffing one step alone
 * would misstate the run's diff % and image. The bump leaves no version-0
 * step behind, so this happens once per run.
 *
 * Locks: the run row, then the bumped steps (`bumpStepGenerations`). Call it
 * BEFORE locking or writing a variation of the run unless the transaction
 * already holds the run (the diff commit's order is run -> step ->
 * variation).
 *
 * After commit, every step's job is tried. The jobs the queue refused are
 * counted under `trigger` (`addDiffJob`) and the first refusal is rethrown, so
 * it surfaces exactly as a single failed enqueue did; a step left without a
 * job keeps its new version and the reconciler re-queues it.
 */
export async function queueStepDiffs(
  ctx: {
    db: DB | Tx;
    diffQueue: DiffQueueProducer;
    telemetry: Pick<Telemetry, "metrics">;
    onCommit: (fn: () => unknown) => void;
  },
  run: { id: string; projectId: string; parentBranchName: string | null },
  stepIds: readonly string[],
  trigger: DiffTrigger,
): Promise<void> {
  if (stepIds.length === 0) return;

  const unversioned = await ctx.db
    .select({ id: screenshots.id, verdict: screenshots.verdict })
    .from(screenshots)
    .where(
      and(
        eq(screenshots.projectId, run.projectId),
        eq(screenshots.runId, run.id),
        eq(screenshots.diffGeneration, 0),
      ),
    )
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  const ids = [
    ...new Set(
      unversioned.some((s) => s.verdict !== null)
        ? [...unversioned.map((s) => s.id), ...stepIds]
        : stepIds,
    ),
  ];

  const bumped = await bumpStepGenerations(ctx.db, run.id, ids);
  const generationOf = new Map(bumped.map((b) => [b.id, b.generation]));
  const jobs = ids.flatMap((id) => {
    const generation = generationOf.get(id);
    // Not a step of the run: nothing was bumped, nothing is queued.
    return generation === undefined ? [] : [stepDiffJob(run, id, generation)];
  });
  if (jobs.length === 0) return;

  const deps = { diffQueue: ctx.diffQueue, registry: ctx.telemetry.metrics };
  ctx.onCommit(async () => {
    const results = await Promise.allSettled(
      jobs.map((job) => addDiffJob(deps, trigger, job)),
    );
    const refused = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (refused) throw refused.reason;
  });
}

/**
 * Every step of `run`, in capture order (`created_at`, `id`): what a re-diff
 * that has to cover the whole run passes to {@link queueStepDiffs}.
 */
export async function runStepIds(
  db: DB | Tx,
  run: { id: string; projectId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(
      and(
        eq(screenshots.projectId, run.projectId),
        eq(screenshots.runId, run.id),
      ),
    )
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  return rows.map((r) => r.id);
}
