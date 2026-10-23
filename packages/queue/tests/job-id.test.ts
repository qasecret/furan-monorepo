import { describe, expect, test } from "vitest";

import { diffJobId, type DiffJob } from "../src/index.js";

describe("diffJobId", () => {
  test("is the step id and its version, joined by -g", () => {
    expect(diffJobId("s1", 3)).toBe("s1-g3");
  });

  test("never contains a colon (BullMQ rejects ':' in a custom job id)", () => {
    const id = diffJobId("0b9f6c1e-2d57-4b1a-9d0e-5f3c2a1b7e44", 12);
    expect(id).not.toContain(":");
    expect(id).toBe("0b9f6c1e-2d57-4b1a-9d0e-5f3c2a1b7e44-g12");
  });

  test("each version of a step has its own id", () => {
    expect(diffJobId("s1", 1)).not.toBe(diffJobId("s1", 2));
  });
});

describe("DiffJob", () => {
  test("an old whole-run payload (no screenshotId or generation) still type-checks", () => {
    const wholeRun: DiffJob = { runId: "r1", projectId: "p1" };
    const perStep: DiffJob = {
      runId: "r1",
      projectId: "p1",
      screenshotId: "s1",
      generation: 1,
    };
    expect(wholeRun.screenshotId).toBeUndefined();
    expect(perStep.generation).toBe(1);
  });
});
