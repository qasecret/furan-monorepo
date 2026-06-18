import { describe, expect, it } from "vitest";

import { computePrimarySignature } from "../src/primary-signature.js";

describe("computePrimarySignature", () => {
  it("returns null when there are no unresolved-with-signature checkpoints", () => {
    expect(computePrimarySignature([])).toBeNull();
    expect(
      computePrimarySignature([
        { diffSignature: null, worstSeverity: "breaking" },
        { diffSignature: "v1:aaa", worstSeverity: "none" },
      ]),
    ).toBeNull();
  });
  it("picks the most-severe unresolved checkpoint's signature", () => {
    expect(
      computePrimarySignature([
        { diffSignature: "v1:minor", worstSeverity: "minor" },
        { diffSignature: "v1:breaking", worstSeverity: "breaking" },
        { diffSignature: "v1:major", worstSeverity: "major" },
      ]),
    ).toBe("v1:breaking");
  });
  it("breaks ties by frequency, then first-seen", () => {
    expect(
      computePrimarySignature([
        { diffSignature: "v1:rare", worstSeverity: "major" },
        { diffSignature: "v1:common", worstSeverity: "major" },
        { diffSignature: "v1:common", worstSeverity: "major" },
      ]),
    ).toBe("v1:common");
    expect(
      computePrimarySignature([
        { diffSignature: "v1:first", worstSeverity: "minor" },
        { diffSignature: "v1:second", worstSeverity: "minor" },
      ]),
    ).toBe("v1:first");
  });
});
