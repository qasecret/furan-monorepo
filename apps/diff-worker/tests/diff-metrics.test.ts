import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { createDiffMetrics } from "../src/diff-metrics.js";

describe("createDiffMetrics", () => {
  it("registers furan_diff_l1_duration_seconds on the provided registry", async () => {
    const registry = new Registry();
    createDiffMetrics(registry);

    const metric = registry.getSingleMetric("furan_diff_l1_duration_seconds");
    expect(metric).toBeDefined();

    const json = await registry.getMetricsAsJSON();
    const found = json.find((m) => m.name === "furan_diff_l1_duration_seconds");
    expect(found).toBeDefined();
    expect(found!.type).toBe("histogram");
    expect(found!.help).toContain("L1");
  });

  it("partitions observations by engine label", async () => {
    const registry = new Registry();
    const metrics = createDiffMetrics(registry);

    metrics.l1Duration.labels({ engine: "odiff" }).observe(0.08);
    metrics.l1Duration.labels({ engine: "odiff" }).observe(0.12);
    metrics.l1Duration.labels({ engine: "pixelmatch" }).observe(0.45);
    metrics.l1Duration.labels({ engine: "looks_same" }).observe(0.3);

    const json = await registry.getMetricsAsJSON();
    const histogram = json.find(
      (m) => m.name === "furan_diff_l1_duration_seconds",
    );
    expect(histogram).toBeDefined();

    // Type narrowing: prom-client's JSON shape has `values` for each
    // observed label set (plus _sum/_count/_bucket entries per series).
    const series = histogram!.values as Array<{
      metricName?: string;
      labels: { engine?: string };
      value: number;
    }>;
    const countByEngine = (engine: string): number => {
      const row = series.find(
        (r) =>
          r.metricName === "furan_diff_l1_duration_seconds_count" &&
          r.labels.engine === engine,
      );
      return row?.value ?? 0;
    };
    expect(countByEngine("odiff")).toBe(2);
    expect(countByEngine("pixelmatch")).toBe(1);
    expect(countByEngine("looks_same")).toBe(1);
  });

  it("uses second-scale buckets sized for L1 latency", async () => {
    const registry = new Registry();
    const metrics = createDiffMetrics(registry);

    // Observe a 100ms diff — should land in the 0.1 bucket.
    metrics.l1Duration.labels({ engine: "odiff" }).observe(0.1);

    const text = await registry.metrics();
    // Bucket labels are emitted in seconds; the test below pins three
    // representative buckets to catch a future accidental switch to a
    // milliseconds basis (which would push everything past le="10").
    expect(text).toMatch(/le="0\.1"/);
    expect(text).toMatch(/le="1"/);
    expect(text).toMatch(/le="10"/);
  });

  it("registers furan_layout_resolution_total with an outcome label", async () => {
    const registry = new Registry();
    const metrics = createDiffMetrics(registry);

    metrics.layoutResolution.labels({ outcome: "stable_element" }).inc();
    metrics.layoutResolution.labels({ outcome: "moved_or_resized" }).inc();

    const json = await registry.getMetricsAsJSON();
    const found = json.find((m) => m.name === "furan_layout_resolution_total");
    expect(found).toBeDefined();
    expect(found!.type).toBe("counter");
    expect(found!.help).toContain("Layout");
  });
});
