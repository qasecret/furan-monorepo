import { describe, expect, it } from "vitest";

import type { BBox } from "../src/bbox.js";
import type { ElementBbox, ElementMap } from "../src/element-map-resolver.js";
import {
  bboxApproxEqual,
  classifyCluster,
  classifyLayoutClusters,
  findSmallestContainingElement,
} from "../src/layout-suppression.js";

const mkMap = (elements: Record<string, ElementBbox>): ElementMap => ({
  v: 1,
  elements,
  capturedAt: 0,
});

describe("bboxApproxEqual", () => {
  const base: BBox = { x: 10, y: 10, width: 100, height: 50 };
  it("is true for identical boxes", () => {
    expect(bboxApproxEqual(base, { ...base }, 1)).toBe(true);
  });
  it("is true within tolerance (1px shift, tol 1)", () => {
    expect(bboxApproxEqual(base, { ...base, x: 11 }, 1)).toBe(true);
  });
  it("is false beyond tolerance (2px shift, tol 1)", () => {
    expect(bboxApproxEqual(base, { ...base, x: 12 }, 1)).toBe(false);
  });
  it("checks every dimension, not just position", () => {
    expect(bboxApproxEqual(base, { ...base, height: 53 }, 1)).toBe(false);
  });
});

describe("findSmallestContainingElement", () => {
  it("returns null when nothing contains the cluster", () => {
    const els = { "div.card": { x: 200, y: 200, width: 50, height: 50 } };
    expect(
      findSmallestContainingElement({ x: 0, y: 0, width: 10, height: 10 }, els),
    ).toBeNull();
  });
  it("returns the smallest containing element when nested", () => {
    const els = {
      "div.outer": { x: 0, y: 0, width: 200, height: 200 },
      "div.inner": { x: 10, y: 10, width: 50, height: 50 },
    };
    const hit = findSmallestContainingElement(
      { x: 15, y: 15, width: 10, height: 10 },
      els,
    );
    expect(hit?.selector).toBe("div.inner");
  });
});

describe("classifyCluster", () => {
  it("suppresses a cluster inside a geometrically-stable element", () => {
    const candidate = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const baseline = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const v = classifyCluster(
      { x: 20, y: 20, width: 30, height: 10 },
      candidate,
      baseline,
    );
    expect(v.decision).toBe("suppress");
    expect(v.reason).toBe("stable_element");
    expect(v.selector).toBe("div.card");
  });

  it("keeps a cluster whose element moved", () => {
    const candidate = mkMap({
      "div.card": { x: 10, y: 60, width: 100, height: 50 },
    });
    const baseline = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const v = classifyCluster(
      { x: 20, y: 70, width: 30, height: 10 },
      candidate,
      baseline,
    );
    expect(v.decision).toBe("keep");
    expect(v.reason).toBe("moved_or_resized");
  });

  it("keeps a cluster whose element is absent in the baseline", () => {
    const candidate = mkMap({
      "div.new": { x: 10, y: 10, width: 100, height: 50 },
    });
    const baseline = mkMap({
      "div.other": { x: 10, y: 10, width: 100, height: 50 },
    });
    const v = classifyCluster(
      { x: 20, y: 20, width: 30, height: 10 },
      candidate,
      baseline,
    );
    expect(v.decision).toBe("keep");
    expect(v.reason).toBe("absent_in_baseline");
  });

  it("keeps an orphan cluster contained by no element", () => {
    const candidate = mkMap({
      "div.card": { x: 200, y: 200, width: 50, height: 50 },
    });
    const baseline = mkMap({
      "div.card": { x: 200, y: 200, width: 50, height: 50 },
    });
    const v = classifyCluster(
      { x: 0, y: 0, width: 10, height: 10 },
      candidate,
      baseline,
    );
    expect(v.decision).toBe("keep");
    expect(v.reason).toBe("orphan_no_container");
  });

  it("suppresses within 1px element drift and keeps beyond it", () => {
    const cluster: BBox = { x: 20, y: 20, width: 30, height: 10 };
    const candidate = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const within = mkMap({
      "div.card": { x: 11, y: 10, width: 100, height: 50 },
    });
    const beyond = mkMap({
      "div.card": { x: 12, y: 10, width: 100, height: 50 },
    });
    expect(classifyCluster(cluster, candidate, within).decision).toBe(
      "suppress",
    );
    expect(classifyCluster(cluster, candidate, beyond).decision).toBe("keep");
  });
});

describe("classifyLayoutClusters", () => {
  it("degrades every cluster when the candidate map is missing", () => {
    const baseline = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const out = classifyLayoutClusters(
      [{ x: 20, y: 20, width: 30, height: 10 }],
      null,
      baseline,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.decision).toBe("keep");
    expect(out[0]!.reason).toBe("degraded_no_map");
  });

  it("degrades every cluster when the baseline map is missing", () => {
    const candidate = mkMap({
      "div.card": { x: 10, y: 10, width: 100, height: 50 },
    });
    const out = classifyLayoutClusters(
      [{ x: 20, y: 20, width: 30, height: 10 }],
      candidate,
      null,
    );
    expect(out[0]!.reason).toBe("degraded_no_map");
  });

  it("classifies each cluster in input order", () => {
    const candidate = mkMap({
      "div.stable": { x: 10, y: 10, width: 100, height: 50 },
      "div.moved": { x: 10, y: 100, width: 100, height: 50 },
    });
    const baseline = mkMap({
      "div.stable": { x: 10, y: 10, width: 100, height: 50 },
      "div.moved": { x: 10, y: 200, width: 100, height: 50 },
    });
    const out = classifyLayoutClusters(
      [
        { x: 20, y: 20, width: 10, height: 10 }, // inside div.stable
        { x: 20, y: 110, width: 10, height: 10 }, // inside div.moved
      ],
      candidate,
      baseline,
    );
    expect(out.map((v) => v.decision)).toEqual(["suppress", "keep"]);
  });
});
