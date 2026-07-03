# Runbook — production deploy (Docker Compose, v1.1.x)

> **Audience:** an operator standing up a self-hosted Furan instance from the
> published app images on a single host, or refreshing an existing one.
> **Scope:** the `docker compose -f infra/docker/compose.yml up -d` install
> path — data plane (Postgres + Redis + MinIO) **and** the five app services,
> all from pre-built images. This is the path users run; it is **not** the
> `pnpm dev` host-process flow (see [`docs/install/quickstart.md`](../install/quickstart.md)
> for that).

This runbook was written/verified during the 2026-06-24 fresh-deploy QA walk.
See the companion [E2E verification report](e2e-verification-2026-06-24.md).

---

## 0. The one rule that bites everyone: image ↔ migration lockstep

**The app image tag and the migrations applied to Postgres MUST come from the
same commit.** This is the single most important fact in this runbook.

`compose.yml` is two things glued together:

- **App services** (`api`, `dashboard`, `capture-worker`, `diff-worker`,
  `integrations`) run a **pinned, pre-built image tag** (e.g.
  `qasecret/furan-api:v1.1.22`).
- The **`migrate` one-shot** service bind-mounts
  `../../packages/db/migrations` — i.e. it applies **whatever migrations are
  in your local checkout**, not what shipped inside the image.

If your checkout's migrations have advanced past the pinned image tag, a fresh
`up -d` applies the **new** schema and then runs the **old** app code against
it. The app 500s on the first query touching a changed table.

**Concrete failure seen on 2026-06-24:** `compose.yml` pinned `v1.1.22`, but
the working tree was 38 commits / 8 migrations ahead. Migration
`0024_slim_hulk.sql` drops `projects.l2_enabled` (ADR-047 L2-tier deletion),
which the v1.1.22 image still queries:

```
PostgresError: column "l2_enabled" of relation "projects" does not exist
```

Health checks (`/livez`, `/readyz`) **still passed** — they don't touch the
drifted tables — so the stack looked green while every project operation 500'd.

### How to stay in lockstep

Pick **one** of these before `up -d`:

1. **Deploy at a release tag** (recommended for end users): `git checkout
v1.1.x` so the migrations match the image pinned in that tagged
   `compose.yml`. This is exactly what an installer following the release gets.
2. **Pin the image to your checkout** (for deploying current `main` / a branch):
   override the five image tags to a published build of the **same commit** as
   your migrations. The repo publishes commit-SHA-tagged images for `main`. Save
   a **local** overlay at `infra/docker/compose.main-images.yml` (kept local, not
   committed — it pins a moving SHA) and add `-f infra/docker/compose.main-images.yml`
   to the §3 commands. Pin all five to one published `main` SHA
   (`git rev-parse origin/main`):

   ```yaml
   # Replace PASTE_SHA with a published origin/main commit (e.g. `git rev-parse origin/main`).
   services:
     api: { image: docker.io/qasecret/furan-api:PASTE_SHA }
     capture-worker:
       { image: docker.io/qasecret/furan-capture-worker:PASTE_SHA }
     diff-worker: { image: docker.io/qasecret/furan-diff-worker:PASTE_SHA }
     integrations: { image: docker.io/qasecret/furan-integrations:PASTE_SHA }
     dashboard: { image: docker.io/qasecret/furan-dashboard:PASTE_SHA }
   ```

3. **Build images from your checkout**: `docker build` all five from
   `apps/*/Dockerfile` and reference the local tags (see
   `infra/docker/compose.all-local.yml`). Slowest; only needed when no
   published image matches your commit.

> **Maintainer note:** the symptom above means the **semver app-image release
> is lagging `main`**. Cutting a new `v1.1.x` (bump the five tags in
> `compose.yml`, tag, let `build-images.yml` publish) restores option 1 for
> everyone. Until then, a fresh deploy from current `main` requires option 2/3.

---

## 1. Prerequisites

| Tool   | Version             | Notes                                      |
| ------ | ------------------- | ------------------------------------------ |
| Docker | 24+ with Compose v2 | verified on 28.0.4                         |
| Disk   | ~6 GB for images    | `capture-worker` alone is ~4 GB (chromium) |
| RAM    | ~4 GB               | single-tenant host                         |

A configured `infra/docker/.env` (see [§2](#2-configure-env)).

## 2. Configure `.env`

`infra/docker/.env` drives the stack. The required keys (copy from
[`.env.example`](../../.env.example) and fill in):

```bash
POSTGRES_USER=furan
POSTGRES_PASSWORD=<high-entropy>
POSTGRES_DB=furan
MINIO_BUCKET=furan
MINIO_ROOT_USER=furan
MINIO_ROOT_PASSWORD=<high-entropy>
JWT_SECRET=<openssl rand -hex 32 — api fails closed if <32 chars>
JWT_EXPIRY=7d
# Optional first-admin bootstrap: seeded ONLY when the users table is empty.
FURAN_BOOTSTRAP_ADMIN_EMAIL=admin@local.test
FURAN_BOOTSTRAP_ADMIN_PASSWORD=<strong>
FURAN_DASHBOARD_ORIGIN=http://localhost:3001
COMPOSE_PROFILES=s3          # REQUIRED — gates MinIO + minio-init (PR #117)
```

> `COMPOSE_PROFILES=s3` is mandatory in S3 mode — without it MinIO never
> starts and the api fails to dial it. HDD-mode installs use
> `COMPOSE_PROFILES=hdd` + `STORAGE_KIND=hdd` + `HDD_ROOT=...` instead — see
> [`storage-backends.md`](storage-backends.md).

## 3. Deploy

> **Project name matters.** Compose derives the project name from the compose
> file's directory (`docker`). Run with `-p docker` (or from `infra/docker/`)
> so you replace the existing stack instead of forking a second one. Use
> `--env-file` because `.env` lives next to the compose file, not in `cwd`.

```bash
# From the repo root. Add the main-images overlay per §0 option 2 if the
# semver pin in compose.yml lags your checkout's migrations.
docker compose -p docker --env-file infra/docker/.env \
  -f infra/docker/compose.yml \
  -f infra/docker/compose.main-images.yml \
  pull

docker compose -p docker --env-file infra/docker/.env \
  -f infra/docker/compose.yml \
  -f infra/docker/compose.main-images.yml \
  up -d
```

Boot order is enforced by `depends_on`: data plane → `minio-init` (bucket) →
`migrate` (one-shot, `service_completed_successfully`) → app services. The
api auto-seeds the bootstrap admin when the `users` table is empty.

## 4. Verify

```bash
P="docker compose -p docker --env-file infra/docker/.env -f infra/docker/compose.yml -f infra/docker/compose.main-images.yml"

# 4a. Every service up/healthy; migrate + minio-init exited 0.
$P ps -a

# 4b. Migrations applied cleanly.
docker logs docker-migrate-1 2>&1 | tail -1     # -> migrate: done (applied=N skipped=0)

# 4c. API health + dependency reachability.
curl -s http://localhost:3000/livez                       # -> ok
curl -s http://localhost:3000/readyz                       # -> {"checks":{"postgres":"ok","redis":"ok","s3":"ok"}}

# 4d. Admin auto-seed landed.
docker logs docker-api-1 2>&1 | grep bootstrap_admin_seeded

# 4e. Dashboard reachable.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/login   # -> 200

# 4f. SMOKE THE DRIFTED-TABLE PATH (health checks alone won't catch §0 drift).
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@local.test","password":"<password>"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
curl -s -o /dev/null -w 'GET /projects -> %{http_code}\n' \
  http://localhost:3000/projects -H "Authorization: Bearer $TOKEN"   # MUST be 200, not 500
```

Step **4f** is the lockstep canary. If it returns 500, re-read [§0](#0-the-one-rule-that-bites-everyone-image--migration-lockstep)
and check `docker logs docker-api-1` for a `column ... does not exist` error.

## 5. Teardown & backup

```bash
# Snapshot Postgres before any destructive op.
docker compose -p docker --env-file infra/docker/.env -f infra/docker/compose.yml \
  exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > infra/docker/backups/pre-teardown-$(date +%Y%m%d-%H%M%S).sql.gz

# Stop, keep data:
docker compose -p docker ... down

# Stop AND wipe all volumes (DESTRUCTIVE — drops postgres/redis/minio data):
docker compose -p docker ... down -v --remove-orphans
```

## 6. Troubleshooting

| Symptom                                                                   | Cause                                                                                         | Fix                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `column "..." does not exist`, projects/runs 500 while `/readyz` is green | image ↔ migration drift ([§0](#0-the-one-rule-that-bites-everyone-image--migration-lockstep)) | pin image and migrations to the same commit                                                   |
| `migrate` exited non-zero                                                 | partial prior migration                                                                       | `docker logs docker-migrate-1`; see [migration-deploy-order.md](migration-deploy-order.md)    |
| api won't boot, `JWT_SECRET must be ≥32 chars`                            | short/missing secret                                                                          | `openssl rand -hex 32` into `.env`                                                            |
| MinIO never starts / api can't reach S3                                   | `COMPOSE_PROFILES` unset                                                                      | add `COMPOSE_PROFILES=s3` to `.env`                                                           |
| dashboard "Cannot connect to API" from a remote browser                   | dashboard's browser bundle bakes `NEXT_PUBLIC_API_URL=http://localhost:3000` at image build — remote browsers can't reach it, and a proxy can't rewrite a baked absolute URL | deploy on a domain per [reverse-proxy-tls.md](reverse-proxy-tls.md) (rebuild the dashboard with your public API URL + terminate TLS) |

## 7. References

- [reverse-proxy-tls.md](reverse-proxy-tls.md) — expose the stack on a domain with HTTPS (the dashboard-URL constraint + a worked TLS proxy)
- [install/quickstart.md](../install/quickstart.md) — dev (`pnpm dev`) path + first-capture walkthrough
- [migration-deploy-order.md](migration-deploy-order.md) — schema-narrowing deploys
- [storage-backends.md](storage-backends.md) — S3 vs HDD
- [restore-from-backup.md](restore-from-backup.md) — snapshot/restore details
- `infra/docker/compose.main-images.yml` — the local main-SHA image overlay you create per §0 (not committed; delete after a semver bump catches up)
