import type { Job } from "@furan/queue";
import { Histogram, type Registry } from "@furan/telemetry";

/** `furan_diff_job_duration_seconds`: one attempt, start to finish. */
const DURATION_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];
/** `furan_diff_job_queue_wait_seconds`: enqueue to first pick-up. */
const QUEUE_WAIT_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900];
/** `furan_diff_job_checkpoints`: screenshots one job diffed. */
const CHECKPOINT_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

/** How one attempt of a diff job ended. */
export type DiffJobAttemptOutcome = "completed" | "retry" | "failed";

/** The bits of a BullMQ job the metrics read. */
export type DiffJobTimes = Pick<
  Job,
  "timestamp" | "processedOn" | "attemptsMade"
>;

export interface DiffJobMetrics {
  /**
   * Record one attempt of a diff job.
   *
   * - Duration is observed for every attempt, by `outcome`.
   * - Queue wait is observed only for the first attempt (`attemptsMade === 0`):
   *   a retry waited on its backoff, not on the queue. The value is
   *   `(processedOn - timestamp) / 1000`.
   * - Checkpoints is observed only when the attempt reported a count (a
   *   thrown attempt has none: pass `null`).
   *
   * Observing never throws: a value that is negative or not finite is
   * skipped, because prom-client rejects it and a metric must not fail the
   * job it describes.
   */
  observeAttempt(
    job: DiffJobTimes,
    outcome: DiffJobAttemptOutcome,
    seconds: number,
    checkpoints: number | null,
  ): void;
}

const metricsByRegistry = new WeakMap<Registry, DiffJobMetrics>();

function isObservable(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/**
 * Register the diff job metrics on `registry`, once. A second call with the
 * same registry returns the first call's instance (prom-client throws on a
 * duplicate registration).
 *
 * No ids in any label: the only label is the bounded `outcome`.
 */
export function createDiffJobMetrics(registry: Registry): DiffJobMetrics {
  const existing = metricsByRegistry.get(registry);
  if (existing) return existing;

  const duration = new Histogram({
    name: "furan_diff_job_duration_seconds",
    help: "Time one attempt of a diff job took, by how it ended (completed, retry or failed)",
    labelNames: ["outcome"] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });
  const queueWait = new Histogram({
    name: "furan_diff_job_queue_wait_seconds",
    help: "Time a diff job waited in the queue before its first attempt started",
    buckets: QUEUE_WAIT_BUCKETS,
    registers: [registry],
  });
  const checkpointsPerJob = new Histogram({
    name: "furan_diff_job_checkpoints",
    help: "Checkpoints (screenshots) one completed diff job diffed",
    buckets: CHECKPOINT_BUCKETS,
    registers: [registry],
  });

  const metrics: DiffJobMetrics = {
    observeAttempt(job, outcome, seconds, checkpoints) {
      if (isObservable(seconds)) duration.observe({ outcome }, seconds);
      if (job.attemptsMade === 0 && job.processedOn !== undefined) {
        const wait = (job.processedOn - job.timestamp) / 1000;
        if (isObservable(wait)) queueWait.observe(wait);
      }
      if (checkpoints !== null && isObservable(checkpoints)) {
        checkpointsPerJob.observe(checkpoints);
      }
    },
  };
  metricsByRegistry.set(registry, metrics);
  return metrics;
}
