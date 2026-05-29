import { describe, expect, it } from "vitest";

import { configForMatchLevel, type EngineConfig } from "../src/index.js";

const base: EngineConfig = {
  threshold: 0.1,
  ignoreAntialiasing: false,
  allowDiffDimensions: false,
};

describe("configForMatchLevel", () => {
  it("Strict: l1 only, base config unchanged", () => {
    const r = configForMatchLevel(base, "Strict");
    expect(r.runL1).toBe(true);
    expect(r.runL2Only).toBe(false);
    expect(r.config).toEqual(base);
  });
  it("Layout: skips l1, runs l2 only", () => {
    const r = configForMatchLevel(base, "Layout");
    expect(r.runL1).toBe(false);
    expect(r.runL2Only).toBe(true);
  });
  it("Content: enables ignoreAntialiasing and raises threshold to 0.2", () => {
    const r = configForMatchLevel(base, "Content");
    expect(r.config.ignoreAntialiasing).toBe(true);
    expect(r.config.threshold).toBeGreaterThanOrEqual(0.2);
  });
  it("Content: doesn't lower threshold below pre-existing value", () => {
    const r = configForMatchLevel({ ...base, threshold: 0.5 }, "Content");
    expect(r.config.threshold).toBeGreaterThanOrEqual(0.5);
  });
  it("IgnoreColors falls back to Strict for v1.1.0", () => {
    expect(configForMatchLevel(base, "IgnoreColors")).toEqual(
      configForMatchLevel(base, "Strict"),
    );
  });
  it("Dynamic falls back to Strict for v1.1.0", () => {
    expect(configForMatchLevel(base, "Dynamic")).toEqual(
      configForMatchLevel(base, "Strict"),
    );
  });
});
