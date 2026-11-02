import {
  and,
  builds,
  eq,
  inArray,
  screenshots,
  sql,
  testRuns,
  type DB,
  type Tx,
} from "@furan/db";
import {
  checkpointReviewState,
  type CheckpointDecisionKind,
  type CheckpointReviewState,
  type CheckpointVerdict,
  type DecisionSource,
  type RevertSkipReason,
} from "@furan/shared-types";

import type { AuthedUser } from "../../plugins/auth.js";
import { isAtLeastAdmin } from "../roles.js";

import { assessRevert } from "./revert.js";
import { loadActiveDecisionDetails, type ActiveDecision } from "./targets.js";

/**
 * The review read model: what `runs.getStep` reports about a step's review,
 * and `runs.listCheckpoints` about each step's (`listedReview`, the part of it
 * the rail and the batch step cards draw). It is a projection of the rows the
 * decision core works on and reuses the core's loaders and rules
 * (`targets.ts`) for them: a checkpoint's state is
 * `checkpointReviewState(verdict, active decision)`, and the active decision
 * and the actor's name are read the way the core reads them. Nothing here
 * re-derives a state from the run's status.
 */

/**
 * Whether the viewer can undo a decision now (spec §5.5), and if not why: a
 * reason `assessRevert` gives, or `not_decider` when the viewer is neither
 * who decided it nor an admin.
 */
export interface UndoAvailability {
  allowed: boolean;
  reason?: RevertSkipReason | "not_decider";
}

/** What the dashboard shows about one checkpoint's review (spec §5.5). */
export interface CheckpointReviewView {
  /** What the diff found; NULL until the checkpoint has been diffed. */
  verdict: CheckpointVerdict | null;
  /** `decision ?? verdict`; NULL while the verdict is NULL. */
  state: CheckpointReviewState | null;
  /** The active (not undone) decision, if any. */
  decision: {
    id: string;
    actionId: string;
    kind: CheckpointDecisionKind;
    /** NULL for a legacy/system decision. */
    actor: { id: string; name: string } | null;
    /** ISO timestamp of the decision. */
    at: string;
    source: DecisionSource;
    /** No undo snapshot (`before IS NULL`). */
    legacy: boolean;
    /** Whether `viewer` can undo it now; mirrors what `review.revert` would do. */
    undo: UndoAvailability;
  } | null;
  /**
   * A later run captured the same variation (spec §5.6): approving this older
   * image would make it the baseline again. The newest such run, and that
   * run's step of the variation (`checkpointId`), so a link can open it.
   */
  newerCapture: {
    runId: string;
    /** The newer run's step (screenshot) of this variation. */
    checkpointId: string;
    buildId: string;
    /** The build's display name, computed like the dashboard's `buildDisplayName`. */
    buildName: string;
  } | null;
}

export interface BuildIdentity {
  name?: string | null;
  /** The build's single distinct test name (set only for one-test builds). */
  testName?: string | null;
  number?: number | null;
  ciBuildId?: string | null;
  id?: string | null;
}

/**
 * The build title, tier for tier the dashboard's `buildDisplayName`
 * (`apps/dashboard/src/lib/build-display-name.ts`): name → single test name →
 * `#number` → ciBuildId[:12] → id[:8]. Computed here so `newerCapture` can
 * name a build the user has not loaded; keep the two in step.
 */
export function buildDisplayName(b: BuildIdentity): string {
  if (b.name) return b.name;
  if (b.testName) return b.testName;
  if (b.number != null) return `#${b.number}`;
  if (b.ciBuildId) return b.ciBuildId.slice(0, 12);
  if (b.id) return b.id.slice(0, 8);
  return "No build";
}

type NewerCapture = NonNullable<CheckpointReviewView["newerCapture"]>;

/**
 * For each variation, the newest screenshot of it in a run captured after
 * `runId`, in this run's project, with its build's name. "Newest" is the runs'
 * capture order (`created_at, id`, as the core orders runs), on any branch; in
 * that run, its earliest screenshot of the variation (`created_at, id`; a run
 * holds one, by `screenshots_run_id_name_viewport_unique`). "After" is compared
 * in SQL so the run's microsecond timestamp is never rounded through a JS Date.
 *
 * Two statements however many variations there are (the second is skipped
 * when nothing is newer). Per variation, two bounded reads of
 * `screenshots_variation_created_idx`, never a scan of its history. They rely
 * on a step never being captured before its run was created (both are stamped
 * by the database's `now()`; a step is written in its run's transaction or in
 * one begun after it, an upload or a capture job), so every step of a run is
 * captured no earlier than the run began:
 *  1. `newest`: the variation's newest capture in a later run (the index
 *     walked down from the newest capture, no further back than this run's
 *     start), with its run's start; none means nothing is newer;
 *  2. the newest later run is that run or one after it, so its captures were
 *     made between that run's start and the newest capture: that range of the
 *     index (the run and those captured alongside it) holds the answer, taken
 *     in the runs' capture order. A run created later but captured sooner
 *     (concurrent CI jobs) is still the newer one, as in the core's run order.
 *     The closed range also keeps the planner's estimate small: an open one is
 *     costed at a third of the variation's history, which over a few hundred
 *     steps passes `jit_above_cost` and spends ~20 ms compiling.
 */
async function loadNewerCaptures(
  db: DB | Tx,
  runId: string,
  variationIds: string[],
): Promise<Map<string, NewerCapture>> {
  const out = new Map<string, NewerCapture>();
  if (variationIds.length === 0) return out;

  // A capture `step` of the variation in a run `run` after this one. The pins
  // on the run and on the step keep a corrupt row (a variation never spans
  // projects) from naming a foreign project's run, build or step.
  const laterCapture = (step: string, run: string) => {
    const [st, ru] = [sql.raw(step), sql.raw(run)];
    return sql`${st}.test_variation_id = v.variation_id
          and ${st}.project_id = this_run.project_id
          and ${ru}.id = ${st}.run_id
          and ${ru}.project_id = this_run.project_id
          and (${ru}.created_at, ${ru}.id) > (this_run.created_at, this_run.id)`;
  };
  const newest = await db.execute<{
    variation_id: string;
    checkpoint_id: string;
    run_id: string;
    build_id: string;
    project_id: string;
  }>(sql`
    select v.variation_id, n.checkpoint_id, n.run_id, n.build_id,
           this_run.project_id
    from (
      select created_at, id, project_id from test_runs where id = ${runId}
    ) this_run
    cross join unnest(array[${sql.join(
      variationIds.map((v) => sql`${v}`),
      sql`, `,
    )}]::uuid[]) as v(variation_id)
    cross join lateral (
      select r1.created_at as run_at, s1.created_at as captured_at
      from screenshots s1, test_runs r1
      where ${laterCapture("s1", "r1")}
        and s1.created_at >= this_run.created_at
      order by s1.created_at desc, s1.id desc
      limit 1
    ) newest
    cross join lateral (
      select s.id as checkpoint_id, r.id as run_id, r.build_id
      from screenshots s, test_runs r
      where ${laterCapture("s", "r")}
        and s.created_at between newest.run_at and newest.captured_at
      order by r.created_at desc, r.id desc, s.created_at, s.id
      limit 1
    ) n
  `);
  if (newest.length === 0) return out;

  // The newer runs' builds, named from this project's rows only: a run whose
  // build is another project's (corrupt data) is named by its build id alone,
  // as is a build the reader cannot see.
  const projectId = newest[0]!.project_id;
  const buildIds = [...new Set(newest.map((n) => n.build_id))];
  const buildRows = await db
    .select({
      id: builds.id,
      name: builds.name,
      number: builds.number,
      ciBuildId: builds.ciBuildId,
      // The builds list's rule: the test name only when every run shares one.
      testName: sql<
        string | null
      >`case when count(distinct ${testRuns.name}) = 1 then min(${testRuns.name}) else null end`,
    })
    .from(builds)
    .leftJoin(
      testRuns,
      and(
        eq(testRuns.buildId, builds.id),
        eq(testRuns.projectId, builds.projectId),
      ),
    )
    .where(and(inArray(builds.id, buildIds), eq(builds.projectId, projectId)))
    .groupBy(builds.id);
  const buildName = new Map(buildRows.map((b) => [b.id, buildDisplayName(b)]));

  for (const n of newest) {
    out.set(n.variation_id, {
      runId: n.run_id,
      checkpointId: n.checkpoint_id,
      buildId: n.build_id,
      buildName:
        buildName.get(n.build_id) ?? buildDisplayName({ id: n.build_id }),
    });
  }
  return out;
}

/**
 * `undo` for each of a run's active decisions, keyed by decision id, as
 * `review.revert` would answer `viewer` now.
 *
 * - Judged first: a decision with no snapshot is never undoable, whoever asks
 *   (`not_undoable_legacy`, a reason about the decision, not the viewer).
 *   Spec §5.3: legacy rows with a NULL actor are only ever refused as not
 *   undoable, so every viewer is told that. (`review.revert` itself answers a
 *   non-admin `not_decider` first; `allowed` is false either way.)
 * - Then only the decider or an admin may undo (`not_decider`), judged before
 *   the assessment, as `revertAction` authorises before it assesses.
 * - The rest go through `assessRevert` in ONE call, which is itself a fixed
 *   number of statements however many decisions there are. It judges each
 *   decision as part of its whole action, so a decision that only a later one
 *   of the same action supersedes stays undoable.
 */
async function loadUndoAvailability(
  db: DB | Tx,
  decisions: ReadonlyArray<ActiveDecision>,
  viewer: AuthedUser,
): Promise<Map<string, UndoAvailability>> {
  const out = new Map<string, UndoAvailability>();
  const admin = isAtLeastAdmin(viewer.role);
  const toAssess: ActiveDecision[] = [];
  for (const d of decisions) {
    if (d.legacy) {
      out.set(d.id, { allowed: false, reason: "not_undoable_legacy" });
    } else if (!admin && d.actor?.id !== viewer.id) {
      out.set(d.id, { allowed: false, reason: "not_decider" });
    } else {
      toAssess.push(d);
    }
  }
  const verdicts = await assessRevert(db, toAssess);
  for (const d of toAssess) {
    const reason = verdicts.get(d.id);
    // No entry: the decision was deleted (retention) since it was read.
    out.set(
      d.id,
      reason === null
        ? { allowed: true }
        : reason === undefined
          ? { allowed: false }
          : { allowed: false, reason },
    );
  }
  return out;
}

/** A step as the review view reads it. */
interface ReviewStep {
  id: string;
  verdict: CheckpointVerdict | null;
  testVariationId: string;
}

/**
 * The review views of `steps` (steps of `runId`), given their active
 * decisions: the newer captures and those captures' builds (at most two
 * statements), and for the undo availability of the decisions one batched
 * `assessRevert`.
 */
async function reviewViews(
  db: DB | Tx,
  runId: string,
  steps: readonly ReviewStep[],
  decisions: Map<string, ActiveDecision>,
  viewer: AuthedUser,
): Promise<Map<string, CheckpointReviewView>> {
  const newer = await loadNewerCaptures(db, runId, [
    ...new Set(steps.map((s) => s.testVariationId)),
  ]);
  const undo = await loadUndoAvailability(db, [...decisions.values()], viewer);

  return new Map(
    steps.map((s) => {
      const d = decisions.get(s.id) ?? null;
      const view: CheckpointReviewView = {
        verdict: s.verdict,
        state:
          s.verdict === null
            ? null
            : checkpointReviewState(s.verdict, d?.kind ?? null),
        decision: d && {
          id: d.id,
          actionId: d.actionId,
          kind: d.kind,
          actor: d.actor,
          at: d.at.toISOString(),
          source: d.source,
          legacy: d.legacy,
          undo: undo.get(d.id) ?? { allowed: false },
        },
        newerCapture: newer.get(s.testVariationId) ?? null,
      };
      return [s.id, view];
    }),
  );
}

/**
 * The review view of every checkpoint of a run, keyed by checkpoint id, with
 * `decision.undo` as `viewer` would find it. A constant number of statements
 * however many checkpoints the run has: the checkpoints, their active
 * decisions, the newer captures and those captures' builds (at most four), and
 * for the undo availability of the decisions one batched `assessRevert`.
 */
export async function loadCheckpointReview(
  db: DB | Tx,
  runId: string,
  viewer: AuthedUser,
): Promise<Map<string, CheckpointReviewView>> {
  const shots = await db
    .select({
      id: screenshots.id,
      verdict: screenshots.verdict,
      testVariationId: screenshots.testVariationId,
    })
    .from(screenshots)
    .where(eq(screenshots.runId, runId));
  if (shots.length === 0) return new Map();

  const decisions = await loadActiveDecisionDetails(db, { runId });
  return reviewViews(db, runId, shots, decisions, viewer);
}

/**
 * The review view of one step of `run`, as `loadCheckpointReview` reports it
 * for that step, with no read of the run's other steps: its active decision
 * (in the run's project), its newer capture and that capture's build, and the
 * decision's undo assessment (which reads the decision's whole action, as it
 * always does).
 */
export async function loadStepReview(
  db: DB | Tx,
  run: { id: string; projectId: string },
  step: ReviewStep,
  viewer: AuthedUser,
): Promise<CheckpointReviewView> {
  const decisions = await loadActiveDecisionDetails(db, {
    screenshotIds: [step.id],
    projectId: run.projectId,
  });
  const views = await reviewViews(db, run.id, [step], decisions, viewer);
  return views.get(step.id) ?? NO_REVIEW;
}

/** The view of a checkpoint the map has no entry for (a stale id). */
export const NO_REVIEW: CheckpointReviewView = {
  verdict: null,
  state: null,
  decision: null,
  newerCapture: null,
};

/**
 * What the step list carries of a step's review (spec 2026-10-27 §5): what
 * the rail and the batch step cards draw. A card offers Undo while the viewer
 * may undo the decision, and names the newer capture's build in the question
 * it asks before approving an older capture. Who decided and when, why an
 * undo is refused, and the newer capture's run and step are the viewer's, and
 * `getStep`'s to serve.
 */
export interface ListedReview {
  verdict: CheckpointReviewView["verdict"];
  state: CheckpointReviewView["state"];
  decision: {
    actionId: string;
    kind: CheckpointDecisionKind;
    undo: { allowed: boolean };
  } | null;
  newerCapture: { buildName: string } | null;
}

/** `view` as the step list carries it. */
export function listedReview(view: CheckpointReviewView): ListedReview {
  const { decision, newerCapture } = view;
  return {
    verdict: view.verdict,
    state: view.state,
    decision: decision && {
      actionId: decision.actionId,
      kind: decision.kind,
      undo: { allowed: decision.undo.allowed },
    },
    newerCapture: newerCapture && { buildName: newerCapture.buildName },
  };
}
