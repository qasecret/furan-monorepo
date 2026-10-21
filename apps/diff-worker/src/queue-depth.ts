import { Gauge, type Registry, type Telemetry } from "@furan/telemetry";

type Logger = Telemetry["logger"];

/** Reads the queue's job counts, keyed by BullMQ state. */
export type QueueCounts = () => Promise<Record<string, number>>;

/**
 * The BullMQ states the gauge reports, and nothing else: a fixed, bounded
 * label set. `completed` is left out on purpose (it is pruned after an hour
 * and only ever grows with throughput, not backlog).
 */
export const QUEUE_DEPTH_STATES = [
  "waiting",
  "active",
  "delayed",
  "failed",
] as const;

/** How long a scrape waits on Redis before it gives up and keeps old values. */
const DEFAULT_TIMEOUT_MS = 500;

/** The unavailable log is rate-limited to once per this interval. */
const LOG_INTERVAL_MS = 60_000;

interface GaugeState {
  counts: QueueCounts;
  logger: Logger;
  timeoutMs: number;
  /** `Date.now()` of the last unavailable log; undefined until the first. */
  lastLoggedAt: number | undefined;
}

// prom-client rejects registering a metric name twice on one registry. A
// second call on the same registry (a harness that starts the worker more than
// once in a process) swaps the source of the gauge already there instead, so
// it reads the live queue and not the one the first run closed.
const stateByRegistry = new WeakMap<Registry, GaugeState>();

/** Reject if `work` has not settled within `ms`. Never leaves its timer behind. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`queue depth read timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register `furan_diff_queue_jobs{state}` on `registry`: how many diff jobs
 * sit in each of `waiting`, `active`, `delayed` and `failed`.
 *
 * The values are read from Redis on every scrape, by the gauge's async
 * `collect()`, so they are never staler than the scrape. That read must not be
 * able to take `/metrics` down with it, so:
 *
 * - `counts()` races a `timeoutMs` cap (default 500 ms). On a timeout or an
 *   error the gauge keeps the values of the last successful read, and logs
 *   `diff_queue_depth_unavailable` (warn), at most once per 60 s.
 * - Before the first successful read the gauge has no sample at all, rather
 *   than a 0 that would read as an empty queue while Redis is unreachable.
 *   Alert on a missing series (`absent(...)`) as well as on its value.
 *
 * `failed` is the failed set BullMQ retains (24 h, capped at 5000 jobs: see
 * `DEFAULT_JOB_OPTIONS` in `@furan/queue`), a level that ages out, not a
 * running total. Use `furan_diff_jobs_dead_lettered_total` for the rate.
 *
 * Registers once per registry: calling it again on the same registry replaces
 * the `counts`, `logger` and `timeoutMs` the existing gauge reads from.
 */
export function registerQueueDepthGauge(
  registry: Registry,
  counts: QueueCounts,
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): void {
  const existing = stateByRegistry.get(registry);
  if (existing) {
    existing.counts = counts;
    existing.logger = logger;
    existing.timeoutMs = timeoutMs;
    return;
  }
  const state: GaugeState = {
    counts,
    logger,
    timeoutMs,
    lastLoggedAt: undefined,
  };
  stateByRegistry.set(registry, state);

  const gauge = new Gauge({
    name: "furan_diff_queue_jobs",
    help: "Diff queue jobs by state (waiting, active, delayed, failed), read from Redis on each scrape",
    labelNames: ["state"] as const,
    registers: [registry],
    async collect() {
      try {
        // `counts()` runs inside the try, so a synchronous throw is handled too.
        const read = await withTimeout(state.counts(), state.timeoutMs);
        for (const name of QUEUE_DEPTH_STATES) {
          const value = read[name];
          // A state BullMQ did not report keeps its previous value.
          if (typeof value === "number" && Number.isFinite(value)) {
            gauge.set({ state: name }, value);
          }
        }
      } catch (err) {
        const now = Date.now();
        if (
          state.lastLoggedAt === undefined ||
          now - state.lastLoggedAt >= LOG_INTERVAL_MS
        ) {
          state.lastLoggedAt = now;
          state.logger.warn(
            { err, timeoutMs: state.timeoutMs },
            "diff_queue_depth_unavailable",
          );
        }
      }
    },
  });
}
