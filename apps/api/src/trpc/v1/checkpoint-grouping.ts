import { asc, eq, screenshots, testRuns, type DB } from "@furan/db";
import { TRPCError } from "@trpc/server";

import {
  promoteCheckpointInTx,
  type ApprovableCheckpoint,
  type ApprovableRun,
} from "../../lib/review/promote.js";
import type { SelectionScope } from "../../lib/review/targets.js";

// The legacy wrappers' parameter types now live with the promotion.
export type { ApprovableCheckpoint, ApprovableRun };

/** A Drizzle transaction handle (first arg of `db.transaction(cb)`). */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Load + validate the seed checkpoint for a build-scoped group action
 * (getCheckpointGroup / approveCheckpointGroup / rejectCheckpointGroup and the
 * review router's group actions share this verbatim, and `groupScope` turns it
 * into the member selection — keep them the single source so they can't drift
 * on what "this checkpoint's group" is). Throws NOT_FOUND if the checkpoint is
 * missing and BAD_REQUEST if it doesn't belong to `runId`. Returns the seed
 * including its `diffSignature` (which may be null — the caller decides the
 * empty-group shape, since each procedure's zero-result differs).
 */
export async function loadGroupSeed(
  db: DB | Tx,
  input: { runId: string; checkpointId: string },
) {
  const seedRows = await db
    .select({
      id: screenshots.id,
      runId: screenshots.runId,
      diffSignature: screenshots.diffSignature,
      buildId: testRuns.buildId,
      projectId: testRuns.projectId,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(eq(screenshots.id, input.checkpointId))
    .limit(1);
  const seed = seedRows[0];
  if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
  if (seed.runId !== input.runId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "checkpoint not in run",
    });
  }
  return seed;
}

/**
 * Cap on how many checkpoints a single "Accept all" propagates. Mirrors
 * BULK_CAP (bulkApproveByBuild) for consistency; reconciles the
 * spec's "~500" down to the established bulk-approve cap. A build with more
 * matches needs a second "run again" click.
 */
export const GROUP_APPROVE_CAP = 200;

/**
 * The scope of a checkpoint's group: its build's checkpoints that share its
 * diff signature, pinned to `projectId`, the project the caller resolved for
 * its membership gate (R18). Null when the seed has no signature (VLM /
 * auto-approved / no meaningful diff): no group can be formed. Every group
 * read and action selects its members from this scope with
 * `selectPendingTargets`, so "the group" and "pending" each have one definition.
 */
export function groupScope(
  seed: Awaited<ReturnType<typeof loadGroupSeed>>,
  projectId: string,
): SelectionScope | null {
  if (seed.diffSignature === null) return null;
  return {
    projectId,
    buildId: seed.buildId,
    diffSignature: seed.diffSignature,
  };
}

/**
 * Legacy approve wrapper, kept unchanged in behaviour for the existing
 * procedures until they move onto `decideCheckpoints` (Task 12, ruling R1):
 * the per-checkpoint promotion (`promoteCheckpointInTx`) followed by the old
 * run-level status write. v1.1 has no "partially approved" run: approving any
 * checkpoint flips the whole run to passed. Every approve path reaches the
 * baseline through `promoteCheckpointInTx` (single checkpoint, group, and — via
 * approveRunInTx — run-level and bulk), so they cannot drift.
 */
export async function approveCheckpointInTx(
  tx: Tx,
  s: ApprovableCheckpoint & { id: string },
  run: ApprovableRun,
  userId: string,
  /**
   * ADR-036: when provided, reviewer-drawn ignore regions replace the
   * variation's ignore regions — so a region drawn in the viewer before
   * "Approve" isn't dropped. `undefined` keeps the variation's saved regions
   * and refreshes the SDK-captured ones (mergeApprovedIgnoreRegions, ADR-067).
   */
  ignoreAreasOverride?: readonly unknown[] | null,
): Promise<void> {
  await promoteCheckpointInTx(tx, s, run, userId, ignoreAreasOverride);
  await markRunApprovedLegacy(tx, run.id);
}

/**
 * Approve a whole run inside an existing transaction: every checkpoint is
 * promoted in capture order, then the run is flipped to passed (a
 * checkpoint-less run too). The single run-level path for runs.approve /
 * inbox.approve / REST approve, approveAllCheckpoints and bulkApproveByBuild
 * (ADR-067) — a run-level approve covers every checkpoint, so all of their
 * baselines must be promoted.
 *
 * `ignoreAreasOverride` (ADR-036) goes to the FIRST checkpoint's variation
 * only — the one the viewer shows when no checkpoint is selected; the other
 * checkpoints keep their saved regions.
 */
export async function approveRunInTx(
  tx: Tx,
  run: ApprovableRun,
  userId: string,
  ignoreAreasOverride?: readonly unknown[] | null,
): Promise<{ checkpointIds: string[] }> {
  const shots = await tx
    .select()
    .from(screenshots)
    .where(eq(screenshots.runId, run.id))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  for (const [i, s] of shots.entries()) {
    await promoteCheckpointInTx(
      tx,
      s,
      run,
      userId,
      i === 0 ? ignoreAreasOverride : undefined,
    );
  }
  await markRunApprovedLegacy(tx, run.id);
  return { checkpointIds: shots.map((s) => s.id) };
}

/**
 * The pre-review-model run status write (R1). Only the legacy wrappers above
 * use it; `decideCheckpoints` leaves the status to `recomputeRunStatus`.
 */
async function markRunApprovedLegacy(tx: Tx, runId: string): Promise<void> {
  await tx
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, runId));
}
