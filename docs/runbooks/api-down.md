# api-down runbook

Use when `apps/api` is unhealthy — `/livez` 5xx, `/readyz` 5xx, connection
refused, or the dashboard shows persistent API errors. The first-30-seconds
decision tree below routes you to the right branch; each branch has the
exact command, expected output, and concrete fix.

> The api container has no host port mapping in `compose.yml` or
> `compose.dev.yml` — probe from inside the network via `docker compose
exec`. If you've added `127.0.0.1:3000:3000` to `compose.dev.yml`,
> `curl` from the host works the same.

## First 30 seconds

1. **Probe the health endpoints from inside the compose network:**

   ```bash
   docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
     exec api node -e "fetch('http://127.0.0.1:3000/livez').then(r=>console.log('livez',r.status)).catch(e=>console.log('livez ERR',e.message))"
   docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
     exec api node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text().then(b=>console.log('readyz',r.status,b))).catch(e=>console.log('readyz ERR',e.message))"
   ```

   - Both 200 → API is fine; problem is upstream (dashboard build, reverse
     proxy, browser cache). Jump to **Everything's fine but dashboard errors**.
   - `exec` fails with "container not running" → jump to **Container down**.
   - `livez` 200, `readyz` 503 → a dependency probe failed. Jump to
     **Readyz failing**.
   - `livez` 5xx → process is up but unhealthy. Jump to **Livez failing**.

2. **Check the container state:**

   ```bash
   docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml ps api
   docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml logs api --tail=100
   ```

## Container down (Exited / Restarting)

Common causes by frequency:

- **`Error: Invalid environment` (Zod validation)** — the api fails closed
  at boot. The only vars without defaults are `DATABASE_URL` and
  `JWT_SECRET` (≥32 chars). `S3_*` / `REDIS_URL` have dev defaults pointing
  at `localhost:*`, which is wrong inside the compose network — they MUST
  be overridden via compose `environment` (already wired in `compose.yml`).
  Confirm `.env` exists at the repo root and exports `POSTGRES_USER/PASSWORD/DB`,
  `MINIO_ROOT_USER/PASSWORD`, `MINIO_BUCKET`, and `JWT_SECRET`. Compare against
  `.env.example`, then `docker compose ... up -d api`.

- **`ECONNREFUSED postgres:5432` at boot** — Postgres unreachable when
  `@furan/db` tries its first connection. Fix:

  ```bash
  docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml ps postgres
  docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml logs postgres --tail=20
  docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml exec postgres pg_isready -U "$POSTGRES_USER"
  ```

  If Postgres is `Exited`: `docker compose ... restart postgres`, wait ~5s
  for the healthcheck to flip green, then `docker compose ... restart api`.
  (`depends_on: condition: service_healthy` gates initial bring-up but a
  manual restart races past it.)

- **`Cannot find module 'X'`** — image built from a broken `pnpm install`.
  Don't `docker compose build` locally; pull a known-good per-SHA GHCR
  tag instead — see **Rollback procedure**.

- **`Address already in use`** — only possible if someone added a host
  port mapping. Find the squatter: `lsof -iTCP:3000 -sTCP:LISTEN`. Kill
  it or change the host-side port in `compose.dev.yml`.

## Livez failing (5xx, but process up)

`/livez` is intentionally trivial — `return { status: "ok" }`. A non-2xx
response means Fastify itself can't service the request:

- **Telemetry SDK blocking** — if `OTLP_ENDPOINT` is set but the collector
  is unreachable, the OTel BatchSpanProcessor may stall the event loop.
  Check logs for OTel errors. Quickfix: unset `OTLP_ENDPOINT` in `.env`
  and `docker compose ... up -d api`.

- **Postgres pool exhausted** — log symptom: `remaining connection slots
are reserved`. Fix: restart api to drop pooled connections; investigate:

  ```bash
  docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
    exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT count(*), application_name FROM pg_stat_activity GROUP BY application_name;"
  ```

- **Memory pressure / OOM** — distroless image hit its cgroup limit.
  Check `docker stats $(docker compose -f infra/docker/compose.yml ps -q api) --no-stream`.
  Fix: add `mem_limit` to the api service in `compose.yml`.

## Readyz failing (livez OK, readyz 5xx)

`/readyz` probes Postgres + Redis + S3 with 1s timeouts each and returns
`{ "checks": { "postgres": ..., "redis": ..., "s3": ... } }`. Each value
is `"ok"` on success or the underlying error message (`"timeout"`, an
`ECONNREFUSED`, etc.) on failure. Inspect the JSON:

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
  exec api node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
# expect on healthy:
# { "checks": { "postgres": "ok", "redis": "ok", "s3": "ok" } }
# any non-"ok" string → that's your culprit
```

- **`postgres` not "ok"** — see Postgres steps in **Container down**.
  If the error is `"timeout"` (not `ECONNREFUSED`), Postgres is up but
  slow; check `pg_stat_activity` for long-running queries.

- **`redis` not "ok"** — same shape: `docker compose ... ps redis`,
  `... logs redis --tail=20`, `... exec redis redis-cli ping`. Common
  cause: Redis OOM under sustained queue load. Fix: set
  `maxmemory-policy allkeys-lru` + a `maxmemory` ceiling via `command:`
  in `compose.yml`.

- **`s3` not "ok"** — MinIO unreachable or bucket missing. The probe calls
  `head("__furan_readyz_sentinel__")` against `S3_BUCKET`; missing bucket
  surfaces as `NoSuchBucket`. Verify with `docker compose ... exec minio
mc ls local/` — expect `<MINIO_BUCKET>/` in the listing. If the bucket
  is missing, the `minio-init` one-shot failed at first boot; rerun
  `docker compose ... up -d minio-init` and check its logs.

## Everything's fine but dashboard errors

If `/livez` + `/readyz` both 200 but the dashboard surfaces errors, the
problem is at a layer above the api:

- **`NEXT_PUBLIC_API_URL` mismatch** — the dashboard image is built with
  `NEXT_PUBLIC_API_URL` inlined at compile time (Next.js semantics). If
  the browser is trying to reach an old hostname, rebuild/repull the
  dashboard image with the right value. See `docs/install/quickstart.md`
  §6.

- **`JWT_SECRET` rotation drift** — the api validates JWTs with whatever
  `JWT_SECRET` is currently in its env. If you rotated the secret without
  restarting api, or rotated only some services, every token signed with
  the old secret now fails verification. Fix: confirm a single
  `JWT_SECRET` is exported everywhere it's consumed, restart api, and
  have users re-login.

- **Schema drift** — a deploy bumped the api image past a migration that
  hasn't been applied. The compose `migrate` one-shot normally runs before
  api on `up -d`; if it's been skipped (e.g. an `up -d api` that ignored
  service dependencies), run it explicitly:

  ```bash
  # Docker-only install:
  docker compose --env-file .env -f infra/docker/compose.yml run --rm migrate

  # Dev install with on-host pnpm:
  pnpm --filter @furan/db exec drizzle-kit migrate
  ```

  If the migration itself fails mid-flight, see
  [restore-from-backup.md](./restore-from-backup.md).

- **Stale image** — somebody ran `docker compose pull` against an old
  pinned tag. Confirm the tag in `compose.yml` matches the release you
  intended, then `docker compose ... pull api && docker compose ... up -d api`.

## Triage time budget

| Symptom                                        | Resolution target | Escalate at |
| ---------------------------------------------- | ----------------- | ----------- |
| Container Exited with clear env error          | 2 min             | 10 min      |
| Postgres / Redis / MinIO restart needed        | 5 min             | 15 min      |
| Schema drift requiring migration               | 10 min            | 30 min      |
| Postgres data corruption                       | see DR runbook    | n/a         |
| **Total triage time before rollback decision** | n/a               | **30 min**  |

At the 30-minute mark, stop debugging forward and **roll back** to the
previous known-good image, then file a follow-up issue with the logs you
gathered.

## Rollback procedure

```bash
# List recent main-branch image builds (each push tags ghcr.io/qasecret/furan-api:<sha>):
gh run list --workflow=build-images.yml --branch=main --limit 10

# Pick a <sha> from a successful run, then edit infra/docker/compose.yml:
#   image: ghcr.io/qasecret/furan-api:0.5.0
# becomes:
#   image: ghcr.io/qasecret/furan-api:<sha>

docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml pull api
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml up -d api

# Verify rollback recovered the service:
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
  exec api node -e "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1))" \
  && echo "rollback OK"
```

## See also

- [restore-from-backup.md](./restore-from-backup.md) — Postgres data recovery
- [alpha-install.md](./alpha-install.md) — first-time install (env vars + compose bring-up)
- [maven-central-publish.md](./maven-central-publish.md) — SDK release flow
