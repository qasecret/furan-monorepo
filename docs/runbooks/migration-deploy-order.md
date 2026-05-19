# Deploy order for schema-narrowing migrations

This runbook covers the deploy sequence for migrations that **narrow** an existing column's accepted values — for example converting a free-form `text` column to a Postgres `enum`. The first concrete instance is migration `0008_run_status_enum.sql` (PR #47, `f25e5f2`), which replaces `test_runs.status text` with `run_status` enum and remaps legacy `'failed'` rows to `'unresolved'`. The pattern applies to any future migration of the same shape.

**Targets:**

- **Zero data loss.** The migration's `CASE` clause must catch every legacy value; the runbook keeps old writers from emitting post-narrowing-illegal values during the deploy window.
- **No `23514` enum-constraint violations** in logs during deploy.
- **<5 minutes** of writer downtime on a single-host self-hosted install. Multi-replica installs can roll workers one at a time with longer windows.

## 1. Why deploy order matters

The migration narrows the set of values the column accepts. Old worker images (running the previous release) may emit values that the migration no longer allows. Concretely for `0008`:

- Old diff-worker writes `status = 'failed'` on diff-found. New enum only contains `'failed'` for reviewer-rejected states; the old writer's value is **still in the enum**, so the row inserts cleanly — but it lands with the wrong semantic (operators will see "Failed" when they should see "Unresolved").
- Old code did not write `'running'`, `'aborted'`, `'empty'`, `'unresolved'`. Those values are new with this release.
- If a future migration adds an enum value AND removes an old one in a single step, an old worker writing the removed value would hit a `23514 check constraint violated` error and the job would fail.

The safe order is: **stop the writers → run the migration → start the new writers.** Doing it in the other order risks either semantic drift (old writers writing newly-meaningful values) or `23514` errors (old writers writing newly-illegal values).

## 2. Procedure — single-host Compose (default install)

This is the canonical path for the v1.0 Compose install on a Hetzner-AX52-class host.

```bash
cd infra/docker

# 1. Snapshot the database before any change.
docker compose exec postgres pg_dump \
  -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "../backups/pre-migration-$(date +%Y%m%d-%H%M%S).sql.gz"

# 2. Stop only the writers (api + workers). Postgres, Redis, MinIO stay up.
docker compose stop api capture-worker diff-worker integrations

# 3. Confirm the queue is drained (no in-flight jobs to land bad values).
docker compose exec redis redis-cli LLEN bull:capture:wait
docker compose exec redis redis-cli LLEN bull:diff:wait
docker compose exec redis redis-cli LLEN bull:capture:active
docker compose exec redis redis-cli LLEN bull:diff:active
# All four must return 0 (or be small enough that you're willing to lose them).
# If any active jobs remain, let them complete with the OLD image before stopping
# — kill them only as a last resort (they'll restart on the new image but with
# whatever partial state they left behind).

# 4. Update image tags in compose.yml to the new release (the squash commit
# itself doesn't change tags; you bump them in a follow-up commit on main).
# Example pattern (single tag-replace per service):
sed -i.bak 's|qasecret/furan-api:v1.0.X|qasecret/furan-api:v1.0.Y|g' compose.yml
sed -i.bak 's|qasecret/furan-capture-worker:v1.0.X|qasecret/furan-capture-worker:v1.0.Y|g' compose.yml
sed -i.bak 's|qasecret/furan-diff-worker:v1.0.X|qasecret/furan-diff-worker:v1.0.Y|g' compose.yml
sed -i.bak 's|qasecret/furan-integrations:v1.0.X|qasecret/furan-integrations:v1.0.Y|g' compose.yml
sed -i.bak 's|qasecret/furan-dashboard:v1.0.X|qasecret/furan-dashboard:v1.0.Y|g' compose.yml
rm compose.yml.bak

# 5. Pull the new images.
docker compose pull api capture-worker diff-worker integrations dashboard

# 6. Run the migration against the live Postgres. The api image carries the
# Drizzle migrator; running `migrate` once is enough — all services share one DB.
docker compose run --rm api pnpm --filter @furan/db exec drizzle-kit migrate

# 7. Verify the new enum is in place and rows were remapped.
docker compose exec postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c \
  "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'run_status'::regtype ORDER BY enumsortorder;"
# Expected: new, running, passed, unresolved, failed, aborted, empty
docker compose exec postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c \
  "SELECT status, COUNT(*) FROM test_runs GROUP BY status ORDER BY 2 DESC LIMIT 20;"
# Confirm: no rows still labelled 'ok', 'OK', or anything outside the enum.

# 8. Start the new writers.
docker compose up -d api capture-worker diff-worker integrations dashboard

# 9. Verify the new writers are healthy.
for svc in api capture-worker diff-worker integrations; do
  echo "--- $svc"
  docker compose exec "$svc" wget -qO- http://localhost:3000/livez || echo "no /livez"
done
# (Some services bind to different ports; check `compose.yml` if you see "no /livez".)

# 10. Spot-check that new statuses appear under load. Trigger one CI run
# from a test project; confirm the run-row shows the new badge colours and
# the GitHub commit-status reads "Furan: visual differences — review required"
# on an Unresolved run.
```

**Total downtime budget:** ~3-5 minutes on the v1.0 single-host install. Steps 2–8 are the writer-down window; queue drain in step 3 is the variable.

## 3. Procedure — multi-replica / K8s (v1.1+)

K8s + Helm path is deferred to v1.1+ per `furan-design/plan-roadmap.md §7.1`. When it lands, the equivalent procedure is:

1. Cordon traffic at the ingress (optional; reduces enqueue rate).
2. Run the migration as a `Job` resource (one-shot pod with the api image).
3. Confirm the enum is in place (step 7 above).
4. Rolling-restart the writer Deployments (`api`, `capture-worker`, `diff-worker`, `integrations`). Each pod must come up on the new image **after** the migration has landed, never before.
5. Uncordon ingress.

If your install runs writers across multiple hosts, the simplest discipline is "drain all writers → migrate → bring writers back up". Mixed-version writers across the migration boundary are the failure mode this runbook prevents.

## 4. Rollback

The migration is forward-only by repo convention. If a rollback is needed:

1. Stop the writers (step 2 above).
2. Restore Postgres from the snapshot taken in step 1: `gunzip < backups/pre-migration-….sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"`.
3. Revert `compose.yml` image tags to the prior version.
4. `docker compose up -d`.

This drops every run created between the snapshot and the rollback. The forward-only convention exists because backward-compat migrations roughly double schema-change cost; if you find yourself rolling back regularly, raise an ADR.

## 5. What to watch for in logs

For 0008 specifically, the symptom of a botched deploy order is:

- **`23514 new row for relation "test_runs" violates check constraint`** in api or worker logs → an old writer is alive against the new schema. Stop that writer immediately; redo step 8 with the right image.
- **Slack notifier silent for `aborted`/`empty` runs** → the workers may be on the old image (these statuses are only emitted by the new code; if the dashboard shows them but Slack doesn't fire, check that the diff-worker / capture-worker images are on the new tag too).
- **GitHub commit-status stays `pending` for `aborted` runs** → same diagnosis. The publish for these terminal states only exists in the new image (commit `bc766d0`).

## 6. References

- Migration: [`packages/db/migrations/0008_run_status_enum.sql`](../../packages/db/migrations/0008_run_status_enum.sql)
- Spec: [`furan-design/specs/2026-05-19-run-status-enum-design.md`](../../furan-design/specs/2026-05-19-run-status-enum-design.md) (gitignored design dir)
- Plan: [`furan-design/plans/2026-05-19-run-status-enum.md`](../../furan-design/plans/2026-05-19-run-status-enum.md) (gitignored design dir)
- PR #47: `feat: Applitools-aligned 7-status run lifecycle`
- Related runbooks: [`restore-from-backup.md`](restore-from-backup.md) for snapshot procedure details.
