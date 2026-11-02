import { describe, expect, it } from "vitest";

import { isPassing, toResultStatus, type ResultStatus } from "../src/index.js";

describe("toResultStatus", () => {
  it.each<[string, boolean, "passed" | "new" | "failed"]>([
    ["passed", false, "passed"],
    ["empty", false, "passed"],
    ["new", true, "passed"],
    ["new", false, "new"],
    ["unresolved", false, "failed"],
    ["failed", false, "failed"],
    ["aborted", false, "failed"],
    ["mystery", false, "failed"],
  ])("%s (autoApproved %s) → %s", (status, autoApproved, expected) => {
    expect(toResultStatus({ status, autoApproved })).toBe(expected);
  });
});

describe("isPassing", () => {
  it.each<[ResultStatus, boolean, boolean]>([
    ["passed", false, true],
    ["uploaded", false, true],
    ["skipped", false, true],
    ["new", false, true],
    ["new", true, false],
    ["failed", false, false],
    ["error", false, false],
  ])("%s with failOnNew %s → %s", (status, failOnNew, expected) => {
    expect(isPassing(status, failOnNew)).toBe(expected);
  });
});
