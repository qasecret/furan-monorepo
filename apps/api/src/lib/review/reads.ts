import {
  and,
  builds,
  desc,
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
  type RunStatus,
} from "@furan/shared-types";

import { loadActiveDecisionDetails, selectPendingTargets } from "./targets.js";

/**
 * The review read model: what `runs.listCheckpoints`, `runs.getById` and
 * `builds.getById` report about each checkpoint's review. It is a projection
 * of the rows the decision core works on and reuses the core's loaders and
 * rules (`targets.ts`) for them: a checkpoint's state is
 * `checkpointReviewState(verdict, active decision)`, the active decision and
 * the actor's name are read the way the core reads them, and "pending" is
 * whatever `selectPendingTargets` selects. Nothing here re-derives a state
 * from the run's status.
 */

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
  } | null;
  /**
   * A later run captured the same variation (spec §5.6): approving this older
   * image would make it the baseline again. The newest such run.
   */
  newerCapture: {
    runId: string;
    buildId: string;
    /** The build's display name, computed like the dashboard's `buildDisplayName`. */
    buildName: string;
  } | null;
}

/** The statuses `runs.listCheckpoints` reports per checkpoint. */
export type CheckpointStatusAlias =
  "new" | "unresolved" | "passed" | "failed" | "running" | "aborted" | "empty";

/**
 * `listCheckpoints.status`, kept until the dashboard reads `state`:
 * `approved` is shown as `passed`, `rejected` as `failed`. A checkpoint that
 * is not diffed yet (no state) shows its run's lifecycle when the run ended
 * without diffing it (`aborted` / `empty`: no diff is coming), otherwise
 * `running` (R20).
 */
export function checkpointStatusAlias(
  state: CheckpointReviewState | null,
  lifecycle: RunStatus,
): CheckpointStatusAlias {
  switch (state) {
    case null:
      return lifecycle === "aborted" || lifecycle === "empty"
        ? lifecycle
        : "running";
    case "approved":
      return "passed";
    case "rejected":
      return "failed";
    default:
      return state;
  }
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
 * `runId` (capture order: run `created_at, id`, as the core orders runs), with
 * its build's name. Two statements however many variations there are; the
 * second is skipped when nothing is newer. "After" is compared in SQL so the
 * run's microsecond timestamp is never rounded through a JS Date.
 */
async function loadNewerCaptures(
  db: DB | Tx,
  runId: string,
  variationIds: string[],
): Promise<Map<string, NewerCapture>> {
  const out = new Map<string, NewerCapture>();
  if (variationIds.length === 0) return out;

  const newest = await db
    .selectDistinctOn([screenshots.testVariationId], {
      variationId: screenshots.testVariationId,
      runId: testRuns.id,
      buildId: testRuns.buildId,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(
      and(
        inArray(screenshots.testVariationId, variationIds),
        // Captured after this run, and in this run's project (a variation
        // never spans projects; the pin keeps a corrupt row from naming a
        // foreign project's run and build).
        sql`(${testRuns.createdAt}, ${testRuns.id}) > (select this_run.created_at, this_run.id from test_runs this_run where this_run.id = ${runId})`,
        sql`${testRuns.projectId} = (select this_run.project_id from test_runs this_run where this_run.id = ${runId})`,
      ),
    )
    .orderBy(
      screenshots.testVariationId,
      desc(testRuns.createdAt),
      desc(testRuns.id),
    );
  if (newest.length === 0) return out;

  const buildIds = [...new Set(newest.map((n) => n.buildId))];
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
    .leftJoin(testRuns, eq(testRuns.buildId, builds.id))
    .where(inArray(builds.id, buildIds))
    .groupBy(builds.id);
  const buildName = new Map(buildRows.map((b) => [b.id, buildDisplayName(b)]));

  for (const n of newest) {
    out.set(n.variationId, {
      runId: n.runId,
      buildId: n.buildId,
      buildName:
        buildName.get(n.buildId) ?? buildDisplayName({ id: n.buildId }),
    });
  }
  return out;
}

/**
 * The review view of every checkpoint of a run, keyed by checkpoint id. A
 * constant number of statements (at most four) however many checkpoints the
 * run has: the checkpoints, their active decisions, the newer captures and
 * those captures' builds.
 */
export async function loadCheckpointReview(
  db: DB | Tx,
  runId: string,
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
  const newer = await loadNewerCaptures(db, runId, [
    ...new Set(shots.map((s) => s.testVariationId)),
  ]);

  return new Map(
    shots.map((s) => {
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
        },
        newerCapture: newer.get(s.testVariationId) ?? null,
      };
      return [s.id, view];
    }),
  );
}

/** The view of a checkpoint the map has no entry for (a stale id). */
export const NO_REVIEW: CheckpointReviewView = {
  verdict: null,
  state: null,
  decision: null,
  newerCapture: null,
};

/**
 * How many checkpoints of a build a reviewer can still approve: the count
 * "approve pending" would act on, taken from the same selection.
 */
export async function countPendingCheckpoints(
  db: DB | Tx,
  scope: { projectId: string; buildId: string },
): Promise<number> {
  const { preview } = await selectPendingTargets(db, scope, 0);
  return preview.pendingCheckpoints;
}
