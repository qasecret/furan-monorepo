import { describe, expect, test } from "vitest";

import { diffViewerHref } from "@/lib/diff-viewer-href";

describe("diffViewerHref", () => {
  test("opens a run's first checkpoint when no checkpoint is named", () => {
    expect(diffViewerHref("p1", "r1")).toBe(
      "/projects/p1/runs/r1/checkpoints/_first",
    );
  });

  test("opens the named checkpoint", () => {
    expect(diffViewerHref("p1", "r1", "c1")).toBe(
      "/projects/p1/runs/r1/checkpoints/c1",
    );
  });

  test("a clean context adds nothing", () => {
    expect(
      diffViewerHref("p1", "r1", "c1", { status: "needs-review", facets: {} }),
    ).toBe("/projects/p1/runs/r1/checkpoints/c1");
  });

  test("carries the status and the environment facets", () => {
    expect(
      diffViewerHref("p1", "r1", "c1", {
        status: "failed",
        facets: { browser: "chrome", viewport: "1280x720" },
      }),
    ).toBe(
      "/projects/p1/runs/r1/checkpoints/c1?status=failed&browser=chrome&viewport=1280x720",
    );
  });

  test("carries the context to the first checkpoint too", () => {
    expect(
      diffViewerHref("p1", "r1", undefined, { facets: { os: "macOS" } }),
    ).toBe("/projects/p1/runs/r1/checkpoints/_first?os=macOS");
  });

  test("does not carry the Batches-only params (branch, search, props)", () => {
    expect(
      diffViewerHref("p1", "r1", "c1", {
        branch: "main",
        q: "login",
        props: { team: "web" },
      }),
    ).toBe("/projects/p1/runs/r1/checkpoints/c1");
  });
});
