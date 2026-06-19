import { describe, expect, it } from "vitest";

import { configForMatchLevel, type EngineConfig } from "../src/index.js";

const base: EngineConfig = {
  threshold: 0.1,
  ignoreAntialiasing: false,
  allowDiffDimensions: false,
};

describe("configForMatchLevel", () => {
  it("image-first (ADR-047): every matchLevel returns the base config unchanged", () => {
    for (const level of [
      "Strict",
      "Layout",
      "Content",
      "IgnoreColors",
      "Dynamic",
    ] as const) {
      expect(configForMatchLevel(base, level)).toEqual(base);
    }
  });

  it("does not mutate the input config", () => {
    const input = { ...base, threshold: 0.5 };
    configForMatchLevel(input, "Content");
    expect(input.threshold).toBe(0.5);
  });
});
