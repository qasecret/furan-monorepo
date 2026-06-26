import { describe, expect, it } from "vitest";

import {
  applyHandleResize,
  applyMove,
  hitTestHandle,
  isInsideBbox,
  MIN_REGION_PX,
} from "../src/components/diff-viewer/region-resize";

const BOX = { x: 100, y: 100, width: 200, height: 100 };

describe("region-resize", () => {
  it("hit-tests handles within tolerance, prefers corners", () => {
    expect(hitTestHandle({ x: 100, y: 100 }, BOX, 6)).toBe("nw");
    expect(hitTestHandle({ x: 300, y: 200 }, BOX, 6)).toBe("se");
    expect(hitTestHandle({ x: 200, y: 100 }, BOX, 6)).toBe("n"); // top edge mid
    expect(hitTestHandle({ x: 250, y: 150 }, BOX, 6)).toBeNull(); // interior
  });

  it("resizes from a corner, moving two edges", () => {
    // Drag SE corner out to (360, 260): left/top fixed, w/h grow.
    expect(applyHandleResize("se", BOX, { x: 360, y: 260 })).toEqual({
      x: 100,
      y: 100,
      width: 260,
      height: 160,
    });
    // Drag NW corner in to (140, 130): right/bottom fixed.
    expect(applyHandleResize("nw", BOX, { x: 140, y: 130 })).toEqual({
      x: 140,
      y: 130,
      width: 160,
      height: 70,
    });
  });

  it("resizes from an edge, moving one axis only", () => {
    // East handle to x=400: width grows, y/height untouched.
    expect(applyHandleResize("e", BOX, { x: 400, y: 999 })).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 100,
    });
    // North handle to y=140: top moves down, x/width untouched.
    expect(applyHandleResize("n", BOX, { x: 999, y: 140 })).toEqual({
      x: 100,
      y: 140,
      width: 200,
      height: 60,
    });
  });

  it("normalizes when a handle is dragged past its anchor", () => {
    // Drag SE corner above-left of NW: box flips, stays positive + min-size.
    const r = applyHandleResize("se", BOX, { x: 100, y: 100 });
    expect(r.width).toBe(MIN_REGION_PX);
    expect(r.height).toBe(MIN_REGION_PX);
  });

  it("moves within image bounds (clamped)", () => {
    expect(applyMove(BOX, 50, 25, 1280, 720)).toEqual({
      x: 150,
      y: 125,
      width: 200,
      height: 100,
    });
    // Clamp: can't push the right edge past the image width.
    expect(applyMove(BOX, 5000, 0, 1280, 720).x).toBe(1280 - 200);
    expect(applyMove(BOX, -5000, 0, 1280, 720).x).toBe(0);
  });

  it("isInsideBbox", () => {
    expect(isInsideBbox({ x: 150, y: 150 }, BOX)).toBe(true);
    expect(isInsideBbox({ x: 50, y: 150 }, BOX)).toBe(false);
  });
});
