import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL1LooksSame } from "../src/l1-looks-same.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));

describe("runL1LooksSame", () => {
  it("returns 0 diff for identical images", async () => {
    const r = await runL1LooksSame(
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
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      undefined,
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBeGreaterThan(0);
    expect(r.pixelMismatchCount).toBeGreaterThan(0);
    expect(r.diffImageBytes.length).toBeGreaterThan(0);
  });

  it("ignoreAreas covering the diff region zero out the result", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-major.png"),
      [{ x: 0, y: 0, width: 10000, height: 10000 }],
      DEFAULT_ENGINE_CONFIG,
    );
    expect(r.diffPercent).toBe(0);
  });

  it("ignoreAntialiasing=true treats AA-only changes as equal", async () => {
    const r = await runL1LooksSame(
      FIXTURE("baseline-a.png"),
      FIXTURE("candidate-a-aa-only.png"),
      undefined,
      { ...DEFAULT_ENGINE_CONFIG, ignoreAntialiasing: true },
    );
    expect(r.diffPercent).toBe(0);
  });
});
