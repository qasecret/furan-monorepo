-- 0036: Repair per-checkpoint baselines that run-level approve never promoted
-- (review-flow spec §4.4).
--
-- Before the approve core promoted every checkpoint, run-level approve and batch
-- "Approve all" wrote ONE baselines row per run (an arbitrary checkpoint), and
-- the diff-worker paired every checkpoint of a run with a single baseline run by
-- viewport. Multi-step tests therefore have step-2..N variations with NO
-- baseline, or a STALE one from an older run. Now that each checkpoint is diffed
-- against its own variation's baseline, the first CI run after the upgrade would
-- raise "no baseline" (or a burst of false diffs) on those tests. This inserts
-- the baseline the reviewer believed they had approved.
--
-- Rule, set-based, per (variation V, branch B):
--   * Candidate runs are those on branch B with `status = 'passed' AND
--     merge = true` that have a screenshot of V. In data written before this
--     release that pair is the only marker that a run was approved or promoted;
--     any other status (unresolved, new, failed, aborted, empty, running) or
--     `merge = false` is never a source. A run with no branch cannot be matched
--     to a baseline branch and is skipped.
--   * "Newer" means newer ACCEPTANCE, not newer run creation: a run created
--     earlier can be approved later, and a reviewer can deliberately re-approve
--     one step of an older run after a newer run was approved. The acceptance
--     time of candidate (V, R) is
--       - created_at of the existing baselines row (V, R), if R owns one (that
--         row was stamped when this very step was accepted); else
--       - the run's acceptance time: MAX(created_at) over the baselines rows R
--         owns for ANY variation (under run-level approve R owns a row for its
--         first checkpoint, stamped when R was approved); else
--       - R.updated_at when R owns no baselines row at all.
--     Rows this migration itself wrote (the audit_log 'baseline.repair' targets)
--     are ignored when computing acceptance: they are stamped "now" and would
--     otherwise inflate their run's acceptance time on a re-run.
--   * The source R is the candidate with the LATEST acceptance time; ties break
--     on R.created_at DESC, R.id DESC.
--   * V's current baseline on B is its newest baselines row on B
--     (created_at DESC, id DESC — the order resolveBaseline reads, ADR-068).
--     Repair only when V has none, or when R's acceptance time is later than
--     that row's created_at. If the current baseline already points at R,
--     nothing is written, which is also what makes a re-run a no-op (repaired
--     rows are stamped clock_timestamp(), later than any acceptance time).
--   * The repair upserts baselines(V, R) on the (test_variation_id, test_run_id)
--     key. baseline_name is R's screenshot image_key; user_id is any approver
--     already recorded on R's baselines (else NULL); branch_name is B;
--     created_at = clock_timestamp() so the repaired row sorts newest. If R
--     already owns a row for V stranded on another branch, that row is moved
--     onto B (its approver is kept) — otherwise the repair would never converge.
--     Older baseline rows are kept as history.
--   * One audit_log row per row written (actor NULL, action 'baseline.repair',
--     target = the baseline), fed from the INSERT's RETURNING in the same
--     statement so the two cannot diverge. previousBaselineId is V's current
--     baseline on B BEFORE the repair, or null.
--
-- test_variations.baseline_name (the denormalized copy) is deliberately NOT
-- touched: nothing authoritative reads it, and the review flow reads `baselines`.
--
-- Idempotent (see above) and data-only: no schema change, so drizzle-kit did not
-- emit it — it is hand-authored (precedent: 0026). The NOTICE reports how many
-- baselines were written; `verify-review-rollup --repairs` lists them later.

DO $$
DECLARE
  repaired integer;
BEGIN
  WITH accepted_rows AS (
    -- Every baselines row except the ones a previous run of this migration wrote.
    SELECT b."id", b."test_variation_id", b."test_run_id", b."created_at"
    FROM "baselines" b
    WHERE NOT EXISTS (
      SELECT 1 FROM "audit_log" al
      WHERE al."action" = 'baseline.repair'
        AND al."target_id" = b."id"
    )
  ),
  approved_run AS (
    SELECT
      r."id"                                       AS run_id,
      r."branch_name"                              AS branch,
      r."created_at"                               AS run_created_at,
      COALESCE(MAX(ar."created_at"), r."updated_at") AS run_accepted_at
    FROM "test_runs" r
    LEFT JOIN accepted_rows ar ON ar."test_run_id" = r."id"
    WHERE r."status" = 'passed'
      AND r."merge" = true
      AND r."branch_name" IS NOT NULL
    GROUP BY r."id"
  ),
  approved_source AS (
    SELECT DISTINCT ON (s."test_variation_id", ar.branch)
      s."test_variation_id"                        AS variation_id,
      ar.branch                                    AS branch,
      ar.run_id                                    AS run_id,
      s."image_key"                                AS image_key,
      COALESCE(own."created_at", ar.run_accepted_at) AS accepted_at
    FROM approved_run ar
    JOIN "screenshots" s ON s."run_id" = ar.run_id
    LEFT JOIN accepted_rows own
      ON own."test_run_id" = ar.run_id
     AND own."test_variation_id" = s."test_variation_id"
    ORDER BY s."test_variation_id", ar.branch,
             COALESCE(own."created_at", ar.run_accepted_at) DESC,
             ar.run_created_at DESC, ar.run_id DESC,
             s."created_at" DESC, s."id" DESC
  ),
  current_baseline AS (
    SELECT DISTINCT ON (b."test_variation_id", b."branch_name")
      b."test_variation_id" AS variation_id,
      b."branch_name"       AS branch,
      b."id"                AS baseline_id,
      b."test_run_id"       AS run_id,
      b."created_at"        AS created_at
    FROM "baselines" b
    WHERE b."test_variation_id" IN (SELECT variation_id FROM approved_source)
    ORDER BY b."test_variation_id", b."branch_name",
             b."created_at" DESC, b."id" DESC
  ),
  repair AS (
    SELECT
      src.variation_id,
      src.branch,
      src.run_id,
      src.image_key,
      cur.baseline_id AS previous_baseline_id,
      (SELECT MIN(rb."user_id"::text)::uuid
         FROM "baselines" rb
        WHERE rb."test_run_id" = src.run_id
          AND rb."user_id" IS NOT NULL) AS approver_id
    FROM approved_source src
    LEFT JOIN current_baseline cur
      ON cur.variation_id = src.variation_id
     AND cur.branch = src.branch
    WHERE cur.baseline_id IS NULL
       OR (cur.run_id <> src.run_id AND src.accepted_at > cur.created_at)
  ),
  written AS (
    INSERT INTO "baselines"
      ("baseline_name", "test_variation_id", "test_run_id", "user_id",
       "branch_name", "created_at", "updated_at")
    SELECT image_key, variation_id, run_id, approver_id, branch,
           clock_timestamp(), now()
    FROM repair
    ON CONFLICT ("test_variation_id", "test_run_id") DO UPDATE SET
      "baseline_name" = EXCLUDED."baseline_name",
      "branch_name"   = EXCLUDED."branch_name",
      "user_id"       = COALESCE("baselines"."user_id", EXCLUDED."user_id"),
      "created_at"    = clock_timestamp(),
      "updated_at"    = now()
    RETURNING "id", "test_variation_id", "test_run_id", "branch_name"
  )
  INSERT INTO "audit_log"
    ("actor_id", "action", "target_type", "target_id", "metadata")
  SELECT
    NULL::uuid,
    'baseline.repair',
    'baseline',
    w."id",
    jsonb_build_object(
      'variationId',        w."test_variation_id",
      'runId',              w."test_run_id",
      'branch',             w."branch_name",
      'previousBaselineId', rp.previous_baseline_id
    )
  FROM written w
  JOIN repair rp
    ON rp.variation_id = w."test_variation_id"
   AND rp.run_id = w."test_run_id";

  GET DIAGNOSTICS repaired = ROW_COUNT;
  RAISE NOTICE '0036_baseline_repair: % baseline(s) repaired', repaired;
END
$$;
