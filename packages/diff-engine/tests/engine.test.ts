import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runDiff } from "../src/engine.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PNG_FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runDiff", () => {
  it("image-only — only runs L1, durationMs.l2 is null (ADR-047)", async () => {
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-identical.png") },
      config: {
        diffThreshold: 0.1,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
    expect(result.durationMs.l2).toBeNull();
  });

  it("L1 above threshold only runs L1, emits no l2 regions (ADR-047)", async () => {
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-major.png") },
      config: {
        diffThreshold: 0.001,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
    expect(result.durationMs.l2).toBeNull();
  });

  it("passed is true when diffPercent is at or below diffThreshold", async () => {
    // candidate-a-major has a non-trivial pixel diff against baseline-a.
    // A very permissive threshold (50%) should let it pass even though
    // pixelMismatchCount > 0 — this is the sensitivity slider's contract
    // (set 1% / 5% in the UI → diffs under that threshold pass).
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-major.png") },
      config: {
        diffThreshold: 0.5,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.diffPercent).toBeGreaterThan(0);
    expect(result.diffPercent).toBeLessThanOrEqual(50);
    expect(result.passed).toBe(true);
  });

  it("passed is false when diffPercent exceeds diffThreshold", async () => {
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-major.png") },
      config: {
        diffThreshold: 0,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.diffPercent).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it("passed is true on byte-identical inputs (threshold=0)", async () => {
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-identical.png") },
      config: {
        diffThreshold: 0,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.diffPercent).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("l1_pixel regions emitted via runDiff are well-formed", async () => {
    // The extractor's own tests (l1-region-extractor.test.ts) cover the
    // "did it produce a region" path with controlled inputs. Here we just
    // verify the engine wiring: ANY l1_pixel regions that come out of
    // runDiff carry the correct source / severity / id-prefix / category
    // shape end-to-end. Region count depends on the fixture's pixel
    // footprint vs. the extractor's current default thresholds and is
    // intentionally not asserted.
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-major.png") },
      config: {
        diffThreshold: 0.001,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    for (const r of result.regions.filter((r) => r.source === "l1_pixel")) {
      // severityForSize only ever returns these three tiers — assert the
      // exact reachable set so a regression to "none"/"breaking" is caught
      // (was the geometry-dependent exact "minor" before image-first P1).
      expect(["major", "minor", "cosmetic"]).toContain(r.severity);
      expect(r.category).toBe("image");
      expect(r.id).toMatch(/^l1-pixel-/);
    }
  });

  it("emits no l1_pixel regions on byte-identical inputs", async () => {
    const result = await runDiff({
      baseline: { image: PNG_FIXTURE("baseline-a.png") },
      candidate: { image: PNG_FIXTURE("candidate-a-identical.png") },
      config: {
        diffThreshold: 0,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    const l1PixelRegions = result.regions.filter(
      (r) => r.source === "l1_pixel",
    );
    expect(l1PixelRegions).toEqual([]);
  });
});

describe("runDiff: L1 displacement pre-alignment", () => {
  const __dirname_disp = dirname(fileURLToPath(import.meta.url));
  const FIX_DISP = (n: string) =>
    readFileSync(join(__dirname_disp, "fixtures", n));

  const baseConfig = {
    diffThreshold: 0.001,
    engine: "pixelmatch" as const,
    engineConfig: DEFAULT_ENGINE_CONFIG,
  };

  function makeMetric() {
    const counts = new Map<string, number>();
    return {
      counts,
      adapter: {
        labels: (l: { outcome: string }) => ({
          inc: () => counts.set(l.outcome, (counts.get(l.outcome) ?? 0) + 1),
        }),
      },
    };
  }

  it("records `applied` and reduces diffPercent when ignoreDisplacements=true on a shifted candidate", async () => {
    const baseline = FIX_DISP("displacement-baseline.png");
    const shifted = FIX_DISP("displacement-shifted-down-40.png");

    const m = makeMetric();
    const result = await runDiff({
      baseline: { image: baseline },
      candidate: { image: shifted },
      config: baseConfig,
      ignoreDisplacements: true,
      l1DisplacementMetric: m.adapter,
    });
    expect(m.counts.get("applied")).toBe(1);
    expect(result.displacementVector).toBeDefined();
    expect(Math.abs(result.displacementVector!.dy - 40)).toBeLessThanOrEqual(1);
    // After alignment the candidate matches the baseline (modulo the
    // 40-row exposed band that we filled with baseline pixels).
    // diffPercent should be near zero.
    expect(result.diffPercent).toBeLessThan(1);
  });

  it("records `skipped` and runs unchanged when ignoreDisplacements=false", async () => {
    const baseline = FIX_DISP("displacement-baseline.png");
    const shifted = FIX_DISP("displacement-shifted-down-40.png");

    const m = makeMetric();
    const result = await runDiff({
      baseline: { image: baseline },
      candidate: { image: shifted },
      config: baseConfig,
      ignoreDisplacements: false,
      l1DisplacementMetric: m.adapter,
    });
    expect(m.counts.get("skipped")).toBe(1);
    expect(result.displacementVector).toBeUndefined();
    // diffPercent should be non-trivial since the candidate is shifted
    // and alignment is disabled.
    expect(result.diffPercent).toBeGreaterThan(0);
  });

  it("records `low_confidence` on uncorrelated content", async () => {
    const baseline = FIX_DISP("displacement-baseline.png");
    const noise = FIX_DISP("displacement-noise.png");

    const m = makeMetric();
    const result = await runDiff({
      baseline: { image: baseline },
      candidate: { image: noise },
      config: baseConfig,
      ignoreDisplacements: true,
      l1DisplacementMetric: m.adapter,
    });
    expect(m.counts.get("low_confidence")).toBe(1);
    expect(result.displacementVector).toBeUndefined();
  });
});
