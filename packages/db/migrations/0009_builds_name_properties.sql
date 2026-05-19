DROP INDEX "builds_ci_build_id_idx";--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "builds_project_ci_build_id_unique" ON "builds" USING btree ("project_id","ci_build_id") WHERE "builds"."ci_build_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "builds_properties_gin_idx" ON "builds" USING gin ("properties");