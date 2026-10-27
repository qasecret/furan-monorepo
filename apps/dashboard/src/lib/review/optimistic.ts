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
/** One step as the viewer reads it (`runs.getStep`). */
export type StepDetail = RouterOutputs["runs"]["getStep"];
/** The run header (`runs.getById`). */
export type RunDetail = RouterOutputs["runs"]["getById"];
export type RunsListPage = RouterOutputs["runs"]["list"];
export type BuildDetail = RouterOutputs["builds"]["getById"];

/** The review fields a step has in the step list. */
export type Review = Pick<CheckpointItem, "verdict" | "state" | "decision">;
/** A step's review as `runs.getStep` has it: the decision in full. */
export type StepReview = StepDetail["review"];

export interface Actor {
  id: string;
  name: string;
}

/** The step list's decision: what its cards draw (`listedReview`). */
function listedDecision(
  kind: CheckpointDecisionKind,
  actionId: string,
): NonNullable<CheckpointItem["decision"]> {
  return { actionId, kind, undo: { allowed: true } };
}

/** The viewer's decision: who decided and when, too. */
function viewedDecision(
  kind: CheckpointDecisionKind,
  actor: Actor,
  actionId: string,
): NonNullable<StepReview["decision"]> {
  return {
    id: `optimistic:${actionId}`,
    ...listedDecision(kind, actionId),
    actor,
    at: new Date().toISOString(),
    source: "viewer",
    legacy: false,
  };
}

/**
 * Rewrites one step's review fields in each view of it, or returns them as
 * they are: `item` in the step list, `review` in the step's own read.
 */
interface Rewrite {
  item(id: string, c: CheckpointItem): CheckpointItem;
  review(id: string, r: StepReview): StepReview;
}

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

/**
 * One change, applied to the two views of a run's steps: its step list, and
 * each step read on its own. Both halves return what they were given,
 * untouched, when the change reaches nothing in it, so a caller can skip
 * writing it back.
 */
export interface ReviewChange {
  /** `runs.listCheckpoints`: the items. */
  items(items: CheckpointItem[]): CheckpointItem[];
  /** `runs.getStep`: the step's review. */
  step(view: StepDetail): StepDetail;
}

function changeOf(rewrite: Rewrite): ReviewChange {
  return {
    items: (items) => {
      const next = items.map((i) => rewrite.item(i.id, i));
      return next.some((n, k) => n !== items[k]) ? next : items;
    },
    step: (view) => {
      const review = rewrite.review(view.step.id, view.review);
      return review === view.review ? view : { ...view, review };
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
  return changeOf({
    item: (id, c) =>
      ids.has(id)
        ? { ...c, state: kind, decision: listedDecision(kind, actionId) }
        : c,
    review: (id, r) =>
      ids.has(id)
        ? {
            ...r,
            state: kind,
            decision: viewedDecision(kind, actor, actionId),
          }
        : r,
  });
}

/** Takes back every decision made under `actionId`. */
export function revertChange(actionId: string): ReviewChange {
  return changeOf({
    item: (_id, c) =>
      c.decision?.actionId === actionId
        ? { ...c, state: c.verdict, decision: null }
        : c,
    review: (_id, r) =>
      r.decision?.actionId === actionId
        ? { ...r, state: r.verdict, decision: null }
        : r,
  });
}

/**
 * The state and decision each view holds of some steps, by step id: what a
 * decision or an undo moves, and what a failed one puts back.
 */
export interface ReviewFields {
  /** In the step list. */
  items: ReadonlyMap<string, Pick<CheckpointItem, "state" | "decision">>;
  /** In the steps' own reads. */
  steps: ReadonlyMap<string, Pick<StepReview, "state" | "decision">>;
}

/** Puts back the state and decision `captured` holds, per view and step id. */
export function restoreChange(captured: ReviewFields): ReviewChange {
  return changeOf({
    item: (id, c) => {
      const fields = captured.items.get(id);
      return fields ? { ...c, ...fields } : c;
    },
    review: (id, r) => {
      const fields = captured.steps.get(id);
      return fields ? { ...r, ...fields } : r;
    },
  });
}

/**
 * The state and decision of every step in `items` and `steps` (the step
 * views, by step id) that `keep` holds, per view.
 */
export function fieldsOf(
  items: Iterable<CheckpointItem>,
  steps: Iterable<StepDetail>,
  keep: (decision: { actionId: string } | null, id: string) => boolean,
): ReviewFields {
  const fromItems = new Map<
    string,
    Pick<CheckpointItem, "state" | "decision">
  >();
  for (const c of items) {
    if (keep(c.decision, c.id)) {
      fromItems.set(c.id, { state: c.state, decision: c.decision });
    }
  }
  const fromSteps = new Map<string, Pick<StepReview, "state" | "decision">>();
  for (const v of steps) {
    if (keep(v.review.decision, v.step.id)) {
      fromSteps.set(v.step.id, {
        state: v.review.state,
        decision: v.review.decision,
      });
    }
  }
  return { items: fromItems, steps: fromSteps };
}

/** The state and decision of every step in the views decided under `actionId`. */
export function decidedBy(
  items: Iterable<CheckpointItem>,
  steps: Iterable<StepDetail>,
  actionId: string,
): ReviewFields {
  return fieldsOf(items, steps, (d) => d?.actionId === actionId);
}

/** The ids `fields` holds, in either view. */
export function fieldIds(fields: ReviewFields): string[] {
  return [...new Set([...fields.items.keys(), ...fields.steps.keys()])];
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

/**
 * `builds.getById` with its pending and approvable counts moved by `delta`
 * (never below 0). A decision or its undo moves both: a step whose diff failed
 * cannot be decided. (Undoing a decision on a step whose re-diff failed since
 * makes it pending but not approvable; the refetch every settled call makes
 * corrects that guess.)
 */
export function withPendingDelta(
  build: BuildDetail,
  delta: number,
): BuildDetail {
  return {
    ...build,
    pendingCheckpoints: Math.max(0, build.pendingCheckpoints + delta),
    approvableCheckpoints: Math.max(0, build.approvableCheckpoints + delta),
  };
}

/**
 * A `runs.list` page with the status of run `runId` replaced; the same page
 * when the run is not on it or already has that status. `status` gets the run's row, so a caller without
 * a patched run can still derive it from the row's own override.
 */
export function patchListedRun(
  page: RunsListPage,
  runId: string,
  status: (row: RunsListPage["items"][number]) => RunStatus,
): RunsListPage {
  const row = page.items.find((r) => r.id === runId);
  if (!row) return page;
  const next = status(row);
  if (next === row.status) return page;
  return {
    ...page,
    items: page.items.map((r) => (r === row ? { ...r, status: next } : r)),
  };
}
