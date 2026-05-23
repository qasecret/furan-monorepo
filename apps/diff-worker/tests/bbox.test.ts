import { describe, expect, it } from "vitest";

import { bboxIntersects } from "../src/bbox.js";

describe("bboxIntersects", () => {
  const a = { x: 10, y: 10, width: 20, height: 20 }; // (10,10) → (30,30)

  it("returns true for identical bboxes", () => {
    expect(bboxIntersects(a, a)).toBe(true);
  });

  it("returns true when one is fully contained in the other", () => {
    expect(bboxIntersects(a, { x: 15, y: 15, width: 5, height: 5 })).toBe(true);
  });

  it("returns true for partial overlap on the corner", () => {
    expect(bboxIntersects(a, { x: 25, y: 25, width: 20, height: 20 })).toBe(
      true,
    );
  });

  it("returns false when bboxes touch on an edge (no interior overlap)", () => {
    // a's right edge is x=30; b starts at x=30 → no overlap (exclusive upper bound).
    expect(bboxIntersects(a, { x: 30, y: 10, width: 10, height: 20 })).toBe(
      false,
    );
  });

  it("returns false when bboxes touch on the bottom edge (no interior overlap)", () => {
    // a's bottom edge is y=30; b starts at y=30 → no overlap (y-axis symmetric to the x-axis edge-touch case).
    expect(bboxIntersects(a, { x: 10, y: 30, width: 20, height: 10 })).toBe(
      false,
    );
  });

  it("returns false when bboxes are fully apart", () => {
    expect(bboxIntersects(a, { x: 100, y: 100, width: 10, height: 10 })).toBe(
      false,
    );
  });

  it("returns false when either bbox is zero-width", () => {
    expect(bboxIntersects(a, { x: 15, y: 15, width: 0, height: 10 })).toBe(
      false,
    );
    expect(bboxIntersects({ x: 0, y: 0, width: 0, height: 0 }, a)).toBe(false);
  });

  it("returns false when a is zero-width (height is non-zero)", () => {
    expect(bboxIntersects({ x: 15, y: 15, width: 0, height: 10 }, a)).toBe(
      false,
    );
  });

  it("returns false when either bbox is zero-height", () => {
    expect(bboxIntersects(a, { x: 15, y: 15, width: 10, height: 0 })).toBe(
      false,
    );
  });

  it("returns false when a is zero-height (width is non-zero)", () => {
    expect(bboxIntersects({ x: 15, y: 15, width: 10, height: 0 }, a)).toBe(
      false,
    );
  });
});
