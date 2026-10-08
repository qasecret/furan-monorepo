-- Idempotency for recordBaseline (audit round 2, #1): one baseline row per
-- (test_variation_id, test_run_id). A diff-worker retry or a re-approve must
-- update that row, not append a duplicate. Keyed on the RUN (not the variation)
-- so distinct runs keep distinct rows — the autoApproved-per-run check and the
-- latest-wins resolver both depend on that.

--> statement-breakpoint
-- Dedupe pre-existing duplicates before the constraint: keep the most-recent
-- row per (variation, run); break created_at ties by the larger id.
DELETE FROM "baselines" a
USING "baselines" b
WHERE a."test_variation_id" = b."test_variation_id"
  AND a."test_run_id" = b."test_run_id"
  AND (a."created_at" < b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
ALTER TABLE "baselines"
  ADD CONSTRAINT "baselines_variation_run_unique"
  UNIQUE ("test_variation_id", "test_run_id");
