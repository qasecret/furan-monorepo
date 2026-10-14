-- 0040: screenshots.has_active_decision, kept by a trigger on checkpoint_decisions (ADR-074).
--
-- A pending review step (spec 2026-10-14-review-loop §3.1) has verdict `new`
-- or `unresolved`, no active decision and a reviewable run. A decision never
-- rewrites the verdict, so a decided step keeps `new` / `unresolved` forever,
-- and every project-wide pending scan (the review queue's next batch and its
-- counts, the sidebar badge, the "needs review" builds list) had to probe
-- `checkpoint_decisions` for every such step in the project's history: a cost
-- that grew with history, not with open work.
--
-- `has_active_decision` is true exactly when the step has a
-- `checkpoint_decisions` row with `reverted_at IS NULL`. The trigger below is
-- its ONLY maintainer: every insert, revert (`reverted_at`), re-pointing
-- (`screenshot_id`) and delete of a decision, cascades included, recomputes
-- the flag of each step it touches from `checkpoint_decisions` itself, so it
-- holds whichever path writes a decision.
--
-- The flag is a pre-filter, never the source of truth: `pendingStepCondition`
-- adds `NOT has_active_decision` (which the open-steps index can use) and
-- keeps its canonical `NOT EXISTS (active decision)`.
--
-- Re-applying this file is safe and leaves the data as it is: the column,
-- indexes and statistics are created only if missing, and the backfill
-- rewrites no row whose flag is already right. The function and the trigger
-- are replaced in place (never dropped, so no decision write can slip through
-- without the trigger) and `ANALYZE` runs again.
--
-- Locks, by runner:
-- - drizzle-kit (`drizzle-kit migrate`: every pending file in ONE
--   transaction): `ADD COLUMN`'s ACCESS EXCLUSIVE lock on `screenshots` is
--   held until commit, through the backfill, both index builds and `ANALYZE`,
--   so reads and writes of `screenshots` wait for the whole migration; the
--   trigger replacement and the backfill also hold `checkpoint_decisions`
--   against writes until commit.
-- - the compose runner (`infra/docker/scripts/migrate.sh`, `psql -f`, each
--   statement its own transaction): `ADD COLUMN` is a brief metadata change;
--   the backfill block holds SHARE on `checkpoint_decisions` (decision writes
--   wait, reads do not) while it runs; each `CREATE INDEX` holds SHARE on
--   `screenshots` (writes wait, reads do not) while it builds; `ANALYZE`
--   blocks neither.
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "has_active_decision" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Invoker rights (no SECURITY DEFINER): the UPDATE runs as whoever wrote the
-- decision, so row-level security applies to it as to the write itself. A
-- decision and its step share a `project_id`, so a caller allowed to write the
-- decision can see the step. The step may already be gone: when a run (or a
-- project) is deleted, ON DELETE CASCADE removes its steps and its decisions
-- in the same statement, and the UPDATE then simply matches no row.
CREATE OR REPLACE FUNCTION checkpoint_decisions_sync_active_flag() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  steps uuid[];
  step uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    steps := ARRAY[NEW.screenshot_id];
  ELSIF TG_OP = 'DELETE' THEN
    steps := ARRAY[OLD.screenshot_id];
  ELSIF OLD.screenshot_id IS DISTINCT FROM NEW.screenshot_id THEN
    steps := ARRAY[OLD.screenshot_id, NEW.screenshot_id];
  ELSE
    steps := ARRAY[NEW.screenshot_id];
  END IF;
  FOREACH step IN ARRAY steps LOOP
    UPDATE screenshots AS s
       SET has_active_decision = a.active
      FROM (
        SELECT EXISTS (
          SELECT 1 FROM checkpoint_decisions AS d
          WHERE d.screenshot_id = step AND d.reverted_at IS NULL
        ) AS active
      ) AS a
     WHERE s.id = step
       AND s.has_active_decision IS DISTINCT FROM a.active;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- CREATE OR REPLACE (PostgreSQL 14+), not DROP + CREATE: under an autocommit
-- runner there is never a moment without the trigger.
CREATE OR REPLACE TRIGGER "checkpoint_decisions_sync_active_flag"
  AFTER INSERT OR UPDATE OF "reverted_at", "screenshot_id" OR DELETE ON "checkpoint_decisions"
  FOR EACH ROW EXECUTE FUNCTION checkpoint_decisions_sync_active_flag();
--> statement-breakpoint
-- Backfill, after the trigger exists: every step whose flag differs from its
-- decisions. At most one active decision per step (the partial unique index
-- `checkpoint_decisions_active_uniq`), so the join yields one row per step.
--
-- The SHARE lock makes it exact under any runner. It waits for every decision
-- write in flight to commit, and holds off new ones until the backfill
-- commits, so the UPDATE (whose snapshot is taken after the lock) sees every
-- decision as it is when it runs. Without it, under autocommit, an undo
-- committing during the UPDATE would find the flag still `false` and write
-- nothing, and the UPDATE would then set `true` from its older snapshot,
-- hiding a pending step. Inside drizzle-kit's single transaction it is
-- harmless.
DO $$
BEGIN
  LOCK TABLE "checkpoint_decisions" IN SHARE MODE;
  UPDATE "screenshots" AS s
     SET "has_active_decision" = c."active"
    FROM (
      SELECT x."id", d."id" IS NOT NULL AS "active"
      FROM "screenshots" AS x
      LEFT JOIN "checkpoint_decisions" AS d
        ON d."screenshot_id" = x."id" AND d."reverted_at" IS NULL
    ) AS c
   WHERE c."id" = s."id"
     AND s."has_active_decision" IS DISTINCT FROM c."active";
END
$$;
--> statement-breakpoint
-- The open steps: a candidate verdict and no active decision, the work still
-- to do. `id` makes it covering for the project-wide scans, which need only a
-- step's id, run and project, so they read the index alone.
CREATE INDEX IF NOT EXISTS "screenshots_pending_open_idx" ON "screenshots" USING btree ("project_id","run_id","created_at","id") WHERE "screenshots"."verdict" IN ('new', 'unresolved') AND NOT "screenshots"."has_active_decision";
--> statement-breakpoint
-- The steps not diffed yet. One of them makes its run non-reviewable, and
-- every pending scan asks that of each candidate step's run
-- (`reviewableRunCondition`); this answers from a tiny index instead of
-- reading every step of the run.
CREATE INDEX IF NOT EXISTS "screenshots_undiffed_idx" ON "screenshots" USING btree ("run_id") WHERE "screenshots"."verdict" IS NULL;
--> statement-breakpoint
-- The verdict and the flag are strongly correlated (only a `new` or
-- `unresolved` step is ever decided, and most of those are), so estimating
-- them independently overstates the open steps several times over and steers
-- the planner to hash plans that read the whole history. A multivariate MCV
-- list gives it their joint frequencies.
CREATE STATISTICS IF NOT EXISTS "screenshots_verdict_decision_stats" (mcv) ON "verdict", "has_active_decision" FROM "screenshots";
--> statement-breakpoint
-- Fresh statistics for the new column and the statistics object, so the
-- planner sees the open steps as few right after the upgrade rather than once
-- autovacuum gets round to it. ANALYZE samples a fixed number of rows, so it
-- takes seconds whatever the table's size.
ANALYZE "screenshots";
