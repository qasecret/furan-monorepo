import { describe, expect, test } from "vitest";

import {
  SEVERITIES,
  SEVERITY_LABEL,
  compareSeverity,
  isSeverity,
  severityRank,
  severitySchema,
  worstSeverity,
} from "./severity.js";

describe("severity table", () => {
  test("SEVERITIES lists the tiers from worst to none", () => {
    expect(SEVERITIES).toEqual([
      "breaking",
      "major",
      "minor",
      "cosmetic",
      "none",
    ]);
  });

  test("severitySchema accepts exactly the tiers", () => {
    for (const s of SEVERITIES) {
      expect(severitySchema.parse(s)).toBe(s);
    }
    expect(severitySchema.safeParse("critical").success).toBe(false);
  });

  test("severityRank maps breaking 4 down to none 0", () => {
    expect(SEVERITIES.map(severityRank)).toEqual([4, 3, 2, 1, 0]);
  });

  test("compareSeverity sorts the worst first", () => {
    expect([...SEVERITIES].reverse().sort(compareSeverity)).toEqual([
      ...SEVERITIES,
    ]);
    expect(compareSeverity("breaking", "minor")).toBeLessThan(0);
    expect(compareSeverity("minor", "breaking")).toBeGreaterThan(0);
    expect(compareSeverity("major", "major")).toBe(0);
  });

  test("worstSeverity returns the worst tier, or null for none given", () => {
    expect(worstSeverity(["minor", "breaking", "none"])).toBe("breaking");
    expect(worstSeverity(["cosmetic"])).toBe("cosmetic");
    expect(worstSeverity([])).toBeNull();
  });

  test("isSeverity narrows only real tiers", () => {
    expect(isSeverity("major")).toBe(true);
    expect(isSeverity("critical")).toBe(false);
    expect(isSeverity(3)).toBe(false);
    expect(isSeverity(null)).toBe(false);
  });

  test("SEVERITY_LABEL is the display name of every tier", () => {
    expect(SEVERITY_LABEL).toEqual({
      breaking: "Breaking",
      major: "Major",
      minor: "Minor",
      cosmetic: "Cosmetic",
      none: "None",
    });
  });
});
