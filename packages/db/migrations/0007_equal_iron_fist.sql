DROP INDEX "screenshots_image_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "screenshots_run_id_viewport_unique" ON "screenshots" USING btree ("run_id","viewport");--> statement-breakpoint
CREATE INDEX "screenshots_image_key_idx" ON "screenshots" USING btree ("image_key");