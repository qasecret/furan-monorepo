# `infra/docker/` — Compose files

The deploy commands and the **image ↔ migration lockstep rule** live in
[`docs/runbooks/production-deploy.md`](../../docs/runbooks/production-deploy.md).
This is just an index of the compose files here.

| File                          | Tracked?   | Purpose                                                                                                                                                                                                       |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yml`                 | yes        | **Base production stack** — data plane + 5 app services from published `qasecret/furan-*:v1.1.x` images. The documented `docker compose up -d` install.                                                       |
| `compose.dev.yml`             | yes        | Dev overlay — exposes the data-plane ports (`5433/6379/9000/9001`) on the host so app services run via `pnpm dev` can reach them.                                                                             |
| `compose.backup.yml`          | yes        | Backup sidecar (`pg_dump` + storage snapshot). See [`restore-from-backup.md`](../../docs/runbooks/restore-from-backup.md).                                                                                    |
| `compose.main-images.yml`     | no (local) | Overlay that pins the 5 app images to a published **`origin/main` commit-SHA** build. Use when the semver pin in `compose.yml` lags your checkout's migrations. **Delete after a semver release catches up.** |
| `compose.all-local.yml`       | no (local) | Pins app services to locally-built `furan-*:local` images (`docker build` from `apps/*/Dockerfile`). The build-from-source path.                                                                              |
| `compose.dashboard-local.yml` | no (local) | Pins just the dashboard to a local build — handy when iterating on the dashboard image alone.                                                                                                                 |

> **Removed 2026-06-24** (obsolete, self-labeled "delete after next release"):
> `compose.local-main.yml` (pinned to pre-v1.0.9 `:main` images) and
> `compose.pin-v1.0.17.yml` (pinned to v1.0.17). Both predated v1.1.x by many
> releases. For "pin to a known-good published build," use
> `compose.main-images.yml` instead.

## Quick reference

```bash
# Production (published semver images):
docker compose -p docker --env-file .env -f compose.yml up -d

# Production from current main (when semver lags — see runbook §0):
docker compose -p docker --env-file .env -f compose.yml -f compose.main-images.yml up -d

# Dev data plane only (app services via `pnpm dev` on the host):
docker compose -f compose.yml -f compose.dev.yml --profile s3 up -d postgres redis minio minio-init
```
