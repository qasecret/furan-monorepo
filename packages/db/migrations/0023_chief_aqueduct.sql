ALTER TABLE "test_runs" ADD COLUMN "primary_signature" text;--> statement-breakpoint
CREATE INDEX "test_runs_project_primary_sig_idx" ON "test_runs" USING btree ("project_id","primary_signature");