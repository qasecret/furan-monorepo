import {
  and,
  asc,
  count,
  eq,
  isNull,
  lt,
  markStepDiffFailed,
  notExists,
  or,
  screenshots,
  sql,
  stepAwaitingDiff,
  testRuns,
  withProjectScope,
  type DB,
} from "@furan/db";
import { diffJobId, type DiffJob } from "@furan/queue";
import { Counter, type Registry, type Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";

import { publishStepEvents } from "./step-events.js";

type Logger = Telemetry["logger"];

/** A step with no result this long after it was queued is looked at. */
export const RECONCILE_STUCK_AFTER_MS = 600_000;
/** Re-queues of one version before its step fails with `timeout`. */
export const RECONCILE_MAX_REQUEUES = 3;
/** Stuck steps looked at per pass, oldest first. */
export const RECONCILE_BATCH = 200;
/** A `running` run with no step, untouched this long, becomes `empty`. */
const EMPTY_RUN_AFTER_MS = 5 * 60_000;

/**
 * The BullMQ states of a job that will still run. A step whose job is in one
 * is a backlog, not a lost job, and is left alone however long it waits.
 */
const LIVE_JOB_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/**
 * What the reconciler needs of the diff queue: the queue the worker consumes
 * (same name and prefix). A BullMQ `Queue<DiffJob>` is one.
 */
export interface ReconcileQueue {
  getJob(id: string): Promise<
    | {
        getState(): Promise<string>;
        remove(): Promise<void>;
      }
    | undefined
  >;
  add(name: "diff", data: DiffJob, opts: { jobId: string }): Promise<unknown>;
}

export interface ReconcileArgs {
  db: DB;
  queue: ReconcileQueue;
  /** Where a step failed with `timeout` publishes its events. */
  redis: Redis;
  logger: Logger;
  /** Carries `furan_diff_jobs_enqueued_total{trigger="reconcile"}`. */
  registry: Registry;
  now?: () => Date;
  stuckAfterMs?: number;
  maxRequeues?: number;
  batch?: number;
}

export interface ReconcileResult {
  /** Steps whose job was re-added. */
  requeued: number;
  /** Steps failed with `timeout`. */
  failed: number;
  /** Step-less `running` runs that became `empty`. */
  emptied: number;
  /** Steps and runs whose handling threw; each was logged, the pass went on. */
  errors: number;
}

// The api counts its own enqueues under the same name; this is the worker's
// copy, for `trigger="reconcile"`, told apart by its registry's `service`
// label. prom-client throws on a duplicate name, so one per registry.
const enqueuedByRegistry = new WeakMap<Registry, Counter<"trigger">>();

function enqueuedCounter(registry: Registry): Counter<"trigger"> {
  let counter = enqueuedByRegistry.get(registry);
  if (!counter) {
    counter = new Counter({
      name: "furan_diff_jobs_enqueued_total",
      help: "Diff jobs handed to the diff queue, by what triggered them",
      labelNames: ["trigger"] as const,
      registers: [registry],
    });
    enqueuedByRegistry.set(registry, counter);
  }
  return counter;
}

/** One step the scan found awaiting a diff past the window. */
interface StuckStep {
  id: string;
  runId: string;
  projectId: string;
  parentBranchName: string | null;
  generation: number;
  /** `diff_queued_at` at full precision, as the claim compares it; NULL for a pre-per-step step. */
  queuedAt: string | null;
  requeues: number;
}

interface PassContext {
  db: DB;
  queue: ReconcileQueue;
  redis: Redis;
  logger: Logger;
  enqueued: Counter<"trigger">;
  maxRequeues: number;
}

/**
 * One pass of the reconciler, which replaces the stale-run sweeper's finalize
 * step (spec 2026-10-23 §6). The worker runs it every 30 s.
 *
 * 1. **Stuck steps.** Up to `batch` steps still awaiting a diff
 *    (`stepAwaitingDiff`: not failed, no result newer than their queue time, so
 *    a lost re-diff counts too) and queued more than `stuckAfterMs` ago, oldest
 *    first. A step uploaded before the per-step pipeline has no queue time and
 *    is timed from its upload. For each, the job of its current version:
 *    - is still `waiting`, `active`, `delayed`, `prioritized` or
 *      `waiting-children`: a backlog, left alone;
 *    - is missing, or finished (`completed`, `failed`): lost. A step already
 *      re-queued `maxRequeues` times fails with `timeout` (`failStuckStep`);
 *      any other is re-queued (`requeueStep`).
 * 2. **Empty runs.** A `running` run with no step whose `updated_at` is more
 *    than 5 minutes old becomes `empty` (`emptyStaleRuns`).
 *
 * A step without a result is never turned into `passed` by time: it is
 * re-queued, or failed, or left to its live job.
 *
 * Several replicas may run it at once; nothing is locked across a pass. A step
 * is re-queued through a compare-and-set claim and failed only while it still
 * awaits that diff, so two passes never act on one step twice. Locks follow the
 * pipeline's order, the run row before the step row.
 *
 * One step or run that throws is logged and counted in `errors`, and the pass
 * goes on. A failed scan rejects.
 */
export async function reconcileStuckSteps(
  args: ReconcileArgs,
): Promise<ReconcileResult> {
  const { db, queue, redis, logger, registry } = args;
  const now = (args.now ?? (() => new Date()))();
  const stuckAfterMs = args.stuckAfterMs ?? RECONCILE_STUCK_AFTER_MS;
  const ctx: PassContext = {
    db,
    queue,
    redis,
    logger,
    enqueued: enqueuedCounter(registry),
    maxRequeues: args.maxRequeues ?? RECONCILE_MAX_REQUEUES,
  };
  const result: ReconcileResult = {
    requeued: 0,
    failed: 0,
    emptied: 0,
    errors: 0,
  };

  const stuck = await findStuckSteps(
    db,
    new Date(now.getTime() - stuckAfterMs),
    args.batch ?? RECONCILE_BATCH,
  );
  for (const step of stuck) {
    try {
      const outcome = await reconcileStep(ctx, step);
      if (outcome === "requeued") result.requeued++;
      else if (outcome === "failed") result.failed++;
      else if (outcome === "error") result.errors++;
    } catch (err) {
      result.errors++;
      logger.error(
        {
          err,
          runId: step.runId,
          projectId: step.projectId,
          screenshotId: step.id,
          generation: step.generation,
        },
        "reconciler_step_failed",
      );
    }
  }

  const empty = await emptyStaleRuns(
    db,
    logger,
    new Date(now.getTime() - EMPTY_RUN_AFTER_MS),
    now,
  );
  result.emptied = empty.emptied;
  result.errors += empty.errors;

  if (result.requeued + result.failed + result.emptied + result.errors > 0) {
    logger.info({ ...result }, "reconciler_pass");
  }
  return result;
}

/**
 * The steps awaiting a diff whose clock is older than `cutoff`, oldest first.
 * The clock is `diff_queued_at`, or `created_at` for a step uploaded before
 * the per-step pipeline (Ruling R10). Both arms keep the awaiting predicate,
 * so the scan can read `screenshots_stuck_idx` alone.
 */
async function findStuckSteps(
  db: DB,
  cutoff: Date,
  batch: number,
): Promise<StuckStep[]> {
  return db
    .select({
      id: screenshots.id,
      runId: screenshots.runId,
      projectId: testRuns.projectId,
      parentBranchName: testRuns.parentBranchName,
      generation: screenshots.diffGeneration,
      queuedAt: sql<string | null>`${screenshots.diffQueuedAt}::text`,
      requeues: screenshots.diffRequeues,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(
      and(
        stepAwaitingDiff(screenshots),
        or(
          lt(screenshots.diffQueuedAt, cutoff),
          and(
            isNull(screenshots.diffQueuedAt),
            lt(screenshots.createdAt, cutoff),
          ),
        ),
      ),
    )
    .orderBy(
      sql`COALESCE(${screenshots.diffQueuedAt}, ${screenshots.createdAt})`,
      asc(screenshots.id),
    )
    .limit(batch);
}

/** What became of one stuck step. */
type StepOutcome = "requeued" | "failed" | "left" | "skipped" | "error";

async function reconcileStep(
  ctx: PassContext,
  step: StuckStep,
): Promise<StepOutcome> {
  const jobId = diffJobId(step.id, step.generation);
  const job = await ctx.queue.getJob(jobId);
  const state = job ? await job.getState() : "missing";
  if (LIVE_JOB_STATES.has(state)) return "left";

  if (step.requeues >= ctx.maxRequeues) return failStuckStep(ctx, step);

  // Ruling R24: BullMQ ignores an add whose id it still holds, and it keeps a
  // finished job for a while (a completed one 1 h, a failed one 24 h). The old
  // job goes first. One that is locked cannot go: try again next pass. This
  // comes before the claim, so a skip costs the step none of its re-queues.
  if (job) {
    try {
      await job.remove();
    } catch (err) {
      ctx.logger.warn(
        { err, runId: step.runId, screenshotId: step.id, jobId, state },
        "reconciler_job_remove_failed",
      );
      return "skipped";
    }
  }

  // Ruling R26: the claim commits BEFORE the job is added. A job added first
  // could commit its result before the claim's later `diff_queued_at`, look
  // stuck again, and in the end fail a step that was diffed.
  if (!(await claimStep(ctx.db, step))) return "skipped";

  const data: DiffJob = {
    runId: step.runId,
    projectId: step.projectId,
    screenshotId: step.id,
    generation: step.generation,
    parentPrBaseBranch: step.parentBranchName,
  };
  try {
    await ctx.queue.add("diff", data, { jobId });
  } catch (err) {
    // The claim stands: the step is found again once its new window passes.
    ctx.logger.error(
      {
        err,
        runId: step.runId,
        projectId: step.projectId,
        screenshotId: step.id,
        generation: step.generation,
        jobId,
      },
      "reconciler_requeue_failed",
    );
    return "error";
  }
  ctx.enqueued.inc({ trigger: "reconcile" });
  ctx.logger.warn(
    {
      runId: step.runId,
      projectId: step.projectId,
      screenshotId: step.id,
      generation: step.generation,
      jobId,
      previousJobState: state,
      requeues: step.requeues + 1,
    },
    "reconciler_step_requeued",
  );
  return "requeued";
}

/**
 * Ruling R25: claims a re-queue of `step` with a compare-and-set, in its own
 * transaction: the run row first (`FOR NO KEY UPDATE`), then the step through
 * the UPDATE, which matches only while the step is exactly as scanned (same
 * version, same queue time, still awaiting a diff). It stamps a new queue time
 * and counts the re-queue. False when another replica's claim, a commit or a
 * new version got there first: the caller skips the step. A pre-per-step step
 * has no queue time; the claim gives it one.
 */
async function claimStep(db: DB, step: StuckStep): Promise<boolean> {
  return withProjectScope(db, step.projectId, async (tx) => {
    await tx
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.id, step.runId))
      .for("no key update");
    const claimed = await tx
      .update(screenshots)
      .set({
        diffQueuedAt: sql`now()`,
        diffRequeues: sql`${screenshots.diffRequeues} + 1`,
      })
      .where(
        and(
          eq(screenshots.id, step.id),
          eq(screenshots.runId, step.runId),
          eq(screenshots.diffGeneration, step.generation),
          sql`${screenshots.diffQueuedAt} IS NOT DISTINCT FROM ${step.queuedAt}::timestamptz`,
          stepAwaitingDiff(screenshots),
        ),
      )
      .returning({ id: screenshots.id });
    return claimed.length > 0;
  });
}

/**
 * A step re-queued `maxRequeues` times whose job is lost again fails with
 * `timeout`, through the final-failure path of a job (`markStepDiffFailed`,
 * which locks the run, then the step), and publishes the same events. Only if
 * the step still awaits the scanned version's diff: a result or a new version
 * that landed meanwhile wins, and nothing is written.
 */
async function failStuckStep(
  ctx: PassContext,
  step: StuckStep,
): Promise<StepOutcome> {
  const marked = await withProjectScope(ctx.db, step.projectId, (tx) =>
    markStepDiffFailed(
      tx,
      {
        runId: step.runId,
        stepId: step.id,
        generation: step.generation,
        code: "timeout",
      },
      { onlyIfAwaitingDiff: true },
    ),
  );
  if (!marked.applied || !marked.rollup) return "skipped";

  ctx.logger.warn(
    {
      runId: step.runId,
      projectId: step.projectId,
      screenshotId: step.id,
      generation: step.generation,
      requeues: step.requeues,
    },
    "reconciler_step_timed_out",
  );
  await publishStepEvents(ctx.redis, {
    runId: step.runId,
    projectId: step.projectId,
    screenshotId: step.id,
    verdict: "unresolved",
    failed: true,
    rollup: marked.rollup,
    db: ctx.db,
    logger: ctx.logger,
  });
  return "failed";
}

/**
 * The stale-run sweeper's rule for a run no step was ever uploaded to: a
 * `running` run with no step, untouched since `cutoff`, becomes `empty`
 * (`checkpoint_count = 0`, `completed_at = now`). `empty` is a lifecycle state
 * the rollup keeps.
 *
 * Runs are visited in ascending `id` order, each in its own transaction that
 * locks the run (`FOR NO KEY UPDATE`) and then re-checks it, since it may have
 * finished or gained a step since the list was read. A run that throws is
 * rolled back, logged (`reconciler_run_failed`) and counted; the runs after it
 * are still visited.
 */
async function emptyStaleRuns(
  db: DB,
  logger: Logger,
  cutoff: Date,
  now: Date,
): Promise<{ emptied: number; errors: number }> {
  const noStep = notExists(
    db
      .select({ id: screenshots.id })
      .from(screenshots)
      .where(eq(screenshots.runId, testRuns.id)),
  );
  const stale = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.status, "running"),
        lt(testRuns.updatedAt, cutoff),
        noStep,
      ),
    )
    .orderBy(asc(testRuns.id));

  let emptied = 0;
  let errors = 0;
  for (const run of stale) {
    try {
      const done = await withProjectScope(db, run.projectId, async (tx) => {
        const [locked] = await tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(
            and(
              eq(testRuns.id, run.id),
              eq(testRuns.status, "running"),
              lt(testRuns.updatedAt, cutoff),
            ),
          )
          .for("no key update");
        if (!locked) return false;
        const [steps] = await tx
          .select({ n: count() })
          .from(screenshots)
          .where(eq(screenshots.runId, run.id));
        if ((steps?.n ?? 0) > 0) return false;
        await tx
          .update(testRuns)
          .set({ status: "empty", checkpointCount: 0, completedAt: now })
          .where(eq(testRuns.id, run.id));
        return true;
      });
      if (done) emptied++;
    } catch (err) {
      errors++;
      logger.error(
        { err, runId: run.id, projectId: run.projectId },
        "reconciler_run_failed",
      );
    }
  }
  return { emptied, errors };
}
