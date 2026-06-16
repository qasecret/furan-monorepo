import { describe, expect, test } from "vitest";

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
});
