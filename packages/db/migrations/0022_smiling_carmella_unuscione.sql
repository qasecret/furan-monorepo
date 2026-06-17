ALTER TABLE "screenshots" ADD COLUMN "diff_signature" text;--> statement-breakpoint
CREATE INDEX "screenshots_diff_signature_idx" ON "screenshots" USING btree ("diff_signature");