import type { Seeded } from "../seed/index.js";

import fallbackPaths from "./viewer-calls.json" with { type: "json" };

/**
 * R4's call set (spec §5.3): the tRPC procedures the diff viewer fetches when
 * it opens a step. The browser suite records the real list (Task 15); the
 * checked-in `viewer-calls.json` is the fallback when it did not run. The two
 * must name the same procedures, so the measured set cannot drift from the
 * viewer: `loadViewerCalls` refuses a recording that differs.
 *
 * The JSON holds the paths only; the inputs are built here, as the viewer
 * sends them (`DiffViewer.tsx`, `use-review-loop.ts`,
 * `GroupApprovalCallout.tsx`, and the header's `inbox-badge.tsx`), for one
 * step.
 */

/** The step a viewer is opened on. */
export interface ViewerTarget {
  projectId: string;
  buildId: string;
  runId: string;
  checkpointId: string;
}

export interface ViewerCall {
  path: string;
  /** The input on step 1 of the long run (R4's step). */
  input: (s: Seeded) => unknown;
  /** The input on any other step (the reviewers' loop opens its own). */
  inputAt: (t: ViewerTarget) => unknown;
}

export class ViewerCallDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerCallDriftError";
  }
}

/** Each procedure's input as the viewer sends it on open. */
const INPUTS: Readonly<Record<string, (t: ViewerTarget) => unknown>> = {
  "runs.listCheckpoints": (t) => ({ runId: t.runId }),
  "runs.getById": (t) => ({ runId: t.runId }),
  "projects.getById": (t) => ({ projectId: t.projectId }),
  "builds.getById": (t) => ({ buildId: t.buildId }),
  // The loop's question from the step on screen, with the context's facets
  // (none on a plain open).
  "review.next": (t) => ({
    projectId: t.projectId,
    at: { buildId: t.buildId, runId: t.runId, checkpointId: t.checkpointId },
    facets: {},
  }),
  "runs.getCheckpointGroup": (t) => ({
    runId: t.runId,
    checkpointId: t.checkpointId,
  }),
  // Not the viewer's own: the protected header's needs-review badge
  // (`inbox-badge.tsx`), which every page asks for when it opens cold, as the
  // browser suite records it.
  "builds.pendingCount": (t) => ({ projectId: t.projectId }),
};

/** The checked-in call set (`viewer-calls.json`). */
export const FALLBACK_VIEWER_PATHS: readonly string[] = fallbackPaths;

for (const path of FALLBACK_VIEWER_PATHS) {
  if (INPUTS[path] === undefined) {
    // A path added to the JSON without an input builder: a harness bug.
    throw new Error(`viewer-calls.json names ${path}, which has no input`);
  }
}

/** Step 1 of the long run, where R4 opens the viewer. */
export function viewerTargetOf(s: Seeded): ViewerTarget {
  return {
    projectId: s.projectId,
    buildId: s.longRunBuildId,
    runId: s.longRunId,
    checkpointId: s.longRunFirstStepId,
  };
}

function callFor(path: string): ViewerCall {
  const build = INPUTS[path]!;
  return {
    path,
    input: (s) => build(viewerTargetOf(s)),
    inputAt: build,
  };
}

/**
 * The call set R4 measures. With `recorded` (the browser suite's procedure
 * paths, duplicates allowed), that list, in its order, once it is checked to
 * name exactly the fallback's procedures; without it, the fallback. Throws
 * `ViewerCallDriftError` naming every path on one side only. An empty
 * recording is drift (the viewer called nothing?), never "not recorded".
 */
export function loadViewerCalls(recorded?: readonly string[]): {
  calls: ViewerCall[];
  source: "recorded" | "fallback";
} {
  if (recorded === undefined) {
    return { calls: FALLBACK_VIEWER_PATHS.map(callFor), source: "fallback" };
  }
  const unique = [...new Set(recorded)];
  const known = new Set(FALLBACK_VIEWER_PATHS);
  const extra = unique.filter((p) => !known.has(p));
  const missing = FALLBACK_VIEWER_PATHS.filter((p) => !unique.includes(p));
  if (extra.length > 0 || missing.length > 0) {
    const parts = [
      ...(extra.length > 0
        ? [`recorded but not in viewer-calls.json: ${extra.join(", ")}`]
        : []),
      ...(missing.length > 0
        ? [`in viewer-calls.json but not recorded: ${missing.join(", ")}`]
        : []),
    ];
    throw new ViewerCallDriftError(
      `the viewer's call set drifted (${parts.join("; ")}); update scale/src/suites/viewer-calls.json and its inputs`,
    );
  }
  return { calls: unique.map(callFor), source: "recorded" };
}
