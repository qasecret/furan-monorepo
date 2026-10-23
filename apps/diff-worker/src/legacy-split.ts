import {
  asc,
  bumpStepGenerations,
  eq,
  screenshots,
  testRuns,
  withProjectScope,
  type DB,
} from "@furan/db";
import { diffJobId, type DiffJob } from "@furan/queue";

/**
 * Where the per-step jobs go: the queue the worker consumes (same name and
 * prefix). A BullMQ `Queue<DiffJob>` is one.
 */
export interface DiffJobQueue {
  addBulk(
    jobs: Array<{ name: "diff"; data: DiffJob; opts: { jobId: string } }>,
  ): Promise<unknown>;
}

/**
 * Splits an old whole-run diff job (no `screenshotId`, queued before the
 * per-step worker started) into one job per step (spec 2026-10-23 §3):
 *  1. in one transaction, bumps the version of every step of the run
 *     (`bumpStepGenerations`, which locks the run first);
 *  2. after it commits, adds one job per step at its new version, in capture
 *     order, with the job id `diffJobId(step, version)`, in one `addBulk`.
 * Each step then gets exactly one current job; a job of an older version
 * (another split, an upload's job) finds itself stale and writes nothing.
 * Returns the number of jobs added. The whole-run job diffs nothing itself.
 *
 * Like the whole-run handler before it, a missing run throws `run_not_found`
 * and a run with no steps throws `run_has_no_screenshots`, before any
 * transaction and without adding a job (the job's failure handling then
 * applies, unchanged). A caller without a queue (`undefined`) gets
 * `diff_queue_missing` after those checks, before any step is bumped.
 */
export async function splitLegacyJob(
  deps: { db: DB },
  job: { runId: string; projectId: string; parentPrBaseBranch?: string | null },
  queue: DiffJobQueue | undefined,
): Promise<number> {
  const [run] = await deps.db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.id, job.runId));
  if (!run) throw new Error(`run_not_found:${job.runId}`);

  const steps = await deps.db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(eq(screenshots.runId, job.runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  if (steps.length === 0) {
    throw new Error(`run_has_no_screenshots:${job.runId}`);
  }
  if (!queue) throw new Error(`diff_queue_missing:${job.runId}`);

  const bumped = await withProjectScope(deps.db, job.projectId, (tx) =>
    bumpStepGenerations(
      tx,
      job.runId,
      steps.map((s) => s.id),
    ),
  );

  // Only after the versions committed: a job added earlier could run against
  // a version not yet visible and be discarded as stale.
  const generationOf = new Map(bumped.map((b) => [b.id, b.generation]));
  const jobs = steps.flatMap(({ id }) => {
    const generation = generationOf.get(id);
    // A step deleted since it was listed was not bumped.
    if (generation === undefined) return [];
    return [
      {
        name: "diff" as const,
        data: {
          runId: job.runId,
          projectId: job.projectId,
          screenshotId: id,
          generation,
          parentPrBaseBranch: job.parentPrBaseBranch ?? null,
        },
        opts: { jobId: diffJobId(id, generation) },
      },
    ];
  });
  if (jobs.length > 0) await queue.addBulk(jobs);
  return jobs.length;
}
