import { describe, expect, it } from "vitest";

import { computeCheckpointSignature, type DiffRegion } from "../src/index.js";

const SIZE = { width: 1000, height: 800 };

function region(p: Partial<DiffRegion>): DiffRegion {
  return {
    id: "x",
    severity: "major",
    category: "text",
    bbox: { x: 100, y: 80, width: 200, height: 40 },
    description: "whatever",
    source: "l2",
    ...p,
  };
}

describe("computeCheckpointSignature", () => {
  it("returns a v1: prefixed hash for meaningful regions", () => {
    const sig = computeCheckpointSignature([region({})], SIZE);
    expect(sig).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("is order-independent", () => {
    const a = region({ id: "a", category: "text" });
    const b = region({
      id: "b",
      category: "color",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(computeCheckpointSignature([a, b], SIZE)).toBe(
      computeCheckpointSignature([b, a], SIZE),
    );
  });

  it("ignores the volatile description field", () => {
    const a = region({ description: "text changed from X" });
    const b = region({ description: "text changed from Y" });
    expect(computeCheckpointSignature([a], SIZE)).toBe(
      computeCheckpointSignature([b], SIZE),
    );
  });

  it("excludes l1_pixel and dynamic_text regions", () => {
    const meaningful = region({ id: "m", source: "l2" });
    const noise = region({
      id: "n",
      source: "l1_pixel",
      bbox: { x: 1, y: 1, width: 3, height: 3 },
    });
    // dynamic_text is a diff-worker DB concept, not an engine source, so it
    // can't occur on a typed DiffRegion — cast to exercise the defensive filter.
    const audit = {
      ...region({ id: "d" }),
      source: "dynamic_text",
    } as unknown as DiffRegion;
    expect(computeCheckpointSignature([meaningful, noise, audit], SIZE)).toBe(
      computeCheckpointSignature([meaningful], SIZE),
    );
  });

  it("returns null when there are no meaningful regions", () => {
    expect(computeCheckpointSignature([], SIZE)).toBeNull();
    expect(
      computeCheckpointSignature([region({ source: "l1_pixel" })], SIZE),
    ).toBeNull();
  });

  it("buckets bbox to a 1% grid (sub-bucket jitter does not change the sig)", () => {
    const a = region({ bbox: { x: 100, y: 80, width: 200, height: 40 } });
    const b = region({ bbox: { x: 102, y: 81, width: 201, height: 41 } });
    expect(computeCheckpointSignature([a], SIZE)).toBe(
      computeCheckpointSignature([b], SIZE),
    );
  });

  it("different bbox bucket → different signature", () => {
    const a = region({ bbox: { x: 100, y: 80, width: 200, height: 40 } });
    const b = region({ bbox: { x: 500, y: 80, width: 200, height: 40 } });
    expect(computeCheckpointSignature([a], SIZE)).not.toBe(
      computeCheckpointSignature([b], SIZE),
    );
  });

  it("category/severity/source/anchor each affect the signature", () => {
    const base = computeCheckpointSignature([region({})], SIZE);
    expect(
      computeCheckpointSignature([region({ category: "color" })], SIZE),
    ).not.toBe(base);
    expect(
      computeCheckpointSignature([region({ severity: "minor" })], SIZE),
    ).not.toBe(base);
    expect(
      computeCheckpointSignature([region({ source: "l1" })], SIZE),
    ).not.toBe(base);
    expect(
      computeCheckpointSignature([region({ route: [1, 2, 3] })], SIZE),
    ).not.toBe(base);
  });

  it("treats an empty route array like an absent route", () => {
    // diff-dom seeds route=[] for root-level DOM changes, and l2.ts spreads it
    // because [] is truthy. An empty route pins no specific element, so it must
    // produce the same signature as a region with no route (anchor → null),
    // not a degenerate "route:" anchor.
    const emptyRoute = region({ route: [] });
    const noRoute = region({});
    expect(computeCheckpointSignature([emptyRoute], SIZE)).toBe(
      computeCheckpointSignature([noRoute], SIZE),
    );
  });

  it("an empty route falls through to axeTarget", () => {
    const emptyRouteWithAxe = region({ route: [], axeTarget: ["#submit"] });
    const axeOnly = region({ axeTarget: ["#submit"] });
    expect(computeCheckpointSignature([emptyRouteWithAxe], SIZE)).toBe(
      computeCheckpointSignature([axeOnly], SIZE),
    );
  });

  it("returns null when image dimensions are missing or non-positive", () => {
    // sharp can yield undefined width/height for a dimensionless candidate,
    // which the handler passes through as 0. Without valid dimensions every
    // bbox collapses to bucket 0 and would falsely group unrelated checkpoints,
    // so decline to fingerprint (→ "ungrouped") instead.
    const r = region({});
    expect(
      computeCheckpointSignature([r], { width: 0, height: 800 }),
    ).toBeNull();
    expect(
      computeCheckpointSignature([r], { width: 1000, height: 0 }),
    ).toBeNull();
    expect(
      computeCheckpointSignature([r], { width: -1, height: 800 }),
    ).toBeNull();
    expect(
      computeCheckpointSignature([r], { width: NaN, height: 800 }),
    ).toBeNull();
    expect(
      computeCheckpointSignature([r], {
        width: undefined as unknown as number,
        height: 800,
      }),
    ).toBeNull();
  });
});
