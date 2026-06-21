import { describe, expect, it, test } from "vitest";

import { orderDiffRegions } from "../src/components/diff-viewer/diff-order";
import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";

function region(p: Partial<DiffRegion>): DiffRegion {
  return {
    id: "x",
    severity: "minor",
    category: "text",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    description: "",
    source: "l2",
    ...p,
  };
}

describe("orderDiffRegions", () => {
  test("orders worst-severity first, then larger area", () => {
    const out = orderDiffRegions([
      region({
        id: "minor-big",
        severity: "minor",
        bbox: { x: 0, y: 0, width: 100, height: 100 },
      }),
      region({
        id: "breaking",
        severity: "breaking",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
      }),
      region({
        id: "major",
        severity: "major",
        bbox: { x: 0, y: 0, width: 5, height: 5 },
      }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["breaking", "major", "minor-big"]);
  });

  test("drops dynamic_text audit rows but keeps l2 regions", () => {
    const out = orderDiffRegions([
      region({ id: "keep", source: "l2" }),
      region({ id: "audit", source: "dynamic_text" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["keep"]);
  });

  test("drops layout_suppressed audit rows but keeps layout_kept (ADR-053)", () => {
    const out = orderDiffRegions([
      region({ id: "kept", source: "layout_kept" }),
      region({ id: "suppressed", source: "layout_suppressed" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["kept"]);
  });

  it("includes l1_pixel regions, ordered by severity then area", () => {
    const regions = [
      region({
        id: "a",
        severity: "minor",
        category: "image",
        source: "l1_pixel",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
      }),
      region({
        id: "b",
        severity: "major",
        category: "image",
        source: "l1_pixel",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
      }),
    ];
    const ordered = orderDiffRegions(regions);
    expect(ordered.map((r) => r.id)).toEqual(["b", "a"]); // major before minor
  });

  test("hideDisplacement drops layout-category regions", () => {
    const out = orderDiffRegions(
      [
        region({ id: "text", category: "text" }),
        region({ id: "moved", category: "layout" }),
      ],
      { hideDisplacement: true },
    );
    expect(out.map((r) => r.id)).toEqual(["text"]);
  });
});
