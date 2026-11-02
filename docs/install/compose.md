---
title: Production install (Docker Compose)
sidebar_label: Production install (Compose)
---

# Production install (Docker Compose)

Time from a freshly-provisioned host to "logged into the dashboard": about 10 minutes. The walkthrough below is the **production-shaped** install (Docker Compose, all services from published images). For a from-source development setup see the [development setup](https://github.com/qasecret/furan-monorepo/blob/main/docs/maintainers/development.md).

## Prerequisites

| Tool      | Version             | Why                            |
| --------- | ------------------- | ------------------------------ |
| Docker    | 24+ with Compose v2 | Runs all services + data plane |
| Disk      | ~10 GB free         | Postgres + MinIO data          |
| RAM       | ~4 GB free          | All services together          |
| `openssl` | any recent          | Generates secrets              |

Tested on **Linux x86_64**, **macOS arm64**, and **macOS x86_64**.

## Step 1 — Clone and configure

```bash
git clone https://github.com/qasecret/furan-monorepo
cd furan-monorepo
cp .env.example .env
```

Open `.env` in your editor and replace **five** placeholder values — three secrets plus your first admin's login. The example ships them as `change-me…`, and the api **fails closed and refuses to boot** until every one is replaced.

```bash
# Generate each value and paste it into the matching key in .env:

# JWT_SECRET — minimum 32 chars, the api fails closed if shorter
openssl rand -hex 32

# POSTGRES_PASSWORD and MINIO_ROOT_PASSWORD — any high-entropy value
openssl rand -base64 24

# FURAN_BOOTSTRAP_ADMIN_PASSWORD — your first admin's password
openssl rand -hex 24
```

Required keys in `.env` (the api rejects the `change-me` placeholders for all of them):

| Key                              | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `JWT_SECRET`                     | Signs dashboard session tokens. **Must be ≥32 chars.**  |
| `POSTGRES_PASSWORD`              | Database password — used by every backend service.      |
| `MINIO_ROOT_PASSWORD`            | Object-storage password for screenshot artifacts.       |
| `FURAN_BOOTSTRAP_ADMIN_EMAIL`    | Your first admin's login email — you sign in with this. |
| `FURAN_BOOTSTRAP_ADMIN_PASSWORD` | Your first admin's password (seeded on first boot).     |

The api seeds that admin automatically the first time it boots against an empty `users` table. The defaults for `POSTGRES_USER=furan`, `POSTGRES_DB=furan`, `MINIO_BUCKET=furan` are safe to keep.

> **Deploying on a domain (not `localhost`)?** The published dashboard image bakes `http://localhost:3000` as the browser's API URL, so client-side features (the diff viewer, live updates) only work for a viewer on the Docker host. A real HTTPS deployment behind `furan.example.com` needs a reverse proxy **and** a dashboard rebuilt with your public API URL — see [`docs/runbooks/reverse-proxy-tls.md`](../runbooks/reverse-proxy-tls.md). The steps below assume `localhost`.

## Step 2 — Start the full stack

```bash
docker compose --env-file .env -f infra/docker/compose.yml up -d
```

`--env-file .env` is required because Compose's project directory defaults to the directory of the first `-f` file (`infra/docker/`), so it would otherwise miss the `.env` you just edited at the repo root.

This pulls and starts eight long-running services: `postgres`, `redis`, `minio` (data plane) plus `api`, `dashboard`, `capture-worker`, `diff-worker`, `integrations` (app plane). All images are signed and SBOM-attested per release.

> **Production operators:** pin a stable Compose project name (`-p furan`) so re-deploys and upgrades reconcile the same stack, keep `.env` wherever you run Compose from, and follow [`docs/runbooks/production-deploy.md`](../runbooks/production-deploy.md) — it covers the one thing that bites everyone (image ↔ migration lockstep), a post-deploy smoke that catches drift `/readyz` misses, and backup-before-teardown. The repo-root [`deploy.sh`](https://github.com/qasecret/furan-monorepo/blob/main/deploy.sh) automates the whole flow (secret bootstrap, ordered bring-up, health-wait, and the drift canary), with a lockstep guard that refuses a `released` deploy when your checkout's migrations are ahead of the pinned tag; deploy at a release tag (`git checkout v1.1.33`) or use `--mode from-head`.

Wait ~30 seconds for healthchecks to settle, then verify everything is up:

```bash
docker compose --env-file .env -f infra/docker/compose.yml ps
```

Every long-running service should report `running (healthy)`. The `minio-perms`, `minio-init` and `migrate` containers will show `exited (0)` — that's intentional; they're one-shots (MinIO volume ownership, bucket creation, and schema migration) that the app services wait on before starting.

## Step 3 — Sign in

Browse to **<http://localhost:3001>** and sign in with the credentials you set in `FURAN_BOOTSTRAP_ADMIN_EMAIL` / `FURAN_BOOTSTRAP_ADMIN_PASSWORD` in Step 1. The API seeded that admin automatically on first boot when it saw an empty users table.

## Step 4 — Create your first project

1. A fresh install has no projects, so you land on **Admin → Projects**. Click **Create project**, name it after your app (the main branch defaults to `main`), and click **Create**.
2. You land on the project's Builds page. The UUID in its URL (`/projects/<projectId>/builds`) is the project ID your tests need.

## Step 5 — Create an API token

1. As an admin, open **Admin → API Tokens** and click **Create token**. (Editors use **API tokens** at `/account/tokens` and click **Create token**.)
2. Enter a **Label** (e.g. `CI - main`), keep the defaults unless you need otherwise, and click **Create**:
   - **Access: SDK & CI** — uploads runs and reads results. It can save the first baseline of a new test (`saveNewTests`), but it never approves a change against an existing baseline; that stays with a reviewer. Pick **Read-only** for a job that only reads results.
   - **Project:** the project this job uploads to. **All my projects** covers every project you're a member of; even an admin's token has no access beyond that unless it is bound to a project.
   - **Expires after:** 90 days by default (7 days to 1 year). The operator can lower the cap with `FURAN_PAT_MAX_LIFETIME_DAYS`, or set it to `0` to allow tokens that never expire.
3. **Copy the token immediately**: it is shown once. The database only stores the SHA-256 hash; there is no recovery flow. If you lose it, delete it and create a new one.

The token has the form `furan_pat_<random>` and is used as a `Bearer` token from CI, the SDK, or curl scripts. A token can't manage tokens, call admin endpoints or use the dashboard's API; those need a signed-in session. The token list shows each token's access, project, expiry, and when and from which address it was last used. Mint a replacement before a token expires, update the CI secret, then delete the old one.

> **Upgrading from v1.1.33 or earlier:** tokens minted before scopes existed become **Legacy** tokens. They keep working as before (every project you can reach, any approve) but expire 90 days after the upgrade; the dashboard shows the date. Replace them with scoped tokens before then.

You now have everything needed to send your first snapshot: continue with [Send your first upload](../getting-started/first-upload.mdx), using `FURAN_API_URL=http://<host>:3000` for this install.

## Adding more admins or resetting a password

After the bootstrap admin exists, use the `seed-admin` CLI to add more admins or the `reset-password` CLI to recover an account.

Add another admin:

```bash
docker compose --env-file .env -f infra/docker/compose.yml exec api \
  node dist/cli/seed-admin.js \
  --email another@example.com \
  --password '<pick-a-strong-passphrase>'
```

Reset a password:

```bash
docker compose --env-file .env -f infra/docker/compose.yml exec api \
  node dist/cli/reset-password.js \
  --email someone@example.com
```

The CLI prompts for the new password and prints nothing on success.

## Direct image pulls

If you'd rather wire Furan into your existing infrastructure (Kubernetes, Nomad, your own Compose stack) instead of using the bundled `infra/docker/compose.yml`:

```bash
docker pull qasecret/furan-api:v1.1.33
docker pull qasecret/furan-dashboard:v1.1.33
docker pull qasecret/furan-capture-worker:v1.1.33
docker pull qasecret/furan-diff-worker:v1.1.33
docker pull qasecret/furan-integrations:v1.1.33
```

GHCR mirrors are published per release at `ghcr.io/qasecret/furan-*:v1.1.33`. Every image is multi-arch (amd64 / arm64), cosign-signed (keyless OIDC — verify against the workflow identity `build-images.yml@refs/tags/v1.1.33`), and ships with an SBOM artifact.
