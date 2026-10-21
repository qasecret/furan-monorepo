import { describe, expect, it } from "vitest";

import {
  amplification,
  changeMix,
  excessEvents,
  findDuplicates,
  formatSteps,
  latencySamples,
  meanJobSeconds,
  overlappingUploads,
  raceLosses,
  raceSchedule,
  ratePerSec,
  stepDifferences,
  throughputRatio,
} from "../src/suites/pipeline-math.js";

const region = (
  screenshotId: string,
  bbox: unknown,
  extra: Partial<{ severity: string; source: string }> = {},
) => ({
  screenshotId,
  severity: extra.severity ?? "major",
  bbox,
  source: extra.source ?? "l1_pixel",
});

describe("amplification", () => {
  it("is checkpoint diffs per step uploaded", () => {
    expect(amplification(1275, 50)).toBe(25.5);
    expect(amplification(50, 50)).toBe(1);
  });

  it("refuses a run with no steps", () => {
    expect(() => amplification(3, 0)).toThrow(RangeError);
  });
});

describe("throughputRatio", () => {
  it("compares the observed rate with concurrency over the single-step time", () => {
    expect(throughputRatio(3.2, 1, 4)).toBe(0.8);
    expect(throughputRatio(2, 0.5, 4)).toBe(0.25);
  });

  it("defaults the concurrency to 4", () => {
    expect(throughputRatio(3.2, 1)).toBe(0.8);
  });
});

describe("meanJobSeconds (R19: the single-step cost)", () => {
  it("is the histogram's sum delta over its count delta", () => {
    expect(
      meanJobSeconds({ count: 3, sum: 1.5 }, { count: 13, sum: 3.5 }),
    ).toBeCloseTo(0.2, 12);
  });

  it("gives the ideal through throughputRatio: concurrency over the mean", () => {
    const mean = meanJobSeconds({ count: 0, sum: 0 }, { count: 10, sum: 2 });
    // 4 / 0.2 s = 20 results/s ideal; 16 observed is 80% of it.
    expect(throughputRatio(16, mean, 4)).toBeCloseTo(0.8, 12);
  });

  it("refuses a delta with no new jobs", () => {
    expect(() =>
      meanJobSeconds({ count: 5, sum: 1 }, { count: 5, sum: 1 }),
    ).toThrow(RangeError);
  });
});

describe("excessEvents", () => {
  it("counts testRun_updated events above status changes + 2", () => {
    expect(excessEvents(5, 2)).toBe(1);
    expect(excessEvents(3, 2)).toBe(0);
  });

  it("never goes below zero", () => {
    expect(excessEvents(0, 4)).toBe(0);
  });
});

describe("findDuplicates", () => {
  it("counts each repeat of a key after the first", () => {
    const rows = [
      region("a", { x: 1, y: 2, width: 3, height: 4 }),
      region("a", { x: 1, y: 2, width: 3, height: 4 }),
      region("b", { x: 1, y: 2, width: 3, height: 4 }),
    ];
    expect(findDuplicates(rows)).toBe(1);
    expect(findDuplicates([...rows, rows[0]!])).toBe(2);
  });

  it("keys on screenshot, severity, bbox and source", () => {
    const bbox = { x: 0, y: 0, width: 5, height: 5 };
    expect(
      findDuplicates([
        region("a", bbox),
        region("a", bbox, { severity: "minor" }),
        region("a", bbox, { source: "axe" }),
        region("a", { ...bbox, x: 1 }),
      ]),
    ).toBe(0);
  });

  it("compares a bbox by value: key order and jsonb text do not matter", () => {
    expect(
      findDuplicates([
        region("a", { x: 1, y: 2, width: 3, height: 4 }),
        region("a", { height: 4, width: 3, y: 2, x: 1 }),
        region("a", '{"height": 4, "width": 3, "x": 1, "y": 2}'),
      ]),
    ).toBe(2);
  });
});

describe("changeMix", () => {
  const counts = (mix: string[]) => ({
    none: mix.filter((c) => c === "none").length,
    small: mix.filter((c) => c === "small").length,
    large: mix.filter((c) => c === "large").length,
  });

  it("places exact 70/25/5 quotas", () => {
    expect(counts(changeMix(500, 1))).toEqual({
      none: 350,
      small: 125,
      large: 25,
    });
    expect(counts(changeMix(200, 1))).toEqual({
      none: 140,
      small: 50,
      large: 10,
    });
    expect(changeMix(50, 1)).toHaveLength(50);
  });

  it("is the same for the same seed and shuffled by it", () => {
    expect(changeMix(50, 7)).toEqual(changeMix(50, 7));
    expect(changeMix(50, 7)).not.toEqual(changeMix(50, 8));
  });
});

describe("raceSchedule", () => {
  it("is the spec's steps 10 and 20 on the 50-step run", () => {
    expect(raceSchedule(50)).toEqual({
      ignoreStep: 3,
      ignoreAfter: 10,
      approveStep: 5,
      approveAfter: 20,
    });
  });

  it("scales down but never before the step it acts on", () => {
    expect(raceSchedule(10)).toMatchObject({ ignoreAfter: 3, approveAfter: 5 });
  });

  it("needs five steps", () => {
    expect(() => raceSchedule(4)).toThrow(RangeError);
  });
});

describe("overlappingUploads (R20b: which uploads a branch overlapped)", () => {
  const uploads = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 30 },
    { start: 30, end: 40 },
  ];

  it("names, 1-based, the uploads in flight while the branch was", () => {
    expect(overlappingUploads(uploads, { start: 12, end: 31 })).toEqual([
      2, 3, 4,
    ]);
  });

  it("does not count an upload that ended as the branch started", () => {
    expect(overlappingUploads(uploads, { start: 20, end: 25 })).toEqual([3]);
  });

  it("is empty for a branch outside every upload", () => {
    expect(overlappingUploads(uploads, { start: 41, end: 50 })).toEqual([]);
  });
});

describe("formatSteps", () => {
  it("collapses runs of steps into ranges", () => {
    expect(formatSteps([4, 5, 6, 8, 10, 11])).toBe("4–6, 8, 10–11");
    expect(formatSteps([7])).toBe("7");
    expect(formatSteps([])).toBe("none");
  });
});

describe("latencySamples", () => {
  it("is result minus upload, a timed-out step counted at the timeout", () => {
    expect(
      latencySamples(
        [
          { uploadedAt: 100, resultAt: 350 },
          { uploadedAt: 200 },
          { uploadedAt: 300, resultAt: 300 },
        ],
        120_000,
      ),
    ).toEqual({ samples: [250, 120_000, 0], timedOut: 1 });
  });
});

describe("ratePerSec", () => {
  it("is results after the first, per second from the first to the last", () => {
    expect(ratePerSec([1000, 1500, 3000], 100)).toBe(1);
  });

  it("never divides by less than the poll interval", () => {
    expect(ratePerSec([500, 500, 500], 100)).toBe(20);
  });

  it("needs two results", () => {
    expect(() => ratePerSec([1], 100)).toThrow(RangeError);
  });
});

describe("raceLosses", () => {
  it("counts duplicates, NULL verdicts and unresolved steps with no region", () => {
    const steps = [
      { id: "s1", verdict: "unresolved" },
      { id: "s2", verdict: "unresolved" },
      { id: "s3", verdict: null },
      { id: "s4", verdict: "passed" },
    ];
    const regions = [
      region("s1", { x: 1 }),
      region("s1", { x: 1 }),
      region("s4", { x: 2 }),
    ];
    expect(raceLosses(steps, regions)).toEqual({
      duplicates: 1,
      nullVerdicts: 1,
      unresolvedWithoutRegion: 1,
    });
  });
});

describe("stepDifferences", () => {
  const steps = [
    { id: "s1", verdict: "unresolved" },
    { id: "s2", verdict: "passed" },
  ];
  const regions = [region("s1", { x: 1 }), region("s1", { x: 2 })];

  it("is zero when the re-diff changes nothing", () => {
    expect(
      stepDifferences(
        { steps, regions },
        { steps: [...steps].reverse(), regions: [...regions].reverse() },
      ),
    ).toBe(0);
  });

  it("counts each step whose verdict or region set changed, once", () => {
    expect(
      stepDifferences(
        { steps, regions },
        {
          steps: [
            { id: "s1", verdict: "passed" },
            { id: "s2", verdict: "passed" },
          ],
          regions: [region("s1", { x: 1 })],
        },
      ),
    ).toBe(1);
    expect(
      stepDifferences(
        { steps, regions },
        {
          steps,
          regions: [...regions, region("s2", { x: 9 })],
        },
      ),
    ).toBe(1);
  });

  it("compares regions as sets: a duplicate is counted by findDuplicates, not again here", () => {
    expect(
      stepDifferences(
        { steps, regions: [...regions, regions[0]!] },
        { steps, regions },
      ),
    ).toBe(0);
  });
});
