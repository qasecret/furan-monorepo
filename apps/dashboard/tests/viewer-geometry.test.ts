import { describe, expect, test } from "vitest";

import {
  canvasToWorld,
  clampZoom,
  fitScale,
  transformFor,
  worldFor,
  worldToCanvas,
  zoomAbout,
  type Rect,
  type View,
} from "../src/components/diff-viewer/viewer-geometry";

const area = (rects: Rect[]): number =>
  rects.reduce((sum, r) => sum + r.w * r.h, 0);

describe("worldFor", () => {
  test("is the union of the image sizes, anchored top-left", () => {
    const w = worldFor({ w: 100, h: 200 }, { w: 100, h: 300 }, null);
    expect(w.size).toEqual({ w: 100, h: 300 });
    expect(w.rects.baseline).toEqual({ x: 0, y: 0, w: 100, h: 200 });
    expect(w.rects.current).toEqual({ x: 0, y: 0, w: 100, h: 300 });
    expect(w.rects.diff).toBeNull();
    expect(w.missing.baseline).toEqual([{ x: 0, y: 200, w: 100, h: 100 }]);
    expect(w.missing.current).toEqual([]);
  });

  test("reports the bottom strip for one image and the right strip for the other", () => {
    const w = worldFor({ w: 120, h: 100 }, { w: 100, h: 150 }, null);
    expect(w.size).toEqual({ w: 120, h: 150 });
    expect(w.missing.baseline).toEqual([{ x: 0, y: 100, w: 120, h: 50 }]);
    expect(w.missing.current).toEqual([{ x: 100, y: 0, w: 20, h: 150 }]);
  });

  test("an image short in both directions gets a right strip and a bottom strip that do not overlap", () => {
    const w = worldFor({ w: 60, h: 40 }, { w: 100, h: 150 }, null);
    expect(w.size).toEqual({ w: 100, h: 150 });
    expect(w.missing.baseline).toEqual([
      { x: 60, y: 0, w: 40, h: 150 },
      { x: 0, y: 40, w: 60, h: 110 },
    ]);
    // Strip areas add up to exactly the uncovered area: no double counting.
    expect(area(w.missing.baseline)).toBe(100 * 150 - 60 * 40);
    expect(w.missing.current).toEqual([]);
  });

  test("with no baseline the world is the current image", () => {
    const w = worldFor(null, { w: 80, h: 90 }, null);
    expect(w.size).toEqual({ w: 80, h: 90 });
    expect(w.rects.baseline).toBeNull();
    expect(w.rects.current).toEqual({ x: 0, y: 0, w: 80, h: 90 });
    expect(w.missing.baseline).toEqual([]);
    expect(w.missing.current).toEqual([]);
  });

  test("the diff image takes part in the union and is anchored top-left", () => {
    const w = worldFor(
      { w: 100, h: 100 },
      { w: 100, h: 100 },
      { w: 130, h: 90 },
    );
    expect(w.size).toEqual({ w: 130, h: 100 });
    expect(w.rects.diff).toEqual({ x: 0, y: 0, w: 130, h: 90 });
    expect(w.missing.baseline).toEqual([{ x: 100, y: 0, w: 30, h: 100 }]);
    expect(w.missing.current).toEqual([{ x: 100, y: 0, w: 30, h: 100 }]);
  });

  test("identical sizes leave nothing missing", () => {
    const w = worldFor({ w: 50, h: 50 }, { w: 50, h: 50 }, null);
    expect(w.missing).toEqual({ baseline: [], current: [] });
  });

  test("an image with no area leaves no zero-area strip", () => {
    // A 0×0 baseline is short on both axes, but its bottom strip would be 0
    // wide: only the right strip, which is the whole world, is missing.
    const w = worldFor({ w: 0, h: 0 }, { w: 100, h: 50 }, null);
    expect(w.missing.baseline).toEqual([{ x: 0, y: 0, w: 100, h: 50 }]);
    // A world with no height: the narrower image's right strip has no area.
    const flat = worldFor({ w: 50, h: 0 }, { w: 100, h: 0 }, null);
    expect(flat.missing).toEqual({ baseline: [], current: [] });
  });
});

describe("fitScale", () => {
  test("caps the upscale at 2", () => {
    expect(fitScale({ w: 100, h: 100 }, { w: 1000, h: 1000 })).toBe(2);
  });

  test("floors at 0.05", () => {
    expect(fitScale({ w: 100000, h: 10 }, { w: 100, h: 100 })).toBe(0.05);
  });

  test("fits the limiting axis in between", () => {
    expect(fitScale({ w: 400, h: 100 }, { w: 200, h: 200 })).toBe(0.5);
  });

  test("is 1 for degenerate sizes", () => {
    expect(fitScale({ w: 0, h: 100 }, { w: 100, h: 100 })).toBe(1);
    expect(fitScale({ w: 100, h: 100 }, { w: 0, h: 0 })).toBe(1);
  });
});

describe("transformFor", () => {
  const world = { w: 200, h: 100 };
  const viewport = { w: 400, h: 400 };

  test("centres the world at fit scale for the identity view", () => {
    const t = transformFor(world, viewport, { zoom: 1, panX: 0, panY: 0 });
    expect(t.scale).toBe(2);
    expect(t.x).toBe(0);
    expect(t.y).toBe(100);
  });

  test("applies zoom about the centre, then pan in world px", () => {
    const t = transformFor(world, viewport, { zoom: 2, panX: 10, panY: -5 });
    expect(t.scale).toBe(4);
    expect(t.x).toBe((400 - 200 * 4) / 2 + 10 * 4);
    expect(t.y).toBe((400 - 100 * 4) / 2 - 5 * 4);
  });

  test("the same view shows the same world point at the centre of any viewport (R12)", () => {
    const w = { w: 1440, h: 900 };
    const view = { zoom: 4, panX: 720 - 1200, panY: 0 };
    for (const vp of [
      { w: 1000, h: 625 },
      { w: 488, h: 305 },
      { w: 1913, h: 1200 },
    ]) {
      const centre = worldToCanvas(transformFor(w, vp, view), {
        x: 1200,
        y: 450,
      });
      expect(centre.x).toBeCloseTo(vp.w / 2, 9);
      expect(centre.y).toBeCloseTo(vp.h / 2, 9);
    }
  });
});

describe("zoomAbout", () => {
  const world = { w: 800, h: 600 };
  const viewport = { w: 500, h: 400 };
  const start: View = { zoom: 1.5, panX: 30, panY: -12 };

  test("keeps the canvas point fixed over the same world point", () => {
    const point = { x: 123, y: 321 };
    const before = transformFor(world, viewport, start);
    const anchor = canvasToWorld(before, point);
    const next = zoomAbout(start, 1.25, point, world, viewport);
    expect(next.zoom).toBeCloseTo(1.5 * 1.25, 12);
    const after = worldToCanvas(transformFor(world, viewport, next), anchor);
    expect(after.x).toBeCloseTo(point.x, 6);
    expect(after.y).toBeCloseTo(point.y, 6);
  });

  test("keeps the point fixed when zooming out too", () => {
    const point = { x: 480, y: 20 };
    const before = transformFor(world, viewport, start);
    const anchor = canvasToWorld(before, point);
    const next = zoomAbout(start, 1 / 1.25, point, world, viewport);
    const after = worldToCanvas(transformFor(world, viewport, next), anchor);
    expect(after.x).toBeCloseTo(point.x, 6);
    expect(after.y).toBeCloseTo(point.y, 6);
  });

  test("clamps the zoom at 8", () => {
    const point = { x: 250, y: 200 };
    const near: View = { zoom: 7.5, panX: 0, panY: 0 };
    const next = zoomAbout(near, 1.25, point, world, viewport);
    expect(next.zoom).toBe(8);
    // Still anchored at the clamped zoom.
    const anchor = canvasToWorld(transformFor(world, viewport, near), point);
    const after = worldToCanvas(transformFor(world, viewport, next), anchor);
    expect(after.x).toBeCloseTo(point.x, 6);
    expect(after.y).toBeCloseTo(point.y, 6);
  });

  test("clamps the zoom at 0.25", () => {
    const point = { x: 10, y: 390 };
    const near: View = { zoom: 0.3, panX: 0, panY: 0 };
    const next = zoomAbout(near, 0.5, point, world, viewport);
    expect(next.zoom).toBe(0.25);
    const anchor = canvasToWorld(transformFor(world, viewport, near), point);
    const after = worldToCanvas(transformFor(world, viewport, next), anchor);
    expect(after.x).toBeCloseTo(point.x, 6);
    expect(after.y).toBeCloseTo(point.y, 6);
  });

  test("a factor that is not a number gives a finite view, at fit zoom", () => {
    for (const factor of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = zoomAbout(start, factor, { x: 1, y: 2 }, world, viewport);
      expect(next.zoom, String(factor)).toBe(1);
      expect(Number.isFinite(next.panX), String(factor)).toBe(true);
      expect(Number.isFinite(next.panY), String(factor)).toBe(true);
    }
  });
});

describe("clampZoom", () => {
  test("clamps to 0.25–8", () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(20)).toBe(8);
  });

  test("a zoom that is not a number is fit (1)", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe("coordinate conversion", () => {
  test("canvasToWorld inverts worldToCanvas", () => {
    const t = transformFor(
      { w: 640, h: 480 },
      { w: 500, h: 300 },
      {
        zoom: 3.2,
        panX: -41,
        panY: 17,
      },
    );
    const p = { x: 217.5, y: 88.25 };
    const back = canvasToWorld(t, worldToCanvas(t, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  test("worldToCanvas applies scale then offset", () => {
    expect(worldToCanvas({ scale: 2, x: 10, y: 20 }, { x: 5, y: 7 })).toEqual({
      x: 20,
      y: 34,
    });
  });
});
