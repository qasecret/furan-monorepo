import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { createDiffJobMetrics } from "../src/job-metrics.js";

import { histogramSeries } from "./helpers/metrics.js";

describe("createDiffJobMetrics", () => {
  it("records duration by outcome", async () => {
    const registry = new Registry();
    const metrics = createDiffJobMetrics(registry);

    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: 1_500, attemptsMade: 0 },
      "completed",
      1.2,
      3,
    );

    const completed = await histogramSeries(
      registry,
      "furan_diff_job_duration_seconds",
      { outcome: "completed" },
    );
    expect(completed.count).toBe(1);
    expect(completed.sum).toBeCloseTo(1.2, 6);
    const retry = await histogramSeries(
      registry,
      "furan_diff_job_duration_seconds",
      { outcome: "retry" },
    );
    expect(retry.count).toBe(0);
  });

  it("records queue wait only on the first attempt", async () => {
    const registry = new Registry();
    const metrics = createDiffJobMetrics(registry);

    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: 3_500, attemptsMade: 0 },
      "completed",
      0.5,
      1,
    );
    const first = await histogramSeries(
      registry,
      "furan_diff_job_queue_wait_seconds",
    );
    expect(first.count).toBe(1);
    expect(first.sum).toBeCloseTo(2.5, 6);

    // A retry (attemptsMade 1) waited on its backoff, not on the queue.
    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: 9_000, attemptsMade: 1 },
      "completed",
      0.5,
      1,
    );
    const second = await histogramSeries(
      registry,
      "furan_diff_job_queue_wait_seconds",
    );
    expect(second.count).toBe(1);
    expect(second.sum).toBeCloseTo(2.5, 6);
  });

  it("skips checkpoints when null", async () => {
    const registry = new Registry();
    const metrics = createDiffJobMetrics(registry);

    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: 1_100, attemptsMade: 0 },
      "retry",
      0.3,
      null,
    );
    expect(
      (await histogramSeries(registry, "furan_diff_job_checkpoints")).count,
    ).toBe(0);
    // The duration is still observed for the failed attempt.
    expect(
      (
        await histogramSeries(registry, "furan_diff_job_duration_seconds", {
          outcome: "retry",
        })
      ).count,
    ).toBe(1);

    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: 1_100, attemptsMade: 0 },
      "completed",
      0.3,
      12,
    );
    const checkpoints = await histogramSeries(
      registry,
      "furan_diff_job_checkpoints",
    );
    expect(checkpoints.count).toBe(1);
    expect(checkpoints.sum).toBe(12);
  });

  it("skips the queue wait when the job has no processedOn", async () => {
    const registry = new Registry();
    const metrics = createDiffJobMetrics(registry);

    metrics.observeAttempt(
      { timestamp: 1_000, processedOn: undefined, attemptsMade: 0 },
      "completed",
      0.2,
      1,
    );
    expect(
      (await histogramSeries(registry, "furan_diff_job_queue_wait_seconds"))
        .count,
    ).toBe(0);
  });

  it("registers once per registry", () => {
    const registry = new Registry();
    const a = createDiffJobMetrics(registry);
    expect(() => createDiffJobMetrics(registry)).not.toThrow();
    expect(createDiffJobMetrics(registry)).toBe(a);
  });

  it("uses the agreed buckets", async () => {
    const registry = new Registry();
    // A labelled histogram exposes its buckets once a series has a sample.
    createDiffJobMetrics(registry).observeAttempt(
      { timestamp: 1_000, processedOn: 1_100, attemptsMade: 0 },
      "completed",
      1,
      1,
    );
    const json = await registry.getMetricsAsJSON();
    const boundsOf = (name: string): number[] => {
      const metric = json.find((m) => m.name === name);
      return (metric?.values as Sample[])
        .filter((s) => s.metricName === `${name}_bucket`)
        .map((s) => Number(s.labels.le))
        .filter((le) => Number.isFinite(le));
    };
    expect(boundsOf("furan_diff_job_duration_seconds")).toEqual([
      0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
    ]);
    expect(boundsOf("furan_diff_job_queue_wait_seconds")).toEqual([
      0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900,
    ]);
    expect(boundsOf("furan_diff_job_checkpoints")).toEqual([
      1, 2, 5, 10, 25, 50, 100, 250, 500, 1000,
    ]);
  });
});
