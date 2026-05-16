CREATE TYPE "public"."baseline_source" AS ENUM('this_branch', 'parent_pr', 'default_branch');--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"image_key" text NOT NULL,
	"dom_key" text,
	"viewport" text NOT NULL,
	"browser" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diff_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"bbox" jsonb NOT NULL,
	"description" varchar(200) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "baseline_source" "baseline_source";--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "branch_name" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_regions" ADD CONSTRAINT "diff_regions_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diff_regions" ADD CONSTRAINT "diff_regions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "screenshots_image_key_unique" ON "screenshots" USING btree ("image_key");--> statement-breakpoint
CREATE INDEX "screenshots_run_idx" ON "screenshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "diff_regions_run_idx" ON "diff_regions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "diff_regions_project_idx" ON "diff_regions" USING btree ("project_id");