import { randomUUID } from "node:crypto";

import { and, eq, isNull, screenshots, type Tx } from "@furan/db";
import type { DecisionSource } from "@furan/shared-types";

import {
  announceRuns,
  decideSelection,
  requireRunProject,
  type ReviewActionCtx,
  type ReviewResult,
} from "./actions.js";
import { decideCheckpoints, type DecideResult } from "./decide.js";
import { reviewError } from "./errors.js";
import { assessRun } from "./legality.js";
import {
  lockRuns,
  selectPendingTargets,
  type LockedRun,
  type ReviewTarget,
} from "./targets.js";

/**
 * The run-level approve and the cluster reject for the surfaces outside
 * `review.*`: the SDK's REST approve and `inbox.approve` / `inbox.rejectCluster`
 * (spec §5.7). Each is a thin wrapper over the decision core: it generates its
 * `actionId` on the server, selects what it decides with the core's own rules,
 * and keeps the response shape its callers have. The dashboard decides through
 * `review.*` instead.
 *
 * A decided checkpoint changes only through undo (R19): an implicit selection
 * skips it, so re-running a run-level action decides nothing more.
 */

/** A run-level action covers the whole run: its selection is not capped. */
const NO_CAP = Number.MAX_SAFE_INTEGER;

/**
 * Locks the run (R8) and refuses a run-level action on a run that isn't
 * reviewable, with the core's own reason (`assessRun`, spec §5.4):
 * `not_reviewable` (running / aborted / empty, or a checkpoint not diffed yet)
 * or `run_overridden`, as PRECONDITION_FAILED. This is the run-level form of
 * the refusal the core gives an explicit target. NOT_FOUND when the run is not
 * in the project.
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

/**
 * Approves every pending checkpoint of a run: `inbox.approve` (source `inbox`)
 * and the SDK's `POST /runs/:id/approve` (`sdk`). The run is locked first and
 * must be reviewable (`lockReviewableRun`). Nothing pending is a successful
 * no-op (spec §5.7): nothing is written or announced. Returns what was decided.
 */
export async function approveRunPending(
  ctx: ReviewActionCtx,
  input: { runId: string; source: DecisionSource },
): Promise<{ runId: string; decided: DecideResult["decided"] }> {
  const projectId = await requireRunProject(ctx.tx, input.runId);
  const run = await lockReviewableRun(ctx.tx, projectId, input.runId);
  const { targets } = await selectPendingTargets(
    ctx.tx,
    { projectId, runId: run.id },
    NO_CAP,
  );

  const decided =
    targets.length === 0
      ? []
      : (
          await decideCheckpoints(
            ctx.tx,
            {
              actor: ctx.actor,
              projectId,
              actionId: randomUUID(),
              source: input.source,
              decision: "approved",
              targets,
            },
            ctx.deps,
          )
        ).decided;

  await announceRuns(ctx, projectId, decided.length > 0 ? [run.id] : []);
  return { runId: run.id, decided };
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
