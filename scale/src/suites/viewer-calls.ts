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
 * sends them, for one step. Since slice 3 (spec 2026-10-27 §5) the viewer
 * reads one step at a time:
 *
 * - `DiffViewer.tsx`: the step list (`runs.listCheckpoints`), the run header
 *   (`runs.getById`: the run's own fields and its batch's runner, so no
 *   `builds.getById`), the project's settings (`projects.getById`), and
 *   through `use-viewer-step.ts` the step on screen (`runs.getStep`) and the
 *   steps either side of it in the rail, fetched ahead (`usePrefetchSteps`,
 *   the next one, then the previous one);
 * - `use-review-loop.ts`: where the review goes next (`review.next`);
 * - `GroupApprovalCallout.tsx`: the step's group (`runs.getCheckpointGroup`);
 * - the protected header's `inbox-badge.tsx` (`builds.pendingCount`).
 *
 * Not modelled: what the loop fetches ahead for the step `review.next`
 * names, when that is neither the step on screen nor a neighbour (its
 * `runs.getStep`, and another run's `runs.getById` and
 * `runs.listCheckpoints`). Those are the same procedures, so the path set is
 * exact; only that request count depends on the review queue.
 */

/** The step a viewer is opened on. */
export interface ViewerTarget {
  projectId: string;
  buildId: string;
  runId: string;
  checkpointId: string;
  /**
   * The steps either side of it in the rail (`runs.listCheckpoints`' order),
   * the next one first, as the viewer fetches them ahead (`railNeighbours`).
   */
  neighbours: readonly string[];
}

export interface ViewerCall {
  path: string;
  /**
   * The inputs on step 1 of the long run (R4's step), one per request: one
   * for most procedures, the step and its neighbours for `runs.getStep`.
   */
  inputs: (s: Seeded) => unknown[];
  /** The inputs on any other step (the reviewers' loop opens its own). */
  inputsAt: (t: ViewerTarget) => unknown[];
}

export class ViewerCallDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerCallDriftError";
  }
}

/** Each procedure's inputs as the viewer sends them on open, one per request. */
const INPUTS: Readonly<Record<string, (t: ViewerTarget) => unknown[]>> = {
  "runs.listCheckpoints": (t) => [{ runId: t.runId }],
  "runs.getById": (t) => [{ runId: t.runId }],
  "projects.getById": (t) => [{ projectId: t.projectId }],
  // The step on screen, then each neighbour the viewer fetches ahead.
  "runs.getStep": (t) =>
    [t.checkpointId, ...t.neighbours].map((checkpointId) => ({
      runId: t.runId,
      checkpointId,
    })),
  // The loop's question from the step on screen, with the context's facets
  // (none on a plain open).
  "review.next": (t) => [
    {
      projectId: t.projectId,
      at: { buildId: t.buildId, runId: t.runId, checkpointId: t.checkpointId },
      facets: {},
    },
  ],
  "runs.getCheckpointGroup": (t) => [
    { runId: t.runId, checkpointId: t.checkpointId },
  ],
  // Not the viewer's own: the protected header's needs-review badge
  // (`inbox-badge.tsx`), which every page asks for when it opens cold, as the
  // browser suite records it.
  "builds.pendingCount": (t) => [{ projectId: t.projectId }],
};

/** The checked-in call set (`viewer-calls.json`). */
export const FALLBACK_VIEWER_PATHS: readonly string[] = fallbackPaths;

for (const path of FALLBACK_VIEWER_PATHS) {
  if (INPUTS[path] === undefined) {
    // A path added to the JSON without an input builder: a harness bug.
    throw new Error(`viewer-calls.json names ${path}, which has no input`);
  }
}

/**
 * The steps the viewer fetches ahead of `checkpointId`: the next one in the
 * rail, then the previous one, those that exist (`DiffViewer.tsx`'s
 * `usePrefetchSteps(runId, [nextStepId, prevStepId])`). None for a step the
 * rail does not hold.
 */
export function railNeighbours(
  rail: readonly string[],
  checkpointId: string,
): string[] {
  const at = rail.indexOf(checkpointId);
  if (at < 0) return [];
  return [rail[at + 1], rail[at - 1]].filter(
    (id): id is string => id !== undefined,
  );
}

/** Step 1 of the long run, where R4 opens the viewer. */
export function viewerTargetOf(s: Seeded): ViewerTarget {
  return {
    projectId: s.projectId,
    buildId: s.longRunBuildId,
    runId: s.longRunId,
    checkpointId: s.longRunFirstStepId,
    neighbours: s.longRunFirstStepNeighbours,
  };
}

function callFor(path: string): ViewerCall {
  const build = INPUTS[path]!;
  return {
    path,
    inputs: (s) => build(viewerTargetOf(s)),
    inputsAt: build,
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
