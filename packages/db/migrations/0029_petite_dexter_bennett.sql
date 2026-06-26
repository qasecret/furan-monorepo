CREATE TYPE "public"."auto_rule_action" AS ENUM('auto_approve', 'flag');--> statement-breakpoint
CREATE TYPE "public"."resolution_source" AS ENUM('rule');--> statement-breakpoint
CREATE TABLE "auto_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match" jsonb NOT NULL,
	"conditions" jsonb,
	"action" "auto_rule_action" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auto_rule_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"test_run_id" uuid NOT NULL,
	"diff_region_id" uuid NOT NULL,
	"region_diff_pct" real NOT NULL,
	"severity" integer NOT NULL,
	"won" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "resolution_source" "resolution_source";--> statement-breakpoint
ALTER TABLE "diff_regions" ADD COLUMN "resolved_by_application_id" uuid;--> statement-breakpoint
ALTER TABLE "auto_rules" ADD CONSTRAINT "auto_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rules" ADD CONSTRAINT "auto_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rules" ADD CONSTRAINT "auto_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rule_applications" ADD CONSTRAINT "auto_rule_applications_rule_id_auto_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."auto_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rule_applications" ADD CONSTRAINT "auto_rule_applications_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rule_applications" ADD CONSTRAINT "auto_rule_applications_diff_region_id_diff_regions_id_fk" FOREIGN KEY ("diff_region_id") REFERENCES "public"."diff_regions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_rules_project_enabled_idx" ON "auto_rules" USING btree ("project_id","enabled") WHERE "auto_rules"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auto_rules_project_deleted_idx" ON "auto_rules" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "auto_rule_applications_test_run_idx" ON "auto_rule_applications" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "auto_rule_applications_diff_region_idx" ON "auto_rule_applications" USING btree ("diff_region_id");--> statement-breakpoint
CREATE INDEX "auto_rule_applications_rule_idx" ON "auto_rule_applications" USING btree ("rule_id");