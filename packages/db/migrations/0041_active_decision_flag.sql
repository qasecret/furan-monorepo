-- 0041: screenshots.has_active_decision, kept by a trigger on checkpoint_decisions (ADR-074).
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
-- Idempotent: re-applying this file is a no-op (the backfill rewrites no row
-- whose flag is already right).
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
DROP TRIGGER IF EXISTS "checkpoint_decisions_sync_active_flag" ON "checkpoint_decisions";
--> statement-breakpoint
CREATE TRIGGER "checkpoint_decisions_sync_active_flag"
  AFTER INSERT OR UPDATE OF "reverted_at", "screenshot_id" OR DELETE ON "checkpoint_decisions"
  FOR EACH ROW EXECUTE FUNCTION checkpoint_decisions_sync_active_flag();
--> statement-breakpoint
-- Backfill, after the trigger exists: every step whose flag differs from its
-- decisions. At most one active decision per step (the partial unique index
-- `checkpoint_decisions_active_uniq`), so the join yields one row per step.
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
