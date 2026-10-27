import {
  DIFF_JOBS_ENQUEUED_METRIC,
  diffJobId,
  type DiffJob,
} from "@furan/queue";
import { Counter, type Registry } from "@furan/telemetry";

import type { DiffQueueProducer } from "../trpc/context.js";

/**
 * Why a diff job was enqueued. The label of both counters below, so it stays a
 * small closed set (never an id):
 *
 * - `upload`: an SDK checkpoint upload (`routes/sdk-runs.ts`);
 * - `ignore_areas`: `runs.setIgnoreAreas` / `runs.addIgnoreAreas`;
 * - `temp_ignore_areas`: `runs.setTempIgnoreAreas`;
 * - `threshold`: `runs.setDiffThresholdOverride`;
 * - `undo`: `review.revert` re-diffing the runs whose verdict it cleared;
 * - `branch_merge`: a synthetic run created by a cross-branch baseline merge;
 * - `retry`: a reviewer retrying a step whose diff failed;
 * - `reconcile`: the diff worker re-queueing a step whose job was lost. The
 *   worker counts it on its own registry; the api never adds one.
 */
export type DiffTrigger =
  | "upload"
  | "ignore_areas"
  | "temp_ignore_areas"
  | "threshold"
  | "undo"
  | "branch_merge"
  | "retry"
  | "reconcile";

/**
 * A per-step diff job: the only kind the api adds (spec 2026-10-23 §3). The
 * worker still splits an old whole-run job, but nothing here makes one.
 */
export type StepDiffJob = DiffJob & {
  screenshotId: string;
  generation: number;
};

/**
 * The version a step is inserted at when its insert queues it (an SDK upload,
 * a branch-merge copy), with `diff_queued_at` stamped: its first job's. A
 * re-diff bumps it from there (`queueStepDiffs`).
 */
export const NEW_STEP_GENERATION = 1;

/**
 * The job that diffs step `screenshotId` of `run` at version `generation`.
 *
 * Forwards the run's parent branch as `parentPrBaseBranch` when it has one, so
 * the diff resolves baselines through the parent_pr tier (ADR-055); the field
 * is omitted when null to keep the wire minimal.
 */
export function stepDiffJob(
  run: { id: string; projectId: string; parentBranchName: string | null },
  screenshotId: string,
  generation: number,
): StepDiffJob {
  return {
    runId: run.id,
    projectId: run.projectId,
    screenshotId,
    generation,
    ...(run.parentBranchName
      ? { parentPrBaseBranch: run.parentBranchName }
      : {}),
  };
}

interface RegisteredMetrics {
  enqueued: Counter<"trigger">;
  failures: Counter<"trigger">;
}

// prom-client throws on a duplicate metric name, and every enqueue site calls
// in with the same registry: register once per registry.
const metricsByRegistry = new WeakMap<Registry, RegisteredMetrics>();

function getOrRegister(registry: Registry): RegisteredMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const enqueued = new Counter({
    ...DIFF_JOBS_ENQUEUED_METRIC,
    registers: [registry],
  });
  const failures = new Counter({
    name: "furan_diff_enqueue_failures_total",
    help: "Diff jobs the diff queue refused (the add threw), by what triggered them",
    labelNames: ["trigger"] as const,
    registers: [registry],
  });
  const out: RegisteredMetrics = { enqueued, failures };
  metricsByRegistry.set(registry, out);
  return out;
}

/**
 * The one way the API adds diff jobs: every job of `jobs` in one `addBulk`
 * (one round trip), each a `diff` job under the job id
 * `diffJobId(step, version)`. The reconciler looks a step's job up by exactly
 * that id, and a version added twice is then one job. The payloads are handed
 * to the queue as given.
 *
 * Counts the jobs the queue accepted in `furan_diff_jobs_enqueued_total
 * {trigger}`. A bulk the queue refused refuses every job in it: they are
 * counted in `furan_diff_enqueue_failures_total{trigger}` and returned, in job
 * order, with the error. It never rejects, and decides nothing about what a
 * refusal means: a caller that treats the enqueue as best-effort (the SDK
 * upload, a branch merge) logs each one; one that must surface it (an edit,
 * an undo, whose retry re-enqueues) rethrows. A step left without its job
 * keeps its version, and the reconciler re-queues it.
 */
export async function addStepDiffJobs(
  deps: { diffQueue: DiffQueueProducer; registry: Registry },
  trigger: DiffTrigger,
  jobs: readonly StepDiffJob[],
): Promise<Array<{ job: StepDiffJob; err: unknown }>> {
  if (jobs.length === 0) return [];
  const m = getOrRegister(deps.registry);
  try {
    await deps.diffQueue.addBulk(
      jobs.map((job) => ({
        name: "diff" as const,
        data: job,
        opts: { jobId: diffJobId(job.screenshotId, job.generation) },
      })),
    );
  } catch (err) {
    m.failures.inc({ trigger }, jobs.length);
    return jobs.map((job) => ({ job, err }));
  }
  m.enqueued.inc({ trigger }, jobs.length);
  return [];
}
