-- 0016: Flip the column-level DEFAULT for projects.auto_approve_feature.
--
-- Before: new projects landed with autoApproveFeature=true, which silently
-- auto-baselined every first run for every test variation. This caused the
-- "I never approved this but it's already a baseline" UX confusion that
-- ADR-036 addressed inside the diff-worker. Newly-created projects should
-- match the default users expect — explicit Save-as-baseline on first runs.
--
-- This migration only changes the default for FUTURE inserts. Existing
-- projects keep their stored value: a project that was created at
-- autoApproveFeature=true stays at true and can be flipped per-project in
-- Settings. Anything else would be a behavioral change applied retroactively.

ALTER TABLE "projects" ALTER COLUMN "auto_approve_feature" SET DEFAULT false;
