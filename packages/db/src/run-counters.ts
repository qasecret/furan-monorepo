/**
 * A run's stored pending counters, `test_runs.pending_steps` and
 * `test_runs.failed_steps` (spec 2026-10-27 speed-at-scale server reads §3.1).
 *
 * Both are 0 unless the run is reviewable, which is exactly
 * `reviewableRunCondition` (`apps/api/src/lib/review/pending.ts`):
 * - its lifecycle (`status`) is not `running`, `aborted` or `empty`;
 * - it has no `status_override`;
 * - none of its steps has a NULL verdict (not diffed yet).
 *
 * When it is reviewable:
 * - `pending_steps` counts its steps with verdict `new` or `unresolved` and no
 *   active decision (no `checkpoint_decisions` row with `reverted_at IS
 *   NULL`): exactly `pendingStepCondition` without facets, including its
 *   `NOT has_active_decision` pre-filter, so diff-failed steps count;
 * - `failed_steps` counts those of them whose diff failed (`diff_failed_at IS
 *   NOT NULL`).
 *
 * Approvable = `pending_steps - failed_steps`.
 */

/**
 * The backfill of migration `0043_server_reads`, verbatim: the migration file
 * contains this exact statement (`migration-server-reads.test.ts` holds the
 * two together). It doubles as the repair of counters that went stale.
 *
 * One UPDATE: every run, LEFT JOINed to the aggregate of its pending steps.
 * The join takes a run's aggregate only when the run is reviewable, so a run
 * that is not, or that has no pending step, computes 0 and 0. Every run whose
 * stored counters differ from the computed ones is written, in either
 * direction (a stale positive goes back to 0); a run whose counters are right
 * is not rewritten, so running it again changes no row.
 *
 * It computes from one statement snapshot. Under READ COMMITTED, a writer
 * that commits a run's new counters while it runs can be overwritten with the
 * counters from before that commit, so a repair against a live database must
 * not run it that way (take the runs' locks, or run it in REPEATABLE READ and
 * retry on a serialization failure).
 */
export const COUNTERS_BACKFILL_SQL = `UPDATE "test_runs" AS r
   SET "pending_steps" = c."pending",
       "failed_steps" = c."failed"
  FROM (
    SELECT t."id",
           COALESCE(p."pending", 0) AS "pending",
           COALESCE(p."failed", 0) AS "failed"
      FROM "test_runs" AS t
      LEFT JOIN (
        SELECT s."run_id",
               count(*)::int AS "pending",
               (count(*) FILTER (WHERE s."diff_failed_at" IS NOT NULL))::int AS "failed"
          FROM "screenshots" AS s
         WHERE s."verdict" IN ('new', 'unresolved')
           AND NOT s."has_active_decision"
           AND NOT EXISTS (
                 SELECT 1 FROM "checkpoint_decisions" AS d
                  WHERE d."screenshot_id" = s."id" AND d."reverted_at" IS NULL
               )
         GROUP BY s."run_id"
      ) AS p
        ON p."run_id" = t."id"
       AND t."status" NOT IN ('running', 'aborted', 'empty')
       AND t."status_override" IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM "screenshots" AS u
              WHERE u."run_id" = t."id" AND u."verdict" IS NULL
           )
  ) AS c
 WHERE r."id" = c."id"
   AND (r."pending_steps", r."failed_steps") IS DISTINCT FROM (c."pending", c."failed");`;
