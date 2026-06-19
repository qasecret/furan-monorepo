import type { DiffRegion } from "@furan/diff-engine";
import { describe, expect, it } from "vitest";

import { resolveAxeBboxes } from "../src/axe-bbox-resolver.js";
import type { ElementMap } from "../src/element-map-resolver.js";

function makeAxeRegion(axeTarget: string[] | undefined): DiffRegion {
  return {
    id: axeTarget?.join(",") ?? "no-target",
    severity: "major",
    category: "accessibility",
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    description: "test violation",
    source: "axe",
    ...(axeTarget ? { axeTarget } : {}),
  };
}

function makeMetrics() {
  const counts = new Map<string, number>();
  return {
    counts,
    metrics: {
      axeResolution: {
        labels: (l: { outcome: string }) => ({
          inc: () => counts.set(l.outcome, (counts.get(l.outcome) ?? 0) + 1),
        }),
      },
    },
  };
}

describe("resolveAxeBboxes", () => {
  const HTML = `<html><body><div id="main"><button class="primary">Click me</button></div></body></html>`;
  const ELEMENT_MAP: ElementMap = {
    v: 1,
    capturedAt: 0,
    elements: {
      "#main": { x: 0, y: 0, width: 800, height: 600 },
      "#main > button.primary": { x: 100, y: 200, width: 120, height: 40 },
    },
  };

  it("resolves an exact match — selector hits the violating element directly", () => {
    const regions = [makeAxeRegion(["button.primary"])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, HTML, ELEMENT_MAP, metrics);
    expect(regions[0]!.bbox).toEqual({
      x: 100,
      y: 200,
      width: 120,
      height: 40,
    });
    expect(counts.get("resolved")).toBe(1);
  });

  it("falls back to the nearest ancestor when the leaf isn't in the map", () => {
    // <span> isn't in the element-map (too small per the SDK's
    // MIN_SIZE filter). Its ancestor #main IS in the map; the
    // resolver should land on that ancestor.
    const html = `<html><body><div id="main"><button class="primary"><span>X</span></button></div></body></html>`;
    const map: ElementMap = {
      v: 1,
      capturedAt: 0,
      elements: { "#main": { x: 0, y: 0, width: 800, height: 600 } },
    };
    const regions = [makeAxeRegion(["span"])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, html, map, metrics);
    expect(regions[0]!.bbox).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
    expect(counts.get("resolved_ancestor")).toBe(1);
  });

  it("emits selector_miss when no ancestor is in the map", () => {
    const html = `<html><body><nav><span class="foo">x</span></nav></body></html>`;
    const map: ElementMap = { v: 1, capturedAt: 0, elements: {} };
    const regions = [makeAxeRegion(["span.foo"])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, html, map, metrics);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.get("selector_miss")).toBe(1);
  });

  it("emits selector_miss when querySelector finds nothing", () => {
    const regions = [makeAxeRegion(["button.does-not-exist"])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, HTML, ELEMENT_MAP, metrics);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.get("selector_miss")).toBe(1);
  });

  it("emits selector_miss on invalid CSS selectors without throwing", () => {
    const regions = [makeAxeRegion([")))not-css(((  "])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, HTML, ELEMENT_MAP, metrics);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.get("selector_miss")).toBe(1);
  });

  it("emits no_target when an axe region has no axeTarget", () => {
    const regions = [makeAxeRegion(undefined)];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, HTML, ELEMENT_MAP, metrics);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.get("no_target")).toBe(1);
  });

  it("does not crash on degenerate DOM input", () => {
    // JSDOM is very permissive — it parses most input to something.
    // The contract is "no crash, emit some outcome metric".
    const regions = [makeAxeRegion(["button"])];
    const { counts, metrics } = makeMetrics();
    resolveAxeBboxes(regions, " ", ELEMENT_MAP, metrics);
    // Whatever outcome we get, the function must not throw.
    const total =
      (counts.get("dom_unparseable") ?? 0) + (counts.get("selector_miss") ?? 0);
    expect(total).toBe(1);
  });

  it("is a no-op when candidateDom is undefined", () => {
    const regions = [makeAxeRegion(["button.primary"])];
    const { counts } = makeMetrics();
    resolveAxeBboxes(regions, undefined, ELEMENT_MAP);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.size).toBe(0);
  });

  it("is a no-op when elementMap is null", () => {
    const regions = [makeAxeRegion(["button.primary"])];
    const { counts } = makeMetrics();
    resolveAxeBboxes(regions, HTML, null);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(counts.size).toBe(0);
  });

  it("never touches non-axe regions", () => {
    const l1: DiffRegion = {
      id: "l1",
      severity: "major",
      category: "color",
      bbox: { x: 5, y: 5, width: 50, height: 50 },
      description: "l1",
      source: "l1",
    };
    const nonAxe: DiffRegion = {
      id: "non-axe",
      severity: "minor",
      category: "structural",
      bbox: { x: 1, y: 2, width: 3, height: 4 },
      description: "non-axe",
      source: "l1",
    };
    const axe = makeAxeRegion(["button.primary"]);
    const regions = [l1, nonAxe, axe];
    const { metrics } = makeMetrics();
    resolveAxeBboxes(regions, HTML, ELEMENT_MAP, metrics);
    expect(l1.bbox).toEqual({ x: 5, y: 5, width: 50, height: 50 });
    expect(nonAxe.bbox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(axe.bbox).toEqual({ x: 100, y: 200, width: 120, height: 40 });
  });
});
