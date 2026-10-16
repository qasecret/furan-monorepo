import { describe, expect, test } from "vitest";

import {
  transformFor,
  worldToCanvas,
} from "../src/components/diff-viewer/viewer-geometry";
import { computeFocusView } from "../src/components/diff-viewer/world-fit";

describe("computeFocusView", () => {
  test("centers the bbox center at the canvas center", () => {
    const v = computeFocusView(
      { x: 40, y: 40, width: 20, height: 20 },
      100,
      100,
      100,
      100,
    );
    expect(Math.round(v.panX)).toBe(0);
    expect(Math.round(v.panY)).toBe(0);
    expect(v.zoom).toBeGreaterThan(1);
  });

  test("pans a corner bbox toward center", () => {
    const v = computeFocusView(
      { x: 0, y: 0, width: 10, height: 10 },
      100,
      100,
      100,
      100,
    );
    expect(v.panX).toBeGreaterThan(0);
    expect(v.panY).toBeGreaterThan(0);
  });

  test("clamps zoom to ZOOM_MAX", () => {
    const v = computeFocusView(
      { x: 0, y: 0, width: 1, height: 1 },
      100,
      100,
      100,
      100,
    );
    expect(v.zoom).toBeLessThanOrEqual(8);
  });

  test("frames the bbox in the world the stage draws: its centre lands on the canvas centre", () => {
    // A 100×300 world (side by side with a shorter baseline) in an 800×600
    // canvas, focused on a region near its bottom.
    const bbox = { x: 20, y: 250, width: 30, height: 20 };
    const view = computeFocusView(bbox, 100, 300, 800, 600);
    const t = transformFor({ w: 100, h: 300 }, { w: 800, h: 600 }, view);
    const centre = worldToCanvas(t, { x: 35, y: 260 });
    expect(centre.x).toBeCloseTo(400, 9);
    expect(centre.y).toBeCloseTo(300, 9);
  });
});
