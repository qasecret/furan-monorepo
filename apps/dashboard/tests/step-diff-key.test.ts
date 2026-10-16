import { describe, expect, test } from "vitest";

import { stepDiffKey } from "../src/components/diff-viewer/step-diff-key";

describe("stepDiffKey", () => {
  test("a step's own diff image wins over the run's", () => {
    expect(
      stepDiffKey(
        { diffImageKey: "k2" },
        { diffName: "k1", screenshotCount: 3 },
      ),
    ).toEqual({ key: "k2", legacyMissing: false });
  });

  test("a single-step run falls back to the run's diff image", () => {
    // Before per-step keys the run's diff image WAS the only step's.
    expect(
      stepDiffKey(
        { diffImageKey: null },
        { diffName: "k1", screenshotCount: 1 },
      ),
    ).toEqual({ key: "k1", legacyMissing: false });
  });

  test("a step of a multi-step run with no key of its own has no image", () => {
    // The run's image belongs to its worst step, never to this one: showing
    // it here would draw another step's diff.
    expect(
      stepDiffKey(
        { diffImageKey: null },
        { diffName: "k1", screenshotCount: 3 },
      ),
    ).toEqual({ key: null, legacyMissing: true });
    expect(stepDiffKey({}, { diffName: "k1", screenshotCount: 2 })).toEqual({
      key: null,
      legacyMissing: true,
    });
  });

  test("no step selected falls back to the run's diff image", () => {
    expect(stepDiffKey(null, { diffName: "k1", screenshotCount: 1 })).toEqual({
      key: "k1",
      legacyMissing: false,
    });
    // No step, so no wrong step to draw it on.
    expect(stepDiffKey(null, { diffName: "k1", screenshotCount: 3 })).toEqual({
      key: "k1",
      legacyMissing: false,
    });
  });

  test("nothing to show is not a missing legacy image", () => {
    expect(stepDiffKey({ diffImageKey: null }, { screenshotCount: 1 })).toEqual(
      { key: null, legacyMissing: false },
    );
    expect(
      stepDiffKey(
        { diffImageKey: null },
        { diffName: null, screenshotCount: 1 },
      ),
    ).toEqual({ key: null, legacyMissing: false });
  });
});
