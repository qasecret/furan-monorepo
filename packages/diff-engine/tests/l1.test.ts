import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1 } from "../src/l1.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1", () => {
  it("returns 0 diff for identical images", async () => {
    const baseline = FIXTURE("baseline-a.png");
    const candidate = FIXTURE("candidate-a-identical.png");
    const result = await runL1(baseline, candidate, undefined);
    expect(result.diffPercent).toBe(0);
    expect(result.pixelMismatchCount).toBe(0);
    expect(result.regions).toEqual([]);
  });

  it("returns non-zero diff for materially different images", async () => {
    const baseline = FIXTURE("baseline-a.png");
    const candidate = FIXTURE("candidate-a-major.png");
    const result = await runL1(baseline, candidate, undefined);
    expect(result.diffPercent).toBeGreaterThan(0.5);
    expect(result.pixelMismatchCount).toBeGreaterThan(0);
  });

  it("zeros pixel diffs inside ignoreAreas", async () => {
    const baseline = FIXTURE("baseline-a.png");
    const candidate = FIXTURE("candidate-a-major.png");
    const result = await runL1(baseline, candidate, [
      { x: 0, y: 0, width: 100, height: 100 },
    ]);
    expect(result.diffPercent).toBe(0);
  });
});
