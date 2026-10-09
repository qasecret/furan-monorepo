-- Review model (spec 2026-10-09-review-flow-approval-safety, section 4.1):
-- per-checkpoint verdicts, the append-only checkpoint_decisions log and the
-- run-level status override. Additive; nothing reads it until the recompute
-- writer lands. The RLS statements at the end are hand-appended (0033 pattern).
-- NOTE: drizzle-kit also re-emitted ADD CONSTRAINT "baselines_variation_run_unique"
-- on "baselines". It is intentionally omitted: 0034 already applied it and it was
-- only missing from 0034's snapshot (the 0035 snapshot records it).
CREATE TYPE "public"."checkpoint_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."checkpoint_verdict" AS ENUM('new', 'passed', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."run_status_override" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TABLE "checkpoint_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"screenshot_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"decision" "checkpoint_decision" NOT NULL,
	"actor_id" uuid,
	"source" text NOT NULL,
	"before" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid,
	CONSTRAINT "checkpoint_decisions_source_chk" CHECK ("checkpoint_decisions"."source" IN ('viewer', 'batch', 'group', 'sdk', 'inbox', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "status_override" "run_status_override";--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "verdict" "checkpoint_verdict";--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "verdict_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkpoint_decisions" ADD CONSTRAINT "checkpoint_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_decisions" ADD CONSTRAINT "checkpoint_decisions_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_decisions" ADD CONSTRAINT "checkpoint_decisions_screenshot_id_screenshots_id_fk" FOREIGN KEY ("screenshot_id") REFERENCES "public"."screenshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_decisions" ADD CONSTRAINT "checkpoint_decisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_decisions" ADD CONSTRAINT "checkpoint_decisions_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoint_decisions_active_uniq" ON "checkpoint_decisions" USING btree ("screenshot_id") WHERE "checkpoint_decisions"."reverted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "checkpoint_decisions_action_idx" ON "checkpoint_decisions" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "checkpoint_decisions_run_idx" ON "checkpoint_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "checkpoint_decisions_project_created_idx" ON "checkpoint_decisions" USING btree ("project_id","created_at" DESC NULLS FIRST);

--> statement-breakpoint
-- checkpoint_decisions: tenant isolation (ADR-058), same project_id predicate as
-- the other direct project_id tables in 0033. New tables are auto-granted to
-- furan_app by 0032's default privileges, so only the policy is needed.
ALTER TABLE "checkpoint_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "checkpoint_decisions_isolation" ON "checkpoint_decisions"
  USING (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()))
  WITH CHECK (app_is_admin() OR "project_id" IN (SELECT app_current_user_projects()));
