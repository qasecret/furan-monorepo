ALTER TABLE "test_variations" ALTER COLUMN "match_level" SET DEFAULT 'Strict';--> statement-breakpoint
ALTER TABLE "screenshots" ALTER COLUMN "match_level" SET DEFAULT 'Strict';--> statement-breakpoint
ALTER TABLE "diff_regions" ADD COLUMN "screenshot_id" uuid;--> statement-breakpoint
ALTER TABLE "diff_regions" ADD CONSTRAINT "diff_regions_screenshot_id_screenshots_id_fk" FOREIGN KEY ("screenshot_id") REFERENCES "public"."screenshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diff_regions_screenshot_idx" ON "diff_regions" USING btree ("screenshot_id");