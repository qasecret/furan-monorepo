import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import { runDiff } from "../src/engine.js";
import { runL1Odiff } from "../src/l1-odiff.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

/** The constant IEND chunk: length 0, type "IEND", its CRC. */
const IEND = Buffer.from("0000000049454e44ae426082", "hex");

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A page-like PNG: white, with a banded stripe per 100 rows so the content is
 * not uniform. Rows `0..h` are the same in every image regardless of its height,
 * so a taller image has a matching top and only extra rows below.
 */
function pagePng(
  w: number,
  h: number,
  paint?: (x: number, y: number) => [number, number, number] | null,
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const band = Math.floor(y / 100) % 2 === 0 ? 255 : 235;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint?.(x, y) ?? [band, band, band];
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/**
 * `odiff-bin` unpacks a native executable at install time (its postinstall
 * copies the one for this platform to `bin/odiff.exe`). When that is missing
 * or not executable (an install that skipped scripts, an unsupported
 * platform) the test is skipped, with the reason, not failed.
 */
function odiffUnavailable(): string | null {
  let bin: string;
  try {
    const entry = createRequire(import.meta.url).resolve("odiff-bin");
    bin = join(dirname(entry), "bin", "odiff.exe");
  } catch (err) {
    return `odiff-bin could not be resolved: ${String(err)}`;
  }
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return `odiff binary is missing or not executable at ${bin}`;
  }
  return null;
}

const skipReason = odiffUnavailable();

describe.skipIf(skipReason !== null)(
  `runL1Odiff diff image${skipReason ? ` (SKIPPED: ${skipReason})` : ""}`,
  () => {
    it("is a complete PNG: it ends with IEND and decodes", async () => {
      const baseline = solidPng(24, 16, [255, 255, 255]);
      const candidate = solidPng(24, 16, [10, 120, 200]);

      const r = await runL1Odiff(
        baseline,
        candidate,
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBeGreaterThan(0);
      const bytes = r.diffImageBytes;
      expect(bytes.length).toBeGreaterThan(IEND.length);
      expect(bytes.subarray(-IEND.length).equals(IEND)).toBe(true);
      const decoded = PNG.sync.read(bytes);
      expect(decoded.width).toBe(24);
      expect(decoded.height).toBe(16);
    });
  },
);

describe.skipIf(skipReason !== null)(
  `runL1Odiff screenshot size${skipReason ? ` (SKIPPED: ${skipReason})` : ""}`,
  () => {
    it("fails a taller screenshot with a matching top: 100%, no image, no regions", async () => {
      // The top 800 rows are identical. odiff compares only the area both
      // images share unless told to fail on a layout change, so without that
      // a page that grew would pass at 0%.
      const baseline = pagePng(1280, 800);
      const candidate = pagePng(1280, 1100);

      const r = await runL1Odiff(
        baseline,
        candidate,
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.diffPercent).toBe(100);
      expect(r.pixelMismatchCount).toBe(0);
      expect(r.regions).toHaveLength(0);
      expect(r.diffImageBytes).toHaveLength(0);
    });

    it("fails a shorter screenshot the same way", async () => {
      const r = await runL1Odiff(
        pagePng(1280, 1100),
        pagePng(1280, 800),
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.diffPercent).toBe(100);
      expect(r.diffImageBytes).toHaveLength(0);
      expect(r.regions).toHaveLength(0);
    });

    it("fails a screenshot whose width changed", async () => {
      const r = await runL1Odiff(
        pagePng(1280, 800),
        pagePng(1024, 800),
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.diffPercent).toBe(100);
      expect(r.diffImageBytes).toHaveLength(0);
    });

    it("still passes identical same-size images at 0", async () => {
      const r = await runL1Odiff(
        pagePng(1280, 800),
        pagePng(1280, 800),
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.diffPercent).toBe(0);
      expect(r.pixelMismatchCount).toBe(0);
      expect(r.diffImageBytes).toHaveLength(0);
      expect(r.regions).toHaveLength(0);
    });

    it("still reports a pixel diff, a complete PNG and a region for same-size images", async () => {
      const baseline = pagePng(1280, 800);
      const candidate = pagePng(1280, 800, (x, y) =>
        x >= 100 && x < 300 && y >= 100 && y < 200 ? [200, 30, 30] : null,
      );

      const r = await runL1Odiff(
        baseline,
        candidate,
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      // About the 200x100 block; odiff skips a few antialiased edge pixels.
      expect(r.pixelMismatchCount).toBeGreaterThan(19000);
      expect(r.pixelMismatchCount).toBeLessThanOrEqual(200 * 100);
      expect(r.diffPercent).toBeGreaterThan(0);
      expect(r.diffPercent).toBeLessThan(100);
      expect(r.diffImageBytes.subarray(-IEND.length).equals(IEND)).toBe(true);
      const decoded = PNG.sync.read(r.diffImageBytes);
      expect(decoded.width).toBe(1280);
      expect(decoded.height).toBe(800);

      // The pixel-cluster pass in runDiff turns that into a region.
      const d = await runDiff({
        baseline: { image: baseline },
        candidate: { image: candidate },
        config: {
          diffThreshold: 0.001,
          engine: "odiff",
          engineConfig: DEFAULT_ENGINE_CONFIG,
        },
      });
      expect(d.passed).toBe(false);
      expect(d.regions.length).toBeGreaterThan(0);
    });

    it("runDiff fails a page that grew, with no image and no regions", async () => {
      const d = await runDiff({
        baseline: { image: pagePng(1280, 800) },
        candidate: { image: pagePng(1280, 1100) },
        config: {
          diffThreshold: 0.001,
          engine: "odiff",
          engineConfig: DEFAULT_ENGINE_CONFIG,
        },
      });

      expect(d.passed).toBe(false);
      expect(d.diffPercent).toBe(100);
      expect(d.regions).toHaveLength(0);
      expect(d.diffImageBytes).toHaveLength(0);
    });
  },
);
