import { describe, expect, it } from "vitest";

import { maxDiffCondition } from "../../src/conditions/max-diff.js";
import type { DiffRegion, MatchCandidate } from "../../src/types.js";

const candidate: MatchCandidate = {
  matched: true,
  overlap: 0.8,
  resolvedSelector: ".ts",
};

function region(diffPercent: number): DiffRegion {
  return {
    id: "r1",
    severity: "major",
    category: "layout",
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    description: "test",
    source: "l1",
    diffPercent,
  };
}

describe("maxDiffCondition", () => {
  it("passes when region diffPercent is below threshold", () => {
    expect(maxDiffCondition(10, { region: region(5), candidate })).toBe(true);
  });

  it("passes when region diffPercent equals threshold", () => {
    expect(maxDiffCondition(5, { region: region(5), candidate })).toBe(true);
  });

  it("fails when region diffPercent exceeds threshold", () => {
    expect(maxDiffCondition(3, { region: region(5), candidate })).toBe(false);
  });

  it("passes when threshold is 100 (always pass)", () => {
    expect(maxDiffCondition(100, { region: region(99), candidate })).toBe(true);
  });

  it("passes when threshold is 0 and diff is 0", () => {
    expect(maxDiffCondition(0, { region: region(0), candidate })).toBe(true);
  });

  it("fails safe (returns false) for a NaN threshold", () => {
    expect(maxDiffCondition(NaN, { region: region(0), candidate })).toBe(false);
  });

  it("fails safe for a non-numeric (string) threshold", () => {
    expect(maxDiffCondition("ten", { region: region(0), candidate })).toBe(
      false,
    );
  });

  it("fails safe for an undefined/null threshold", () => {
    expect(maxDiffCondition(undefined, { region: region(0), candidate })).toBe(
      false,
    );
    expect(maxDiffCondition(null, { region: region(0), candidate })).toBe(
      false,
    );
  });
});
