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
      minClusterTiles: 4,
    });
    expect(regions.length).toBe(1);
    const r = regions[0]!;
    expect(r.source).toBe("l1_pixel");
    expect(r.category).toBe("image");
    expect(r.id).toMatch(/^l1-pixel-/);
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
      minClusterTiles: 4,
    });
    expect(regions.length).toBe(2);
  });

  it("ignores tiny per-channel deltas below the antialiasing tolerance", () => {
    const baseline = makeImage(64, 64, [200, 200, 200]);
    const candidate = makeImage(64, 64, [205, 205, 205]);
    expect(extractL1PixelRegions(baseline, candidate)).toEqual([]);
  });

  // Defaults are tuned for real web content: tileSize=48,
  // minTileDiffRatio=0.22, channelTolerance=16, minClusterTiles=3.
  // Below tests lock in the noise floor + minimum cluster footprint
  // at the defaults so a refactor that loosens them surfaces here
  // before it surfaces as a 60-region Regions panel on prod.

  it("default thresholds drop a small 32×32 patch as below noise floor", () => {
    const baseline = makeImage(256, 256, [255, 255, 255]);
    const candidate = paintRect(baseline, 64, 64, 32, 32, [255, 0, 0]);
    // 32 px patch sits inside a single 48 px tile (with overhang into a
    // neighbor); the one tile that gets ~700 dirty px clears the ratio
    // but the single-tile cluster is below `minClusterTiles=3`.
    expect(extractL1PixelRegions(baseline, candidate)).toEqual([]);
  });

  it("default thresholds preserve a visible 200×200 patch as one region", () => {
    const baseline = makeImage(512, 512, [255, 255, 255]);
    const candidate = paintRect(baseline, 100, 100, 200, 200, [255, 0, 0]);
    const regions = extractL1PixelRegions(baseline, candidate);
    expect(regions.length).toBe(1);
    expect(regions[0]!.source).toBe("l1_pixel");
  });

  it("default channelTolerance=16 swallows a per-channel delta of 15", () => {
    const baseline = makeImage(256, 256, [200, 200, 200]);
    const candidate = makeImage(256, 256, [215, 215, 215]);
    expect(extractL1PixelRegions(baseline, candidate)).toEqual([]);
  });
});
