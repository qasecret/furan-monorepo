#!/bin/sh
# Idempotent Drizzle migration runner for the docker-compose install path.
#
# The published api image (qasecret/furan-api) is a distroless --prod build:
# `pnpm` and `drizzle-kit` are not present, so the host-side `drizzle-kit
# migrate` cannot run inside it. This script applies every SQL file in
# /migrations/ in order via psql, tracking applied migrations in the same
# `drizzle.__drizzle_migrations` table that drizzle-kit uses so a future
# host-side `drizzle-kit migrate` is a no-op.
#
# Required env (set on the compose service):
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE
#
# Mounts:
#   /migrations  → packages/db/migrations (bind, ro)

set -eu

PSQL="psql -v ON_ERROR_STOP=1"

echo "migrate: ensuring drizzle journal table"
$PSQL -tAc "CREATE SCHEMA IF NOT EXISTS drizzle;" >/dev/null
$PSQL -tAc "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);" >/dev/null

applied=0
skipped=0

for f in /migrations/*.sql; do
  [ -e "$f" ] || { echo "migrate: no .sql files at /migrations"; exit 1; }
  name=$(basename "$f")
  hash=$(sha256sum "$f" | awk '{print $1}')
  exists=$($PSQL -tAc "SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = '$hash' LIMIT 1;")
  if [ "$exists" = "1" ]; then
    echo "migrate: skip $name (already applied)"
    skipped=$((skipped + 1))
  else
    echo "migrate: apply $name"
    $PSQL -f "$f" >/dev/null
    ts=$(date +%s)000
    $PSQL -tAc "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$hash', $ts);" >/dev/null
    applied=$((applied + 1))
  fi
done

echo "migrate: done (applied=$applied skipped=$skipped)"
