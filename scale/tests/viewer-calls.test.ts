import { describe, expect, it } from "vitest";

import type { Seeded } from "../src/seed/index.js";
import {
  FALLBACK_VIEWER_PATHS,
  ViewerCallDriftError,
  loadViewerCalls,
  viewerTargetOf,
} from "../src/suites/viewer-calls.js";

const FALLBACK = [
  "runs.listCheckpoints",
  "runs.getById",
  "projects.getById",
  "builds.getById",
  "review.next",
  "runs.getCheckpointGroup",
  // The header's needs-review badge, on every page the viewer opens in.
  "builds.pendingCount",
];

const paths = (calls: { path: string }[]): string[] =>
  calls.map((c) => c.path).sort();

// Only what the input builders read.
const seeded = {
  projectId: "00000000-0000-4000-8000-000000000001",
  longRunBuildId: "00000000-0000-4000-8000-000000000002",
  longRunId: "00000000-0000-4000-8000-000000000003",
  longRunFirstStepId: "00000000-0000-4000-8000-000000000004",
} as Seeded;

describe("loadViewerCalls", () => {
  it("checks in the seven procedures the viewer calls on open today", () => {
    expect([...FALLBACK_VIEWER_PATHS].sort()).toEqual([...FALLBACK].sort());
  });

  it("uses the recorded set when it matches", () => {
    const recorded = [...FALLBACK].reverse();
    const { calls, source } = loadViewerCalls(recorded);
    expect(source).toBe("recorded");
    expect(calls.map((c) => c.path)).toEqual(recorded);
  });

  it("counts a path the viewer requested twice once", () => {
    const { calls } = loadViewerCalls([...FALLBACK, "runs.getById"]);
    expect(paths(calls)).toEqual([...FALLBACK].sort());
  });

  it("throws on a recorded path missing from the fallback", () => {
    expect(() => loadViewerCalls([...FALLBACK, "runs.facets"])).toThrow(
      ViewerCallDriftError,
    );
    expect(() => loadViewerCalls([...FALLBACK, "runs.facets"])).toThrow(
      /runs\.facets/,
    );
  });

  it("throws on a fallback path not recorded", () => {
    const recorded = FALLBACK.filter((p) => p !== "runs.getCheckpointGroup");
    expect(() => loadViewerCalls(recorded)).toThrow(ViewerCallDriftError);
    expect(() => loadViewerCalls(recorded)).toThrow(/runs\.getCheckpointGroup/);
  });

  it("treats an empty recording as drift, not as nothing recorded", () => {
    expect(() => loadViewerCalls([])).toThrow(ViewerCallDriftError);
  });

  it("falls back with source=fallback when nothing was recorded", () => {
    const { calls, source } = loadViewerCalls();
    expect(source).toBe("fallback");
    expect(paths(calls)).toEqual([...FALLBACK].sort());
  });

  it("builds every input on step 1 of the long run", () => {
    const { calls } = loadViewerCalls();
    const inputs = Object.fromEntries(
      calls.map((c) => [c.path, c.input(seeded)]),
    );
    expect(inputs).toEqual({
      "runs.listCheckpoints": { runId: seeded.longRunId },
      "runs.getById": { runId: seeded.longRunId },
      "projects.getById": { projectId: seeded.projectId },
      "builds.getById": { buildId: seeded.longRunBuildId },
      "review.next": {
        projectId: seeded.projectId,
        at: {
          buildId: seeded.longRunBuildId,
          runId: seeded.longRunId,
          checkpointId: seeded.longRunFirstStepId,
        },
        facets: {},
      },
      "runs.getCheckpointGroup": {
        runId: seeded.longRunId,
        checkpointId: seeded.longRunFirstStepId,
      },
      "builds.pendingCount": { projectId: seeded.projectId },
    });
  });

  it("builds the same inputs for any other step through inputAt", () => {
    const { calls } = loadViewerCalls();
    const target = viewerTargetOf(seeded);
    for (const call of calls) {
      expect(call.inputAt(target)).toEqual(call.input(seeded));
    }
  });
});
