import { describe, expect, it } from "vitest";

import { selectorMatcher } from "../../src/matchers/selector.js";
import type { Bbox, DiffRegion, ElementMap } from "../../src/types.js";

function region(bbox: Bbox, id = "r1"): DiffRegion {
  return {
    id,
    severity: "major",
    category: "layout",
    bbox,
    description: "test",
    source: "l1",
    diffPercent: 5,
  };
}

describe("selectorMatcher", () => {
  it("matches when selector bbox overlaps region", () => {
    const elementMap: ElementMap = [
      {
        selector: ".timestamp",
        bbox: { x: 10, y: 10, width: 100, height: 50 },
      },
    ];
    const r = region({ x: 20, y: 20, width: 50, height: 30 });
    const result = selectorMatcher(".timestamp", r, elementMap);
    expect(result.matched).toBe(true);
    expect(result.overlap).toBeGreaterThan(0);
    expect(result.resolvedSelector).toBe(".timestamp");
  });

  it("returns not matched when selector not in element-map", () => {
    const elementMap: ElementMap = [
      { selector: ".other", bbox: { x: 10, y: 10, width: 100, height: 50 } },
    ];
    const r = region({ x: 20, y: 20, width: 50, height: 30 });
    const result = selectorMatcher(".timestamp", r, elementMap);
    expect(result.matched).toBe(false);
    expect(result.overlap).toBe(0);
  });

  it("returns not matched when element-map is null", () => {
    const r = region({ x: 20, y: 20, width: 50, height: 30 });
    const result = selectorMatcher(".timestamp", r, null);
    expect(result.matched).toBe(false);
  });

  it("returns not matched when bboxes don't overlap", () => {
    const elementMap: ElementMap = [
      {
        selector: ".timestamp",
        bbox: { x: 500, y: 500, width: 100, height: 50 },
      },
    ];
    const r = region({ x: 20, y: 20, width: 50, height: 30 });
    const result = selectorMatcher(".timestamp", r, elementMap);
    expect(result.matched).toBe(false);
    expect(result.overlap).toBe(0);
  });

  it("unions multiple matching bboxes", () => {
    const elementMap: ElementMap = [
      { selector: ".ts", bbox: { x: 0, y: 0, width: 50, height: 50 } },
      { selector: ".ts", bbox: { x: 100, y: 0, width: 50, height: 50 } },
    ];
    const r = region({ x: 0, y: 0, width: 150, height: 50 });
    const result = selectorMatcher(".ts", r, elementMap);
    expect(result.matched).toBe(true);
    expect(result.overlap).toBeGreaterThan(0);
  });

  it("returns not matched for zero-area region", () => {
    const r = region({ x: 20, y: 20, width: 0, height: 30 });
    const result = selectorMatcher(".ts", r, null);
    expect(result.matched).toBe(false);
  });
});
