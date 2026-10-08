-- ADR-058 Release N+1, Migration B: ENABLE ROW LEVEL SECURITY + tenant-isolation
-- policies. Safe by default: the owner role (workers, CLIs, migrations, and the
-- API when DATABASE_URL_APP is unset) BYPASSES RLS, so nothing changes until an
-- operator points the API at the non-owner `furan_app` role. Reversible per
-- table (DROP POLICY + DISABLE ROW LEVEL SECURITY).
--
-- Predicate helpers (migration 0032): app_is_admin() → owner/admin bypass;
-- app_current_user_projects() → the caller's member project ids (SECURITY
-- DEFINER, reads project_members bypassing RLS to avoid policy recursion).

--> statement-breakpoint
-- projects: keyed by `id` (not project_id).
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "projects_isolation" ON "projects"
  USING (app_is_admin() OR "id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
-- project_members: a caller sees their own rows + co-members of shared projects.
-- The definer function breaks the self-reference recursion.
ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "project_members_isolation" ON "project_members"
  USING (
    app_is_admin()
    OR "user_id" = app_current_user_id()
    OR "project_id" IN (SELECT app_current_user_projects())
  )
  WITH CHECK (
    app_is_admin() OR "project_id" IN (SELECT app_current_user_projects())
  );
--> statement-breakpoint
-- Direct project_id tables.
ALTER TABLE "builds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "builds_isolation" ON "builds"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
ALTER TABLE "test_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "test_runs_isolation" ON "test_runs"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
ALTER TABLE "screenshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "screenshots_isolation" ON "screenshots"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
ALTER TABLE "diff_regions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "diff_regions_isolation" ON "diff_regions"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
ALTER TABLE "test_variations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "test_variations_isolation" ON "test_variations"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
ALTER TABLE "auto_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "auto_rules_isolation" ON "auto_rules"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
--> statement-breakpoint
-- Join-based tables: no project_id column — scope via the RLS-protected parent,
-- so isolation composes (the parent subquery is itself filtered to the caller).
ALTER TABLE "baselines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "baselines_isolation" ON "baselines"
  USING (
    app_is_admin()
    OR "test_variation_id" IN (SELECT "id" FROM "test_variations")
  )
  WITH CHECK (
    app_is_admin()
    OR "test_variation_id" IN (SELECT "id" FROM "test_variations")
  );
--> statement-breakpoint
ALTER TABLE "auto_rule_applications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "auto_rule_applications_isolation" ON "auto_rule_applications"
  USING (app_is_admin() OR "rule_id" IN (SELECT "id" FROM "auto_rules"))
  WITH CHECK (app_is_admin() OR "rule_id" IN (SELECT "id" FROM "auto_rules"));
