import { describe, expect, it } from "vitest";

import type { Seeded } from "../src/seed/index.js";
import {
  FALLBACK_VIEWER_PATHS,
  ViewerCallDriftError,
  loadViewerCalls,
  railNeighbours,
  viewerTargetOf,
} from "../src/suites/viewer-calls.js";

/**
 * What the diff viewer asks for when it opens a step (spec 2026-10-27 §5),
 * read from the dashboard: `DiffViewer.tsx` (the step list, the run header,
 * the project, the step and its neighbours through `use-viewer-step.ts`),
 * `use-review-loop.ts` (where the review goes next), `GroupApprovalCallout`
 * (the step's group) and the protected header's `inbox-badge.tsx`.
 */
const FALLBACK = [
  "runs.listCheckpoints",
  // The run header: its own fields and its batch's runner, nothing per step.
  "runs.getById",
  "projects.getById",
  // The step on screen, and the steps either side of it, fetched ahead.
  "runs.getStep",
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
  // Step 1 is the rail's first: its one neighbour is step 2.
  longRunFirstStepNeighbours: ["00000000-0000-4000-8000-000000000005"],
} as Seeded;

describe("viewer-calls", () => {
  it("lists getStep and the run header, not builds.getById", () => {
    expect(FALLBACK_VIEWER_PATHS).toContain("runs.getStep");
    expect(FALLBACK_VIEWER_PATHS).toContain("runs.getById");
    expect(FALLBACK_VIEWER_PATHS).not.toContain("builds.getById");
    // Nothing else: exactly the procedures the viewer calls on open.
    expect([...FALLBACK_VIEWER_PATHS].sort()).toEqual([...FALLBACK].sort());
  });

  it("reads the step on screen, then its neighbours, through getStep", () => {
    const { calls } = loadViewerCalls();
    const getStep = calls.find((c) => c.path === "runs.getStep")!;
    // Step 1 of the long run, then step 2, which the viewer fetches ahead.
    expect(getStep.inputs(seeded)).toEqual([
      { runId: seeded.longRunId, checkpointId: seeded.longRunFirstStepId },
      {
        runId: seeded.longRunId,
        checkpointId: seeded.longRunFirstStepNeighbours[0],
      },
    ]);
    // A step in the middle of a run: the next one, then the previous one.
    expect(
      getStep.inputsAt({
        projectId: "p",
        buildId: "b",
        runId: "r",
        checkpointId: "c2",
        neighbours: ["c3", "c1"],
      }),
    ).toEqual([
      { runId: "r", checkpointId: "c2" },
      { runId: "r", checkpointId: "c3" },
      { runId: "r", checkpointId: "c1" },
    ]);
    // Every other procedure is one request.
    for (const call of calls.filter((c) => c.path !== "runs.getStep")) {
      expect(call.inputs(seeded), call.path).toHaveLength(1);
    }
  });
});

describe("railNeighbours", () => {
  const rail = ["c1", "c2", "c3", "c4"];

  it("names the next step, then the previous one, as the viewer fetches them ahead", () => {
    expect(railNeighbours(rail, "c2")).toEqual(["c3", "c1"]);
  });

  it("has only a next step at the rail's start and only a previous one at its end", () => {
    expect(railNeighbours(rail, "c1")).toEqual(["c2"]);
    expect(railNeighbours(rail, "c4")).toEqual(["c3"]);
  });

  it("has none for a run of one step, or a step the rail does not hold", () => {
    expect(railNeighbours(["c1"], "c1")).toEqual([]);
    expect(railNeighbours(rail, "c9")).toEqual([]);
  });
});

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
    const { calls } = loadViewerCalls([...FALLBACK, "runs.getStep"]);
    expect(paths(calls)).toEqual([...FALLBACK].sort());
  });

  it("throws on a recorded path missing from the fallback", () => {
    expect(() => loadViewerCalls([...FALLBACK, "builds.getById"])).toThrow(
      ViewerCallDriftError,
    );
    expect(() => loadViewerCalls([...FALLBACK, "builds.getById"])).toThrow(
      /builds\.getById/,
    );
  });

  it("throws on a fallback path not recorded", () => {
    const recorded = FALLBACK.filter((p) => p !== "runs.getStep");
    expect(() => loadViewerCalls(recorded)).toThrow(ViewerCallDriftError);
    expect(() => loadViewerCalls(recorded)).toThrow(/runs\.getStep/);
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
      calls.map((c) => [c.path, c.inputs(seeded)]),
    );
    const step = {
      runId: seeded.longRunId,
      checkpointId: seeded.longRunFirstStepId,
    };
    expect(inputs).toEqual({
      "runs.listCheckpoints": [{ runId: seeded.longRunId }],
      "runs.getById": [{ runId: seeded.longRunId }],
      "projects.getById": [{ projectId: seeded.projectId }],
      "runs.getStep": [
        step,
        {
          runId: seeded.longRunId,
          checkpointId: seeded.longRunFirstStepNeighbours[0],
        },
      ],
      "review.next": [
        {
          projectId: seeded.projectId,
          at: { buildId: seeded.longRunBuildId, ...step },
          facets: {},
        },
      ],
      "runs.getCheckpointGroup": [step],
      "builds.pendingCount": [{ projectId: seeded.projectId }],
    });
  });

  it("builds the same inputs for any other step through inputsAt", () => {
    const { calls } = loadViewerCalls();
    const target = viewerTargetOf(seeded);
    expect(target.neighbours).toEqual(seeded.longRunFirstStepNeighbours);
    for (const call of calls) {
      expect(call.inputsAt(target)).toEqual(call.inputs(seeded));
    }
  });
});
