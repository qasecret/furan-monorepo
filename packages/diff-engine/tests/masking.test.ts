import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { applyIgnoreMask } from "../src/masking.js";

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

describe("applyIgnoreMask", () => {
  it("returns input unchanged when areas is empty", () => {
    const src = solidPng(10, 10, 255, 0, 0);
    const out = applyIgnoreMask(src, []);
    expect(out.equals(src)).toBe(true);
  });

  it("paints solid black RGBA over each area", () => {
    const src = solidPng(20, 20, 255, 0, 0);
    const out = applyIgnoreMask(src, [{ x: 5, y: 5, width: 10, height: 10 }]);
    const decoded = PNG.sync.read(out);
    const insideIdx = (10 * decoded.width + 10) * 4;
    expect(decoded.data[insideIdx]).toBe(0);
    expect(decoded.data[insideIdx + 1]).toBe(0);
    expect(decoded.data[insideIdx + 2]).toBe(0);
    expect(decoded.data[insideIdx + 3]).toBe(0);
    const outsideIdx = (0 * decoded.width + 0) * 4;
    expect(decoded.data[outsideIdx]).toBe(255);
    expect(decoded.data[outsideIdx + 1]).toBe(0);
    expect(decoded.data[outsideIdx + 2]).toBe(0);
  });

  it("clamps areas that extend past image bounds", () => {
    const src = solidPng(10, 10, 255, 255, 255);
    const out = applyIgnoreMask(src, [{ x: 8, y: 8, width: 100, height: 100 }]);
    const decoded = PNG.sync.read(out);
    const idx = (9 * decoded.width + 9) * 4;
    expect(decoded.data[idx]).toBe(0);
  });
});
