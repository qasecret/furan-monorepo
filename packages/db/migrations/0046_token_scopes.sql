-- 0046: API token scopes, project binding and expiry (ADR-064 step B).
--
-- scopes        what the token may do: `sdk` (SDK/CI uploads and reads), `read`
--               (reads only) or `legacy`. New tokens default to `sdk`.
-- project_id    the one project the token works on; NULL = every project the
--               owner is a member of. Deleting the project deletes its tokens.
-- expires_at    after this the token is refused (401 token_expired); NULL =
--               never expires, which the api mints only when the operator
--               allows it (FURAN_PAT_MAX_LIFETIME_DAYS=0).
-- last_used_ip  the client address of the last use, stamped with
--               last_used_at (at most once a minute).
--
-- Backfill: every existing token becomes `legacy`. A legacy token keeps the
-- step-A behaviour (the owner's projects, admin membership bypass, any
-- approve) and expires 90 days after this migration runs, so CI keeps working
-- while owners replace it with a scoped token. The dashboard shows the date.
ALTER TABLE "tokens" ADD COLUMN "scopes" text[] DEFAULT '{"sdk"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "last_used_ip" "inet";--> statement-breakpoint
UPDATE "tokens" SET "scopes" = '{"legacy"}', "expires_at" = now() + interval '90 days';--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tokens_project_id_idx" ON "tokens" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_scopes_chk" CHECK (cardinality("tokens"."scopes") > 0 AND "tokens"."scopes" <@ ARRAY['legacy', 'sdk', 'read']::text[]);
