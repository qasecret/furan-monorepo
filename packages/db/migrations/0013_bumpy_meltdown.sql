CREATE TABLE "run_reviewer_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_reviewer_decisions_run_user_uniq" UNIQUE("run_id","user_id"),
	CONSTRAINT "run_reviewer_decisions_decision_chk" CHECK ("run_reviewer_decisions"."decision" IN ('rejected'))
);
--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "run_reviewer_decisions" ADD CONSTRAINT "run_reviewer_decisions_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reviewer_decisions" ADD CONSTRAINT "run_reviewer_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_reviewer_decisions_run_idx" ON "run_reviewer_decisions" USING btree ("run_id");