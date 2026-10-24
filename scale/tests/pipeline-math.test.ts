import { describe, expect, it } from "vitest";

import { shapes } from "../src/seed/shape.js";
import {
  amplification,
  changeMix,
  excessEvents,
  findDuplicates,
  formatSequence,
  formatSteps,
  latencySamples,
  meanJobSeconds,
  mixCounts,
  mixSeed,
  overlappingUploads,
  pairedSteps,
  parseJsonObject,
  raceLosses,
  raceSchedule,
  ratePerSec,
  rediffShortfall,
  runCompletedStatus,
  singleStepChanges,
  statusSequence,
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
    ).toEqual({ samples: [250, 120_000, 0], capped: 1 });
  });

  it("caps a result that came after the timeout too (R22)", () => {
    expect(
      latencySamples(
        [
          { uploadedAt: 0, resultAt: 130_000 },
          { uploadedAt: 0, resultAt: 120_000 },
        ],
        120_000,
      ),
    ).toEqual({ samples: [120_000, 120_000], capped: 1 });
  });
});

describe("singleStepChanges (R19a: P4's single-step sample)", () => {
  for (const shape of Object.values(shapes)) {
    it(`${shape.name}: has pipeline-200's screen/page and change mix, proportionally`, () => {
      const n = shape.pipelineSets["pipeline-200"];
      const full = mixCounts(
        "pipeline-200",
        changeMix(n, mixSeed("pipeline-200")),
      );
      const changes = singleStepChanges(shape);
      const sample = mixCounts("pipeline-200", changes);
      const k = changes.length;
      for (const field of [
        "screen",
        "page",
        "none",
        "small",
        "large",
      ] as const) {
        expect(sample[field] * n).toBe(full[field] * k);
      }
    });
  }

  it("is 20 steps on large (14/6 screens/pages, 14/5/1) and 10 on smoke", () => {
    expect(mixCounts("pipeline-200", singleStepChanges(shapes.large))).toEqual({
      screen: 14,
      page: 6,
      none: 14,
      small: 5,
      large: 1,
    });
    expect(singleStepChanges(shapes.smoke)).toHaveLength(10);
  });
});

describe("statusSequence (R24: transitions from the event stream)", () => {
  it("merges observations in time order and collapses repeats", () => {
    expect(
      statusSequence("running", [
        { at: 3, status: "unresolved" },
        { at: 1, status: "running" },
        { at: 5, status: "running" },
        { at: 6, status: "running" },
        { at: 9, status: "unresolved" },
      ]),
    ).toEqual(["running", "unresolved", "running", "unresolved"]);
  });

  it("is the initial status alone when nothing was observed", () => {
    expect(statusSequence("running", [])).toEqual(["running"]);
  });
});

describe("runCompletedStatus (R24: the statuses the run channel announces)", () => {
  it("reads the diff worker's run.completed, published once per status change", () => {
    expect(
      runCompletedStatus(
        JSON.stringify({
          type: "run.completed",
          runId: "r1",
          projectId: "p1",
          status: "unresolved",
          numChanges: 3,
        }),
      ),
    ).toBe("unresolved");
  });

  it("ignores run.checkpoint_diffed: a step's verdict is no run status", () => {
    expect(
      runCompletedStatus(
        JSON.stringify({
          type: "run.checkpoint_diffed",
          runId: "r1",
          screenshotId: "s1",
          verdict: "passed",
          failed: false,
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores the api's run.completed, whose status is nested in payload", () => {
    expect(
      runCompletedStatus(
        JSON.stringify({
          type: "run.completed",
          runId: "r1",
          payload: { status: "running", checkpointCount: 3 },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores a run.completed whose status is not a string", () => {
    expect(
      runCompletedStatus(JSON.stringify({ type: "run.completed", status: 3 })),
    ).toBeUndefined();
  });

  it("ignores anything that is not a JSON object", () => {
    expect(runCompletedStatus("not json")).toBeUndefined();
    expect(runCompletedStatus("null")).toBeUndefined();
    expect(runCompletedStatus('"run.completed"')).toBeUndefined();
  });
});

describe("formatSequence", () => {
  it("joins a short sequence", () => {
    expect(formatSequence(["running", "unresolved"])).toBe(
      "running→unresolved",
    );
  });

  it("truncates a long one, keeping the last status and the length", () => {
    const seq = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? "running" : "passed",
    );
    expect(formatSequence(seq, 4)).toBe(
      "running→passed→running→…→passed (20 statuses)",
    );
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
      failedSteps: 0,
    });
  });

  it("counts a failed step as a lost result, not as an unresolved step without a region", () => {
    const steps = [
      { id: "s1", verdict: "unresolved", failed: true },
      { id: "s2", verdict: "unresolved", failed: false },
      { id: "s3", verdict: "passed", failed: false },
    ];
    expect(raceLosses(steps, [region("s2", { x: 1 })])).toEqual({
      duplicates: 0,
      nullVerdicts: 0,
      unresolvedWithoutRegion: 0,
      failedSteps: 1,
    });
  });
});

describe("pairedSteps", () => {
  it("counts the steps a threshold re-diff queues: every verdict but new", () => {
    expect(
      pairedSteps([
        { id: "s1", verdict: "unresolved" },
        { id: "s2", verdict: "passed" },
        { id: "s3", verdict: "new" },
        { id: "s4", verdict: "unresolved", failed: true },
        { id: "s5", verdict: null },
      ]),
    ).toBe(4);
  });

  it("is zero for a run of new steps only", () => {
    expect(pairedSteps([{ id: "s1", verdict: "new" }])).toBe(0);
  });
});

describe("rediffShortfall", () => {
  it("is undefined once every paired step added a checkpoint diff", () => {
    expect(
      rediffShortfall({ steps: 10, paired: 9, rediffed: 9, failedAfter: 0 }),
    ).toBeUndefined();
  });

  it("says the re-diff did not run in full when diffs are missing", () => {
    expect(
      rediffShortfall({ steps: 10, paired: 10, rediffed: 7, failedAfter: 0 }),
    ).toBe(
      "the ground-truth re-diff did not run in full: 7 checkpoint diffs for 10 paired steps (of 10)",
    );
  });

  it("stays strict when a step's diff failed again, and names the failed steps", () => {
    expect(
      rediffShortfall({ steps: 10, paired: 10, rediffed: 9, failedAfter: 1 }),
    ).toBe(
      "the ground-truth re-diff did not run in full: 9 checkpoint diffs for 10 paired steps (of 10); 1 steps read as failed after it, and a failed diff observes no checkpoint",
    );
  });

  it("refuses a run with no paired step: the ground truth would be vacuous", () => {
    expect(
      rediffShortfall({ steps: 3, paired: 0, rediffed: 0, failedAfter: 0 }),
    ).toBe(
      "the ground-truth re-diff did not run in full: 0 checkpoint diffs for 0 paired steps (of 3)",
    );
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

  it("counts a step whose diff failed on one side only", () => {
    expect(
      stepDifferences(
        {
          steps: [{ id: "s1", verdict: "unresolved", failed: true }],
          regions: [],
        },
        { steps: [{ id: "s1", verdict: "unresolved" }], regions: [] },
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

describe("parseJsonObject", () => {
  it("returns a JSON object as it is", () => {
    expect(
      parseJsonObject('{"event":"testRun_updated","data":{"id":"r1"}}'),
    ).toEqual({
      event: "testRun_updated",
      data: { id: "r1" },
    });
  });

  it("is undefined for anything that is not JSON or not an object", () => {
    expect(parseJsonObject("not json")).toBeUndefined();
    expect(parseJsonObject("null")).toBeUndefined();
    expect(parseJsonObject("42")).toBeUndefined();
  });
});
