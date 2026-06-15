import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { runL1 } from "../src/l1.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

function solidPng(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function pngWithPatch(
  w: number,
  h: number,
  bgR: number,
  bgG: number,
  bgB: number,
  patch: {
    x: number;
    y: number;
    width: number;
    height: number;
    r: number;
    g: number;
    b: number;
  },
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;
      const inPatch =
        px >= patch.x &&
        px < patch.x + patch.width &&
        py >= patch.y &&
        py < patch.y + patch.height;
      png.data[idx] = inPatch ? patch.r : bgR;
      png.data[idx + 1] = inPatch ? patch.g : bgG;
      png.data[idx + 2] = inPatch ? patch.b : bgB;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("L1 ignore areas integration", () => {
  const baseline = solidPng(100, 100, 255, 255, 255);
  const candidate = pngWithPatch(100, 100, 255, 255, 255, {
    x: 20,
    y: 20,
    width: 30,
    height: 30,
    r: 255,
    g: 0,
    b: 0,
  });

  const engines = ["pixelmatch", "looks_same", "odiff"] as const;

  for (const engine of engines) {
    it(`${engine}: detects diff without ignore area`, async () => {
      const result = await runL1(
        baseline,
        candidate,
        undefined,
        engine,
        DEFAULT_ENGINE_CONFIG,
      );
      expect(result.diffPercent).toBeGreaterThan(0);
    });

    it(`${engine}: ignore area covering the patch zeroes the diff`, async () => {
      const ignoreAreas = [{ x: 20, y: 20, width: 30, height: 30 }];
      const result = await runL1(
        baseline,
        candidate,
        ignoreAreas,
        engine,
        DEFAULT_ENGINE_CONFIG,
      );
      expect(result.diffPercent).toBe(0);
    });

    it(`${engine}: ignore area NOT covering the patch still detects diff`, async () => {
      const ignoreAreas = [{ x: 60, y: 60, width: 20, height: 20 }];
      const result = await runL1(
        baseline,
        candidate,
        ignoreAreas,
        engine,
        DEFAULT_ENGINE_CONFIG,
      );
      expect(result.diffPercent).toBeGreaterThan(0);
    });
  }
});
