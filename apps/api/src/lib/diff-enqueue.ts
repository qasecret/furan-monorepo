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
 * The one way the API adds a diff job. Counts a job the queue accepted in
 * `furan_diff_jobs_enqueued_total{trigger}`; one it refused in
 * `furan_diff_enqueue_failures_total{trigger}`, and then rethrows.
 *
 * It decides nothing about what a failure means. A caller that treats the
 * enqueue as best-effort (the SDK upload, a branch merge) catches and logs; one
 * that must surface it (an undo, whose retry re-enqueues) lets it propagate.
 * The payload is handed to the queue as given, under the job id
 * `diffJobId(step, version)`: the reconciler looks a step's job up by exactly
 * that id, and a version added twice is then one job.
 */
export async function addDiffJob(
  deps: { diffQueue: DiffQueueProducer; registry: Registry },
  trigger: DiffTrigger,
  payload: StepDiffJob,
): Promise<void> {
  const m = getOrRegister(deps.registry);
  try {
    await deps.diffQueue.add("diff", payload, {
      jobId: diffJobId(payload.screenshotId, payload.generation),
    });
  } catch (err) {
    m.failures.inc({ trigger });
    throw err;
  }
  m.enqueued.inc({ trigger });
}

/**
 * Adds every job of `jobs` at once (`addDiffJob`, each counted under
 * `trigger`) and resolves, once all were tried, to the ones the queue refused
 * with their errors, in job order. It never rejects: the caller decides what a
 * refusal means (rethrow the first, or log each).
 */
export async function addStepDiffJobs(
  deps: { diffQueue: DiffQueueProducer; registry: Registry },
  trigger: DiffTrigger,
  jobs: readonly StepDiffJob[],
): Promise<Array<{ job: StepDiffJob; err: unknown }>> {
  const results = await Promise.allSettled(
    jobs.map((job) => addDiffJob(deps, trigger, job)),
  );
  return results.flatMap((r, i) =>
    r.status === "rejected" ? [{ job: jobs[i]!, err: r.reason }] : [],
  );
}
