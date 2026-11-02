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
 * `odiff-bin` 4 ships the native executable in a per-platform optional
 * dependency (`@odiff/<platform>-<arch>`) and finds it with its own
 * `findBinary()`, the lookup `compare()` uses. When that fails or the file is
 * not executable (an install that skipped optional dependencies, an
 * unsupported platform) the test is skipped, with the reason, not failed.
 */
function odiffUnavailable(): string | null {
  let bin: string;
  try {
    const load = createRequire(import.meta.url);
    const { findBinary } = load(
      join(dirname(load.resolve("odiff-bin")), "binary.js"),
    ) as { findBinary: () => string };
    bin = findBinary();
  } catch (err) {
    return `odiff binary could not be resolved: ${String(err)}`;
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
  `runL1Odiff ignore regions${skipReason ? ` (SKIPPED: ${skipReason})` : ""}`,
  () => {
    // A 144x144 block recoloured at (100, 100).
    const baseline = pagePng(400, 400);
    const candidate = pagePng(400, 400, (x, y) =>
      x >= 100 && x < 244 && y >= 100 && y < 244 ? [200, 30, 30] : null,
    );

    it("ignores exactly the region's pixels", async () => {
      const r = await runL1Odiff(
        baseline,
        candidate,
        [{ x: 100, y: 100, width: 40, height: 40 }],
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBe(144 * 144 - 40 * 40);
    });

    it("still counts a change in the region's rows, outside it", async () => {
      // odiff 3 ignored every row from the region's top to its bottom, so
      // this change at x=300 went unseen.
      const r = await runL1Odiff(
        baseline,
        pagePng(400, 400, (x, y) => (x === 300 && y === 20 ? [0, 0, 0] : null)),
        [{ x: 0, y: 0, width: 40, height: 40 }],
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBe(1);
    });

    it("skips a region that padding clamped to nothing", async () => {
      const r = await runL1Odiff(
        baseline,
        candidate,
        [{ x: 400, y: 0, width: 0, height: 40 }],
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBe(144 * 144);
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

    it("reports the exact percentage of a small change, which fails a zero threshold", async () => {
      // 40 pixels of 1280x800 is 0.00390625%; odiff 4 prints it as 0.00.
      const baseline = pagePng(1280, 800);
      const candidate = pagePng(1280, 800, (x, y) =>
        x === 10 && y < 40 ? [0, 0, 255] : null,
      );

      const r = await runL1Odiff(
        baseline,
        candidate,
        undefined,
        DEFAULT_ENGINE_CONFIG,
      );

      expect(r.pixelMismatchCount).toBe(40);
      expect(r.diffPercent).toBe(0.00390625);

      const d = await runDiff({
        baseline: { image: baseline },
        candidate: { image: candidate },
        config: {
          diffThreshold: 0,
          engine: "odiff",
          engineConfig: DEFAULT_ENGINE_CONFIG,
        },
      });
      expect(d.passed).toBe(false);
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

      // The whole 200x100 block: its hard edges are not antialiasing (odiff 3
      // skipped some of them).
      expect(r.pixelMismatchCount).toBe(200 * 100);
      expect(r.diffPercent).toBe(1.953125); // 20000 of 1280x800
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

    it("with Allow diff dimensions off (the default), a size change fails", async () => {
      expect(DEFAULT_ENGINE_CONFIG.allowDiffDimensions).toBe(false);
      const r = await runL1Odiff(
        pagePng(1280, 800),
        pagePng(1280, 1100),
        undefined,
        { ...DEFAULT_ENGINE_CONFIG, allowDiffDimensions: false },
      );

      expect(r.diffPercent).toBe(100);
      expect(r.diffImageBytes).toHaveLength(0);
      expect(r.regions).toHaveLength(0);
    });

    it("with Allow diff dimensions on, a taller screenshot with a matching top compares the area both share, and passes", async () => {
      // The project opted out of failing on a size change (R30): only the
      // shared area is compared. odiff 4 alone would count the 300 extra rows.
      const r = await runL1Odiff(
        pagePng(1280, 800),
        pagePng(1280, 1100),
        undefined,
        { ...DEFAULT_ENGINE_CONFIG, allowDiffDimensions: true },
      );

      expect(r.diffPercent).toBe(0);
      expect(r.pixelMismatchCount).toBe(0);
      expect(r.diffImageBytes).toHaveLength(0);
      expect(r.regions).toHaveLength(0);
    });

    it("with Allow diff dimensions on, a shorter screenshot also compares the area both share, and passes", async () => {
      // odiff 3 compared only the baseline's area, so a page that shrank
      // counted its missing rows; the shared area is the same either way.
      const r = await runL1Odiff(
        pagePng(1280, 1100),
        pagePng(1280, 800),
        undefined,
        { ...DEFAULT_ENGINE_CONFIG, allowDiffDimensions: true },
      );

      expect(r.diffPercent).toBe(0);
      expect(r.pixelMismatchCount).toBe(0);
      expect(r.diffImageBytes).toHaveLength(0);
    });

    it("with Allow diff dimensions on, a change inside the shared area is a pixel diff of that area", async () => {
      const r = await runL1Odiff(
        pagePng(1280, 800),
        pagePng(1280, 1100, (x, y) =>
          x >= 100 && x < 300 && y >= 100 && y < 200 ? [200, 30, 30] : null,
        ),
        undefined,
        { ...DEFAULT_ENGINE_CONFIG, allowDiffDimensions: true },
      );

      expect(r.pixelMismatchCount).toBe(200 * 100);
      expect(r.diffPercent).toBe(1.953125); // 20000 of 1280x800
      expect(r.diffImageBytes.subarray(-IEND.length).equals(IEND)).toBe(true);
      const decoded = PNG.sync.read(r.diffImageBytes);
      expect(decoded.width).toBe(1280);
      expect(decoded.height).toBe(800);
    });

    it("with Allow diff dimensions on, a width change compares the shared columns", async () => {
      const block = (x: number, y: number): [number, number, number] | null =>
        x >= 100 && x < 300 && y >= 100 && y < 200 ? [200, 30, 30] : null;
      const r = await runL1Odiff(
        pagePng(1024, 800, block),
        pagePng(1280, 800),
        undefined,
        { ...DEFAULT_ENGINE_CONFIG, allowDiffDimensions: true },
      );

      expect(r.pixelMismatchCount).toBe(200 * 100);
      expect(r.diffPercent).toBe(2.44140625); // 20000 of 1024x800
      const decoded = PNG.sync.read(r.diffImageBytes);
      expect(decoded.width).toBe(1024);
      expect(decoded.height).toBe(800);
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
