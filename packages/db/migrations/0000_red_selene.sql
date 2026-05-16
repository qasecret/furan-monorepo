CREATE TYPE "public"."environment" AS ENUM('default', 'staging', 'prod');--> statement-breakpoint
CREATE TYPE "public"."image_comparison" AS ENUM('pixelmatch', 'looks_same', 'odiff');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'editor', 'guest');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"hashed_password" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"role" "user_role" DEFAULT 'guest' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"main_branch_name" text DEFAULT 'main' NOT NULL,
	"builds_counter" integer DEFAULT 0 NOT NULL,
	"max_build_allowed" integer DEFAULT 100 NOT NULL,
	"max_branch_lifetime" integer DEFAULT 30 NOT NULL,
	"auto_approve_feature" boolean DEFAULT true NOT NULL,
	"image_comparison" "image_comparison" DEFAULT 'pixelmatch' NOT NULL,
	"image_comparison_config" text DEFAULT '{"threshold":0.1,"ignoreAntialiasing":true,"allowDiffDimensions":false}' NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"diff_threshold" double precision DEFAULT 0.001 NOT NULL,
	"l2_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_user_project_unique" UNIQUE("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ci_build_id" text,
	"number" integer,
	"branch_name" text,
	"status" text,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"is_running" boolean DEFAULT false NOT NULL,
	"environment" "environment" DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_variations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"branch_name" text,
	"browser" text,
	"device" text,
	"os" text,
	"viewport" text,
	"custom_tags" text,
	"baseline_name" text,
	"ignore_areas" text,
	"project_id" uuid NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_name" text,
	"diff_name" text,
	"diff_percent" double precision,
	"diff_tollerance_percent" double precision,
	"pixel_mis_match_count" integer,
	"status" text,
	"build_id" uuid NOT NULL,
	"test_variation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"merge" boolean DEFAULT false NOT NULL,
	"name" text,
	"browser" text,
	"device" text,
	"os" text,
	"viewport" text,
	"custom_tags" text,
	"baseline_name" text,
	"comment" text,
	"branch_name" text,
	"baseline_branch_name" text,
	"ignore_areas" text,
	"temp_ignore_areas" text,
	"environment" "environment" DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"baseline_name" text,
	"test_variation_id" uuid NOT NULL,
	"test_run_id" uuid NOT NULL,
	"user_id" uuid,
	"environment" "environment" DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_hash" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"last_status" text
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_variations" ADD CONSTRAINT "test_variations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_test_variation_id_test_variations_id_fk" FOREIGN KEY ("test_variation_id") REFERENCES "public"."test_variations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_test_variation_id_test_variations_id_fk" FOREIGN KEY ("test_variation_id") REFERENCES "public"."test_variations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_project_id_idx" ON "project_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tokens_user_id_idx" ON "tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "builds_project_id_idx" ON "builds" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "builds_ci_build_id_idx" ON "builds" USING btree ("project_id","ci_build_id");--> statement-breakpoint
CREATE INDEX "test_variations_project_id_idx" ON "test_variations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_runs_project_id_idx" ON "test_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_runs_build_id_idx" ON "test_runs" USING btree ("build_id");--> statement-breakpoint
CREATE INDEX "test_runs_test_variation_id_idx" ON "test_runs" USING btree ("test_variation_id");--> statement-breakpoint
CREATE INDEX "baselines_test_variation_id_idx" ON "baselines" USING btree ("test_variation_id");--> statement-breakpoint
CREATE INDEX "baselines_test_run_id_idx" ON "baselines" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "webhooks_project_id_idx" ON "webhooks" USING btree ("project_id");