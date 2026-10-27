import { Writable } from "node:stream";

import { Histogram, Registry, bootstrapTelemetry } from "@furan/telemetry";
import { describe, expect, it } from "vitest";

import type { HistogramBuckets } from "../src/clients/metrics.js";
import {
  LOOP_LAG_P99_METRIC,
  POOL_WAIT_METRIC,
  openLoadWindow,
  quantileBetween,
} from "../src/load.js";

/** Cumulative buckets from `[le, count]` pairs, `+Inf` last. */
const hist = (pairs: [number, number][]): HistogramBuckets => ({
  buckets: pairs.map(([le, count]) => ({ le, count })),
  count: pairs.at(-1)?.[1] ?? 0,
});
const EMPTY = hist([
  [0.001, 0],
  [0.005, 0],
  [0.01, 0],
  [Infinity, 0],
]);

describe("quantileBetween", () => {
  it("interpolates inside the bucket the rank falls in", () => {
    // 50 at or below 1 ms, 90 at or below 5 ms, all 100 at or below 10 ms:
    // rank 95 is half way through the 5–10 ms bucket.
    const after = hist([
      [0.001, 50],
      [0.005, 90],
      [0.01, 100],
      [Infinity, 100],
    ]);
    const p95 = quantileBetween(EMPTY, after, 0.95);
    expect(p95.count).toBe(100);
    expect(p95.beyondBuckets).toBe(false);
    expect(p95.value).toBeCloseTo(0.0075, 10);
  });

  it("starts the first bucket at 0", () => {
    const after = hist([
      [0.001, 10],
      [0.005, 10],
      [0.01, 10],
      [Infinity, 10],
    ]);
    expect(quantileBetween(EMPTY, after, 0.5).value).toBeCloseTo(0.0005, 10);
  });

  it("counts only what was observed after the first reading", () => {
    const before = hist([
      [0.001, 0],
      [0.005, 0],
      [0.01, 1000],
      [Infinity, 1000],
    ]);
    const after = hist([
      [0.001, 100],
      [0.005, 100],
      [0.01, 1100],
      [Infinity, 1100],
    ]);
    // The 100 new observations are all under 1 ms; the 1000 slow ones came
    // before the window.
    const p95 = quantileBetween(before, after, 0.95);
    expect(p95.count).toBe(100);
    expect(p95.value).toBeCloseTo(0.00095, 10);
  });

  it("answers the last finite bound, as a floor, past the last bucket", () => {
    const after = hist([
      [0.001, 1],
      [0.005, 2],
      [0.01, 3],
      [Infinity, 100],
    ]);
    expect(quantileBetween(EMPTY, after, 0.95)).toEqual({
      value: 0.01,
      beyondBuckets: true,
      count: 100,
    });
  });

  it("has no value without an observation", () => {
    expect(quantileBetween(EMPTY, EMPTY, 0.95)).toEqual({
      value: null,
      beyondBuckets: false,
      count: 0,
    });
  });
});

/** The api's registry as the harness has it: default metrics, and the pool wait. */
function apiRegistry(): { registry: Registry; poolWait: Histogram } {
  const { metrics } = bootstrapTelemetry({
    service: "api",
    version: "test",
    destination: new Writable({ write: (_c, _e, done) => done() }),
  });
  const poolWait = new Histogram({
    name: POOL_WAIT_METRIC,
    help: "pool wait",
    buckets: [
      0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
      5,
    ],
    registers: [metrics],
  });
  return { registry: metrics, poolWait };
}

describe("openLoadWindow", () => {
  it("reads the pool wait observed while the window was open, and the loop's p99 lag", async () => {
    const { registry, poolWait } = apiRegistry();
    // Before the window: slow, and not the suite's.
    for (let i = 0; i < 50; i++) poolWait.observe(3);

    const window = await openLoadWindow(registry);
    for (let i = 0; i < 95; i++) poolWait.observe(0.0002);
    for (let i = 0; i < 5; i++) poolWait.observe(0.04);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const load = await window.close();

    expect(load.error).toBeUndefined();
    expect(load.poolWait.transactions).toBe(100);
    expect(load.poolWait.beyondBuckets).toBe(false);
    // Rank 95 is the last of the 95 fast ones: the top of the first bucket.
    expect(load.poolWait.p95Ms).toBeCloseTo(0.5, 6);
    // In ms, from prom-client's p99 gauge, read after the window's collection.
    expect(load.loopLagP99Ms).toBeGreaterThan(0);
    expect(load.loopLagP99Ms).toBe(
      (((await registry.getSingleMetric(LOOP_LAG_P99_METRIC)!.get()).values[0]
        ?.value ?? 0) as number) * 1000,
    );
  });

  it("reports a registry without the pool wait as an error, never throwing", async () => {
    const window = await openLoadWindow(new Registry());
    const load = await window.close();
    expect(load.error).toMatch(/furan_db_pool_wait_seconds is not registered/);
    expect(load.poolWait).toEqual({
      p95Ms: null,
      beyondBuckets: false,
      transactions: 0,
    });
    expect(load.loopLagP99Ms).toBeNull();
  });

  it("reports a registry without the default metrics as an error", async () => {
    const registry = new Registry();
    new Histogram({ name: POOL_WAIT_METRIC, help: "x", registers: [registry] });
    const load = await (await openLoadWindow(registry)).close();
    expect(load.error).toMatch(
      /nodejs_eventloop_lag_seconds is not registered/,
    );
  });
});
