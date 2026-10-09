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
--   * Source run R = the newest run (created_at DESC, id DESC) on branch B that
--     is `status = 'passed' AND merge = true` and has a screenshot of V. In data
--     written before this release that pair is the only marker that a run was
--     approved or promoted; any other status (unresolved, new, failed, aborted,
--     empty, running) or `merge = false` is never a source. A run with no branch
--     cannot be matched to a baseline branch and is skipped.
--   * V's current baseline on B is its newest baselines row on B
--     (created_at DESC, id DESC — the order resolveBaseline reads, ADR-068).
--   * Repair only when V has none, or R is newer than the run that row points at
--     (run created_at DESC, id DESC). If the current baseline already points at
--     R, nothing is written, which is also what makes a re-run a no-op.
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
  WITH approved_source AS (
    SELECT DISTINCT ON (s."test_variation_id", r."branch_name")
      s."test_variation_id" AS variation_id,
      r."branch_name"       AS branch,
      r."id"                AS run_id,
      r."created_at"        AS run_created_at,
      s."image_key"         AS image_key
    FROM "test_runs" r
    JOIN "screenshots" s ON s."run_id" = r."id"
    WHERE r."status" = 'passed'
      AND r."merge" = true
      AND r."branch_name" IS NOT NULL
    ORDER BY s."test_variation_id", r."branch_name",
             r."created_at" DESC, r."id" DESC,
             s."created_at" DESC, s."id" DESC
  ),
  current_baseline AS (
    SELECT DISTINCT ON (b."test_variation_id", b."branch_name")
      b."test_variation_id" AS variation_id,
      b."branch_name"       AS branch,
      b."id"                AS baseline_id,
      br."id"               AS run_id,
      br."created_at"       AS run_created_at
    FROM "baselines" b
    JOIN "test_runs" br ON br."id" = b."test_run_id"
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
       OR (src.run_created_at, src.run_id) > (cur.run_created_at, cur.run_id)
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
