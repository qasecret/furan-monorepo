import { Container, type Graphics } from "pixi.js";
import { describe, expect, test, vi } from "vitest";

import {
  drawHatch,
  HATCH_ALPHA,
  HATCH_SPACING,
  mountHatchLayer,
} from "../src/components/diff-viewer/layers/HatchLayer";

// A Graphics that records its path and strokes.
vi.mock("pixi.js", () => {
  class Graphics {
    label = "";
    ops: Array<[string, number, number]> = [];
    strokes: Array<Record<string, unknown>> = [];
    moveTo(x: number, y: number) {
      this.ops.push(["moveTo", x, y]);
      return this;
    }
    lineTo(x: number, y: number) {
      this.ops.push(["lineTo", x, y]);
      return this;
    }
    stroke(style: Record<string, unknown>) {
      this.strokes.push(style);
      return this;
    }
    clear() {
      this.ops = [];
      this.strokes = [];
      return this;
    }
  }
  class Container {
    children: unknown[] = [];
    addChild<T>(c: T): T {
      this.children.push(c);
      return c;
    }
  }
  return { Graphics, Container };
});

interface Recorded {
  ops: Array<[string, number, number]>;
  strokes: Array<Record<string, unknown>>;
}

/** The hatch's line segments, as [x1, y1, x2, y2]. */
function segments(g: Recorded): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i + 1 < g.ops.length; i += 2) {
    const [a, x1, y1] = g.ops[i]!;
    const [b, x2, y2] = g.ops[i + 1]!;
    expect([a, b]).toEqual(["moveTo", "lineTo"]);
    out.push([x1, y1, x2, y2]);
  }
  return out;
}

describe("mountHatchLayer", () => {
  test("is added to its parent, one stroke in the colour at alpha 0.35", () => {
    const parent = new Container();
    const g = mountHatchLayer(
      parent,
      [{ x: 0, y: 200, w: 100, h: 100 }],
      0x6a6a73,
    ) as unknown as Recorded;
    expect((parent as unknown as { children: unknown[] }).children).toEqual([
      g,
    ]);
    expect(HATCH_ALPHA).toBe(0.35);
    expect(g.strokes).toEqual([
      expect.objectContaining({ color: 0x6a6a73, alpha: 0.35 }),
    ]);
  });

  test("draws 45° lines every 8 px, clipped to the rect", () => {
    const rect = { x: 0, y: 200, w: 100, h: 100 };
    const g = mountHatchLayer(
      new Container(),
      [rect],
      0,
    ) as unknown as Recorded;
    const lines = segments(g);
    expect(HATCH_SPACING).toBe(8);
    expect(lines.length).toBeGreaterThan(20);
    for (const [x1, y1, x2, y2] of lines) {
      // Each line climbs one for one: 45°.
      expect(x2 - x1).toBeCloseTo(y1 - y2, 9);
      expect(x2).toBeGreaterThan(x1);
      for (const [x, y] of [
        [x1, y1],
        [x2, y2],
      ] as const) {
        expect(x).toBeGreaterThanOrEqual(rect.x);
        expect(x).toBeLessThanOrEqual(rect.x + rect.w);
        expect(y).toBeGreaterThanOrEqual(rect.y);
        expect(y).toBeLessThanOrEqual(rect.y + rect.h);
      }
    }
    // Neighbouring lines are 8 px apart along x + y.
    const sums = lines.map(([x1, y1]) => x1 + y1).sort((a, b) => a - b);
    for (let i = 1; i < sums.length; i++) {
      expect(sums[i]! - sums[i - 1]!).toBeCloseTo(HATCH_SPACING, 9);
    }
  });

  test("no rects, or rects with no area, draw nothing", () => {
    const g = mountHatchLayer(
      new Container(),
      [
        { x: 0, y: 0, w: 0, h: 50 },
        { x: 0, y: 0, w: 50, h: 0 },
      ],
      0,
    ) as unknown as Recorded;
    expect(g.ops).toEqual([]);
    expect(g.strokes).toEqual([]);
  });

  test("a redraw replaces the lines and the colour", () => {
    const g = mountHatchLayer(
      new Container(),
      [{ x: 0, y: 0, w: 40, h: 40 }],
      0x111111,
    );
    drawHatch(g, [{ x: 100, y: 0, w: 16, h: 16 }], 0x222222);
    const rec = g as unknown as Recorded;
    for (const [x1, , x2] of segments(rec)) {
      expect(x1).toBeGreaterThanOrEqual(100);
      expect(x2).toBeLessThanOrEqual(116);
    }
    expect(rec.strokes).toEqual([expect.objectContaining({ color: 0x222222 })]);
  });

  test("takes the spacing in world px, for a screen spacing under a scale", () => {
    const g = mountHatchLayer(
      new Container(),
      [{ x: 0, y: 0, w: 40, h: 40 }],
      0,
      2,
    ) as unknown as Recorded;
    const sums = segments(g)
      .map(([x1, y1]) => x1 + y1)
      .sort((a, b) => a - b);
    for (let i = 1; i < sums.length; i++) {
      expect(sums[i]! - sums[i - 1]!).toBeCloseTo(2, 9);
    }
    // A spacing that is not a positive number falls back to the default.
    const fallback = segments(
      drawHatch(
        g as unknown as Graphics,
        [{ x: 0, y: 0, w: 40, h: 40 }],
        0,
        0,
      ) as unknown as Recorded,
    );
    expect(
      fallback[1]![0] + fallback[1]![1] - (fallback[0]![0] + fallback[0]![1]),
    ).toBeCloseTo(HATCH_SPACING, 9);
  });
});
