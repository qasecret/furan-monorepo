import { describe, expect, it } from "vitest";

import { configForMatchLevel, type EngineConfig } from "../src/index.js";

const base: EngineConfig = {
  threshold: 0.1,
  ignoreAntialiasing: false,
  allowDiffDimensions: false,
};

describe("configForMatchLevel", () => {
  const STRICT = { config: base, runL1: true, runL2Only: false };

  it("Strict: image-only, base config unchanged", () => {
    expect(configForMatchLevel(base, "Strict")).toEqual(STRICT);
  });

  it("image-first (ADR-047): every matchLevel collapses to Strict", () => {
    for (const level of [
      "Strict",
      "Layout",
      "Content",
      "IgnoreColors",
      "Dynamic",
    ] as const) {
      expect(configForMatchLevel(base, level)).toEqual(STRICT);
    }
  });

  it("Layout no longer skips the pixel compare (was runL2Only)", () => {
    const r = configForMatchLevel(base, "Layout");
    expect(r.runL1).toBe(true);
    expect(r.runL2Only).toBe(false);
  });

  it("Content no longer raises the threshold (config is the base verbatim)", () => {
    expect(
      configForMatchLevel({ ...base, threshold: 0.1 }, "Content").config,
    ).toEqual({ ...base, threshold: 0.1 });
  });
});
