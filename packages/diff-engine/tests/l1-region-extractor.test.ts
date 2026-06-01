import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { extractL1PixelRegions } from "../src/l1-region-extractor.js";

function makeImage(
  width: number,
  height: number,
  fill: [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill[0];
    png.data[i + 1] = fill[1];
    png.data[i + 2] = fill[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function paintRect(
  buf: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number],
): Buffer {
  const png = PNG.sync.read(buf);
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * png.width + px) * 4;
      png.data[i] = color[0];
      png.data[i + 1] = color[1];
      png.data[i + 2] = color[2];
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("extractL1PixelRegions", () => {
  it("returns no regions when baseline === candidate", () => {
    const img = makeImage(128, 128, [255, 255, 255]);
    expect(extractL1PixelRegions(img, img)).toEqual([]);
  });

  it("returns no regions on dimension mismatch", () => {
    const a = makeImage(64, 64, [255, 255, 255]);
    const b = makeImage(128, 128, [255, 255, 255]);
    expect(extractL1PixelRegions(a, b)).toEqual([]);
  });

  it("emits a single bounded region around one painted rect", () => {
    const baseline = makeImage(256, 256, [255, 255, 255]);
    const candidate = paintRect(baseline, 64, 64, 64, 64, [255, 0, 0]);
    const regions = extractL1PixelRegions(baseline, candidate, {
      tileSize: 16,
    });
    expect(regions.length).toBe(1);
    const r = regions[0]!;
    expect(r.source).toBe("l1");
    expect(r.category).toBe("image");
    expect(r.bbox.x).toBeLessThanOrEqual(64);
    expect(r.bbox.y).toBeLessThanOrEqual(64);
    expect(r.bbox.x + r.bbox.width).toBeGreaterThanOrEqual(128);
    expect(r.bbox.y + r.bbox.height).toBeGreaterThanOrEqual(128);
  });

  it("emits two separate regions for two disjoint rects", () => {
    let candidate = makeImage(512, 512, [255, 255, 255]);
    candidate = paintRect(candidate, 16, 16, 64, 64, [255, 0, 0]);
    candidate = paintRect(candidate, 384, 384, 64, 64, [0, 0, 255]);
    const baseline = makeImage(512, 512, [255, 255, 255]);
    const regions = extractL1PixelRegions(baseline, candidate, {
      tileSize: 16,
    });
    expect(regions.length).toBe(2);
  });

  it("ignores tiny per-channel deltas below the antialiasing tolerance", () => {
    const baseline = makeImage(64, 64, [200, 200, 200]);
    const candidate = makeImage(64, 64, [205, 205, 205]);
    expect(extractL1PixelRegions(baseline, candidate)).toEqual([]);
  });
});
