-- 0037: Backfill per-checkpoint verdicts and legacy review decisions
-- (review-flow spec §4.5).
--
-- Runs reviewed under the old run-level model have screenshots with no
-- `verdict` and reviews that left no `checkpoint_decisions` row. Under the
-- review model a run's status is the rollup of its checkpoints' verdicts and
-- active decisions (`rollupRunStatus`), and a NULL verdict means "diff
-- pending" (the rollup says `running`). This derives both from the legacy
-- data so that EVERY run's rollup equals the status it already has. It writes
-- no status: parity is proven per run class by the migration test, and on a
-- live database by `verify-review-rollup` (docs/runbooks/review-model-upgrade.md).
--
-- Step 1, verdicts. For each screenshot whose verdict IS NULL, of a run whose
-- status is not running / aborted / empty (those are lifecycle states the
-- rollup keeps; a running run's diff is genuinely pending):
--   0. 'passed' on EVERY checkpoint of a run that passed without review
--      (status 'passed' AND merge = false: the diff passed it, or an operator
--      forced it to passed; it was never approved or promoted), whatever its
--      regions. The per-checkpoint diff-worker judges a sub-threshold step
--      'passed'; marking a step 'unresolved' would need a synthetic approval
--      (step 2) that, as decisions survive re-diffs, would mask a later
--      re-diff of the step.
--   1. else 'unresolved' if the checkpoint has a qualifying diff region: a
--      diff_regions row with severity <> 'none' AND resolved_by_application_id
--      IS NULL, matched by screenshot_id, or — for a legacy pre-v1.1.20 row
--      with NULL screenshot_id — by the same run and viewport. This is the
--      stale-run sweeper's predicate (apps/diff-worker/src/sweeper.ts),
--      verbatim.
--   2. else 'new' if the run's status is 'new';
--   3. else 'unresolved' if the run's status is 'unresolved' and NO checkpoint
--      of the run has a qualifying region (the old run-level derivation: an
--      unresolved run without regions was unresolved as a whole). Regions
--      that match no checkpoint (a legacy row at a viewport the run has no
--      screenshot of, a v0.4 row with no viewport) do not count;
--   4. else 'passed'.
--   verdict_at = the run's updated_at.
--
-- Step 2, legacy decisions, for runs with status 'passed' or 'failed':
--   - passed: 'approved' on each checkpoint whose verdict <> 'passed' (so
--     only approved or promoted runs, merge = true, ever get one: step 1.0
--     leaves a merge = false passed run all 'passed'). Actor:
--     MIN(user_id) over the run's baselines rows with a user (deterministic;
--     the same choice 0036 made), else NULL.
--   - failed: 'rejected' on each checkpoint whose verdict <> 'passed', or on
--     EVERY checkpoint when all of them passed (a force-failed run). Actor:
--     the actor of the run's newest reject audit entry (action run.reject /
--     run.reviewer_reject / run.reject_cluster, target_type 'run',
--     target_id = the run; newest by created_at, then id), if that user still
--     exists, else NULL. audit_log.actor_id has no FK, so a deleted actor is
--     mapped to NULL exactly as checkpoint_decisions' ON DELETE SET NULL
--     would have left it, never to an older entry's actor. (The legacy
--     cluster reject audited the project, not the run, so cluster-rejected
--     runs get NULL.)
--   Every row: source 'backfill', before NULL (not undoable: the UI labels
--   it "recorded before review history"), the run's project_id and run_id,
--   reverted_at NULL, created_at = the run's updated_at (when the legacy
--   review last touched the run, as verdict_at), and ONE generated action_id
--   per run (a MATERIALIZED CTE keyed by run, so gen_random_uuid() runs once
--   per run).
--
-- Re-application guards. Deploys track migrations by content hash, so an
-- edited file runs again over data the review model wrote. Both steps skip
-- runs with a status_override (the override decides their rollup; a NULL
-- verdict there is a re-diff the diff-worker owns), and step 2 skips any run
-- that already has a decision row (so it never adds a reject to a step a
-- reviewer deliberately left pending), as well as any screenshot that has
-- one. On data written before the review model none of these exist, so the
-- guards change nothing there.
--
-- Idempotent: step 1 writes only NULL verdicts, and leaves none in its scope;
-- step 2 writes only for runs with no decision, and a run it wrote to has
-- one. A second execution writes nothing (verdict_at and decision rows
-- included).
--
-- Data-only (no schema change), so drizzle-kit emitted an empty custom
-- migration; one DO block, executable by drizzle-kit migrate and by
-- `psql -v ON_ERROR_STOP=1 -f` (the compose migrate one-shot) alike. The
-- NOTICE reports the counts.

DO $$
DECLARE
  verdicts_set integer;
  approvals integer;
  rejections integer;
BEGIN
  -- Step 1: verdicts. ---------------------------------------------------------
  WITH run_scope AS (
    SELECT r."id", r."status", r."merge", r."updated_at"
    FROM "test_runs" r
    WHERE r."status" NOT IN ('running', 'aborted', 'empty')
      AND r."status_override" IS NULL
      AND EXISTS (
        SELECT 1 FROM "screenshots" n
        WHERE n."run_id" = r."id" AND n."verdict" IS NULL
      )
  ),
  checkpoint AS (
    -- Every checkpoint of an in-scope run (step 1.3 looks at all of them).
    SELECT
      s."id",
      s."run_id",
      s."verdict",
      rs."status"     AS run_status,
      rs."merge"      AS run_merge,
      rs."updated_at" AS run_updated_at,
      EXISTS (
        SELECT 1 FROM "diff_regions" dr
        WHERE dr."run_id" = s."run_id"
          AND dr."severity" <> 'none'
          AND dr."resolved_by_application_id" IS NULL
          AND (
            dr."screenshot_id" = s."id"
            OR (dr."screenshot_id" IS NULL AND dr."viewport" = s."viewport")
          )
      ) AS has_region
    FROM run_scope rs
    JOIN "screenshots" s ON s."run_id" = rs."id"
  ),
  derived AS (
    SELECT
      c."id",
      c.run_updated_at,
      (CASE
        WHEN c.run_status = 'passed' AND NOT c.run_merge THEN 'passed'
        WHEN c.has_region THEN 'unresolved'
        WHEN c.run_status = 'new' THEN 'new'
        WHEN c.run_status = 'unresolved'
         AND NOT bool_or(c.has_region) OVER (PARTITION BY c."run_id")
          THEN 'unresolved'
        ELSE 'passed'
      END)::"checkpoint_verdict" AS verdict
    FROM checkpoint c
  )
  UPDATE "screenshots" s
  SET "verdict" = d.verdict,
      "verdict_at" = d.run_updated_at
  FROM derived d
  WHERE s."id" = d."id"
    AND s."verdict" IS NULL;

  GET DIAGNOSTICS verdicts_set = ROW_COUNT;

  -- Step 2: legacy decisions. -------------------------------------------------
  -- 2a reads (into a transaction-local table), 2b writes. Kept apart so every
  -- read of checkpoint_decisions happens before the first row is inserted
  -- into it: in one INSERT ... SELECT, an anti-join planned as a nested loop
  -- (the table is empty at upgrade time) rescans the pages the same
  -- statement is appending, which is quadratic in the number of decisions.
  CREATE TEMP TABLE IF NOT EXISTS "backfill_0037_decision" (
    "project_id"    uuid NOT NULL,
    "run_id"        uuid NOT NULL,
    "screenshot_id" uuid NOT NULL,
    "action_id"     uuid NOT NULL,
    "decision"      "checkpoint_decision" NOT NULL,
    "actor_id"      uuid,
    "created_at"    timestamptz NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE "backfill_0037_decision";

  WITH legacy_run AS MATERIALIZED (
    SELECT
      r."id"          AS run_id,
      r."project_id",
      r."status",
      r."updated_at",
      gen_random_uuid() AS action_id
    FROM "test_runs" r
    WHERE r."status" IN ('passed', 'failed')
      AND r."status_override" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "checkpoint_decisions" d WHERE d."run_id" = r."id"
      )
  ),
  target AS (
    SELECT lr.*, s."id" AS screenshot_id
    FROM legacy_run lr
    JOIN "screenshots" s ON s."run_id" = lr.run_id
    WHERE (
        s."verdict" <> 'passed'
        OR (
          lr."status" = 'failed'
          AND NOT EXISTS (
            SELECT 1 FROM "screenshots" o
            WHERE o."run_id" = lr.run_id AND o."verdict" <> 'passed'
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "checkpoint_decisions" d WHERE d."screenshot_id" = s."id"
      )
  ),
  approver AS (
    SELECT b."test_run_id" AS run_id, MIN(b."user_id"::text)::uuid AS actor_id
    FROM "baselines" b
    WHERE b."user_id" IS NOT NULL
      AND b."test_run_id" IN (
        SELECT t.run_id FROM target t WHERE t."status" = 'passed'
      )
    GROUP BY b."test_run_id"
  ),
  last_reject AS (
    SELECT DISTINCT ON (al."target_id")
      al."target_id" AS run_id,
      al."actor_id"
    FROM "audit_log" al
    WHERE al."target_type" = 'run'
      AND al."action" IN ('run.reject', 'run.reviewer_reject', 'run.reject_cluster')
      AND al."target_id" IN (
        SELECT t.run_id FROM target t WHERE t."status" = 'failed'
      )
    ORDER BY al."target_id", al."created_at" DESC, al."id" DESC
  )
  INSERT INTO "backfill_0037_decision"
    ("project_id", "run_id", "screenshot_id", "action_id", "decision",
     "actor_id", "created_at")
  SELECT
    t."project_id",
    t.run_id,
    t.screenshot_id,
    t.action_id,
    (CASE t."status" WHEN 'passed' THEN 'approved' ELSE 'rejected' END)
      ::"checkpoint_decision",
    CASE t."status" WHEN 'passed' THEN ap.actor_id ELSE u."id" END,
    t."updated_at"
  FROM target t
  LEFT JOIN approver ap ON ap.run_id = t.run_id
  LEFT JOIN last_reject lj ON lj.run_id = t.run_id
  LEFT JOIN "users" u ON u."id" = lj."actor_id";

  INSERT INTO "checkpoint_decisions"
    ("project_id", "run_id", "screenshot_id", "action_id", "decision",
     "actor_id", "source", "before", "created_at")
  SELECT
    b."project_id", b."run_id", b."screenshot_id", b."action_id", b."decision",
    b."actor_id", 'backfill', NULL, b."created_at"
  FROM "backfill_0037_decision" b;

  SELECT
    count(*) FILTER (WHERE b."decision" = 'approved'),
    count(*) FILTER (WHERE b."decision" = 'rejected')
  INTO approvals, rejections
  FROM "backfill_0037_decision" b;

  RAISE NOTICE '0037_review_backfill: % verdict(s) set, % legacy approval(s), % legacy rejection(s)',
    verdicts_set, approvals, rejections;
END
$$;
