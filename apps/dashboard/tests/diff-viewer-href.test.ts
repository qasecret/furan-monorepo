import { describe, expect, test } from "vitest";

import { diffViewerHref } from "@/lib/diff-viewer-href";

describe("diffViewerHref", () => {
  test("builds the run-level diff viewer route (runId in both segments)", () => {
    expect(diffViewerHref("p1", "r1")).toBe("/projects/p1/runs/r1/diffs/r1");
  });
});
