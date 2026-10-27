import { describe, expect, test } from "vitest";

import { stepNumber } from "../src/components/diff-viewer/step-number";

const own = (
  diffGeneration: number,
  diffPercent: number | null,
  vlmDescription: string | null = null,
) => ({ diffGeneration, diffPercent, vlmDescription });

describe("stepNumber", () => {
  test.each([0, 1, 4])(
    "a step's own value is shown, whatever its generation (%i)",
    (gen) => {
      expect(stepNumber(own(gen, 1.25), "diffPercent", 9)).toBe(1.25);
      expect(
        stepNumber(own(gen, null, "A banner"), "vlmDescription", "Run"),
      ).toBe("A banner");
    },
  );

  test("a legacy step (generation 0) with none falls back to the run's", () => {
    expect(stepNumber(own(0, null), "diffPercent", 9)).toBe(9);
    expect(stepNumber(own(0, null, null), "vlmDescription", "Run text")).toBe(
      "Run text",
    );
  });

  test("a newer step with none has none, never the run's (R46)", () => {
    expect(stepNumber(own(1, null), "diffPercent", 9)).toBeNull();
    expect(
      stepNumber(own(3, null, null), "vlmDescription", "Run text"),
    ).toBeNull();
  });

  test.each([0, 1])(
    "a real 0 is kept, never replaced by the run's (generation %i)",
    (gen) => {
      expect(stepNumber(own(gen, 0), "diffPercent", 9)).toBe(0);
    },
  );

  test("an item that carries no generation is not legacy", () => {
    expect(
      stepNumber({ diffPercent: null } as never, "diffPercent", 9),
    ).toBeNull();
  });

  test("with no step known yet, the run's value stands", () => {
    expect(stepNumber(undefined, "diffPercent", 9)).toBe(9);
    expect(stepNumber(undefined, "diffPercent", undefined)).toBeNull();
  });
});
