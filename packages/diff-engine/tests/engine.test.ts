import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runDiff } from "../src/engine.js";
import { DEFAULT_ENGINE_CONFIG } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PNG_FIXTURE = (n: string) => readFileSync(join(__dirname, "fixtures", n));
const HTML = (n: string) =>
  readFileSync(join(__dirname, "fixtures", n), "utf8");

describe("runDiff", () => {
  it("L1 below threshold short-circuits L2", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-identical.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.1,
        l2Enabled: true,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
    expect(result.durationMs.l2).toBeNull();
  });

  it("L1 above threshold runs L2", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-major.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.001,
        l2Enabled: true,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toContain("l2");
    expect(result.regions.length).toBeGreaterThan(0);
  });

  it("l2Enabled=false skips L2 regardless of L1", async () => {
    const result = await runDiff({
      baseline: {
        image: PNG_FIXTURE("baseline-a.png"),
        dom: HTML("dom-baseline.html"),
      },
      candidate: {
        image: PNG_FIXTURE("candidate-a-major.png"),
        dom: HTML("dom-text-change.html"),
      },
      config: {
        diffThreshold: 0.001,
        l2Enabled: false,
        engine: "odiff",
        engineConfig: DEFAULT_ENGINE_CONFIG,
      },
    });
    expect(result.ranTiers).toEqual(["l1"]);
  });
});
