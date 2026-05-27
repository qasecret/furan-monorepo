-- Partial index for inbox.list / inbox.count queries.
-- Covers WHERE project_id IN (...) AND status IN ('unresolved', 'failed')
-- ORDER BY created_at DESC, id DESC. v1 uses a plain (non-concurrent) build;
-- the dev/prod test_runs tables are small enough that a brief lock at deploy
-- time is negligible. When the table grows past ~1M rows, switch to
-- CREATE INDEX CONCURRENTLY in a maintenance window (manual op step,
-- documented in docs/runbooks/).
CREATE INDEX IF NOT EXISTS "test_runs_inbox_idx"
  ON "test_runs" ("project_id", "status", "created_at" DESC, "id" DESC)
  WHERE "status" IN ('unresolved', 'failed');
