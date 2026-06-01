# Restore from backup (Postgres)

This runbook covers Furan's Phase 5 GA backup/restore mechanism: nightly
`pg_dump` of the Furan Postgres database, plus the step-by-step restore
procedure for a metadata-only recovery.

**Targets:**

- **RPO:** ≤24 h (nightly backup; last 24 h of activity lost on restore).
- **RTO:** ≤4 h on metadata, measured from "host accessible" to "API serving
  authenticated requests".

**Scope:** Postgres only. MinIO content bytes, Redis queue state, and secret
keys are out of scope — see [§4 What is NOT backed up](#4-what-is-not-backed-up)
below. Off-host MinIO mirror is deferred to v1.1+ per the Phase 5 cut list
in [furan-design/plan-roadmap.md §7 Phase 5](../../../furan/furan-design/plan-roadmap.md);
see [§6 Off-host mirror — deferred](#6-off-host-mirror--deferred-to-v11).

## 1. Backup strategy

| Property      | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Tool          | `pg_dump --no-owner --no-acl --clean --create` → `gzip`               |
| Schedule      | 03:00 UTC daily (BusyBox `crond` in a `postgres:17-alpine` sidecar)   |
| Output path   | `infra/docker/backups/furan-pg-YYYYMMDD-HHMMSS.sql.gz` (host bind)    |
| Log path      | `infra/docker/backups/backup.log`                                     |
| Retention     | 7 days on-host (anything older than 7 days is deleted at backup time) |
| Off-host sync | Out of scope at v1.0 — configure host-side (rsync / restic / S3)      |

**Note on retention:** the spec originally called for a tiered policy
(7 daily + 4 weekly + 12 monthly). The shipped policy is the simpler
"delete anything older than 7 days" — BusyBox `date` in
`postgres:17-alpine` does not parse the `-d <string>` arg the tiered
policy needs. Long-tier retention belongs in off-host sync (S3 lifecycle
to Glacier, restic snapshot rotation, etc.), not in the container cron.

## 2. Enable the nightly backup sidecar

The backup sidecar lives in a Compose **overlay** so existing
single-Postgres deployments opt in without touching the main `compose.yml`.
It reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` from the
same `.env` the data plane uses — no new secrets.

```bash
cd infra/docker

# Bring up data plane + apps + backup-cron together:
docker compose -f compose.yml -f compose.backup.yml up -d

# Or just the sidecar against an already-running stack:
docker compose -f compose.yml -f compose.backup.yml up -d backup-cron

# Verify:
docker compose -f compose.yml -f compose.backup.yml ps backup-cron
docker compose -f compose.yml -f compose.backup.yml logs backup-cron
# expect: "[init ...Z] crontab installed; backup-cron running (03:00 UTC daily)"
#         "crond: crond (busybox 1.37.0) started, log level 8"
```

### Force a one-shot backup (don't wait for 03:00)

```bash
docker compose -f compose.yml -f compose.backup.yml exec backup-cron \
  /usr/local/bin/backup-pg.sh

ls -lh backups/        # expect: furan-pg-YYYYMMDD-HHMMSS.sql.gz
tail backups/backup.log
```

## 3. Restore procedure

Target RTO: **≤4 hours**. The wall-clock for the actual `pg_restore` step
itself is seconds to minutes (depending on dump size); the rest of the
budget covers host re-provisioning, secret re-issuance, and post-restore
smoke testing.

> **Before you start:** make sure you have a current copy of the dump
> file on the restore host — either from off-host sync, or
> `scp`'d from the old host's `infra/docker/backups/` directory. The
> backup is the only thing that has to come from off-host; everything
> else (compose files, scripts, app images on GHCR) rehydrates from git
> and the registry.

### Step 1 — Stop app containers (keep data plane up)

The data plane (postgres, redis, minio) stays running; we only stop the
services that read/write app state, so the restore is atomic from the
app layer's perspective.

```bash
cd infra/docker
docker compose stop api dashboard capture-worker diff-worker integrations
```

### Step 2 — Identify the dump to restore

```bash
ls -lt backups/furan-pg-*.sql.gz | head -5
```

Pick the most recent unless restoring older state for a specific reason
(e.g. a known-bad migration landed after a specific timestamp).

### Step 3 — Restore

```bash
BACKUP=backups/furan-pg-20260517-030000.sql.gz   # adjust to your file

gunzip -c "$BACKUP" | docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres
```

Notes:

- `-d postgres` (not `-d furan_dev`). The dump was taken with `--clean
--create`, so its first action is `DROP DATABASE furan_dev` followed by
  `CREATE DATABASE furan_dev`. Both must execute against the maintenance
  `postgres` database — `psql` can't drop the database it is connected to.
- `-T` disables TTY allocation on `docker compose exec`, which is required
  when piping stdin.
- Expect a stream of `DROP TABLE / CREATE TABLE / COPY / ALTER TABLE`
  output. The dump exits 0 on success.

### Step 4 — Re-run migrations

The dump captures schema as of the backup moment. If deployed code has
migrations newer than the dump, run them now:

```bash
# Docker-only install (no on-host node toolchain): use the compose
# `migrate` one-shot. Idempotent — only previously-unapplied SQL runs.
docker compose --env-file .env -f infra/docker/compose.yml run --rm migrate

# Dev install with on-host pnpm:
pnpm --filter @furan/db db:migrate
```

### Step 5 — Restart apps + smoke-test

```bash
docker compose start api dashboard capture-worker diff-worker integrations

curl -sf http://127.0.0.1:3000/livez && echo OK
curl -sf http://127.0.0.1:3001/api/healthz && echo OK
```

Then log in via the dashboard at http://localhost:3001/login and confirm
the user list, most-recent project, and most-recent run at
`/projects/<id>/runs` all render. If any check fails, escalate to
`docs/runbooks/api-down.md` (parallel D5 deliverable).

## 4. What is NOT backed up

The v1.0 backup is **Postgres only**. Three categories of state are
intentionally excluded; the restore procedure must compensate for each.

### 4.1 MinIO content bytes (screenshots + diff images)

Image object keys are content-addressed `sha256(bytes)` — the same
screenshot run twice produces the same key. MinIO content is derivative
state, regenerable by re-running CI against the same commits.

**Recovery action:** none required for correctness. Historical diff
thumbnails for _previous_ runs are 404 until a re-run lands. If
regenerating CI history is expensive, `mc mirror` from the old MinIO to
the new is a nice-to-have side-step. The v1.1+ off-host mirror
([§6](#6-off-host-mirror--deferred-to-v11)) closes this properly.

### 4.2 Redis state (queue jobs in flight, Pub/Sub messages)

BullMQ jobs are restart-safe — workers re-pick stalled jobs on boot.
Pub/Sub channels are transient by design. In-flight jobs at the failure
moment are lost. Trade-off is acceptable because:

1. Capture jobs are idempotent by `(buildId, viewport, captureUrl)`; the
   client SDK retries naturally.
2. Diff jobs trigger on `screenshot.created` events. If those events
   never persisted to Postgres, the work was already lost at the data
   layer — Redis isn't the source of truth.

If the loss matters operationally, trigger CI re-runs against the last
known-good build SHAs.

### 4.3 Secret keys (JWT_SECRET, GitHub App private key, webhook signing keys)

Secrets live in `.env` on the host, never in Postgres. A restore to a
fresh host inherits a fresh `.env`. **Required actions on restore:**

- **`JWT_SECRET`**: rotate (`openssl rand -hex 32`). All existing user
  sessions invalidate; users must re-login.
- **`GITHUB_APP_PRIVATE_KEY`**, **`GITHUB_APP_WEBHOOK_SECRET`**: restore
  from password manager / vault if available. If lost, regenerate in the
  GitHub App settings UI; webhooks fail signature verification until the
  customer re-configures.
- **`SLACK_WEBHOOK_URL`**: paste from password manager.
- **MinIO root credentials**: if the MinIO volume survived (named docker
  volume), reuse the originals; otherwise pick new ones and re-init.

## 5. DR test cadence

**Recommendation:** quarterly full-restore rehearsal on a throwaway VM.
Not a v1.0 GA gate (first GA install is the de-facto first rehearsal).

### Methodology for a rehearsal

1. Provision a clean VM matching the target deployment class.
2. `scp` the most recent `furan-pg-*.sql.gz` from prod to the rehearsal
   host.
3. `git clone` the monorepo at the same commit as production.
4. Bring up `compose.yml` (data plane + apps) with a synthetic `.env`
   (no real secrets).
5. Run steps 1–6 of [§3 Restore procedure](#3-restore-procedure).
6. Record wall-clock per step. Compare to RTO target ≤4 h.

### Logged rehearsals

| Date               | Operator   | Dump size | Restore wall-clock | RTO outcome | Notes                                                             |
| ------------------ | ---------- | --------- | ------------------ | ----------- | ----------------------------------------------------------------- |
| 2026-05-17         | maintainer | 4.0 KB    | 0.32 s             | ✅ pass     | Local rehearsal against dev Postgres (empty schema, no app data). |
| _next: GA install_ | _TBD_      | _TBD_     | _TBD_              | _TBD_       | First production-shaped rehearsal.                                |

The 2026-05-17 rehearsal validated mechanics only (the dev Postgres at
the time had an empty schema). The first realistic timing measurement
will come from the first GA install — at which point this table is
updated with a representative production dump size + wall-clock.

## 6. Off-host mirror — deferred to v1.1+

**Status:** deferred at v1.0 GA per the
[Phase 5 cut list](../../../furan/furan-design/plan-roadmap.md) ("defer
off-host MinIO mirror; declare RPO/RTO metadata-only at GA"). v1.0 GA
ships a metadata-only DR contract.

**Rationale:** MinIO bytes are content-addressed (`sha256(image_bytes)`)
and recoverable from CI re-runs. Shipping a hardened off-host mirror at
v1.0 (S3 credential wiring, IAM policy templates, bytes-only restore
docs, lifecycle config) outweighs the benefit for the install-and-dogfood
audience v1.0 targets.

**Re-entry trigger for v1.1+:** first customer ask, OR first incident
where regenerating CI is operationally unacceptable. When triggered, the
v1.1+ design adds an `rclone sync` / `mc mirror` sidecar pushing MinIO
to an off-host S3-compatible bucket on the same nightly cadence as
`pg_dump`, a second restore section here covering "restore MinIO bytes",
and object-lock / bucket-versioning docs for deletion-resistance against
rogue restore-host credentials.

Until then: operators wanting off-host backup today can
`rsync infra/docker/backups/` to a second host on whatever cadence they
prefer — the gzipped pg_dump files are self-contained and portable.

## 7. References

- `infra/docker/compose.backup.yml` — the overlay this runbook enables.
- `infra/docker/scripts/backup-pg.sh` — the actual dump + rotation
  script the sidecar runs.
- Phase 5 cut list in
  [furan-design/plan-roadmap.md §7](../../../furan/furan-design/plan-roadmap.md)
  — authoritative source for the v1.0 metadata-only DR scope.
