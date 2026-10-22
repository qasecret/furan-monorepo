import type { DiffJob } from "@furan/queue";
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
 * - `branch_merge`: a synthetic run created by a cross-branch baseline merge.
 */
export type DiffTrigger =
  | "upload"
  | "ignore_areas"
  | "temp_ignore_areas"
  | "threshold"
  | "undo"
  | "branch_merge";

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
    name: "furan_diff_jobs_enqueued_total",
    help: "Diff jobs handed to the diff queue, by what triggered them",
    labelNames: ["trigger"] as const,
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
 * The payload is handed to the queue as given.
 */
export async function addDiffJob(
  deps: { diffQueue: DiffQueueProducer; registry: Registry },
  trigger: DiffTrigger,
  payload: DiffJob,
): Promise<void> {
  const m = getOrRegister(deps.registry);
  try {
    await deps.diffQueue.add("diff", payload);
  } catch (err) {
    m.failures.inc({ trigger });
    throw err;
  }
  m.enqueued.inc({ trigger });
}
