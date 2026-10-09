import {
  and,
  asc,
  checkpointDecisions,
  eq,
  inArray,
  isNull,
  screenshots,
  testRuns,
  testVariations,
  users,
  type Tx,
} from "@furan/db";
import type {
  ApproveBuildPreview,
  CheckpointDecisionKind,
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
    .where(and(inArray(testRuns.id, runIds), eq(testRuns.projectId, projectId)))
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

/** One entry per (run, checkpoint), first occurrence kept. */
export function dedupeTargets(
  targets: ReadonlyArray<ReviewTarget>,
): ReviewTarget[] {
  const seen = new Set<string>();
  const out: ReviewTarget[] = [];
  for (const t of targets) {
    const key = `${t.runId}:${t.screenshotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runId: t.runId, screenshotId: t.screenshotId });
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
 * The active decision on a checkpoint, as review errors report it: the
 * actor's "First Last" name, else their email, else null (a legacy/system
 * decision or a deleted user).
 */
export async function loadWinner(
  tx: Tx,
  screenshotId: string,
): Promise<NonNullable<ReviewErrorDetails["winner"]> | null> {
  const [row] = await tx
    .select({
      kind: checkpointDecisions.decision,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(checkpointDecisions)
    .leftJoin(users, eq(users.id, checkpointDecisions.actorId))
    .where(
      and(
        eq(checkpointDecisions.screenshotId, screenshotId),
        isNull(checkpointDecisions.revertedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const fullName = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
  return {
    checkpointId: screenshotId,
    kind: row.kind,
    actorName: fullName || row.email || null,
  };
}

/**
 * Every pending checkpoint in a run or a build, in capture order, capped at
 * `cap`. Pending is exactly "`decideCheckpoints` would approve it": a
 * reviewable run, verdict `new` or `unresolved`, no active decision
 * (`assessDecision(…, "approved") === null`), so an implicit selection only
 * ever picks legal targets. The preview counts the whole scope, before the cap.
 *
 * Read-only and unlocked: `decideCheckpoints` locks and re-checks every
 * target, so a selection that went stale in between is refused, not misapplied.
 */
export async function selectPendingTargets(
  tx: Tx,
  scope: { runId: string } | { buildId: string },
  cap: number,
): Promise<{ targets: ReviewTarget[]; preview: ApproveBuildPreview }> {
  const runs = await tx
    .select({
      id: testRuns.id,
      lifecycle: testRuns.status,
      override: testRuns.statusOverride,
    })
    .from(testRuns)
    .where(
      "runId" in scope
        ? eq(testRuns.id, scope.runId)
        : eq(testRuns.buildId, scope.buildId),
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

  const pending: ReviewTarget[] = [];
  const pendingRuns = new Set<string>();
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
      const facts = {
        ...runFacts,
        verdict: s.verdict,
        active: activeByShot.get(s.id) ?? null,
      };
      if (assessDecision(facts, "approved") === null) {
        pending.push({ runId: run.id, screenshotId: s.id });
        pendingRuns.add(run.id);
      }
    }
  }

  return {
    targets: pending.slice(0, Math.max(0, cap)),
    preview: {
      pendingCheckpoints: pending.length,
      tests: pendingRuns.size,
      rejectedLeftAsIs: active.filter((a) => a.decision === "rejected").length,
      notReviewableTests,
      capped: pending.length > cap,
      cap,
    },
  };
}
