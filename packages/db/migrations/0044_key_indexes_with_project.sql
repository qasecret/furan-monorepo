-- 0044: the storage proxy's key indexes lead with the key and carry the
-- project, and the legacy image_name probe gets an index (speed-at-scale
-- server reads, slice 3: rulings R20 and R21).
--
-- Migration 0043 built one index per storage key the proxy checks, each on the
-- key alone. The proxy asks "does this key belong to a row of one of the
-- caller's projects?", that is `key = $1 AND project_id IN (...)`, and two
-- things were left over:
--
-- 1. A key is a content hash, so every identical capture of a page shares it,
--    and a key can be held by many rows of other projects. An index on the
--    key alone reads all of those entries, and fetches each row to test its
--    project, before it reaches the caller's own: measured at 90 to 100 ms for
--    a key that 45,000 rows of other projects share, whether the caller's
--    project held none of them or one. Each index is now `(key, project_id)`,
--    so the same lookup lands on the caller's own entries (1.3 ms in the same
--    measurement) and costs the same however many other projects share the
--    key. The leading key column still serves every lookup by the key
--    alone, as before (the retention sweep's `image_key IN (...)`).
-- 2. `test_runs.image_name`, one of the six places the proxy looks for a key,
--    had no index, so a probe that found nothing (a 404) scanned `test_runs`.
--    Nothing in this repository writes the column any more, so the new partial
--    index is empty on a current install and costs a write nothing; on an
--    install with old rows in it, it holds only those.
--
-- The six indexes, each led by the key it is for (the sparse columns partial on
-- their own column IS NOT NULL, which `col = $1` implies):
-- - screenshots (image_key, project_id)
-- - screenshots (dom_key, project_id) WHERE dom_key IS NOT NULL
-- - screenshots (element_map_key, project_id) WHERE element_map_key IS NOT NULL
-- - screenshots (diff_image_key, project_id) WHERE diff_image_key IS NOT NULL
-- - test_runs (diff_name, project_id) WHERE diff_name IS NOT NULL
-- - test_runs (image_name, project_id) WHERE image_name IS NOT NULL  (new)
-- Five keep their 0043 names, so every name in 0043 stays true; the sixth is
-- `test_runs_image_name_idx`.
--
-- This is a new file rather than an edit of 0043 because 0043 has already run
-- on databases (the test database, and any deploy part-way through a release
-- train), where an edited 0043 would never be applied again.
--
-- Each index is dropped (IF EXISTS) before it is created, as in 0043: every
-- database that ran 0043 holds the five single-column indexes under these very
-- names, and `IF NOT EXISTS` alone would keep them. On a fresh install, where
-- the same transaction or run has just built 0043's versions of the five on
-- empty tables, the DROPs find those and cost nothing measurable; the sixth
-- has nothing to drop.
--
-- Additive and idempotent: no column, no data and no constraint changes, and
-- every lookup the single-column indexes served is served by the new ones, so
-- the previous release keeps working against this schema. Re-applying this
-- file rebuilds the same six indexes and changes nothing else.
--
-- Order: the four `screenshots` indexes first (the larger table), then the
-- `test_runs` ones, the new one before the replaced one. That keeps the span
-- during which a table is locked as short as the runner allows; see below.
--
-- Locks, by runner:
-- - drizzle-kit (`drizzle-kit migrate`: every pending file in ONE
--   transaction): the first DROP of an existing index on a table takes
--   ACCESS EXCLUSIVE on that table and holds it until commit, so every read
--   and write of `screenshots` waits from the first statement below until the
--   end of the migration (all four index builds, and the `test_runs` ones that
--   follow), and likewise `test_runs` from the `test_runs_diff_name_idx` DROP.
--   The new `test_runs_image_name_idx` is built first and holds only SHARE on
--   `test_runs` (writes wait, reads do not). Stop the app services (api,
--   capture-worker, diff-worker) before a `drizzle-kit migrate` run: a live
--   reader that holds a lock the migration needs next can deadlock with it.
-- - the compose runner (`infra/docker/scripts/migrate.sh`, `psql -f`, each
--   statement its own transaction): each DROP INDEX takes ACCESS EXCLUSIVE on
--   its table for a moment; each CREATE INDEX holds SHARE on its table (writes
--   wait, reads do not) while it builds. Between an index's DROP and the end of
--   its build the table has no index for that key, and the storage proxy's
--   probe falls back to a scan for it: correct, but it can take hundreds of
--   milliseconds per image on a large install. The previous release can keep
--   serving while the file runs.
--
-- One-off cost on a large install: each build reads its table once and sorts
-- it. The four `screenshots` builds dominate; the `test_runs` ones read a table
-- with one row per test run. Measure it on a restored copy before upgrading a
-- large install. The entries carry the project's uuid too, which the btree's
-- deduplication of repeated keys mostly absorbs: on a table of 1.09M steps
-- (the image and diff keys repeating 24 ways) the four `screenshots` indexes,
-- freshly built, are 18.1 MB against 17.2 MB on the key alone. The builds took
-- 1.4 s, 0.2 s, 0.8 s and 0.6 s there, and the two `test_runs` ones (230,000
-- rows) 0.04 s and 0.1 s.
DROP INDEX IF EXISTS "screenshots_image_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_image_key_idx" ON "screenshots" USING btree ("image_key","project_id");--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_dom_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_dom_key_idx" ON "screenshots" USING btree ("dom_key","project_id") WHERE "screenshots"."dom_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_element_map_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_element_map_key_idx" ON "screenshots" USING btree ("element_map_key","project_id") WHERE "screenshots"."element_map_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "screenshots_diff_image_key_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screenshots_diff_image_key_idx" ON "screenshots" USING btree ("diff_image_key","project_id") WHERE "screenshots"."diff_image_key" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_image_name_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_image_name_idx" ON "test_runs" USING btree ("image_name","project_id") WHERE "test_runs"."image_name" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "test_runs_diff_name_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_runs_diff_name_idx" ON "test_runs" USING btree ("diff_name","project_id") WHERE "test_runs"."diff_name" IS NOT NULL;
