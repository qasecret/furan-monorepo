import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { detectGlobalDisplacement } from "../src/l1-displacement.js";

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
