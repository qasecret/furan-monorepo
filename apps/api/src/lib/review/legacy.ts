import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, screenshots, type Tx } from "@furan/db";
import type { DecisionSource } from "@furan/shared-types";

import {
  announceRuns,
  auditBuildAction,
  decideSelection,
  requireBuildProject,
  requireRunProject,
  type ReviewActionCtx,
  type ReviewResult,
} from "./actions.js";
import { decideCheckpoints, type DecideResult } from "./decide.js";
import { reviewError } from "./errors.js";
import { assessRun } from "./legality.js";
import {
  lockBuildRuns,
  lockRuns,
  selectPendingTargets,
  selectUndecidedTargets,
  type LockedRun,
  type ReviewTarget,
} from "./targets.js";

/**
 * The pre-`review.*` approve / reject paths (`runs.*`, `inbox.*`, the SDK's
 * REST approve), kept for the current dashboard, inbox and SDK as thin
 * wrappers over the decision core until the dashboard moves to `review.*`
 * (spec §5.7). Each generates its `actionId` on the server, selects what it
 * decides with the core's own rules, and keeps its legacy response shape.
 *
 * A decided checkpoint changes only through undo (R19): an implicit selection
 * skips it, so re-running a run-level action decides nothing more.
 */

/** A legacy run-level action covers the whole run: its selection is not capped. */
const NO_CAP = Number.MAX_SAFE_INTEGER;

/** `bulkApproveByBuild` approves at most this many RUNS per call (its legacy contract). */
export const BULK_RUN_CAP = 200;

/**
 * Locks the run (R8) and refuses a run-level action on a run that isn't
 * reviewable, with the core's own reason (`assessRun`, spec §5.4):
 * `not_reviewable` (running / aborted / empty, or a checkpoint not diffed yet)
 * or `run_overridden`, as PRECONDITION_FAILED. This is the run-level form of
 * the refusal the core gives an explicit target, and replaces the legacy
 * status gate (`assertApprovable`). NOT_FOUND when the run is not in the
 * project.
 */
async function lockReviewableRun(
  tx: Tx,
  projectId: string,
  runId: string,
): Promise<LockedRun> {
  const [run] = (await lockRuns(tx, projectId, [runId])).values();
  if (!run) throw reviewError("NOT_FOUND", "run_not_found");
  const [undiffed] = await tx
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(and(eq(screenshots.runId, run.id), isNull(screenshots.verdict)))
    .limit(1);
  const reason = assessRun({
    lifecycle: run.lifecycle,
    override: run.override,
    allVerdictsSet: undiffed === undefined,
  });
  if (reason !== null) throw reviewError("PRECONDITION_FAILED", reason);
  return run;
}

/** The run's first checkpoint in capture order (`created_at, id`), or null. */
async function firstCheckpointId(
  tx: Tx,
  runId: string,
): Promise<string | null> {
  const [first] = await tx
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(eq(screenshots.runId, runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id))
    .limit(1);
  return first?.id ?? null;
}

/**
 * Approves every pending checkpoint of a run: `runs.approve` and
 * `approveAllCheckpoints` (source `viewer`), `inbox.approve` (`inbox`) and the
 * SDK's `POST /runs/:id/approve` (`sdk`). The run is locked first and must be
 * reviewable (`lockReviewableRun`). Nothing pending is a successful no-op
 * (spec §5.7): nothing is written or announced. Returns what was decided.
 *
 * `ignoreAreas` (ADR-036, `runs.approve` only) belong to the run's FIRST
 * checkpoint, as they always have (ADR-067). The core takes an override for
 * exactly one target, so that checkpoint is decided with it as one action and
 * the rest of the pending ones as a second; when it is not pending, the core
 * refuses it (`already_decided` / `nothing_to_approve`) rather than dropping
 * the reviewer's regions.
 */
export async function approveRunPending(
  ctx: ReviewActionCtx,
  input: {
    runId: string;
    source: DecisionSource;
    ignoreAreas?: unknown[] | null;
  },
): Promise<{ runId: string; decided: DecideResult["decided"] }> {
  const projectId = await requireRunProject(ctx.tx, input.runId);
  const run = await lockReviewableRun(ctx.tx, projectId, input.runId);
  const { targets } = await selectPendingTargets(
    ctx.tx,
    { projectId, runId: run.id },
    NO_CAP,
  );

  const decide = async (
    picked: typeof targets,
    ignoreAreas?: unknown[] | null,
  ) =>
    (
      await decideCheckpoints(
        ctx.tx,
        {
          actor: ctx.actor,
          projectId,
          actionId: randomUUID(),
          source: input.source,
          decision: "approved",
          targets: picked,
          ...(ignoreAreas !== undefined ? { ignoreAreas } : {}),
        },
        ctx.deps,
      )
    ).decided;

  const decided: DecideResult["decided"] = [];
  let rest = targets;
  if (input.ignoreAreas !== undefined) {
    const first = await firstCheckpointId(ctx.tx, run.id);
    if (first !== null) {
      decided.push(
        ...(await decide(
          [{ runId: run.id, screenshotId: first }],
          input.ignoreAreas,
        )),
      );
      rest = targets.filter((t) => t.screenshotId !== first);
    }
  }
  if (rest.length > 0) decided.push(...(await decide(rest)));

  await announceRuns(ctx, projectId, decided.length > 0 ? [run.id] : []);
  return { runId: run.id, decided };
}

/**
 * `runs.reject` (and the viewer's "Mark as bug"): rejects the run's pending
 * checkpoints, or every undecided one when none is pending, the same rule as
 * `review.reject` without ids (spec §5.2). The run is locked first and must be
 * reviewable. Nothing left to reject is a successful no-op.
 */
export async function rejectRunPendingElseUndecided(
  ctx: ReviewActionCtx,
  input: { runId: string; source: DecisionSource },
): Promise<{ runId: string; result: ReviewResult }> {
  const projectId = await requireRunProject(ctx.tx, input.runId);
  const run = await lockReviewableRun(ctx.tx, projectId, input.runId);
  const scope = { projectId, runId: run.id };
  const pending = await selectPendingTargets(ctx.tx, scope, NO_CAP);
  const targets =
    pending.targets.length > 0
      ? pending.targets
      : (await selectUndecidedTargets(ctx.tx, scope, NO_CAP)).targets;
  const result = await decideSelection(
    ctx,
    {
      projectId,
      actionId: randomUUID(),
      source: input.source,
      decision: "rejected",
    },
    { targets, capped: false, cap: NO_CAP },
  );
  return { runId: run.id, result };
}

/**
 * `runs.bulkApproveByBuild` ("Approve all" on the batch page): approves the
 * pending checkpoints of the build's runs as one action, `source: "batch"`.
 * Its legacy contract is kept: at most `BULK_RUN_CAP` RUNS per call, oldest
 * first (run `created_at, id`), and a capped call drains: decided checkpoints
 * stop being pending, so the next call takes the next runs instead of
 * re-selecting approved ones. The build's runs are locked first, so the
 * selection is what gets decided. A rejected step stays rejected and a run
 * that is not reviewable is skipped.
 */
export async function approveBuildRuns(
  ctx: ReviewActionCtx,
  buildId: string,
): Promise<{
  approved: number;
  runIds: string[];
  capped: boolean;
  cap: number;
}> {
  const projectId = await requireBuildProject(ctx.tx, buildId);
  await lockBuildRuns(ctx.tx, projectId, buildId);
  const { targets } = await selectPendingTargets(
    ctx.tx,
    { projectId, buildId },
    NO_CAP,
  );
  // Capture order lists each run's checkpoints together, oldest run first.
  const runOrder = [...new Set(targets.map((t) => t.runId))];
  const runIds = runOrder.slice(0, BULK_RUN_CAP);
  const kept = new Set(runIds);
  const result = await decideSelection(
    ctx,
    {
      projectId,
      actionId: randomUUID(),
      source: "batch",
      decision: "approved",
    },
    {
      targets: targets.filter((t) => kept.has(t.runId)),
      capped: runOrder.length > BULK_RUN_CAP,
      cap: BULK_RUN_CAP,
    },
  );
  await auditBuildAction(
    ctx,
    "run.approve_build",
    buildId,
    projectId,
    "batch",
    result,
    {},
  );
  return {
    approved: runIds.length,
    runIds,
    capped: result.capped,
    cap: BULK_RUN_CAP,
  };
}

/**
 * `inbox.rejectCluster`: rejects the pending checkpoints of `runIds` (the
 * cluster the caller re-derived, in its priority order) as one action. At most
 * `runCap` runs that still have something pending are decided, the first ones
 * in `runIds` order; `capped` says more remain, and a re-run drains them
 * (rejected checkpoints stop being pending).
 *
 * The cap is applied BEFORE anything is locked (R21), so only the runs this
 * call decides are locked, never the whole cluster: an unlocked read picks
 * them, they are locked, and their pending checkpoints are selected again
 * under the lock, so what gets decided is what is pending now. A run that
 * stopped being pending in between is simply not decided; the next run is
 * not pulled in, and `capped` still reports the remainder for a re-run.
 */
export async function rejectPendingInRuns(
  ctx: ReviewActionCtx,
  input: {
    projectId: string;
    runIds: string[];
    runCap: number;
    source: DecisionSource;
  },
): Promise<ReviewResult> {
  const { projectId } = input;
  const unlocked = await selectPendingTargets(
    ctx.tx,
    { projectId, runIds: input.runIds },
    NO_CAP,
  );
  const withPending = new Set(unlocked.targets.map((t) => t.runId));
  const ordered = input.runIds.filter((id) => withPending.has(id));
  const kept = ordered.slice(0, Math.max(0, input.runCap));
  let targets: ReviewTarget[] = [];
  if (kept.length > 0) {
    await lockRuns(ctx.tx, projectId, kept);
    ({ targets } = await selectPendingTargets(
      ctx.tx,
      { projectId, runIds: kept },
      NO_CAP,
    ));
  }
  return decideSelection(
    ctx,
    {
      projectId,
      actionId: randomUUID(),
      source: input.source,
      decision: "rejected",
    },
    {
      targets,
      capped: ordered.length > input.runCap,
      cap: input.runCap,
    },
  );
}
