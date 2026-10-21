import { describe, expect, it } from "vitest";

import {
  DIFF_POOL,
  PIPELINE_SETS,
  SHAPE_VERSION,
  diffImage,
  expectedRows,
  longRunCaptures,
  needsReseed,
  pipelineStep,
  shapes,
} from "../src/seed/shape.js";

describe("shapes", () => {
  it("is version 2 (v2 added diff images)", () => {
    expect(SHAPE_VERSION).toBe(2);
  });

  it("large carries the table's values", () => {
    expect(shapes.large).toMatchObject({
      name: "large",
      reviewers: 20,
      nightlyRuns: 1000,
      nightlySteps: 5,
      nightlies: 200,
      baselineEvery: 10,
      prBatches: 9800,
      prRuns: 3,
      prSteps: 3,
      branches: 40,
      longRunSteps: 500,
      longRunHistory: 200,
      pipelineSets: {
        "pipeline-50": 50,
        "pipeline-200": 200,
        "pipeline-500": 500,
      },
      pendingPct: 5,
      decidedPct: 40,
      notReviewablePct: 3,
      regionsPerChangedStep: { min: 2, max: 5 },
      imagePool: 24,
    });
  });

  it("smoke carries the table's values", () => {
    expect(shapes.smoke).toMatchObject({
      name: "smoke",
      reviewers: 3,
      nightlyRuns: 10,
      nightlySteps: 3,
      nightlies: 5,
      baselineEvery: 2,
      prBatches: 15,
      prRuns: 2,
      prSteps: 2,
      branches: 3,
      longRunSteps: 20,
      longRunHistory: 5,
      pipelineSets: {
        "pipeline-50": 10,
        "pipeline-200": 10,
        "pipeline-500": 10,
      },
      pendingPct: 5,
      decidedPct: 40,
      notReviewablePct: 3,
      regionsPerChangedStep: { min: 2, max: 5 },
      imagePool: 24,
    });
  });
});

describe("expectedRows", () => {
  it("large: 10,001 batches and at least 1,000,000 steps", () => {
    const rows = expectedRows(shapes.large);
    // 200 nightlies (the newest included) + 9,800 PR batches + the long
    // run's own one-run batch.
    expect(rows.builds).toBe(10_001);
    expect(rows.screenshots).toBeGreaterThanOrEqual(1_000_000);
  });

  it("large: the exact run, step and baseline counts", () => {
    expect(expectedRows(shapes.large)).toEqual({
      builds: 10_001,
      // 200 x 1,000 nightly runs + 199 long-run history runs + the current
      // long run + 3 pipeline baseline runs + 9,800 x 3 PR runs.
      runs: 200_000 + 199 + 1 + 3 + 29_400,
      // 200 x 1,000 x 5 + 200 x 500 (history + current long run) + 750
      // pipeline baseline steps + 9,800 x 3 x 3.
      screenshots: 1_000_000 + 100_000 + 750 + 88_200,
      // Baseline nights 0, 10, ..., 190 (20 of the 199 earlier nights), for
      // the 5,000 suite steps and the 500 long-run steps, + 750 pipeline.
      baselines: 20 * 5_000 + 20 * 500 + 750,
    });
  });

  it("smoke: under 50 batches", () => {
    const rows = expectedRows(shapes.smoke);
    expect(rows.builds).toBeLessThan(50);
    expect(rows).toEqual({
      builds: 5 + 15 + 1,
      runs: 5 * 10 + 4 + 1 + 3 + 15 * 2,
      screenshots: 5 * 10 * 3 + 5 * 20 + 30 + 15 * 2 * 2,
      // Baseline nights 0 and 2 of the earlier nights 0-3.
      baselines: 2 * 30 + 2 * 20 + 30,
    });
  });

  it("the long run keeps one earlier capture per earlier nightly at most", () => {
    expect(longRunCaptures(shapes.large)).toBe(199);
    expect(longRunCaptures(shapes.smoke)).toBe(4);
  });
});

describe("needsReseed", () => {
  it("is true unless the stored version matches", () => {
    expect(needsReseed(null, 1)).toBe(true);
    expect(needsReseed(0, 1)).toBe(true);
    expect(needsReseed(2, 1)).toBe(true);
    expect(needsReseed(1, 1)).toBe(false);
  });
});

describe("diffImage", () => {
  it("keeps 8 diff images, 70% screens, on seeds of their own", () => {
    expect(DIFF_POOL).toBe(8);
    const all = Array.from({ length: DIFF_POOL }, (_, i) => diffImage(i));
    expect(all.filter((d) => d.kind === "screen")).toHaveLength(6);
    expect(all.filter((d) => d.kind === "page")).toHaveLength(2);
    const pipelineSeeds = new Set(
      PIPELINE_SETS.flatMap((set) =>
        Array.from({ length: 500 }, (_, i) => pipelineStep(set, i).seed),
      ),
    );
    for (const d of all) {
      expect(d.seed).toBeGreaterThan(shapes.large.imagePool);
      expect(pipelineSeeds.has(d.seed)).toBe(false);
    }
  });
});

describe("pipelineStep", () => {
  it("names each set's steps and mixes 70% screens with 30% pages", () => {
    for (const set of PIPELINE_SETS) {
      const steps = Array.from({ length: 10 }, (_, i) => pipelineStep(set, i));
      expect(steps.filter((s) => s.kind === "screen")).toHaveLength(7);
      expect(new Set(steps.map((s) => s.name)).size).toBe(10);
      expect(steps[0]!.name).toBe(`${set}/step-0001`);
    }
  });

  it("gives every step of every set its own image seed", () => {
    const seeds = PIPELINE_SETS.flatMap((set) =>
      Array.from({ length: 500 }, (_, i) => pipelineStep(set, i).seed),
    );
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
