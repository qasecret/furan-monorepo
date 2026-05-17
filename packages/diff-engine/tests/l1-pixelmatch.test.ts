import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1Pixelmatch } from "../src/l1-pixelmatch.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1Pixelmatch", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
    expect(r.pixelMismatchCount).toBe(0);
    expect(r.diffImageBytes.length).toBe(0);
  });

  it("returns non-zero diff for materially different images", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0.5);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
    expect(r.diffImageBytes.length).toBeGreaterThan(0);
  });

  it("ignoreAreas covering the diff region zero out the result", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 10000, height: 10000 }],
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });

  it("ignoreAntialiasing=true treats AA-only changes as equal", async () => {
    const r = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, ignoreAntialiasing: true },
    );
    expect(r.diffPercent).toBe(0);
  });

  it("threshold knob: strict catches near-identical, loose does not", async () => {
    // The AA fixture differs from baseline only by alpha ±2 in a 20x20 patch.
    // pixelmatch's `threshold` is per-pixel sensitivity (0=strictest, 1=loosest).
    // With AA tracking ON (ignoreAntialiasing:false → includeAA:true) and strict
    // threshold, those sub-perceptual diffs register. With a loose threshold or
    // AA disabled, they don't.
    const strict = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, threshold: 0, ignoreAntialiasing: false },
    );
    const loose = await runL1Pixelmatch(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, threshold: 0.5, ignoreAntialiasing: false },
    );
    expect(strict.pixelMismatchCount).toBeGreaterThan(loose.pixelMismatchCount);
  });
});
