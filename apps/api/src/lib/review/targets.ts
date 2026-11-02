import {
  and,
  asc,
  checkpointDecisions,
  eq,
  inArray,
  isNull,
  notInArray,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type DB,
  type Tx,
} from "@furan/db";
import type {
  ApproveBuildPreview,
  CheckpointDecisionKind,
  DecisionSource,
  ReviewErrorDetails,
  ReviewRefusalReason,
  RunStatus,
  RunStatusOverride,
} from "@furan/shared-types";

import {
  assessDecision,
  assessRun,
  UNREVIEWABLE_LIFECYCLE_LIST,
} from "./legality.js";
import { pendingStepCondition, storedPendingRun } from "./pending.js";

/**
 * The reads behind the decision core: the runs it locks, the checkpoints it
 * decides and the facts legality needs, plus the "every pending checkpoint"
 * selection. Capture order (run `created_at, id`, then screenshot
 * `created_at, id`) is always taken from SQL so every caller agrees on it.
 */

export interface ReviewTarget {
  runId: string;
  screenshotId: string;
}

/** A run as the core needs it; locked by `lockRuns`. */
export interface LockedRun {
  id: string;
  projectId: string;
  buildId: string;
  name: string;
  branchName: string | null;
  lifecycle: RunStatus;
  override: RunStatusOverride | null;
}

/**
 * Legality's `diffFailed` (`diff_failed_at IS NOT NULL`) as a select column:
 * the step's diff failed for good, so it has no result to decide on.
 */
const stepDiffFailed = sql<boolean>`${screenshots.diffFailedAt} is not null`;

/**
 * A checkpoint as the core needs it: the promotion's fields, its verdict, and
 * the facts legality reads beside it (`loadTargetFacts`).
 */
export type DecidableCheckpoint = Awaited<
  ReturnType<typeof loadTargetFacts>
>[number];

/**
 * Locks the project's runs among `runIds` `FOR NO KEY UPDATE`, in ascending id
 * order (R8: never `FOR UPDATE`, which would conflict with the `FOR KEY SHARE`
 * every child-row insert takes). Rows are locked as the sorted scan returns
 * them, so concurrent callers acquire overlapping runs in the same order.
 * Runs of other projects are neither locked nor returned.
 */
export async function lockRuns(
  tx: Tx,
  projectId: string,
  runIds: string[],
): Promise<Map<string, LockedRun>> {
  return lockRunsBy(tx, projectId, { runIds });
}

/**
 * `lockRuns` for the runs of a build that can be decision targets: reviewable
 * (lifecycle not `running` / `aborted` / `empty`) and not overridden. They are
 * chosen by the same statement that locks them, so a run that appears while
 * the lock is being taken cannot slip between "which runs" and "lock them".
 *
 * A run that cannot be a target is not locked, so a build-wide action never
 * holds up a `running` run's uploads and diff commits (each takes the run's
 * lock first, then a variation). A run that becomes reviewable after this
 * statement is therefore unlocked; `approveBuild` refuses a selection that
 * reaches such a run.
 */
export async function lockBuildRuns(
  tx: Tx,
  projectId: string,
  buildId: string,
): Promise<Map<string, LockedRun>> {
  return lockRunsBy(tx, projectId, { buildId, reviewableOnly: true });
}

async function lockRunsBy(
  tx: Tx,
  projectId: string,
  by: { runIds: string[] } | { buildId: string; reviewableOnly: true },
): Promise<Map<string, LockedRun>> {
  const rows = await tx
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      buildId: testRuns.buildId,
      name: testRuns.name,
      branchName: testRuns.branchName,
      lifecycle: testRuns.status,
      override: testRuns.statusOverride,
    })
    .from(testRuns)
    .where(
      and(
        "runIds" in by
          ? inArray(testRuns.id, by.runIds)
          : and(
              eq(testRuns.buildId, by.buildId),
              notInArray(testRuns.status, [...UNREVIEWABLE_LIFECYCLE_LIST]),
              isNull(testRuns.statusOverride),
            ),
        eq(testRuns.projectId, projectId),
      ),
    )
    .orderBy(asc(testRuns.id))
    .for("no key update");
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Locks variations `FOR NO KEY UPDATE` in ascending id order (R8). (An approve
 * locks them with the fields it promotes instead:
 * `lockVariationsForPromotion`.)
 */
export async function lockVariations(
  tx: Tx,
  variationIds: string[],
): Promise<void> {
  if (variationIds.length === 0) return;
  await tx
    .select({ id: testVariations.id })
    .from(testVariations)
    .where(inArray(testVariations.id, variationIds))
    .orderBy(asc(testVariations.id))
    .for("no key update");
}

/**
 * The given checkpoints, in capture order (unknown ids are absent), each with
 * what legality reads beside its own row, in ONE statement:
 * - `active`, its active decision (`reverted_at IS NULL`; at most one, by the
 *   partial unique index, so the join adds no row);
 * - `runAwaitsDiff`, whether its run is among `runIds` and has a step that
 *   is not diffed yet (`verdict IS NULL`). The runs are scanned once for the
 *   statement, not once per checkpoint.
 * `runIds` must not be empty.
 */
async function loadTargetFacts(
  tx: Tx,
  screenshotIds: string[],
  runIds: string[],
) {
  return tx
    .select({
      id: screenshots.id,
      runId: screenshots.runId,
      testVariationId: screenshots.testVariationId,
      imageKey: screenshots.imageKey,
      ignoreRegions: screenshots.ignoreRegions,
      layoutRegions: screenshots.layoutRegions,
      floatingRegions: screenshots.floatingRegions,
      contentRegions: screenshots.contentRegions,
      accessibilityRegions: screenshots.accessibilityRegions,
      matchLevel: screenshots.matchLevel,
      verdict: screenshots.verdict,
      diffFailed: stepDiffFailed,
      active: checkpointDecisions.decision,
      runAwaitsDiff: sql<boolean>`${screenshots.runId} IN (
        SELECT undiffed.run_id FROM ${screenshots} AS undiffed
        WHERE undiffed.run_id IN ${runIds} AND undiffed.verdict IS NULL)`,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .leftJoin(
      checkpointDecisions,
      and(
        eq(checkpointDecisions.screenshotId, screenshots.id),
        isNull(checkpointDecisions.revertedAt),
      ),
    )
    .where(inArray(screenshots.id, screenshotIds))
    .orderBy(
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    );
}

/** Each given checkpoint's active decision (at most one, by the partial unique index). */
export async function loadActiveDecisions(
  tx: Tx,
  screenshotIds: string[],
): Promise<Map<string, CheckpointDecisionKind>> {
  if (screenshotIds.length === 0) return new Map();
  const rows = await tx
    .select({
      screenshotId: checkpointDecisions.screenshotId,
      decision: checkpointDecisions.decision,
    })
    .from(checkpointDecisions)
    .where(
      and(
        inArray(checkpointDecisions.screenshotId, screenshotIds),
        isNull(checkpointDecisions.revertedAt),
      ),
    );
  return new Map(rows.map((r) => [r.screenshotId, r.decision]));
}

/** A refused target, as `details.reasons` reports it. */
export interface TargetRefusal {
  checkpointId: string;
  reason: ReviewRefusalReason;
}

/**
 * One entry per (run, checkpoint), first occurrence kept, with ids lowercased.
 * Zod's `.uuid()` accepts upper case and Postgres compares uuids by value, but
 * the core keys its maps by the text it reads back (always lowercase), so a
 * mixed-case id would otherwise miss its run or dodge the dedupe.
 */
export function dedupeTargets(
  targets: ReadonlyArray<ReviewTarget>,
): ReviewTarget[] {
  const seen = new Set<string>();
  const out: ReviewTarget[] = [];
  for (const t of targets) {
    const runId = t.runId.toLowerCase();
    const screenshotId = t.screenshotId.toLowerCase();
    const key = `${runId}:${screenshotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runId, screenshotId });
  }
  return out;
}

/**
 * Loads what legality needs for `targets` (deduped, not empty; every run must
 * be in `runs`, locked by the caller) and assesses each against `decision`.
 * The checkpoints and their facts are read in one statement
 * (`loadTargetFacts`). Returns the targets' checkpoints in capture order, and
 * one refusal per illegal target, in target order: `not_in_run` for a
 * checkpoint that is not in its target's run, otherwise `assessDecision`'s
 * reason. When `reasons` is empty, `checkpoints` holds exactly one row per
 * target.
 */
export async function assessTargets(
  tx: Tx,
  runs: ReadonlyMap<string, LockedRun>,
  targets: ReadonlyArray<ReviewTarget>,
  decision: CheckpointDecisionKind,
): Promise<{
  checkpoints: DecidableCheckpoint[];
  reasons: TargetRefusal[];
}> {
  const checkpoints = await loadTargetFacts(
    tx,
    targets.map((t) => t.screenshotId),
    [...runs.keys()],
  );
  const shotById = new Map(checkpoints.map((s) => [s.id, s]));

  const reasons: TargetRefusal[] = [];
  for (const t of targets) {
    const run = runs.get(t.runId)!;
    const shot = shotById.get(t.screenshotId);
    // A checkpoint in its target's run: `runAwaitsDiff` is that run's.
    const reason =
      shot === undefined || shot.runId !== t.runId
        ? "not_in_run"
        : assessDecision(
            {
              lifecycle: run.lifecycle,
              override: run.override,
              allVerdictsSet: !shot.runAwaitsDiff,
              verdict: shot.verdict,
              active: shot.active,
              diffFailed: shot.diffFailed,
            },
            decision,
          );
    if (reason !== null) reasons.push({ checkpointId: t.screenshotId, reason });
  }
  return { checkpoints, reasons };
}

/**
 * How review surfaces name a person: "First Last", else their email, else null
 * (no person: a legacy/system decision, or a deleted user). The one definition,
 * for review errors (`loadWinner`) and the read model alike.
 */
export function actorDisplayName(u: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string | null {
  const fullName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  return fullName || u.email || null;
}

/** A checkpoint's active decision, with who made it. */
export interface ActiveDecision {
  id: string;
  /** The decision's project (an action id is unique per project, not globally). */
  projectId: string;
  actionId: string;
  kind: CheckpointDecisionKind;
  /** NULL for a legacy/system decision (`actor_id IS NULL`). */
  actor: { id: string; name: string } | null;
  at: Date;
  source: DecisionSource;
  /** No undo snapshot (`before IS NULL`): a backfilled or pre-undo decision. */
  legacy: boolean;
}

/**
 * The active decision (`reverted_at IS NULL`; at most one per checkpoint, by
 * the partial unique index) of each checkpoint, either the given ones or every
 * one of a run, only `projectId`'s when it is given. Decisions always carry
 * their screenshot's run (`decideCheckpoints`, backfill), so the run form
 * reads the same rows.
 */
export async function loadActiveDecisionDetails(
  db: DB | Tx,
  by: ({ screenshotIds: string[] } | { runId: string }) & {
    projectId?: string;
  },
): Promise<Map<string, ActiveDecision>> {
  if ("screenshotIds" in by && by.screenshotIds.length === 0) return new Map();
  const rows = await db
    .select({
      screenshotId: checkpointDecisions.screenshotId,
      id: checkpointDecisions.id,
      projectId: checkpointDecisions.projectId,
      actionId: checkpointDecisions.actionId,
      kind: checkpointDecisions.decision,
      source: checkpointDecisions.source,
      createdAt: checkpointDecisions.createdAt,
      legacy: sql<boolean>`${checkpointDecisions.before} is null`,
      actorId: checkpointDecisions.actorId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(checkpointDecisions)
    .leftJoin(users, eq(users.id, checkpointDecisions.actorId))
    .where(
      and(
        "screenshotIds" in by
          ? inArray(checkpointDecisions.screenshotId, by.screenshotIds)
          : eq(checkpointDecisions.runId, by.runId),
        isNull(checkpointDecisions.revertedAt),
        by.projectId === undefined
          ? undefined
          : eq(checkpointDecisions.projectId, by.projectId),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.screenshotId,
      {
        id: r.id,
        projectId: r.projectId,
        actionId: r.actionId,
        kind: r.kind,
        actor:
          r.actorId === null
            ? null
            : { id: r.actorId, name: actorDisplayName(r) ?? "" },
        at: r.createdAt,
        // Closed set, enforced by `checkpoint_decisions_source_chk`.
        source: r.source as DecisionSource,
        legacy: r.legacy,
      },
    ]),
  );
}

/**
 * The active decision on a checkpoint, as review errors report it: the
 * actor's "First Last" name, else their email, else null (a legacy/system
 * decision or a deleted user).
 */
export async function loadWinner(
  tx: Tx,
  screenshotId: string,
): Promise<NonNullable<ReviewErrorDetails["winner"]> | null> {
  const active = (
    await loadActiveDecisionDetails(tx, { screenshotIds: [screenshotId] })
  ).get(screenshotId);
  if (!active) return null;
  return {
    checkpointId: screenshotId,
    kind: active.kind,
    actorName: active.actor?.name || null,
  };
}

/**
 * What an implicit selection ranges over: one run, a set of runs (the inbox's
 * cluster), a whole build, or a build's "group" (its checkpoints that share one
 * diff signature). Every scope carries the project the caller resolved and only
 * that project's runs are selected: a build should never span projects, but a
 * corrupt build/project state must not make the core refuse the whole action
 * (`decideCheckpoints` locks the project's runs only) or inflate the preview.
 */
export type SelectionScope =
  | { projectId: string; runId: string }
  | { projectId: string; runIds: string[] }
  | { projectId: string; buildId: string }
  | { projectId: string; buildId: string; diffSignature: string };

/** A build's group: its checkpoints that share one diff signature. */
export type GroupScope = Extract<SelectionScope, { diffSignature: string }>;

/** The runs a scope ranges over, as a WHERE condition on `test_runs`. */
function scopeRuns(scope: SelectionScope) {
  if ("runId" in scope) return eq(testRuns.id, scope.runId);
  if ("runIds" in scope) return inArray(testRuns.id, scope.runIds);
  return eq(testRuns.buildId, scope.buildId);
}

/**
 * Every checkpoint in `scope` that `decision` would be legal for
 * (`assessDecision(…, decision) === null`), in capture order, plus the counts
 * the approve-build preview shows. Run-level facts (`allVerdictsSet`) always
 * come from the WHOLE run, whatever the scope's signature filter keeps.
 *
 * A checkpoint whose diff failed is skipped like any illegal one (spec
 * 2026-10-23 §7), and its run is counted once under `notReviewableTests`, the
 * "can't be reviewed right now" count, even when the run has other checkpoints
 * that are legal (and so is counted in `legalRuns` too).
 *
 * Read-only and unlocked.
 */
async function collectLegalTargets(
  tx: DB | Tx,
  scope: SelectionScope,
  decision: CheckpointDecisionKind,
): Promise<{
  legal: ReviewTarget[];
  legalRuns: Set<string>;
  notReviewableTests: number;
  rejectedLeftAsIs: number;
}> {
  const runs =
    "runIds" in scope && scope.runIds.length === 0
      ? []
      : await tx
          .select({
            id: testRuns.id,
            lifecycle: testRuns.status,
            override: testRuns.statusOverride,
          })
          .from(testRuns)
          .where(and(scopeRuns(scope), eq(testRuns.projectId, scope.projectId)))
          .orderBy(asc(testRuns.createdAt), asc(testRuns.id));
  const runIds = runs.map((r) => r.id);

  const shots =
    runIds.length === 0
      ? []
      : await tx
          .select({
            id: screenshots.id,
            runId: screenshots.runId,
            verdict: screenshots.verdict,
            diffSignature: screenshots.diffSignature,
            diffFailed: stepDiffFailed,
          })
          .from(screenshots)
          .where(inArray(screenshots.runId, runIds))
          .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  // Decisions always carry their screenshot's run (decideCheckpoints, backfill).
  const active =
    runIds.length === 0
      ? []
      : await tx
          .select({
            screenshotId: checkpointDecisions.screenshotId,
            decision: checkpointDecisions.decision,
          })
          .from(checkpointDecisions)
          .where(
            and(
              inArray(checkpointDecisions.runId, runIds),
              isNull(checkpointDecisions.revertedAt),
            ),
          );
  const activeByShot = new Map(active.map((a) => [a.screenshotId, a.decision]));
  const pendingDiff = new Set(
    shots.filter((s) => s.verdict === null).map((s) => s.runId),
  );
  const shotsByRun = new Map<string, typeof shots>();
  for (const s of shots) {
    const list = shotsByRun.get(s.runId) ?? [];
    list.push(s);
    shotsByRun.set(s.runId, list);
  }
  const signature = "diffSignature" in scope ? scope.diffSignature : null;

  const legal: ReviewTarget[] = [];
  const legalRuns = new Set<string>();
  const runsWithFailedStep = new Set<string>();
  let notReviewableTests = 0;
  for (const run of runs) {
    const runFacts = {
      lifecycle: run.lifecycle,
      override: run.override,
      allVerdictsSet: !pendingDiff.has(run.id),
    };
    if (assessRun(runFacts) !== null) {
      notReviewableTests++;
      continue;
    }
    for (const s of shotsByRun.get(run.id) ?? []) {
      if (signature !== null && s.diffSignature !== signature) continue;
      const facts = {
        ...runFacts,
        verdict: s.verdict,
        active: activeByShot.get(s.id) ?? null,
        diffFailed: s.diffFailed,
      };
      const reason = assessDecision(facts, decision);
      if (reason === null) {
        legal.push({ runId: run.id, screenshotId: s.id });
        legalRuns.add(run.id);
      } else if (reason === "diff_failed") {
        runsWithFailedStep.add(run.id);
      }
    }
  }

  return {
    legal,
    legalRuns,
    notReviewableTests: notReviewableTests + runsWithFailedStep.size,
    rejectedLeftAsIs: active.filter((a) => a.decision === "rejected").length,
  };
}

/**
 * Every pending checkpoint in a run, a set of runs, a build or a group, in
 * capture order, capped at `cap`. Pending is exactly "`decideCheckpoints`
 * would approve it": a reviewable run, verdict `new` or `unresolved`, no
 * active decision (`assessDecision(…, "approved") === null`), so an implicit
 * selection only ever picks legal targets. The preview counts the whole
 * scope, before the cap.
 *
 * Read-only and unlocked: `decideCheckpoints` locks and re-checks every
 * target, so a selection that went stale in between is refused, not misapplied.
 */
export async function selectPendingTargets(
  tx: DB | Tx,
  scope: SelectionScope,
  cap: number,
): Promise<{ targets: ReviewTarget[]; preview: ApproveBuildPreview }> {
  const c = await collectLegalTargets(tx, scope, "approved");
  return {
    targets: c.legal.slice(0, Math.max(0, cap)),
    preview: {
      pendingCheckpoints: c.legal.length,
      tests: c.legalRuns.size,
      rejectedLeftAsIs: c.rejectedLeftAsIs,
      notReviewableTests: c.notReviewableTests,
      capped: c.legal.length > cap,
      cap,
    },
  };
}

/** A member of a checkpoint's group, with the names the group read lists. */
export interface CheckpointTarget extends ReviewTarget {
  /** The step's (checkpoint's) name. */
  name: string;
  viewport: string;
  /** Its run's test name. */
  testName: string;
}

/**
 * The members of a build's group (its steps with `diffSignature`) that
 * "approve" would act on, in capture order, the first `limit` of them, and
 * `total`, how many there are. One statement.
 *
 * It selects exactly what `selectPendingTargets` selects over the same group
 * scope (`collectLegalTargets` for "approve"): the pending steps
 * (`pendingStepCondition`) whose diff did not fail (`diff_failed`, the one
 * pending step approve refuses). `group-selection-equivalence.test.ts` holds
 * the two selections together. "Exactly" holds while the rows are
 * consistent, which the app's writers keep them; two drifts it does not
 * cover (Ruling R14: approve still selects the true group):
 * - the run's stored counter is the pre-filter every step pick uses
 *   (`storedPendingRun`, `test_runs_pending_idx`), so a run whose counter
 *   is stale at 0 is left out;
 * - the step must carry the scope's `project_id` too, so a corrupt step whose
 *   `project_id` differs from its run's is left out (the JS selection goes
 *   by the run's project alone).
 *
 * `limit` must be at least 1: the total is read off the selected rows.
 * Read-only and unlocked, like `selectPendingTargets`.
 */
export async function selectGroupTargets(
  db: DB | Tx,
  args: GroupScope & { limit: number },
): Promise<{ targets: CheckpointTarget[]; total: number }> {
  if (!(args.limit >= 1)) {
    throw new Error("selectGroupTargets: limit must be at least 1");
  }
  const rows = await db
    .select({
      runId: screenshots.runId,
      screenshotId: screenshots.id,
      name: screenshots.name,
      viewport: screenshots.viewport,
      testName: testRuns.name,
      // Over every member, before the LIMIT.
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(testRuns)
    .innerJoin(screenshots, eq(screenshots.runId, testRuns.id))
    .where(
      and(
        eq(testRuns.buildId, args.buildId),
        eq(testRuns.projectId, args.projectId),
        storedPendingRun(),
        eq(screenshots.projectId, args.projectId),
        eq(screenshots.diffSignature, args.diffSignature),
        pendingStepCondition(),
        isNull(screenshots.diffFailedAt),
      ),
    )
    .orderBy(
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    )
    .limit(args.limit);
  return {
    targets: rows.map((r) => ({
      runId: r.runId,
      screenshotId: r.screenshotId,
      name: r.name,
      viewport: r.viewport,
      testName: r.testName,
    })),
    total: rows[0]?.total ?? 0,
  };
}

/**
 * Every undecided checkpoint of a run, in capture order, capped at `cap`:
 * `decideCheckpoints` would reject it (`assessDecision(…, "rejected") === null`),
 * whatever its verdict. This is what "reject" without ids falls back to when
 * nothing is pending (spec §5.2). `total` is the count before the cap.
 */
export async function selectUndecidedTargets(
  tx: DB | Tx,
  scope: { projectId: string; runId: string },
  cap: number,
): Promise<{ targets: ReviewTarget[]; total: number }> {
  const c = await collectLegalTargets(tx, scope, "rejected");
  return {
    targets: c.legal.slice(0, Math.max(0, cap)),
    total: c.legal.length,
  };
}
