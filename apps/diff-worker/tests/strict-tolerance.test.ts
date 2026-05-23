import { describe, expect, it } from "vitest";

import {
  countDiffPixelsInBbox,
  strictBreaches,
  type DiffRaw,
  type StrictRegionInput,
} from "../src/strict-tolerance.js";

// Build a 10x10 RGBA buffer where the top-left 5x5 block is "diff"
// (alpha=255) and the rest is "match" (alpha=0). 400 bytes total.
function build10x10WithTopLeftDiff(): DiffRaw {
  const data = Buffer.alloc(10 * 10 * 4); // all zeros = match
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      data[(y * 10 + x) * 4 + 3] = 255; // alpha
    }
  }
  return { data, info: { width: 10, height: 10 } };
}

describe("countDiffPixelsInBbox", () => {
  const img = build10x10WithTopLeftDiff();

  it("counts every diff pixel when bbox covers the whole image", () => {
    const r = countDiffPixelsInBbox(img, { x: 0, y: 0, width: 10, height: 10 });
    expect(r).toEqual({ diffCount: 25, totalPixels: 100 });
  });

  it("counts only inside the bbox", () => {
    const r = countDiffPixelsInBbox(img, { x: 0, y: 0, width: 3, height: 3 });
    expect(r).toEqual({ diffCount: 9, totalPixels: 9 });
  });

  it("returns 0 when bbox lands fully in the match area", () => {
    const r = countDiffPixelsInBbox(img, { x: 5, y: 5, width: 5, height: 5 });
    expect(r).toEqual({ diffCount: 0, totalPixels: 25 });
  });

  it("clamps to image bounds when bbox spills off the edge", () => {
    const r = countDiffPixelsInBbox(img, { x: 8, y: 0, width: 20, height: 5 });
    // Effective rect: x∈[8,10), y∈[0,5) = 2x5 = 10 pixels, none of which are diff.
    expect(r).toEqual({ diffCount: 0, totalPixels: 10 });
  });

  it("returns totalPixels=0 for a bbox fully outside the image", () => {
    const r = countDiffPixelsInBbox(img, {
      x: 100,
      y: 100,
      width: 10,
      height: 10,
    });
    expect(r).toEqual({ diffCount: 0, totalPixels: 0 });
  });
});

describe("strictBreaches", () => {
  const img = build10x10WithTopLeftDiff(); // 25 diff pixels in a 100-px image (25%)

  it("emits a breach when fraction > thresholdOverride", () => {
    const regions: StrictRegionInput[] = [
      {
        resolved: { x: 0, y: 0, width: 10, height: 10 },
        thresholdOverride: 0.1, // 10% allowed; we have 25% → breach
      },
    ];
    const breaches = strictBreaches(regions, img);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.fraction).toBeCloseTo(0.25, 5);
    expect(breaches[0]!.threshold).toBe(0.1);
    expect(breaches[0]!.bbox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("does not emit a breach when fraction === thresholdOverride (inclusive pass)", () => {
    // 25 diff pixels / 100 pixels = exactly 0.25. Threshold 0.25 → fraction
    // is NOT strictly greater → pass.
    const breaches = strictBreaches(
      [
        {
          resolved: { x: 0, y: 0, width: 10, height: 10 },
          thresholdOverride: 0.25,
        },
      ],
      img,
    );
    expect(breaches).toHaveLength(0);
  });

  it("treats thresholdOverride=undefined as 0 (any mismatch fails)", () => {
    const breaches = strictBreaches(
      [{ resolved: { x: 0, y: 0, width: 10, height: 10 } }], // no threshold
      img,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.threshold).toBe(0);
  });

  it("skips regions fully outside the image (totalPixels=0)", () => {
    const breaches = strictBreaches(
      [
        {
          resolved: { x: 200, y: 200, width: 10, height: 10 },
          thresholdOverride: 0,
        },
      ],
      img,
    );
    expect(breaches).toHaveLength(0);
  });

  it("returns one breach per failing region (multiple strict regions, one image)", () => {
    const breaches = strictBreaches(
      [
        { resolved: { x: 0, y: 0, width: 5, height: 5 }, thresholdOverride: 0 }, // 25/25 diff
        { resolved: { x: 5, y: 5, width: 5, height: 5 }, thresholdOverride: 0 }, // 0/25 diff
      ],
      img,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.bbox.x).toBe(0);
  });
});
