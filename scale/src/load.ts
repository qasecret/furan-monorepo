import type { Registry } from "@furan/telemetry";

import {
  readBuckets,
  readGauge,
  type HistogramBuckets,
} from "./clients/metrics.js";
import { describeError } from "./errors.js";

/**
 * The load notes (spec 2026-10-27 §8): how long the api's tRPC procedures
 * waited for a database connection, and how late the event loop ran, while
 * each suite ran. They explain a budget's number; they are not budgets.
 */

/**
 * The api's histogram of the time a tRPC procedure waited for its request
 * transaction: a pooled connection, then its BEGIN. A transaction that never
 * begins (a connect error, for one) is not observed.
 */
export const POOL_WAIT_METRIC = "furan_db_pool_wait_seconds";
/** prom-client's default metric: the event loop's p99 delay. */
export const LOOP_LAG_P99_METRIC = "nodejs_eventloop_lag_p99_seconds";
/**
 * The default metric whose collection sets the lag percentiles and then
 * resets their histogram: collecting it ends one window and starts the next.
 */
const LOOP_LAG_METRIC = "nodejs_eventloop_lag_seconds";

/** One suite's load: the pool wait and the event-loop lag over its run. */
export interface SuiteLoad {
  poolWait: {
    /** The p95 in ms, estimated from the buckets; null with no transaction. */
    p95Ms: number | null;
    /**
     * The p95 lies past the last finite bucket: `p95Ms` is that bucket's
     * bound, a floor, not an estimate.
     */
    beyondBuckets: boolean;
    /** Transactions that began (the histogram's observations). */
    transactions: number;
  };
  /** The event loop's p99 delay in ms; null when it was not read. */
  loopLagP99Ms: number | null;
  /** Why the load could not be read; the figures are then empty. */
  error?: string;
}

/**
 * The `q` quantile of the observations made between two readings of one
 * histogram, as Prometheus's `histogram_quantile` estimates it: linear within
 * the bucket the rank falls in (the first bucket starts at 0). Past the last
 * finite bucket it answers that bucket's bound, as a floor.
 */
export function quantileBetween(
  before: HistogramBuckets,
  after: HistogramBuckets,
  q: number,
): { value: number | null; beyondBuckets: boolean; count: number } {
  const was = new Map(before.buckets.map((b) => [b.le, b.count]));
  const delta = after.buckets.map((b) => ({
    le: b.le,
    count: b.count - (was.get(b.le) ?? 0),
  }));
  const count = delta.at(-1)?.count ?? 0;
  if (count <= 0) return { value: null, beyondBuckets: false, count: 0 };
  const rank = q * count;
  let lower = 0;
  let below = 0;
  for (const { le, count: atOrBelow } of delta) {
    if (atOrBelow >= rank) {
      if (le === Infinity) {
        return { value: lower, beyondBuckets: true, count };
      }
      const inBucket = atOrBelow - below;
      const value =
        inBucket === 0
          ? le
          : lower + ((le - lower) * (rank - below)) / inBucket;
      return { value, beyondBuckets: false, count };
    }
    lower = le;
    below = atOrBelow;
  }
  // The +Inf bucket holds every observation, so the loop always returns.
  return { value: lower, beyondBuckets: true, count };
}

/** Collects the lag metric: ends the event loop's current lag window. */
async function collectLoopLag(registry: Registry): Promise<void> {
  const metric = registry.getSingleMetric(LOOP_LAG_METRIC);
  if (metric === undefined) {
    throw new Error(`metric ${LOOP_LAG_METRIC} is not registered`);
  }
  await metric.get();
}

export interface LoadWindow {
  /** The load since the window opened. Never throws: a failure is `error`. */
  close: () => Promise<SuiteLoad>;
}

const failed = (error: unknown): SuiteLoad => ({
  poolWait: { p95Ms: null, beyondBuckets: false, transactions: 0 },
  loopLagP99Ms: null,
  error: describeError(error),
});

/**
 * Opens a window on the api's registry: the pool-wait histogram as it stands
 * now, and a fresh event-loop lag window. Nothing else may collect the lag
 * metric meanwhile (prom-client resets the lag histogram on each
 * collection); the harness serves no `/metrics` scrape. Never throws: a
 * failure is the close's `error`.
 */
export async function openLoadWindow(registry: Registry): Promise<LoadWindow> {
  let before: HistogramBuckets;
  try {
    before = await readBuckets(registry, POOL_WAIT_METRIC);
    await collectLoopLag(registry);
  } catch (error) {
    return { close: () => Promise.resolve(failed(error)) };
  }
  return {
    close: async () => {
      try {
        const after = await readBuckets(registry, POOL_WAIT_METRIC);
        await collectLoopLag(registry);
        const lag = await readGauge(registry, LOOP_LAG_P99_METRIC);
        const p95 = quantileBetween(before, after, 0.95);
        return {
          poolWait: {
            p95Ms: p95.value === null ? null : p95.value * 1000,
            beyondBuckets: p95.beyondBuckets,
            transactions: p95.count,
          },
          loopLagP99Ms: lag === null ? null : lag * 1000,
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
}
