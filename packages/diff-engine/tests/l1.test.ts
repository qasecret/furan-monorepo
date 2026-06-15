import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1 } from "../src/l1.js";
import { DEFAULT_ENGINE_CONFIG, type ImageComparison } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1 dispatcher", () => {
  it.each<ImageComparison>(["odiff", "pixelmatch", "looks_same"])(
    "returns 0 diff for identical images via %s",
    async (engine) => {
      const r = await runL1(
        FIXTURE("baseline-a.png"),
        FIXTURE("candidate-a-identical.png"),
        undefined,
        engine,
        DEFAULT_ENGINE_CONFIG,
      );
      expect(r.diffPercent).toBe(0);
      expect(r.pixelMismatchCount).toBe(0);
    },
  );

  it("throws on unknown engine value", async () => {
    await expect(
      runL1(
        FIXTURE("baseline-a.png"),
        FIXTURE("candidate-a-identical.png"),
        undefined,
        "nope" as unknown as ImageComparison,
        DEFAULT_ENGINE_CONFIG,
      ),
    ).rejects.toThrow(/Unknown image comparison engine/);
  });
});

describe("runL1 odiff regression", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-identical.png"),
      undefined,
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
    expect(r.pixelMismatchCount).toBe(0);
    expect(r.regions).toEqual([]);
  });

  it("returns non-zero diff for materially different images", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0.5);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
  });

  it("zeros pixel diffs inside ignoreAreas", async () => {
    const r = await runL1(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 100, height: 100 }],
      "odiff",
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });
});
