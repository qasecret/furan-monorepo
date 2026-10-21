import { describe, expect, it } from "vitest";

import { percentile, windowCounts } from "../src/stats.js";

describe("percentile", () => {
  it("of a single sample is that sample", () => {
    expect(percentile([10], 95)).toBe(10);
  });

  it("uses nearest rank on two samples", () => {
    expect(percentile([1, 2], 95)).toBe(2);
    expect(percentile([1, 2], 50)).toBe(1);
  });

  it("matches nearest rank for 1..50", () => {
    const sorted = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(48);
    expect(percentile(sorted, 50)).toBe(25);
    expect(percentile(sorted, 100)).toBe(50);
  });

  it("is exact where p*n is a multiple of 100", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(19);
    expect(percentile(sorted, 90)).toBe(18);
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(percentile(ten, 90)).toBe(9);
    expect(percentile(ten, 70)).toBe(7);
  });

  it("clamps p = 0 to the first sample", () => {
    expect(percentile([4, 5, 6], 0)).toBe(4);
  });

  it("throws on an empty array", () => {
    expect(() => percentile([], 95)).toThrow(/empty/i);
  });

  it("throws on a percentile outside 0..100", () => {
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], -1)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe("windowCounts", () => {
  it("counts per consecutive window from the first timestamp", () => {
    expect(windowCounts([0, 100, 3100, 3200, 3300], 3000)).toEqual([2, 3]);
  });

  it("starts at the first timestamp, not at zero", () => {
    expect(windowCounts([2000, 2500, 3500, 4000], 3000)).toEqual([4]);
  });

  it("puts a timestamp on a window boundary in the later window", () => {
    expect(windowCounts([0, 2999, 3000], 3000)).toEqual([2, 1]);
  });

  it("reports empty windows between events as zero", () => {
    expect(windowCounts([0, 7000], 3000)).toEqual([1, 0, 1]);
  });

  it("does not depend on input order", () => {
    expect(windowCounts([3300, 0, 3100, 100, 3200], 3000)).toEqual([2, 3]);
  });

  it("returns no windows for no events", () => {
    expect(windowCounts([], 3000)).toEqual([]);
  });

  it("rejects a non-positive window", () => {
    expect(() => windowCounts([0], 0)).toThrow(RangeError);
    expect(() => windowCounts([0], -5)).toThrow(RangeError);
  });
});
