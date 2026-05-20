ALTER TABLE "projects" ADD COLUMN "dynamic_text_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "diff_regions" ADD COLUMN "ocr_text" text;--> statement-breakpoint
ALTER TABLE "diff_regions" ADD COLUMN "ocr_matched" boolean;