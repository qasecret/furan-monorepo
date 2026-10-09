import {
  and,
  asc,
  count,
  diffRegions,
  eq,
  isNull,
  lt,
  recomputeRunStatus,
  screenshots,
  sql,
  testRuns,
  withProjectScope,
} from "@furan/db";
import type { DB } from "@furan/db";

export interface SweepArgs {
  db: DB;
  now?: Date;
  thresholdMs?: number;
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
 *  3. `recomputeRunStatus` derives the status from the verdicts, any active
 *     reviewer decisions and the run override.
 *
 * Runs are visited in ascending `id` order, the order every multi-run caller
 * of `recomputeRunStatus` must lock in, so two concurrent sweeps cannot
 * deadlock on each other.
 */
export async function sweepStaleRuns({
  db,
  now = new Date(),
  thresholdMs = 5 * 60_000,
}: SweepArgs): Promise<{ finalized: number }> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const stale = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId })
    .from(testRuns)
    .where(and(eq(testRuns.status, "running"), lt(testRuns.updatedAt, cutoff)))
    .orderBy(asc(testRuns.id));

  let finalized = 0;
  for (const row of stale) {
    const swept = await withProjectScope(db, row.projectId, async (tx) => {
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
      await tx
        .update(screenshots)
        .set({ verdict: "unresolved", verdictAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(screenshots.runId, row.id),
            isNull(screenshots.verdict),
            hasSeverityRegion,
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
    if (swept) finalized++;
  }
  return { finalized };
}
