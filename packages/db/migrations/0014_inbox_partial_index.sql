-- Partial index for the inbox.list / inbox.count queries.
-- Covers WHERE project_id IN (...) AND status IN ('unresolved', 'failed')
-- ORDER BY created_at DESC, id DESC. `concurrently` so deploy doesn't lock
-- test_runs; safe to retry if interrupted.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_runs_inbox_idx"
  ON "test_runs" ("project_id", "status", "created_at" DESC, "id" DESC)
  WHERE "status" IN ('unresolved', 'failed');
