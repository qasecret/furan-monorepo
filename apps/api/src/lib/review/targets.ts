import {
  and,
  asc,
  checkpointDecisions,
  eq,
  inArray,
  isNull,
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

import { assessDecision, assessRun } from "./legality.js";

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

/** A checkpoint as the core needs it (the promotion's fields + its verdict). */
export type DecidableCheckpoint = Awaited<
  ReturnType<typeof loadCheckpointsInCaptureOrder>
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
 * `lockRuns` for every run of a build, chosen by the same statement that locks
 * them: a run that appears while the lock is being taken cannot slip between
 * "which runs" and "lock them".
 */
export async function lockBuildRuns(
  tx: Tx,
  projectId: string,
  buildId: string,
): Promise<Map<string, LockedRun>> {
  return lockRunsBy(tx, projectId, { buildId });
}

async function lockRunsBy(
  tx: Tx,
  projectId: string,
  by: { runIds: string[] } | { buildId: string },
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
          : eq(testRuns.buildId, by.buildId),
        eq(testRuns.projectId, projectId),
      ),
    )
    .orderBy(asc(testRuns.id))
    .for("no key update");
  return new Map(rows.map((r) => [r.id, r]));
}

/** Locks variations `FOR NO KEY UPDATE` in ascending id order (R8). */
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

/** The given checkpoints, in capture order. Unknown ids are absent. */
async function loadCheckpointsInCaptureOrder(tx: Tx, screenshotIds: string[]) {
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
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(inArray(screenshots.id, screenshotIds))
    .orderBy(
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    );
}

/** The runs among `runIds` that still have an undiffed checkpoint. */
async function runsWithPendingDiff(
  tx: Tx,
  runIds: string[],
): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ runId: screenshots.runId })
    .from(screenshots)
    .where(
      and(inArray(screenshots.runId, runIds), isNull(screenshots.verdict)),
    );
  return new Set(rows.map((r) => r.runId));
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
 * Loads what legality needs for `targets` (deduped; every run must be in
 * `runs`, locked by the caller) and assesses each against `decision`.
 * Returns the targets' checkpoints in capture order, and one refusal per
 * illegal target, in target order: `not_in_run` for a checkpoint that is not
 * in its target's run, otherwise `assessDecision`'s reason. When `reasons` is
 * empty, `checkpoints` holds exactly one row per target.
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
  const shotIds = targets.map((t) => t.screenshotId);
  const checkpoints = await loadCheckpointsInCaptureOrder(tx, shotIds);
  const shotById = new Map(checkpoints.map((s) => [s.id, s]));
  const pendingDiff = await runsWithPendingDiff(tx, [...runs.keys()]);
  const active = await loadActiveDecisions(tx, shotIds);

  const reasons: TargetRefusal[] = [];
  for (const t of targets) {
    const run = runs.get(t.runId)!;
    const shot = shotById.get(t.screenshotId);
    const reason =
      shot === undefined || shot.runId !== t.runId
        ? "not_in_run"
        : assessDecision(
            {
              lifecycle: run.lifecycle,
              override: run.override,
              allVerdictsSet: !pendingDiff.has(run.id),
              verdict: shot.verdict,
              active: active.get(shot.id) ?? null,
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
 * one of a run. Decisions always carry their screenshot's run
 * (`decideCheckpoints`, backfill), so the run form reads the same rows.
 */
export async function loadActiveDecisionDetails(
  db: DB | Tx,
  by: { screenshotIds: string[] } | { runId: string },
): Promise<Map<string, ActiveDecision>> {
  if ("screenshotIds" in by && by.screenshotIds.length === 0) return new Map();
  const rows = await db
    .select({
      screenshotId: checkpointDecisions.screenshotId,
      id: checkpointDecisions.id,
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
      ),
    );
  return new Map(
    rows.map((r) => [
      r.screenshotId,
      {
        id: r.id,
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
 * What an implicit selection ranges over: one run, a whole build, or a build's
 * "group" (its checkpoints that share one diff signature). Every scope carries
 * the project the caller resolved and only that project's runs are selected: a
 * build should never span projects, but a corrupt build/project state must not
 * make the core refuse the whole action (`decideCheckpoints` locks the
 * project's runs only) or inflate the preview.
 */
export type SelectionScope =
  | { projectId: string; runId: string }
  | { projectId: string; buildId: string }
  | { projectId: string; buildId: string; diffSignature: string };

/**
 * Every checkpoint in `scope` that `decision` would be legal for
 * (`assessDecision(…, decision) === null`), in capture order, plus the counts
 * the approve-build preview shows. Run-level facts (`allVerdictsSet`) always
 * come from the WHOLE run, whatever the scope's signature filter keeps.
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
  const runs = await tx
    .select({
      id: testRuns.id,
      lifecycle: testRuns.status,
      override: testRuns.statusOverride,
    })
    .from(testRuns)
    .where(
      and(
        "runId" in scope
          ? eq(testRuns.id, scope.runId)
          : eq(testRuns.buildId, scope.buildId),
        eq(testRuns.projectId, scope.projectId),
      ),
    )
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
      };
      if (assessDecision(facts, decision) === null) {
        legal.push({ runId: run.id, screenshotId: s.id });
        legalRuns.add(run.id);
      }
    }
  }

  return {
    legal,
    legalRuns,
    notReviewableTests,
    rejectedLeftAsIs: active.filter((a) => a.decision === "rejected").length,
  };
}

/**
 * Every pending checkpoint in a run, a build or a group, in capture order,
 * capped at `cap`. Pending is exactly "`decideCheckpoints` would approve it": a
 * reviewable run, verdict `new` or `unresolved`, no active decision
 * (`assessDecision(…, "approved") === null`), so an implicit selection only
 * ever picks legal targets. The preview counts the whole scope, before the cap.
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
