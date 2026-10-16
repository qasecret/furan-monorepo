import { severityRank as sharedSeverityRank } from "@furan/shared-types";
import { describe, expect, test } from "vitest";

import { classifyRegions, severityRank } from "../src/classify.js";
import type { DiffRegion } from "../src/types.js";

function region(over: Partial<DiffRegion> = {}): DiffRegion {
  return {
    id: "r",
    severity: "minor",
    category: "color",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    description: "a region",
    source: "l1_pixel",
    ...over,
  };
}

describe("classify", () => {
  test("ranks via the shared table", () => {
    expect(severityRank).toBe(sharedSeverityRank);
  });

  test("orders regions worst severity first, then by area", () => {
    const sorted = classifyRegions([
      region({ id: "small-minor", severity: "minor" }),
      region({
        id: "big-minor",
        severity: "minor",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
      }),
      region({ id: "major", severity: "major" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      "major",
      "big-minor",
      "small-minor",
    ]);
  });

  test("upgrades a heading text change to breaking", () => {
    const [r] = classifyRegions([
      region({ category: "text", description: "heading text changed" }),
    ]);
    expect(r?.severity).toBe("breaking");
  });
});
