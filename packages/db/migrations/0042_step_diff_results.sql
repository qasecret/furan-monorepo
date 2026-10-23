-- 0042: per-step diff results, versions and the reconciler's index
-- (spec 2026-10-23 speed-at-scale per-step pipeline §2).
--
-- Today every upload queues a diff of the WHOLE run, so a run of N steps does
-- up to N^2 checkpoint diffs, and overlapping whole-run jobs race. The
-- pipeline moves to one job per step, guarded by a per-step version.
--
-- diff_generation   the step's version. Bumped every time the step is queued
--                   for a diff; a job whose generation no longer matches is
--                   stale and writes nothing.
-- diff_queued_at    when the current version was queued (the reconciler's
--                   stuck clock).
-- diff_requeues     how many times the reconciler re-queued the current
--                   version; reset to 0 by every new version.
-- diff_percent, pixel_mismatch_count, baseline_source, vlm_description,
-- rule_resolved     the step's OWN diff result. The run's totals are folded
--                   from these, under the run lock, by `recomputeRunTotals`.
-- diff_failed_at, diff_error
--                   set when the step's diff failed permanently (its verdict
--                   is then `unresolved`). `diff_error` is a fixed reason
--                   code, never a message or a stack trace.
--
-- No column holds a storage key, so the storage proxy's ownership probes and
-- the orphan reconcile are unchanged.
--
-- No backfill: existing steps keep version 0 and NULL per-step numbers, and
-- the first re-diff of a step fills them. The totals of an existing run stay
-- as stored until one of its steps is diffed again.
--
-- screenshots_stuck_idx holds only the steps still awaiting a result, so the
-- reconciler's scan is proportional to the work in flight, not to the
-- project's history. A step awaits one while it has not failed for good and
-- has no result newer than its queue time: no verdict yet, or one from before
-- it was last queued (a re-diff keeps the old result until the new one lands,
-- so a lost re-diff is found too). A comparison with NULL is unknown, so a
-- step with a verdict but no verdict_at or no diff_queued_at is left out.
--
-- Additive and idempotent: every column has no default or a constant one (a
-- metadata-only change on Postgres 11+, no rewrite of existing rows), and
-- re-applying this file is a no-op.
--
-- Locks, by runner:
-- - drizzle-kit (`drizzle-kit migrate`: every pending file in ONE
--   transaction): `ADD COLUMN`'s ACCESS EXCLUSIVE lock on `screenshots` is
--   held until commit, through the index build below (one scan of the table),
--   so reads and writes of `screenshots` both wait for the whole migration.
-- - the compose runner (`infra/docker/scripts/migrate.sh`, `psql -f`, each
--   statement its own transaction): each `ADD COLUMN` is a brief metadata
--   change; the `CREATE INDEX` holds SHARE on `screenshots` (writes wait,
--   reads do not) while it builds.
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_requeues" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_percent" double precision;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "pixel_mismatch_count" integer;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "baseline_source" "baseline_source";--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "vlm_description" text;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "rule_resolved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "diff_error" varchar(64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_stuck_idx" ON "screenshots" USING btree ("diff_queued_at") WHERE ("screenshots"."diff_failed_at" IS NULL AND ("screenshots"."verdict" IS NULL OR "screenshots"."verdict_at" < "screenshots"."diff_queued_at"));
