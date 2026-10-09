import { eq, screenshots, testRuns, type DB, type Tx } from "@furan/db";
import { TRPCError } from "@trpc/server";

import type { SelectionScope } from "./targets.js";

/**
 * A checkpoint's "group": the checkpoints of its build that share its diff
 * signature (ADR-042). The group read (`runs.getCheckpointGroup`) and every
 * group action (`review.approveGroup` / `rejectGroup` and their legacy
 * wrappers) derive it here, so "this checkpoint's group" has one definition.
 */

/**
 * Cap on how many checkpoints a single group action ("Accept all N like
 * this") decides. Mirrors the legacy bulk-approve cap; a build with more
 * matches needs a second "run again" click.
 */
export const GROUP_APPROVE_CAP = 200;

/**
 * Loads and validates the seed checkpoint of a group read or action. Throws
 * NOT_FOUND if the checkpoint is missing and BAD_REQUEST if it doesn't belong
 * to `runId`. Returns the seed including its `diffSignature` (which may be
 * null: the caller decides the empty-group shape, since each procedure's zero
 * result differs).
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
