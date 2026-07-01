-- 0017_batch_test_checkpoint_model.sql
-- Hard-cutover migration for the batch→test→checkpoint
-- model (ADR-038).
--
-- Wipes:    test_runs, screenshots, diff_regions (schema becomes incompatible).
--           baselines (cascades through baselines.test_run_id FK).
-- Preserves: test_variations (the per-name *address* lives on).
--           project_members, builds, projects, users.
--
-- ⚠️  OPERATOR NOTICE — all approved baselines are wiped by this migration.
-- After upgrade, the first run per (project, branch, name, viewport, browser,
-- os, device) will be a fresh first-baseline (status=new). If
-- autoApproveFeature is true on the project, those baselines auto-seed.
-- If false (default after migration 0016), reviewers must explicitly
-- Save-as-baseline for each variation. There is no in-place rollback;
-- back up your DB before applying if baseline history matters.

TRUNCATE test_runs, screenshots, diff_regions CASCADE;
--> statement-breakpoint
ALTER TABLE test_runs
  DROP COLUMN IF EXISTS test_variation_id,
  DROP COLUMN IF EXISTS ignore_areas,
  DROP COLUMN IF EXISTS viewport,
  DROP COLUMN IF EXISTS browser,
  DROP COLUMN IF EXISTS os,
  DROP COLUMN IF EXISTS device,
  ALTER COLUMN name SET NOT NULL,
  ADD COLUMN IF NOT EXISTS checkpoint_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;
--> statement-breakpoint
ALTER TABLE screenshots
  ADD COLUMN IF NOT EXISTS name text NOT NULL,
  ADD COLUMN IF NOT EXISTS test_variation_id uuid NOT NULL REFERENCES test_variations(id),
  ADD COLUMN IF NOT EXISTS match_level text NOT NULL DEFAULT 'Strict',
  ADD COLUMN IF NOT EXISTS ignore_regions jsonb,
  ADD COLUMN IF NOT EXISTS layout_regions jsonb,
  ADD COLUMN IF NOT EXISTS floating_regions jsonb,
  ADD COLUMN IF NOT EXISTS content_regions jsonb,
  ADD COLUMN IF NOT EXISTS accessibility_regions jsonb,
  ADD COLUMN IF NOT EXISTS os text,
  ADD COLUMN IF NOT EXISTS device text;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'screenshots_run_id_viewport_unique'
  ) THEN
    ALTER TABLE screenshots DROP CONSTRAINT screenshots_run_id_viewport_unique;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS screenshots_run_id_viewport_unique;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'screenshots_run_id_name_viewport_unique'
  ) THEN
    ALTER TABLE screenshots ADD CONSTRAINT screenshots_run_id_name_viewport_unique UNIQUE (run_id, name, viewport);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_variations' AND column_name = 'ignore_areas'
  ) THEN
    ALTER TABLE test_variations RENAME COLUMN ignore_areas TO ignore_regions;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE test_variations
  ADD COLUMN IF NOT EXISTS layout_regions jsonb,
  ADD COLUMN IF NOT EXISTS floating_regions jsonb,
  ADD COLUMN IF NOT EXISTS content_regions jsonb,
  ADD COLUMN IF NOT EXISTS accessibility_regions jsonb,
  ADD COLUMN IF NOT EXISTS match_level text NOT NULL DEFAULT 'Strict';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_variations' AND column_name = 'ignore_regions'
    AND data_type = 'text'
  ) THEN
    ALTER TABLE test_variations ALTER COLUMN ignore_regions TYPE jsonb USING ignore_regions::jsonb;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS screenshots_image_key_idx;
DROP INDEX IF EXISTS test_runs_test_variation_id_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS screenshots_test_variation_id_idx ON screenshots(test_variation_id);
--> statement-breakpoint
-- Recovery for environments that previously had project_id dropped via an
-- earlier draft of this migration (snapshot was out-of-spec; restoring).
-- The TRUNCATE earlier makes the table empty, so NOT NULL is safe to add immediately.
-- On a fresh v1.0.20 DB the column already exists so the ADD is a no-op.
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS project_id uuid;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'screenshots' AND column_name = 'project_id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE screenshots ALTER COLUMN project_id SET NOT NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'screenshots_project_id_projects_id_fk'
  ) THEN
    ALTER TABLE screenshots ADD CONSTRAINT screenshots_project_id_projects_id_fk
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END $$;
