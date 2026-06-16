import { describe, expect, test } from "vitest";

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

  test("drops l1_pixel and dynamic_text audit rows", () => {
    const out = orderDiffRegions([
      region({ id: "keep", source: "l2" }),
      region({ id: "pixel", source: "l1_pixel" }),
      region({ id: "audit", source: "dynamic_text" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["keep"]);
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
