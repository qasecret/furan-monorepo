-- 0045: the repository, pull request and commit a run was made for.
--
-- The integrations service posts a sticky pull request comment and the
-- `furan/baselines` commit status when a run completes. For that it needs to
-- know which repository, pull request and commit the run belongs to. The SDK
-- sends them on `POST /runs` (`FURAN_REPO`, `FURAN_PR_NUMBER`,
-- `FURAN_COMMIT_SHA`, or GitHub Actions' own variables) and the api stores them
-- here; the service reads them back by run id.
--
-- repo_owner, repo_name   the `owner/name` slug, split on the slash.
-- pr_number               the pull request number; null for a push build, which
--                         gets a commit status and no comment.
-- commit_sha              the head commit the status goes on, lower-case hex.
--
-- All four are nullable and have no default: a run made before this migration,
-- or by an SDK that sends none of them, simply has nothing to report to GitHub.
-- No backfill, no index (the rows are read by primary key).
--
-- Re-applying this file is safe: each column is added only if missing.
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "repo_owner" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "repo_name" text;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "pr_number" integer;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN IF NOT EXISTS "commit_sha" text;
