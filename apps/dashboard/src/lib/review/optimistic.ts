import {
  isPending,
  rollupRunStatus,
  type CheckpointDecisionKind,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";

import type { RouterOutputs } from "@/lib/trpc";

/**
 * Pure patches for the review caches: what a decision or an undo will look
 * like once the server has answered. They only guess a result the server will
 * confirm (or correct, on the refetch that follows every settled call).
 */

export type CheckpointItem =
  RouterOutputs["runs"]["listCheckpoints"]["items"][number];
export type RunDetail = RouterOutputs["runs"]["getById"];
export type RunsListPage = RouterOutputs["runs"]["list"];
export type BuildDetail = RouterOutputs["builds"]["getById"];

/** The review fields a checkpoint has in every cached view of it. */
type Review = Pick<CheckpointItem, "verdict" | "state" | "decision">;

export interface Actor {
  id: string;
  name: string;
}

function decideOne<T extends Review>(
  c: T,
  kind: CheckpointDecisionKind,
  actor: Actor,
  actionId: string,
): T {
  return {
    ...c,
    state: kind,
    decision: {
      id: `optimistic:${actionId}`,
      actionId,
      kind,
      actor,
      at: new Date().toISOString(),
      source: "viewer",
      legacy: false,
      undo: { allowed: true },
    },
  };
}

function revertOne<T extends Review>(c: T): T {
  return { ...c, state: c.verdict, decision: null };
}

/** Rewrites one checkpoint's review fields, or returns it as it is. */
type Rewrite = <T extends Review>(id: string, c: T) => T;

/**
 * The run status the checkpoints imply: the same rollup the server stores
 * (`rollupRunStatus`), so the guess and the stored value cannot disagree on
 * the rule. `lifecycle` is the run's current status; it only matters for runs
 * that ended `aborted` or `empty`, and for a run with no checkpoints.
 */
export function runStatusFor(
  items: ReadonlyArray<Pick<Review, "verdict" | "decision">>,
  lifecycle: RunStatus,
  override: RunStatusOverride | null,
): RunStatus {
  return rollupRunStatus({
    lifecycle,
    override,
    checkpoints: items.map((i) => ({
      verdict: i.verdict,
      decision: i.decision?.kind ?? null,
    })),
  });
}

/** One change, applied to the two views that list a run's checkpoints. */
export interface ReviewChange {
  /** `runs.listCheckpoints`: the items. */
  items(items: CheckpointItem[]): CheckpointItem[];
  /**
   * `runs.getById`: each checkpoint's context, plus the recomputed `status`.
   * Pass the patched `items` when they are loaded; the status is then derived
   * from them, otherwise from the patched contexts.
   */
  run(run: RunDetail, items?: CheckpointItem[]): RunDetail;
}

function changeOf(rewrite: Rewrite): ReviewChange {
  return {
    items: (items) => items.map((i) => rewrite(i.id, i)),
    run: (run, items) => {
      const checkpointContexts = Object.fromEntries(
        Object.entries(run.checkpointContexts).map(([id, c]) => [
          id,
          rewrite(id, c),
        ]),
      );
      return {
        ...run,
        checkpointContexts,
        status: runStatusFor(
          items ?? Object.values(checkpointContexts),
          run.status,
          run.statusOverride,
        ),
      };
    },
  };
}

/** Decides `ids` as `kind`, by `actor`, under `actionId`. */
export function decisionChange(
  ids: ReadonlySet<string>,
  kind: CheckpointDecisionKind,
  actor: Actor,
  actionId: string,
): ReviewChange {
  return changeOf((id, c) =>
    ids.has(id) ? decideOne(c, kind, actor, actionId) : c,
  );
}

/** Takes back every decision made under `actionId`. */
export function revertChange(actionId: string): ReviewChange {
  return changeOf((_id, c) =>
    c.decision?.actionId === actionId ? revertOne(c) : c,
  );
}

export function applyDecision(
  items: CheckpointItem[],
  ids: ReadonlySet<string>,
  kind: CheckpointDecisionKind,
  actor: Actor,
  actionId: string,
): CheckpointItem[] {
  return decisionChange(ids, kind, actor, actionId).items(items);
}

export function revertDecision(
  items: CheckpointItem[],
  actionId: string,
): CheckpointItem[] {
  return revertChange(actionId).items(items);
}

const pendingIn = (rows: ReadonlyArray<Pick<Review, "state">>): number =>
  rows.filter((r) => r.state !== null && isPending(r.state)).length;

/** How many more steps need a reviewer in `after` than in `before`. */
export function pendingDelta(
  before: ReadonlyArray<Pick<Review, "state">>,
  after: ReadonlyArray<Pick<Review, "state">>,
): number {
  return pendingIn(after) - pendingIn(before);
}

/** `builds.getById` with its pending count moved by `delta` (never below 0). */
export function withPendingDelta(
  build: BuildDetail,
  delta: number,
): BuildDetail {
  return {
    ...build,
    pendingCheckpoints: Math.max(0, build.pendingCheckpoints + delta),
  };
}

/**
 * A `runs.list` page with the status of run `runId` replaced; the same page
 * when the run is not on it. `status` gets the run's row, so a caller without
 * a patched run can still derive it from the row's own override.
 */
export function patchListedRun(
  page: RunsListPage,
  runId: string,
  status: (row: RunsListPage["items"][number]) => RunStatus,
): RunsListPage {
  if (!page.items.some((r) => r.id === runId)) return page;
  return {
    ...page,
    items: page.items.map((r) =>
      r.id === runId ? { ...r, status: status(r) } : r,
    ),
  };
}
