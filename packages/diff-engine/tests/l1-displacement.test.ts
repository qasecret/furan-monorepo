import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { describe, it, expect } from "vitest";

import {
  detectGlobalDisplacement,
  shiftImage,
} from "../src/l1-displacement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("detectGlobalDisplacement", () => {
  it("reports zero shift with high confidence on identical buffers", () => {
    const baseline = FIXTURE("displacement-baseline.png");
    const result = detectGlobalDisplacement(baseline, baseline);
    expect(result).not.toBeNull();
    expect(result!.dx).toBe(0);
    expect(result!.dy).toBe(0);
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it("detects a 40px vertical shift with high confidence", () => {
    const baseline = FIXTURE("displacement-baseline.png");
    const shifted = FIXTURE("displacement-shifted-down-40.png");
    const result = detectGlobalDisplacement(baseline, shifted);
    expect(result).not.toBeNull();
    // Allow ±1 pixel tolerance from downsample quantization.
    expect(Math.abs(result!.dy - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(result!.dx)).toBeLessThanOrEqual(1);
    expect(result!.confidence).toBeGreaterThan(0.05);
  });

  it("detects a 25px horizontal shift", () => {
    const baseline = FIXTURE("displacement-baseline.png");
    const shifted = FIXTURE("displacement-shifted-right-25.png");
    const result = detectGlobalDisplacement(baseline, shifted);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.dx - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(result!.dy)).toBeLessThanOrEqual(1);
    expect(result!.confidence).toBeGreaterThan(0.05);
  });

  it("reports low confidence on random-noise candidate", () => {
    const baseline = FIXTURE("displacement-baseline.png");
    const noise = FIXTURE("displacement-noise.png");
    const result = detectGlobalDisplacement(baseline, noise);
    expect(result).not.toBeNull();
    // The peak/mean ratio on uncorrelated noise should be near 1.0
    // (flat surface). Confidence well below the 0.05 threshold the
    // engine uses is the contract.
    expect(result!.confidence).toBeLessThan(0.05);
  });

  it("returns null when buffers have mismatched dimensions", () => {
    // The pass requires same-dimension inputs; the engine already
    // returns early on dimension mismatch so this is a safety net.
    const baseline = FIXTURE("displacement-baseline.png");
    // For this test, just pass empty Buffer to provoke null.
    const result = detectGlobalDisplacement(baseline, Buffer.alloc(0));
    expect(result).toBeNull();
  });

  it("detects shift correctly at 512x512 — exercises the downsample path (factor=2)", () => {
    const baseline = FIXTURE("displacement-baseline-512.png");
    const shifted = FIXTURE("displacement-shifted-large-down-60.png");
    const result = detectGlobalDisplacement(baseline, shifted);
    expect(result).not.toBeNull();
    // factor=2; shift of 60 in source coords = 30 in downsampled,
    // multiplied back by 2 = 60 in result. Allow ±2 tolerance for
    // FFT spectral leakage on the larger image.
    expect(Math.abs(result!.dy - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(result!.dx)).toBeLessThanOrEqual(2);
    expect(result!.confidence).toBeGreaterThan(0.05);
  });
});

describe("shiftImage", () => {
  // Build a tiny 4×4 RGBA PNG with each row a distinct color so we can
  // verify exactly which pixels moved where.
  function tinyPng(rows: number[][]): Buffer {
    // rows[y][x] is a 0xRRGGBB integer. Alpha is always 255.
    const png = new PNG({ width: 4, height: 4 });
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const rgb = rows[y]![x]!;
        const i = (y * 4 + x) * 4;
        png.data[i] = (rgb >> 16) & 0xff;
        png.data[i + 1] = (rgb >> 8) & 0xff;
        png.data[i + 2] = rgb & 0xff;
        png.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  }

  function readRows(buf: Buffer): number[][] {
    const png = PNG.sync.read(buf);
    const rows: number[][] = [];
    for (let y = 0; y < png.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        row.push(
          (png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!,
        );
      }
      rows.push(row);
    }
    return rows;
  }

  it("shifts candidate down by dy, padding top with baseline's top rows", () => {
    // Baseline rows: B0 B1 B2 B3 (each row a single color)
    // Candidate rows: C0 C1 C2 C3
    // shiftImage(candidate, baseline, dx=0, dy=1) should produce:
    //   row 0: B0  (padded from baseline)
    //   row 1: C0
    //   row 2: C1
    //   row 3: C2
    const baseline = tinyPng([
      [0x110000, 0x110000, 0x110000, 0x110000],
      [0x220000, 0x220000, 0x220000, 0x220000],
      [0x330000, 0x330000, 0x330000, 0x330000],
      [0x440000, 0x440000, 0x440000, 0x440000],
    ]);
    const candidate = tinyPng([
      [0x000011, 0x000011, 0x000011, 0x000011],
      [0x000022, 0x000022, 0x000022, 0x000022],
      [0x000033, 0x000033, 0x000033, 0x000033],
      [0x000044, 0x000044, 0x000044, 0x000044],
    ]);
    const shifted = shiftImage(candidate, baseline, 0, 1);
    const rows = readRows(shifted);
    expect(rows[0]).toEqual([0x110000, 0x110000, 0x110000, 0x110000]); // baseline B0
    expect(rows[1]).toEqual([0x000011, 0x000011, 0x000011, 0x000011]); // C0
    expect(rows[2]).toEqual([0x000022, 0x000022, 0x000022, 0x000022]); // C1
    expect(rows[3]).toEqual([0x000033, 0x000033, 0x000033, 0x000033]); // C2
  });

  it("shifts candidate up by |dy|, padding bottom with baseline's bottom rows", () => {
    const baseline = tinyPng([
      [0x110000, 0x110000, 0x110000, 0x110000],
      [0x220000, 0x220000, 0x220000, 0x220000],
      [0x330000, 0x330000, 0x330000, 0x330000],
      [0x440000, 0x440000, 0x440000, 0x440000],
    ]);
    const candidate = tinyPng([
      [0x000011, 0x000011, 0x000011, 0x000011],
      [0x000022, 0x000022, 0x000022, 0x000022],
      [0x000033, 0x000033, 0x000033, 0x000033],
      [0x000044, 0x000044, 0x000044, 0x000044],
    ]);
    const shifted = shiftImage(candidate, baseline, 0, -1);
    const rows = readRows(shifted);
    expect(rows[0]).toEqual([0x000022, 0x000022, 0x000022, 0x000022]); // C1
    expect(rows[1]).toEqual([0x000033, 0x000033, 0x000033, 0x000033]); // C2
    expect(rows[2]).toEqual([0x000044, 0x000044, 0x000044, 0x000044]); // C3
    expect(rows[3]).toEqual([0x440000, 0x440000, 0x440000, 0x440000]); // baseline B3
  });

  it("shifts candidate right by dx, padding left with baseline's left columns", () => {
    const baseline = tinyPng([
      [0x110000, 0x220000, 0x330000, 0x440000],
      [0x110000, 0x220000, 0x330000, 0x440000],
      [0x110000, 0x220000, 0x330000, 0x440000],
      [0x110000, 0x220000, 0x330000, 0x440000],
    ]);
    const candidate = tinyPng([
      [0x000011, 0x000022, 0x000033, 0x000044],
      [0x000011, 0x000022, 0x000033, 0x000044],
      [0x000011, 0x000022, 0x000033, 0x000044],
      [0x000011, 0x000022, 0x000033, 0x000044],
    ]);
    const shifted = shiftImage(candidate, baseline, 1, 0);
    const rows = readRows(shifted);
    // Column 0 should be baseline's column 0; columns 1-3 are candidate's
    // columns 0-2.
    expect(rows[0]).toEqual([0x110000, 0x000011, 0x000022, 0x000033]);
  });

  it("is a no-op when dx=0 and dy=0", () => {
    const baseline = tinyPng([
      [0x111111, 0x111111, 0x111111, 0x111111],
      [0x222222, 0x222222, 0x222222, 0x222222],
      [0x333333, 0x333333, 0x333333, 0x333333],
      [0x444444, 0x444444, 0x444444, 0x444444],
    ]);
    const candidate = tinyPng([
      [0xaaaaaa, 0xaaaaaa, 0xaaaaaa, 0xaaaaaa],
      [0xbbbbbb, 0xbbbbbb, 0xbbbbbb, 0xbbbbbb],
      [0xcccccc, 0xcccccc, 0xcccccc, 0xcccccc],
      [0xdddddd, 0xdddddd, 0xdddddd, 0xdddddd],
    ]);
    const shifted = shiftImage(candidate, baseline, 0, 0);
    expect(readRows(shifted)).toEqual(readRows(candidate));
  });
});
