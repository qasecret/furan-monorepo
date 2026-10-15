import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { StaleStepCallout } from "@/components/diff-viewer/StaleStepCallout";
import type { ReviewContext } from "@/lib/review-context";

afterEach(cleanup);

/** The filters the viewer was opened with; they travel with the link. */
const FILTERED: ReviewContext = {
  status: "failed",
  facets: { browser: "chromium", os: "macOS" },
};

const link = () => screen.getByRole("link", { name: "Open the newer capture" });

describe("StaleStepCallout", () => {
  test("stale-step link opens the newer capture's exact step", () => {
    render(
      <StaleStepCallout
        newer={{
          buildName: "#42",
          runId: "run-9",
          checkpointId: "cp-9",
          projectId: "p1",
        }}
        context={FILTERED}
      />,
    );
    // The newer run's step of this variation, not the run's first step, and
    // inside the filters the reviewer is working in.
    expect(link().getAttribute("href")).toBe(
      "/projects/p1/runs/run-9/checkpoints/cp-9?status=failed&browser=chromium&os=macOS",
    );
  });

  test("without the newer step, it opens that run's first step, in the same filters", () => {
    render(
      <StaleStepCallout
        newer={{
          buildName: "#42",
          runId: "run-9",
          checkpointId: null,
          projectId: "p1",
        }}
        context={FILTERED}
      />,
    );
    expect(link().getAttribute("href")).toBe(
      "/projects/p1/runs/run-9/checkpoints/_first?status=failed&browser=chromium&os=macOS",
    );
  });

  test("with no review context, the link carries none", () => {
    render(
      <StaleStepCallout
        newer={{
          buildName: "#42",
          runId: "run-9",
          checkpointId: "cp-9",
          projectId: "p1",
        }}
      />,
    );
    expect(link().getAttribute("href")).toBe(
      "/projects/p1/runs/run-9/checkpoints/cp-9",
    );
  });
});
