#!/bin/sh
# Phase 5 D4 — nightly pg_dump of furan Postgres.
# Invoked from infra/docker/compose.backup.yml's backup-cron container via crond.
#
# Output: /backups/furan-pg-YYYYMMDD-HHMMSS.sql.gz (gzip-compressed plain SQL).
# Restore: see docs/runbooks/restore-from-backup.md.
#
# Env (provided by compose.backup.yml):
#   POSTGRES_HOST  (default: postgres)
#   POSTGRES_PORT  (default: 5432)
#   POSTGRES_USER  (required)
#   POSTGRES_DB    (required)
#   PGPASSWORD     (required — pg_dump reads this directly; not committed)

set -eu

TS=$(date -u +%Y%m%d-%H%M%S)
OUT="/backups/furan-pg-${TS}.sql.gz"

echo "[$(date -u +%FT%TZ)] backup start -> ${OUT}"

# --clean --create produces a self-contained restore script: the dump drops
# and re-creates the target database before loading rows. Restore command in
# the runbook pipes this into `psql -d postgres` (note: -d postgres, not -d
# furan_dev — the dump file issues its own CREATE DATABASE).
#
# --no-owner / --no-acl strip ownership + GRANTs so the dump restores cleanly
# under a different role (e.g. when restoring to a fresh host whose Postgres
# superuser name differs).
pg_dump \
  --host="${POSTGRES_HOST:-postgres}" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="${POSTGRES_USER}" \
  --dbname="${POSTGRES_DB}" \
  --no-owner --no-acl --clean --create \
  | gzip > "${OUT}"

SIZE=$(ls -lh "${OUT}" | awk '{print $5}')
echo "[$(date -u +%FT%TZ)] backup wrote ${OUT} (${SIZE})"

# Rotation: delete dumps older than 7 days. Simpler than the spec's
# 7-daily + 4-weekly + 12-monthly tiered policy because BusyBox `date`
# in postgres:17-alpine does not support `-d <string>` for the
# day-of-week parse the tiered policy needs. The runbook documents
# this simplification; off-host sync (rsync to a second host, S3
# Glacier with lifecycle, etc.) is where longer-tier retention lives.
find /backups -name "furan-pg-*.sql.gz" -type f -mtime +7 -print -delete

echo "[$(date -u +%FT%TZ)] backup done"
