-- 0043: stored pending counters on test_runs, the slice-3 read indexes, the
-- reconciler's index, and the indexes they supersede; plus two schema drift
-- fixes (spec 2026-10-27 speed-at-scale server reads §2).
--
-- "Pending" was stored nowhere: every review queue, count and list re-derived
-- it across the whole project. Two counters on the run now hold it (spec
-- §3.1; the definition is documented in `packages/db/src/run-counters.ts`):
--
-- pending_steps  0 unless the run is reviewable (its lifecycle is not running,
--                aborted or empty, it has no status_override, and no step has
--                a NULL verdict); then its steps with verdict `new` or
--                `unresolved` and no active decision (`pendingStepCondition`
--                without facets, diff-failed steps included).
-- failed_steps   those pending steps whose diff failed (`diff_failed_at` set).
--
-- Both are `integer NOT NULL DEFAULT 0`. A constant default is a metadata-only
-- change on Postgres 11+, with no rewrite of existing rows.
--
-- The read indexes (spec §2 names the read each one serves):
-- - test_runs (project_id, build_id) WHERE pending_steps > 0: the runs with
--   pending work (queue, counts, "needs review" filter);
-- - test_runs (build_id, created_at, id): a build's runs in capture order;
-- - test_runs (build_id, status) INCLUDE (name): per-build status and
--   test-name aggregation, and status filters;
-- - test_runs (diff_name) WHERE diff_name IS NOT NULL: the storage proxy's
--   legacy ownership probe;
-- - screenshots (test_variation_id, created_at DESC, id DESC): a variation's
--   newest captures;
-- - screenshots (image_key), and (dom_key), (element_map_key) and
--   (diff_image_key), each partial on its own column IS NOT NULL: the storage
--   proxy's ownership probes;
-- - baselines (test_variation_id, branch_name, created_at DESC, id DESC): one
--   step's baseline.
-- And one beyond spec §2:
-- - test_runs (updated_at) WHERE status = 'running': the diff-worker
--   reconciler's empty-run rule, every 30 s (running runs not updated since
--   its cutoff), which otherwise scans the whole table. Only runs in flight
--   are in it.
-- `test_runs_build_status_idx` lives only in this SQL. Drizzle's index builder
-- cannot express INCLUDE, so the schema does not declare it and drizzle-kit
-- never creates or drops it (see the note in `schema/test_runs.ts`). Every
-- other index in this file is declared in the Drizzle schema.
--
-- Each new index is dropped (IF EXISTS) before it is created, as in 0042: a
-- database that applied a draft of this file self-corrects, where
-- `IF NOT EXISTS` alone would keep the draft's definition. On a fresh install
-- the DROPs find nothing and do nothing.
--
-- Superseded indexes, dropped. Each is a plain single-column btree (not
-- unique, backing no constraint) whose column leads a new, non-partial btree
-- index, so every lookup it served (the foreign-key cascades included) is
-- served by its replacement, and dropping it spares every insert into a hot
-- table one index:
-- - test_runs_build_id_idx (build_id): by test_runs_build_created_idx
--   (build_id, created_at, id), and test_runs_build_status_idx;
-- - screenshots_test_variation_id_idx (test_variation_id): by
--   screenshots_variation_created_idx (test_variation_id, created_at DESC,
--   id DESC);
-- - baselines_test_variation_id_idx (test_variation_id): by
--   baselines_variation_branch_created_idx (test_variation_id, branch_name,
--   created_at DESC, id DESC).
-- They are dropped only after their replacements are built, so no lookup is
-- ever left without an index, whatever the runner.
--
-- Schema drift, fixed so that the schema and the migrations agree:
-- - `test_runs_status_created_idx` (status, created_at) was declared in the
--   schema, but no migration created it and no query needs it: no read of
--   test_runs filters on status and created_at without a project or a build in
--   front (the inbox reads use `test_runs_inbox_idx`, the analytics filter
--   `status NOT IN (...)` within a project, the reconciler's empty-run rule
--   filters on `updated_at`). It leaves the schema. Its DROP IF EXISTS finds an
--   index only on a database built from the schema with `drizzle-kit push`.
-- - `test_runs_inbox_idx` was created by 0014 for the inbox reads but never
--   declared; the schema now declares it. Its CREATE IF NOT EXISTS is a no-op
--   on every database, since 0014 built it, so it is not dropped first:
--   rebuilding an index that already has the right definition only costs time.
--
-- The backfill (`COUNTERS_BACKFILL_SQL`, last below) is one UPDATE: every run
-- LEFT JOINed to the aggregate of its pending steps, taken only when the run
-- is reviewable, so any other run computes 0 and 0. It writes every run whose
-- stored counters differ from the computed ones, in either direction, and
-- rewrites no run whose counters are right. Here, on columns that have just
-- been added at 0, that means the runs with pending work, usually a small share
-- of the table; run again later with the writers stopped, it repairs counters
-- that went stale (the live repair is per run, see below). It reads
-- every run once, the open steps (exactly what the partial
-- `screenshots_pending_open_idx` holds) with their active decisions, and the
-- undiffed steps of each run with pending work (`screenshots_undiffed_idx`).
-- It runs after the index builds, which keeps the window described under the
-- compose runner below as short as this file can.
--
-- Additive and idempotent: re-applying this file leaves the same schema and
-- data and rewrites no row (the columns are skipped, the new indexes are
-- rebuilt as they were, the superseded ones are already gone, and the backfill
-- finds every counter right).
--
-- Locks, by runner:
-- - drizzle-kit (`drizzle-kit migrate`: every pending file in ONE
--   transaction): `ADD COLUMN`'s ACCESS EXCLUSIVE lock on `test_runs` is held
--   until commit, through every index build and the backfill, so reads and
--   writes of `test_runs` wait for the whole migration. Each `CREATE INDEX` on
--   `screenshots` or `baselines` holds SHARE on that table until commit, so
--   writes there wait from that build on, and the DROP of its superseded index
--   takes ACCESS EXCLUSIVE until commit, so reads wait too from that DROP on
--   (it comes after the builds, so that is the drops and the backfill). Every
--   write path that changes a counter's input locks its run row first or
--   inserts a row that references it, so none can run during the backfill, and
--   the counters are exact at commit. Stop the app services (api,
--   capture-worker, diff-worker) before a `drizzle-kit migrate` run: the
--   index DROPs take ACCESS EXCLUSIVE inside the one transaction, so a live
--   reader holding a lock the migration needs next can deadlock with it.
-- - the compose runner (`infra/docker/scripts/migrate.sh`, `psql -f`, each
--   statement its own transaction): each `ADD COLUMN` is a brief metadata
--   change; each `CREATE INDEX` holds SHARE on its table (writes wait, reads do
--   not) while it builds; each `DROP INDEX` of an existing index (a superseded
--   one, or a new one on a re-apply) takes ACCESS EXCLUSIVE on its table for a
--   moment. The backfill takes no table lock beyond an UPDATE's: it row-locks
--   the runs it writes, waiting for any write that holds one of them, and a
--   write that locks several runs can deadlock with it, in which case Postgres
--   aborts one of the two. If that is the backfill, the migration fails before
--   it is recorded, and running it again applies the whole file again, safely,
--   though that re-run rebuilds every index the file drops and creates, each
--   build blocking writes to its table again.
--   The previous release writes no counters, and under this runner it can keep
--   serving while the file runs (on `docker compose up -d` the old containers
--   run until their replacements start, after `migrate` completes). A run it
--   changes after the backfill has read it keeps counters that are stale until
--   the run's next write recomputes them, or until the repair fixes them:
--   `verify-review-rollup --repair` (apps/api), which recomputes each such run
--   under its own run lock. Do not re-run the backfill itself while any writer
--   is up: it computes from one snapshot and can overwrite a concurrent
--   writer's counters. For exact counters at the upgrade, stop the writers
--   first (api, capture-worker, diff-worker), as
--   docs/runbooks/migration-deploy-order.md describes.
--
-- One-off cost on a large install: each index build reads its whole table once
-- and sorts it, and the five `screenshots` builds dominate (spec §6 estimates
-- the four probe indexes at about 120 MB at 1.2M steps); the three superseded
-- indexes give back their space. The backfill reads every run and the open
-- steps once. Measure it on a restored copy before upgrading a large install.
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "pending_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "failed_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_status_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_inbox_idx" ON "test_runs" USING btree ("project_id","status","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "test_runs"."status" IN ('unresolved', 'failed');--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_pending_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_pending_idx" ON "test_runs" USING btree ("project_id","build_id") WHERE "test_runs"."pending_steps" > 0;--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_build_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_build_created_idx" ON "test_runs" USING btree ("build_id","created_at","id");--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_build_status_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_build_status_idx" ON "test_runs" USING btree ("build_id","status") INCLUDE ("name");--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_diff_name_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_diff_name_idx" ON "test_runs" USING btree ("diff_name") WHERE "test_runs"."diff_name" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_running_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_running_idx" ON "test_runs" USING btree ("updated_at") WHERE "test_runs"."status" = 'running';--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_variation_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_variation_created_idx" ON "screenshots" USING btree ("test_variation_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_image_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_image_key_idx" ON "screenshots" USING btree ("image_key");--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_dom_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_dom_key_idx" ON "screenshots" USING btree ("dom_key") WHERE "screenshots"."dom_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_element_map_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_element_map_key_idx" ON "screenshots" USING btree ("element_map_key") WHERE "screenshots"."element_map_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_diff_image_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_diff_image_key_idx" ON "screenshots" USING btree ("diff_image_key") WHERE "screenshots"."diff_image_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "baselines_variation_branch_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "baselines_variation_branch_created_idx" ON "baselines" USING btree ("test_variation_id","branch_name","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_build_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_test_variation_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "baselines_test_variation_id_idx";--> statement-breakpoint
-- The backfill (spec §3.1), verbatim `COUNTERS_BACKFILL_SQL`
-- (`packages/db/src/run-counters.ts`; a test holds the two together). The
-- aggregate lists each run's pending steps; the LEFT JOIN takes it only for a
-- reviewable run (its conditions are `reviewableRunCondition`), so a run that
-- is not reviewable, or has no pending step, computes 0 and 0. Only rows whose
-- stored counters differ are written.
UPDATE "test_runs" AS r
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
   AND (r."pending_steps", r."failed_steps") IS DISTINCT FROM (c."pending", c."failed");
