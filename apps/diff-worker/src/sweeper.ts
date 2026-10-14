import {
  and,
  asc,
  checkpointDecisions,
  count,
  diffRegions,
  eq,
  isNull,
  lt,
  or,
  recomputeRunStatus,
  screenshots,
  sql,
  testRuns,
  withProjectScope,
} from "@furan/db";
import type { DB } from "@furan/db";

/** Where a run the sweep could not finalise is reported. */
export interface SweepLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface SweepArgs {
  db: DB;
  now?: Date;
  thresholdMs?: number;
  /** Receives `sweeper_run_failed` for each run that threw. */
  logger?: SweepLogger;
}

/**
 * Finalises `running` runs whose diff never landed (review flow spec §3).
 *
 * Per stale run, in ONE transaction that holds the run's row lock:
 *  1. No checkpoints: the run is `empty` (a lifecycle write the rollup keeps).
 *  2. Otherwise every checkpoint whose `verdict` is still NULL gets one:
 *     `unresolved` if it has a region with `severity <> 'none'`, else
 *     `passed` (today's outcome rule, applied per checkpoint; a region an
 *     auto rule resolved does not count, as in the backfill). Without this,
 *     rollup rule 4 (a NULL verdict means a diff is pending) would keep the
 *     run `running` forever. Verdicts the diff-worker already wrote are left
 *     alone.
 *     Ruling R47 (fail closed): a checkpoint whose decisions were all undone
 *     (its latest decision is reverted, none is active) is `unresolved`
 *     whatever its regions. The undo cleared the verdict of a step re-diffed
 *     against its own, now removed, baseline, so it has no counted region; if
 *     the undo's re-diff is lost, `passed` would be a machine pass nobody
 *     looked at. A human must.
 *  3. `recomputeRunStatus` derives the status from the verdicts, any active
 *     reviewer decisions and the run override.
 *
 * Runs are visited in ascending `id` order, the order every multi-run caller
 * of `recomputeRunStatus` must lock in, so two concurrent sweeps cannot
 * deadlock on each other. A run that throws is rolled back, logged
 * (`sweeper_run_failed`) and counted in `failed`; the runs after it are still
 * swept.
 */
export async function sweepStaleRuns({
  db,
  now = new Date(),
  thresholdMs = 5 * 60_000,
  logger,
}: SweepArgs): Promise<{ finalized: number; failed: number }> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const stale = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId })
    .from(testRuns)
    .where(and(eq(testRuns.status, "running"), lt(testRuns.updatedAt, cutoff)))
    .orderBy(asc(testRuns.id));

  let finalized = 0;
  let failed = 0;
  for (const row of stale) {
    try {
      if (await sweepRun(db, row, cutoff, now)) finalized++;
    } catch (err) {
      failed++;
      logger?.error(
        { err, runId: row.id, projectId: row.projectId },
        "sweeper_run_failed",
      );
    }
  }
  return { finalized, failed };
}

/** One stale run, in its own transaction; true when it was finalised. */
async function sweepRun(
  db: DB,
  row: { id: string; projectId: string },
  cutoff: Date,
  now: Date,
): Promise<boolean> {
  return withProjectScope(db, row.projectId, async (tx) => {
    // Lock first, then re-check: the run may have finished (or been touched
    // by a live diff) since the list above was read. Skipping it then is
    // right, and everything below runs under this lock.
    const [locked] = await tx
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(
        and(
          eq(testRuns.id, row.id),
          eq(testRuns.status, "running"),
          lt(testRuns.updatedAt, cutoff),
        ),
      )
      .for("no key update");
    if (!locked) return false;

    const [counted] = await tx
      .select({ n: count() })
      .from(screenshots)
      .where(eq(screenshots.runId, row.id));
    const checkpointCount = counted?.n ?? 0;

    if (checkpointCount === 0) {
      await tx
        .update(testRuns)
        .set({ status: "empty", checkpointCount: 0, completedAt: now })
        .where(eq(testRuns.id, row.id));
      return true;
    }

    // The backfill's derivation (spec §4.5 step 1): a region counts when its
    // severity is not 'none' and no auto rule resolved it. It belongs to a
    // checkpoint by `screenshot_id`; a legacy row without one (pre-v1.1.20)
    // matches on the run and viewport instead.
    const hasSeverityRegion = sql`EXISTS (
        SELECT 1 FROM ${diffRegions}
        WHERE ${diffRegions.runId} = ${screenshots.runId}
          AND ${diffRegions.severity} <> 'none'
          AND ${diffRegions.resolvedByApplicationId} IS NULL
          AND (
            ${diffRegions.screenshotId} = ${screenshots.id}
            OR (
              ${diffRegions.screenshotId} IS NULL
              AND ${diffRegions.viewport} = ${screenshots.viewport}
            )
          )
      )`;
    // R47: every decision of the checkpoint was undone (one exists, none is
    // active), so its NULL verdict waits for a re-diff a human must check.
    const undoneDecision = sql`(
        EXISTS (
          SELECT 1 FROM ${checkpointDecisions}
          WHERE ${checkpointDecisions.screenshotId} = ${screenshots.id}
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${checkpointDecisions}
          WHERE ${checkpointDecisions.screenshotId} = ${screenshots.id}
            AND ${checkpointDecisions.revertedAt} IS NULL
        )
      )`;
    await tx
      .update(screenshots)
      .set({ verdict: "unresolved", verdictAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(screenshots.runId, row.id),
          isNull(screenshots.verdict),
          or(hasSeverityRegion, undoneDecision),
        ),
      );
    // Whatever is still NULL has no real region.
    await tx
      .update(screenshots)
      .set({ verdict: "passed", verdictAt: sql`clock_timestamp()` })
      .where(and(eq(screenshots.runId, row.id), isNull(screenshots.verdict)));

    await recomputeRunStatus(tx, row.id);
    await tx
      .update(testRuns)
      .set({ checkpointCount, completedAt: now })
      .where(eq(testRuns.id, row.id));
    return true;
  });
}
