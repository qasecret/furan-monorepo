ALTER TYPE "public"."image_comparison" ADD VALUE 'vlm';--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "vlm_description" text;