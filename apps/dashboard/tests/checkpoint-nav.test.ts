import { describe, expect, test } from "vitest";

import { summarizeCheckpoints } from "../src/components/diff-viewer/checkpoint-nav";

const step = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  name: "home" as string | null,
  state: "unresolved" as string | null,
  diffPercent: 1.25 as number | null,
  diffGeneration: 1,
  vlmDescription: null,
  ...over,
});

describe("summarizeCheckpoints", () => {
  test("each step's diffPercent is its own, not the run's", () => {
    const out = summarizeCheckpoints(
      [step(), step({ id: "c2", name: "search", diffPercent: 7.5 })],
      9,
    );
    expect(out.map((s) => s.diffPercent)).toEqual([1.25, 7.5]);
  });

  test("a step from before per-step diffs takes the run's value; a newer one with none stays null", () => {
    const out = summarizeCheckpoints(
      [
        step({ id: "old", diffPercent: null, diffGeneration: 0 }),
        step({ id: "new", diffPercent: null, diffGeneration: 1 }),
      ],
      9,
    );
    expect(out.map((s) => s.diffPercent)).toEqual([9, null]);
  });

  test("keeps a real 0 and the step's id, name and state", () => {
    const [s] = summarizeCheckpoints(
      [step({ diffPercent: 0, diffGeneration: 0 })],
      9,
    );
    expect(s).toEqual({
      id: "c1",
      name: "home",
      state: "unresolved",
      diffPercent: 0,
    });
  });

  test("an unnamed step is named by its id", () => {
    const [s] = summarizeCheckpoints([step({ name: null })], null);
    expect(s!.name).toBe("c1");
  });
});
