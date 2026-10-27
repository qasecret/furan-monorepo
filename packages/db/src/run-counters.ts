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
 * The one-off backfill of migration `0043_server_reads`, verbatim: the
 * migration file contains this exact statement (`migration-server-reads.test.ts`
 * holds the two together).
 *
 * One UPDATE over the aggregate of every run's pending steps. A run without
 * one is absent from the aggregate, so only runs whose counts are above 0 are
 * written; of those, only rows whose stored counters differ, so a re-applied
 * migration rewrites no row. Every other run keeps the columns' default, 0,
 * which is right for it on the database the migration has just given the
 * columns to.
 */
export const COUNTERS_BACKFILL_SQL = `UPDATE "test_runs" AS r
   SET "pending_steps" = c."pending",
       "failed_steps" = c."failed"
  FROM (
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
  ) AS c
 WHERE r."id" = c."run_id"
   AND r."status" NOT IN ('running', 'aborted', 'empty')
   AND r."status_override" IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM "screenshots" AS u
          WHERE u."run_id" = r."id" AND u."verdict" IS NULL
       )
   AND (r."pending_steps", r."failed_steps") IS DISTINCT FROM (c."pending", c."failed");`;
