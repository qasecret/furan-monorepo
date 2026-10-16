import { SEVERITIES, SEVERITY_LABEL } from "@furan/shared-types";
import { cleanup, render } from "@testing-library/react";
import { Container } from "pixi.js";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { orderDiffRegions } from "../src/components/diff-viewer/diff-order";
import { mountDiffOverlayLayer } from "../src/components/diff-viewer/layers/DiffOverlayLayer";
import { mountDiffShadingLayer } from "../src/components/diff-viewer/layers/DiffShadingLayer";
import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";
import {
  isRegionHidden,
  isRegionShown,
} from "../src/components/diff-viewer/region-visibility";
import { RegionListPanel } from "../src/components/diff-viewer/RegionListPanel";
import { SEVERITY_CANVAS_HEX, SEVERITY_STYLE } from "../src/lib/severity-style";

// Records every colour a layer paints with, so a test can assert on the hex a
// region was drawn in without a real canvas.
vi.mock("pixi.js", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
      return c;
    }
  },
  Graphics: class {
    fills: number[] = [];
    strokes: number[] = [];
    rect() {
      return this;
    }
    circle() {
      return this;
    }
    fill(opts?: { color?: number }) {
      this.fills.push(opts?.color ?? -1);
      return this;
    }
    stroke(opts?: { color?: number }) {
      this.strokes.push(opts?.color ?? -1);
      return this;
    }
    clear() {
      return this;
    }
  },
}));

interface FakeGraphics {
  fills: number[];
  strokes: number[];
}
interface FakeContainer {
  children: Array<FakeGraphics | FakeContainer>;
}

/** Every Graphics under `node`, depth first (layers nest a group per region). */
function graphicsUnder(node: FakeContainer): FakeGraphics[] {
  const out: FakeGraphics[] = [];
  for (const child of node.children) {
    if ("children" in child) out.push(...graphicsUnder(child));
    else out.push(child);
  }
  return out;
}

const region = (p: Partial<DiffRegion>): DiffRegion => ({
  id: "r",
  severity: "minor",
  category: "text",
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  description: "",
  source: "l1_pixel",
  ...p,
});

afterEach(cleanup);

describe("every severity map is complete", () => {
  test.each(SEVERITIES)(
    "%s has a chip class, a canvas hex and a label",
    (s) => {
      expect(SEVERITY_STYLE[s]).toBeTruthy();
      expect(SEVERITY_CANVAS_HEX[s]).toBeTypeOf("number");
      expect(SEVERITY_LABEL[s]).toBeTruthy();
    },
  );
});

describe("the canvas layers use the shared hex", () => {
  test("the overlay layer draws a breaking region in SEVERITY_CANVAS_HEX.breaking", () => {
    const parent = new Container() as unknown as FakeContainer;
    const layer = mountDiffOverlayLayer(parent as never, [
      region({ id: "b", severity: "breaking" }),
    ]) as unknown as FakeContainer;
    const [g] = graphicsUnder(layer);
    expect(g!.fills).toEqual([SEVERITY_CANVAS_HEX.breaking]);
    expect(g!.strokes).toEqual([SEVERITY_CANVAS_HEX.breaking]);
  });

  test("the overlay layer without fill draws the outline in the same hex, and no fill, the halo too (R28)", () => {
    const parent = new Container() as unknown as FakeContainer;
    const layer = mountDiffOverlayLayer(
      parent as never,
      [region({ id: "b", severity: "breaking" })],
      "b",
      { fill: false },
    ) as unknown as FakeContainer;
    const drawn = graphicsUnder(layer);
    // The rectangle and the selected one's halo.
    expect(drawn).toHaveLength(2);
    for (const g of drawn) {
      expect(g.fills).toEqual([]);
      expect(g.strokes).toEqual([SEVERITY_CANVAS_HEX.breaking]);
    }
  });

  test("the shading layer dots a breaking region in SEVERITY_CANVAS_HEX.breaking", () => {
    const parent = new Container() as unknown as FakeContainer;
    const { container } = mountDiffShadingLayer(
      parent as never,
      [region({ id: "b", severity: "breaking" })],
      null,
    );
    // Per region the group holds the pink rect first, then the severity dot.
    const [, dot] = graphicsUnder(container as unknown as FakeContainer);
    expect(dot!.fills).toEqual([SEVERITY_CANVAS_HEX.breaking]);
  });

  test("an unknown severity falls back to the `none` hex on both layers", () => {
    const parent = new Container() as unknown as FakeContainer;
    const legacy = region({ id: "old", severity: "legacy-value" });
    const overlay = mountDiffOverlayLayer(parent as never, [
      legacy,
    ]) as unknown as FakeContainer;
    const { container } = mountDiffShadingLayer(parent as never, [legacy]);
    expect(graphicsUnder(overlay)[0]!.fills).toEqual([
      SEVERITY_CANVAS_HEX.none,
    ]);
    expect(
      graphicsUnder(container as unknown as FakeContainer)[1]!.fills,
    ).toEqual([SEVERITY_CANVAS_HEX.none]);
  });
});

describe("isRegionHidden", () => {
  test.each(["dynamic_text", "layout_suppressed"])(
    "a %s audit row is hidden unless suppressed rows are shown",
    (source) => {
      const r = region({ source });
      expect(isRegionHidden(r, { showSuppressed: false })).toBe(true);
      expect(isRegionHidden(r, { showSuppressed: true })).toBe(false);
    },
  );

  test.each(["l1_pixel", "layout_kept", "axe"])(
    "a %s region is never hidden",
    (source) => {
      const r = region({ source });
      expect(isRegionHidden(r, { showSuppressed: false })).toBe(false);
      expect(isRegionHidden(r, { showSuppressed: true })).toBe(false);
    },
  );
});

describe("isRegionShown: the one rule for every region surface (R10)", () => {
  test("an audit row shows only with Show suppressed on", () => {
    const r = region({ source: "dynamic_text" });
    expect(
      isRegionShown(r, { showSuppressed: false, hideDisplacement: false }),
    ).toBe(false);
    expect(
      isRegionShown(r, { showSuppressed: true, hideDisplacement: false }),
    ).toBe(true);
  });

  test("a layout change hides with Hide displacement, whatever Show suppressed says", () => {
    const r = region({ category: "layout" });
    expect(
      isRegionShown(r, { showSuppressed: false, hideDisplacement: false }),
    ).toBe(true);
    expect(
      isRegionShown(r, { showSuppressed: true, hideDisplacement: true }),
    ).toBe(false);
  });

  test("the stepper order keeps exactly the shown regions", () => {
    const all = [
      region({ id: "a" }),
      region({ id: "b", category: "layout" }),
      region({ id: "c", source: "layout_suppressed" }),
    ];
    for (const visibility of [
      { showSuppressed: false, hideDisplacement: false },
      { showSuppressed: true, hideDisplacement: true },
    ]) {
      expect(
        orderDiffRegions(all, visibility)
          .map((r) => r.id)
          .sort(),
      ).toEqual(
        all
          .filter((r) => isRegionShown(r, visibility))
          .map((r) => r.id)
          .sort(),
      );
    }
  });
});

describe("the stepper order and the region list agree", () => {
  // Mixed severities and areas; same-severity rows differ in size so the list
  // does not fold them into one "x2" row. `legacy-value` is not a severity and
  // ranks with `none`.
  const fixture: DiffRegion[] = [
    region({
      id: "minor-100",
      severity: "minor",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    }),
    region({
      id: "breaking-25",
      severity: "breaking",
      bbox: { x: 0, y: 0, width: 5, height: 5 },
    }),
    region({
      id: "major-400",
      severity: "major",
      bbox: { x: 0, y: 0, width: 20, height: 20 },
    }),
    region({
      id: "breaking-900",
      severity: "breaking",
      bbox: { x: 0, y: 0, width: 30, height: 30 },
    }),
    region({
      id: "cosmetic-2500",
      severity: "cosmetic",
      bbox: { x: 0, y: 0, width: 50, height: 50 },
    }),
    region({
      id: "legacy-3000",
      severity: "legacy-value",
      bbox: { x: 0, y: 0, width: 60, height: 50 },
    }),
  ];
  const expected = [
    "breaking-900",
    "breaking-25",
    "major-400",
    "minor-100",
    "cosmetic-2500",
    "legacy-3000",
  ];

  test("orderDiffRegions", () => {
    expect(orderDiffRegions(fixture).map((r) => r.id)).toEqual(expected);
  });

  test("RegionListPanel", () => {
    const { container } = render(
      createElement(RegionListPanel, { regions: fixture }),
    );
    const ids = Array.from(container.querySelectorAll("[data-region-id]")).map(
      (el) => el.getAttribute("data-region-id"),
    );
    expect(ids).toEqual(expected);
  });
});
