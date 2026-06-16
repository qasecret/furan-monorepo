import { Container } from "pixi.js";
import { describe, expect, test, vi } from "vitest";

import { mountDiffShadingLayer } from "../src/components/diff-viewer/layers/DiffShadingLayer";
import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";

vi.mock("pixi.js", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
      return c;
    }
  },
  Graphics: class {
    _strokes: Array<{ color: number; width: number; alpha: number }> = [];
    _fillCalls = 0;
    rect() {
      return this;
    }
    circle() {
      return this;
    }
    fill() {
      this._fillCalls++;
      return this;
    }
    stroke(opts?: { color?: number; width?: number; alpha?: number }) {
      this._strokes.push({
        color: opts?.color ?? 0,
        width: opts?.width ?? 1,
        alpha: opts?.alpha ?? 1,
      });
      return this;
    }
    clear() {
      this._strokes = [];
      return this;
    }
  },
}));

const r = (p: Partial<DiffRegion>): DiffRegion => ({
  id: "r",
  severity: "major",
  category: "text",
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  description: "",
  source: "l2",
  ...p,
});

describe("mountDiffShadingLayer", () => {
  test("adds one shading container to the parent", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const { container } = mountDiffShadingLayer(
      parent,
      [r({}), r({ id: "r2" })],
      null,
    );
    expect((parent as unknown as { children: unknown[] }).children).toContain(
      container,
    );
  });

  test("skips zero-size and non-object bboxes", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const { container } = mountDiffShadingLayer(
      parent,
      [r({ bbox: { x: 0, y: 0, width: 0, height: 0 } }), r({ id: "ok" })],
      null,
    ) as unknown as { container: { children: unknown[] }; destroy: () => void };
    expect(
      (container as unknown as { children: unknown[] }).children.length,
    ).toBe(1);
  });

  test("reducedMotion=true: adds a static ring child and does NOT call ticker.add", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const ticker = { add: vi.fn(), remove: vi.fn() };

    const { container } = mountDiffShadingLayer(parent, [r({})], null, {
      highlight: true,
      reducedMotion: true,
      ticker,
    });

    // ticker.add should NOT have been called (no animation for reduced-motion)
    expect(ticker.add).not.toHaveBeenCalled();

    // The region group should have 3 children: base rect, dot, static ring
    // (more than the no-highlight case which has 2: rect + dot)
    const regionGroup = (
      container as unknown as { children: Array<{ children: unknown[] }> }
    ).children[0]!;
    expect(regionGroup.children.length).toBeGreaterThan(2);
  });

  test("highlight=true, reducedMotion=false: calls ticker.add once; destroy() calls ticker.remove", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const ticker = { add: vi.fn(), remove: vi.fn() };

    const { destroy } = mountDiffShadingLayer(parent, [r({})], null, {
      highlight: true,
      reducedMotion: false,
      ticker,
    });

    // ticker.add must be called once to register the pulse animation
    expect(ticker.add).toHaveBeenCalledTimes(1);

    // destroy() must unregister the ticker callback
    destroy();
    expect(ticker.remove).toHaveBeenCalledTimes(1);
    // The same fn reference that was passed to add should be removed
    expect(ticker.remove).toHaveBeenCalledWith(ticker.add.mock.calls[0]![0]);
  });

  test("no highlight: does not call ticker.add; destroy() is a no-op", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const ticker = { add: vi.fn(), remove: vi.fn() };

    const { destroy } = mountDiffShadingLayer(parent, [r({})], null, {
      highlight: false,
      reducedMotion: false,
      ticker,
    });

    expect(ticker.add).not.toHaveBeenCalled();
    // Should not throw and not call remove
    destroy();
    expect(ticker.remove).not.toHaveBeenCalled();
  });
});
