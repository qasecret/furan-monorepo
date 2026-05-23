import type { DiffRegion } from "@furan/diff-engine";
import { describe, expect, it } from "vitest";

import type { ElementMap } from "../src/element-map-resolver.js";
import { resolveL2Bboxes } from "../src/l2-bbox-resolver.js";

const HTML = `<html><body><div id="main"><p class="lead">hi</p><p>two</p><p>three</p></div></body></html>`;
// stringToObj returns root = { nodeName: "HTML", childNodes: [BODY] }
// (no outer wrapper — root IS the html element)
// Route to <p class="lead">: [0, 0, 0]   → body > div#main > p.lead
// SDK selector path (stops at #main): "#main > p.lead"
// Route to second <p>:        [0, 0, 1]   → "#main > p:nth-child(2)" (3 siblings same tag)
// Route to third <p>:         [0, 0, 2]   → "#main > p:nth-child(3)"

// SDK always appends :nth-child(N) when 2+ siblings share the same tag —
// even for the element that has a distinguishing class. So p.lead (first of
// three <p> siblings) gets :nth-child(1).
const ELEMENT_MAP: ElementMap = {
  v: 1,
  capturedAt: 0,
  elements: {
    "#main > p.lead:nth-child(1)": { x: 10, y: 20, width: 100, height: 30 },
    "#main > p:nth-child(2)": { x: 10, y: 60, width: 100, height: 30 },
    "#main > p:nth-child(3)": { x: 10, y: 100, width: 100, height: 30 },
  },
};

function makeL2Region(route: number[]): DiffRegion {
  return {
    id: route.join("-"),
    severity: "minor",
    category: "text",
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    description: "test",
    source: "l2",
    route,
  };
}

describe("resolveL2Bboxes", () => {
  it("resolves a class-anchored path that stops at the nearest #id ancestor", () => {
    const regions = [makeL2Region([0, 0, 0])];
    resolveL2Bboxes(regions, HTML, ELEMENT_MAP);
    expect(regions[0]!.bbox).toEqual({ x: 10, y: 20, width: 100, height: 30 });
  });

  it("resolves nth-child for siblings sharing a tag with no id/class", () => {
    const regions = [makeL2Region([0, 0, 1]), makeL2Region([0, 0, 2])];
    resolveL2Bboxes(regions, HTML, ELEMENT_MAP);
    expect(regions[0]!.bbox.y).toBe(60);
    expect(regions[1]!.bbox.y).toBe(100);
  });

  it("leaves bbox unchanged when the route walks off the AST", () => {
    const regions = [makeL2Region([0, 0, 99])];
    resolveL2Bboxes(regions, HTML, ELEMENT_MAP);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("leaves bbox unchanged when the derived selector isn't in the map", () => {
    const map: ElementMap = { v: 1, capturedAt: 0, elements: {} };
    const regions = [makeL2Region([0, 0, 0])];
    resolveL2Bboxes(regions, HTML, map);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("is a no-op when candidateDom is missing", () => {
    const regions = [makeL2Region([0, 0, 0])];
    resolveL2Bboxes(regions, undefined, ELEMENT_MAP);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("is a no-op when elementMap is null", () => {
    const regions = [makeL2Region([0, 0, 0])];
    resolveL2Bboxes(regions, HTML, null);
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("skips L1 regions and regions without route", () => {
    const l1: DiffRegion = {
      id: "l1",
      severity: "major",
      category: "image",
      bbox: { x: 1, y: 1, width: 1, height: 1 },
      description: "l1",
      source: "l1",
    };
    const l2NoRoute: DiffRegion = {
      id: "l2-no-route",
      severity: "minor",
      category: "text",
      bbox: { x: 2, y: 2, width: 2, height: 2 },
      description: "overflow",
      source: "l2",
    };
    const regions = [l1, l2NoRoute];
    resolveL2Bboxes(regions, HTML, ELEMENT_MAP);
    expect(regions[0]!.bbox).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    expect(regions[1]!.bbox).toEqual({ x: 2, y: 2, width: 2, height: 2 });
  });

  it("emits `route_invalid` outcome when route steps into a non-element node (#text)", () => {
    // <div id="main">hello world<p>x</p></div>
    // Inside <div#main>, child index 0 is the text node "hello world",
    // child index 1 is <p>. A route that steps into [..., 0] hits #text → route_invalid.
    const html = `<html><body><div id="main">hello world<p>x</p></div></body></html>`;
    const map: ElementMap = {
      v: 1,
      capturedAt: 0,
      elements: {},
    };
    const calls: Array<{ outcome: string }> = [];
    const regions = [makeL2Region([0, 0, 0])]; // body → div#main → #text
    resolveL2Bboxes(regions, html, map, {
      l2Resolution: {
        labels: (l) => ({ inc: () => calls.push(l) }),
      },
    });
    expect(regions[0]!.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(calls).toEqual([{ outcome: "route_invalid" }]);
  });

  it("records `resolved` outcome metric when bbox lookup succeeds", () => {
    const inc = (() => {
      const calls: Array<{ outcome: string }> = [];
      return {
        labels: (l: { outcome: string }) => ({
          inc: () => {
            calls.push(l);
          },
        }),
        calls,
      };
    })();
    const regions = [makeL2Region([0, 0, 0])];
    resolveL2Bboxes(regions, HTML, ELEMENT_MAP, {
      l2Resolution: { labels: inc.labels },
    });
    expect(inc.calls).toEqual([{ outcome: "resolved" }]);
  });
});
