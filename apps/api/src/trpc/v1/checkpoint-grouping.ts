import {
  and,
  baselines,
  diffRegions,
  eq,
  inArray,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";

/** A Drizzle transaction handle (first arg of `db.transaction(cb)`). */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Per-checkpoint review status, mirroring runs.listCheckpoints. */
export type CheckpointStatus = "new" | "unresolved" | "passed";

/**
 * Cap on how many checkpoints a single "Accept all" propagates. Mirrors
 * BULK_CAP (bulkApproveByVariation/byBuild) for consistency; reconciles the
 * spec's "~500" down to the established bulk-approve cap. A build with more
 * matches needs a second "run again" click.
 */
export const GROUP_APPROVE_CAP = 200;

/** Minimal checkpoint shape the status derivation needs. */
export interface CheckpointStatusInput {
  id: string;
  runId: string;
  viewport: string | null;
  baselineName: string | null;
}

/**
 * Derive each checkpoint's review status using the SAME signals as
 * runs.listCheckpoints (single source of truth — do NOT fork this):
 *   - test_variations.baseline_name IS NULL                  -> "new"
 *   - else any diff_regions row with severity != 'none' for
 *     this checkpoint (modern: screenshot_id match; legacy
 *     NULL screenshot_id: viewport fallback, scoped per run)  -> "unresolved"
 *   - else                                                    -> "passed"
 * Cross-run capable (build-scoped grouping spans runs); listCheckpoints is the
 * single-run caller.
 */
export async function deriveCheckpointStatuses(
  db: DB | Tx,
  checkpoints: CheckpointStatusInput[],
): Promise<Map<string, CheckpointStatus>> {
  const out = new Map<string, CheckpointStatus>();
  if (checkpoints.length === 0) return out;

  const runIds = [...new Set(checkpoints.map((c) => c.runId))];
  const unresolvedRows = await db
    .select({
      screenshotId: diffRegions.screenshotId,
      runId: diffRegions.runId,
      viewport: diffRegions.viewport,
    })
    .from(diffRegions)
    .where(
      and(
        inArray(diffRegions.runId, runIds),
        sql`${diffRegions.severity} != 'none'`,
      ),
    );

  const unresolvedScreenshotSet = new Set(
    unresolvedRows
      .map((r) => r.screenshotId)
      .filter((s): s is string => s !== null),
  );
  // Legacy (pre-v1.1.20) rows have NULL screenshot_id; fall back to a per-run
  // viewport match so old runs keep their (imperfect) status.
  const legacyKey = (runId: string, viewport: string | null) =>
    `${runId}::${viewport ?? ""}`;
  const legacyUnresolvedSet = new Set(
    unresolvedRows
      // Parity with the original listCheckpoints filter: legacy rows match by
      // (run, viewport). Drop null-viewport rows — real checkpoints (screenshots)
      // always have a viewport, so they can never match a "runId::" key anyway.
      .filter((r) => r.screenshotId === null && r.viewport !== null)
      .map((r) => legacyKey(r.runId, r.viewport)),
  );

  for (const c of checkpoints) {
    const status: CheckpointStatus =
      c.baselineName === null
        ? "new"
        : unresolvedScreenshotSet.has(c.id) ||
            legacyUnresolvedSet.has(legacyKey(c.runId, c.viewport))
          ? "unresolved"
          : "passed";
    out.set(c.id, status);
  }
  return out;
}

/** The screenshot fields approveCheckpointInTx promotes onto the baseline. */
export interface ApprovableCheckpoint {
  testVariationId: string;
  imageKey: string | null;
  ignoreRegions: unknown;
  layoutRegions: unknown;
  floatingRegions: unknown;
  contentRegions: unknown;
  accessibilityRegions: unknown;
  matchLevel: string;
}
export interface ApprovableRun {
  id: string;
  name: string | null;
  branchName: string | null;
}

/**
 * Promote one checkpoint's variation baseline, record the baseline row, and
 * flip its run to passed — inside an existing transaction. Extracted VERBATIM
 * from runs.approveCheckpoint so single-checkpoint and group approval cannot
 * drift. (v1.1 has no "partially approved" run: approving any checkpoint flips
 * the whole run to passed — preserved here intentionally.)
 */
export async function approveCheckpointInTx(
  tx: Tx,
  s: ApprovableCheckpoint,
  run: ApprovableRun,
  userId: string,
): Promise<void> {
  await tx
    .update(testVariations)
    .set({
      baselineName: s.imageKey,
      ignoreRegions: s.ignoreRegions,
      layoutRegions: s.layoutRegions,
      floatingRegions: s.floatingRegions,
      contentRegions: s.contentRegions,
      accessibilityRegions: s.accessibilityRegions,
      matchLevel: s.matchLevel,
      updatedAt: new Date(),
    })
    .where(eq(testVariations.id, s.testVariationId));

  await tx.insert(baselines).values({
    baselineName: s.imageKey ?? run.name ?? "auto",
    testVariationId: s.testVariationId,
    testRunId: run.id,
    userId,
    ...(run.branchName ? { branchName: run.branchName } : {}),
  });

  await tx
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, run.id));
}
