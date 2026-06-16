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
    rect() {
      return this;
    }
    circle() {
      return this;
    }
    fill() {
      return this;
    }
    stroke() {
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
    const layer = mountDiffShadingLayer(parent, [r({}), r({ id: "r2" })], null);
    expect((parent as unknown as { children: unknown[] }).children).toContain(
      layer,
    );
  });

  test("skips zero-size and non-object bboxes", () => {
    const parent = new Container() as unknown as import("pixi.js").Container;
    const layer = mountDiffShadingLayer(
      parent,
      [r({ bbox: { x: 0, y: 0, width: 0, height: 0 } }), r({ id: "ok" })],
      null,
    ) as unknown as { children: unknown[] };
    expect(layer.children.length).toBe(1);
  });
});
