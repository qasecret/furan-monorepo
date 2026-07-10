# Furan

**Self-hostable UI testing for small teams.** Capture screenshots from your CI, compare them against an approved baseline, and review the diff in a polished dashboard — all on infrastructure you control. No SaaS account, no per-screenshot pricing, no telemetry phone-home.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/qasecret/furan-monorepo?label=release)](https://github.com/qasecret/furan-monorepo/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/qasecret/furan-monorepo/ci.yml?branch=main&label=CI)](https://github.com/qasecret/furan-monorepo/actions)
[![Docker Hub](https://img.shields.io/badge/docker-qasecret%2Ffuran--*-blue?logo=docker)](https://hub.docker.com/u/qasecret)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.qasecret/furan-selenium?label=sdk-kotlin)](https://central.sonatype.com/namespace/io.github.qasecret)

## Is Furan for you?

Furan fits if **all** of the following are true:

- Your team is **2–20 people** running a web app that ships often enough that visual regressions hurt.
- You want a **self-hosted** tool — either for data-residency reasons or to avoid per-snapshot SaaS billing.
- You already use **GitHub** for code review (GitLab / Bitbucket / Azure DevOps adapters are deferred to a later release).
- Your tests run on **JUnit 5 (Kotlin / Java)** with **Selenium, Playwright, or Appium** — or you're willing to drive Furan's REST API directly.

If you're an enterprise needing SSO / SCIM / SAML or multi-organization tenancy, Furan is not there yet. See [Status and roadmap](#status-and-roadmap).

## What you get

- **Image-first diff pipeline** — the rendered screenshot is the source of truth: per-project pixel comparison (`odiff` / `pixelmatch` / `looks-same`) or an optional **VLM mode** (Ollama / Gemini / Anthropic) that runs pixel-first and only invokes a vision model when a pixel diff is detected. Per-region severity scoring, plus an opt-in `axe-core` accessibility pass.
- **Diff viewer** — `pixi.js`-based renderer with side-by-side / overlay / onion-skin / heatmap modes, per-region keyboard nav, ignore-region drawing, and inline review comments.
- **Element-anchored ignore regions** — drag-draw a region over a button; the SDK captures its CSS selector at snapshot time so the mask survives layout reflows. Falls back to bounding-box masking when the element can't be resolved.
- **Dynamic text regions** — regex-anchored ignore regions with OCR (tesseract.js); the region is only masked when the extracted text matches your pattern, so real layout changes underneath dynamic dates / order numbers still surface as diffs.
- **Branch-aware baselines** — feature branch → PR base → default branch fallback chain with atomic promotion when a PR merges. Feature work doesn't pollute `main`'s baselines.
- **GitHub App** — sticky PR comments, `furan/baselines` status check, auto-promote on merge.
- **JVM SDK family** — `furan-selenium`, `furan-playwright`, and `furan-appium` on Maven Central (`4.2.0`), each a drop-in for a JUnit 5 suite on that driver over a shared capture core, plus a `furan-junit5` `@FuranTest` annotation.
- **Access control & audit** — four-tier role hierarchy (owner ⊇ admin ⊇ editor ⊇ guest) enforced per request, an admin audit-log viewer, and an opt-in Postgres row-level-security backstop for tenant isolation.
- **OpenAPI 3.1 spec** — `GET /openapi.json`. **Interactive docs** at `GET /docs` (Scalar).
- **Operations** — per-project retention TTL, nightly Postgres backup sidecar, restore + api-down runbooks.
- **Container images** — multi-arch (amd64 / arm64), cosign-signed (keyless OIDC), Trivy CRITICAL/HIGH scanned, SBOM per release.
- **Apache 2.0** — no telemetry on the server, no feature gates, no upgrade pressure.

## Fastest install (evaluation)

One file, one command, no clone and no `.env` — like ReportPortal:

```bash
curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
docker compose -f furan-compose.yml up -d
# open http://localhost:8080  →  sign in as  admin@furan.local / FuranAdmin123!
```

nginx serves the whole thing on `:8080`; migrations self-apply from the image. This ships **default credentials and a default JWT secret** for zero-friction evaluation — before anything network-reachable, override `FURAN_BOOTSTRAP_ADMIN_PASSWORD`, `JWT_SECRET`, `POSTGRES_PASSWORD`, and `MINIO_ROOT_PASSWORD` (export them before `up`), or keep the defaults off the network with `FURAN_BIND=127.0.0.1`. For a hardened, secret-generating install use [`./deploy.sh`](deploy.sh) or the 10-minute walkthrough below.

> On **v1.1.28** the dashboard UI works from the Docker host's own browser; full remote-browser access lands in v1.1.29 (single-origin `/api`). The API/SDK path works from anywhere today.

## Install in 10 minutes

Time from a freshly-provisioned host to "logged into the dashboard": about 10 minutes. The walkthrough below is the **production-shaped** install (Docker Compose, all services from published images). For a from-source development setup see [`docs/install/quickstart.md`](docs/install/quickstart.md).

### Prerequisites

| Tool      | Version             | Why                            |
| --------- | ------------------- | ------------------------------ |
| Docker    | 24+ with Compose v2 | Runs all services + data plane |
| Disk      | ~10 GB free         | Postgres + MinIO data          |
| RAM       | ~4 GB free          | All services together          |
| `openssl` | any recent          | Generates secrets              |

Tested on **Linux x86_64**, **macOS arm64**, and **macOS x86_64**.

### Step 1 — Clone and configure

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

> **Deploying on a domain (not `localhost`)?** The published dashboard image bakes `http://localhost:3000` as the browser's API URL, so client-side features (the diff viewer, live updates) only work for a viewer on the Docker host. A real HTTPS deployment behind `furan.example.com` needs a reverse proxy **and** a dashboard rebuilt with your public API URL — see [`docs/runbooks/reverse-proxy-tls.md`](docs/runbooks/reverse-proxy-tls.md). The steps below assume `localhost`.

### Step 2 — Start the full stack

```bash
docker compose --env-file .env -f infra/docker/compose.yml up -d
```

`--env-file .env` is required because Compose's project directory defaults to the directory of the first `-f` file (`infra/docker/`), so it would otherwise miss the `.env` you just edited at the repo root.

This pulls and starts eight long-running services: `postgres`, `redis`, `minio` (data plane) plus `api`, `dashboard`, `capture-worker`, `diff-worker`, `integrations` (app plane). All images are signed and SBOM-attested per release.

> **Production operators:** pin a stable Compose project name (`-p furan`) so re-deploys and upgrades reconcile the same stack, keep `.env` wherever you run Compose from, and follow [`docs/runbooks/production-deploy.md`](docs/runbooks/production-deploy.md) — it covers the one thing that bites everyone (image ↔ migration lockstep), a post-deploy smoke that catches drift `/readyz` misses, and backup-before-teardown. The repo-root [`deploy.sh`](deploy.sh) automates the whole flow (secret bootstrap, ordered bring-up, health-wait, and the drift canary), with a lockstep guard that refuses a `released` deploy when your checkout's migrations are ahead of the pinned tag; deploy at a release tag (`git checkout v1.1.27`) or use `--mode from-head`.

Wait ~30 seconds for healthchecks to settle, then verify everything is up:

```bash
docker compose --env-file .env -f infra/docker/compose.yml ps
```

Every long-running service should report `running (healthy)`. The `minio-init` and `migrate` containers will show `exited (0)` — that's intentional; they're one-shots (bucket creation and schema migration) that the app services wait on before starting.

### Step 3 — Sign in

Browse to **<http://localhost:3001>** and sign in with the credentials you set in `FURAN_BOOTSTRAP_ADMIN_EMAIL` / `FURAN_BOOTSTRAP_ADMIN_PASSWORD` in Step 1. The API seeded that admin automatically on first boot when it saw an empty users table.

### Step 4 — Create your first project

1. From the empty `/projects` page, click **Create project**. Name it after your app; the main branch defaults to `main`.
2. The project lands at `/projects/<projectId>` — bookmark this URL for the dashboard.

### Step 5 — Mint a personal access token (PAT)

1. Click your avatar → **Tokens**, or browse to **<http://localhost:3001/account/tokens>**.
2. Click **Create**, label it (e.g. `CI - main`), and click **Generate**.
3. **Copy the raw token immediately** — it is shown once. The database only stores the SHA-256 hash; there is no recovery flow. If you lose it, delete and mint a new one.

The PAT has the form `furan_pat_<random>` and is used as a `Bearer` token from CI, the SDK, or curl scripts.

You now have everything needed to send your first snapshot.

### Adding more admins or resetting a password

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

## Send your first snapshot

The fastest path is from a JUnit 5 + Selenium test using the Kotlin SDK. Copy-paste-runnable examples live under [`packages/sdk-kotlin/examples`](packages/sdk-kotlin/examples) — one each for `sdk-selenium-junit5`, `sdk-playwright-junit5`, and `sdk-appium-junit5`.

Add Furan as a test dependency (swap `furan-selenium` for `furan-playwright` or `furan-appium` to match your driver):

```kotlin
// build.gradle.kts
testImplementation("io.github.qasecret:furan-selenium:4.2.0")
```

In your test:

```kotlin
import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.chrome.ChromeDriver

class CheckoutTest {
    @Test
    fun `checkout page renders correctly`() {
        val driver = ChromeDriver()
        Furan.use(FuranConfig.fromEnv(), driver, "checkout-page") { furan ->
            driver.get("https://app.example.com/checkout")
            furan.snapshot("checkout-page")
        }
        driver.quit()
    }
}
```

See [`packages/sdk-kotlin/README.md`](packages/sdk-kotlin/README.md) for the full SDK reference, including `snapshotAndAwait` for synchronous assertion-style tests, the `@FuranTest` JUnit 5 annotation, ignore regions, and the v2 runtime architecture.

Set three environment variables (locally for development, as CI secrets in production):

```bash
export FURAN_API_URL=http://localhost:3000          # or your deployed host
export FURAN_API_TOKEN=furan_pat_<paste-from-step-5>
export FURAN_PROJECT_ID=<paste-from-step-4>
```

Run the test. Furan will:

1. Capture a PNG + per-element bbox map of the page.
2. Upload to the API → enqueue capture + diff jobs.
3. Compare against the project's baseline for this `(test name, branch, browser, viewport, OS/device)` identity. The first run has no baseline yet, so it's recorded as **New** for you to approve as the baseline — Furan does **not** auto-seed a baseline by default (enable auto-seed per project if you'd rather the first capture become the baseline automatically).
4. Surface the run in the dashboard at `/projects/<projectId>` with status **New** (no baseline yet) or, once a baseline exists, **Passed** / **Unresolved** (a diff awaiting review) on subsequent runs.

Open the run, click into the diff viewer, and you're looking at your first Furan diff.

## Wire into CI (GitHub Actions)

Copy [`docs/integrations/.examples/visual-regression.yml`](docs/integrations/.examples/visual-regression.yml) into `.github/workflows/` of your test repo, then set two repository secrets:

| Secret            | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `FURAN_API_URL`   | Your Furan deployment URL (e.g. `https://furan.acme.io`) |
| `FURAN_API_TOKEN` | The `furan_pat_*` from install step 5                    |

The reference workflow runs your test suite, uploads diffs, posts a sticky PR comment, and updates the `furan/baselines` status check on every push. The full setup including the GitHub App and Slack webhook integration is documented in [`docs/integrations/github-actions.md`](docs/integrations/github-actions.md).

## Direct image pulls

If you'd rather wire Furan into your existing infrastructure (Kubernetes, Nomad, your own Compose stack) instead of using the bundled `infra/docker/compose.yml`:

```bash
docker pull qasecret/furan-api:v1.1.27
docker pull qasecret/furan-dashboard:v1.1.27
docker pull qasecret/furan-capture-worker:v1.1.27
docker pull qasecret/furan-diff-worker:v1.1.27
docker pull qasecret/furan-integrations:v1.1.27
```

GHCR mirrors are published per release at `ghcr.io/qasecret/furan-*:v1.1.27`. Every image is multi-arch (amd64 / arm64), cosign-signed (keyless OIDC — verify against the workflow identity `build-images.yml@refs/tags/v1.1.27`), and ships with an SBOM artifact.

## Common first-install problems

**The dashboard shows "Cannot connect to API".** The browser is loading the dashboard but the API host isn't reachable from your browser. Check that `NEXT_PUBLIC_API_URL` in `.env` matches where you're actually serving the API — for the default Compose install that's `http://localhost:3000`.

**`docker compose ... up -d` fails with port conflicts.** The default Compose stack binds ports `3000` (api), `3001` (dashboard), `5432` (postgres), `6379` (redis), and `9000` / `9001` (minio). If you already have something on those ports, either stop it or edit the port mappings in `infra/docker/compose.yml`.

**API exits at boot with `FURAN_BOOTSTRAP_ADMIN_EMAIL must be replaced from .env.example placeholder` (or the same for `_PASSWORD`).** You forgot to edit the two new keys at the top of `.env`. Either replace `change-me` / `change-me-run: openssl rand -hex 24` with real values (the API will then seed a first admin) — or remove both lines entirely and seed via the `seed-admin` CLI (see "Adding more admins or resetting a password" above).

**API exits at boot with `JWT_SECRET must be ≥32 chars`.** Generate a new one with `openssl rand -hex 32` and restart the api container.

**Screenshots upload but the diff viewer is empty.** The diff worker may be down or stuck. Check `docker compose ... ps` for `diff-worker` health, and `docker compose ... logs diff-worker` for the last error. The [`docs/runbooks/api-down.md`](docs/runbooks/api-down.md) triage tree covers worker-stuck symptoms as well.

**SDK upload fails with `401 unauthorized`.** Most likely cause: the PAT wasn't copied correctly, or it's been deleted. Mint a new one from `/account/tokens`.

## Repository layout

```
furan-monorepo/
├── apps/
│   ├── api/              Fastify + tRPC + Drizzle backend (REST + /trpc)
│   ├── dashboard/        Next.js 15 + React 19 + pixi.js diff viewer
│   ├── capture-worker/   Playwright + sharp; BullMQ consumer
│   ├── diff-worker/      diff-engine consumer (BullMQ)
│   └── integrations/     GitHub App + Slack webhook
├── packages/
│   ├── db/               Drizzle schema + migrations + scope helpers
│   ├── diff-engine/      Image-first: pixel (odiff/pixelmatch/looks-same) + VLM + axe
│   ├── rules-engine/     Project auto-rules that auto-resolve known diffs
│   ├── sdk-kotlin/       Kotlin/JVM SDK (core + selenium/playwright/appium adapters)
│   ├── storage/          S3 (MinIO-compatible) + HDD storage backends
│   ├── queue/            BullMQ wrappers
│   ├── telemetry/        pino + OpenTelemetry + prom-client
│   └── shared-types/     Zod schemas shared across apps
├── infra/docker/         compose.yml + dev overlay + backup sidecar
└── docs/                 install/, runbooks/, integrations/
```

## Runbooks

Operator one-pagers for common scenarios in [`docs/runbooks/`](docs/runbooks/):

- [`production-deploy.md`](docs/runbooks/production-deploy.md) — the full Compose install, incl. image ↔ migration lockstep
- [`reverse-proxy-tls.md`](docs/runbooks/reverse-proxy-tls.md) — expose the stack on a domain with HTTPS
- [`storage-backends.md`](docs/runbooks/storage-backends.md) — S3/MinIO vs HDD storage
- [`api-down.md`](docs/runbooks/api-down.md) — first-call triage decision tree
- [`restore-from-backup.md`](docs/runbooks/restore-from-backup.md) — backup + restore lifecycle
- [`migration-deploy-order.md`](docs/runbooks/migration-deploy-order.md) — schema-additive-first deploy ordering
- [`alpha-install.md`](docs/runbooks/alpha-install.md) — structured-feedback template for new installers
- [`maven-central-publish.md`](docs/runbooks/maven-central-publish.md) — Kotlin SDK release flow
- [`security-dry-run-v1.md`](docs/runbooks/security-dry-run-v1.md) — v1.0 security posture sign-off

## Status and roadmap

**v1.1.27 is the current release** (2026-07-04), published as cosign-signed, Trivy-scanned, multi-arch (amd64 / arm64) images. Beyond the v1.0 baseline, the v1.1 line adds the Playwright and Appium SDK adapters, the image-first VLM diff layer, an opt-in Postgres row-level-security tenant-isolation backstop, an audit log with an admin viewer, and a four-tier role hierarchy. Still onboarding early installers — if you'd like to be one, see [`docs/runbooks/alpha-install.md`](docs/runbooks/alpha-install.md).

Not yet built (no schedule, will land when there's user signal):

- **Non-JVM SDKs** — TypeScript / JavaScript, Python, C#, plus Cypress / Storybook. The JVM adapters (Selenium, Playwright, Appium) already ship.
- **More VCS integrations** — GitLab, Bitbucket, Azure DevOps. The GitHub App already ships.
- **Enterprise identity** — SSO / SCIM / SAML and multi-organization tenancy. Furan is single-organization today; role-based access control and the audit log already ship.

Design docs, ADRs, and forward planning live in the separate `furan-design` workspace (not part of this repo; maintained internally).

## License and governance

- [LICENSE](LICENSE) — Apache 2.0
- [SECURITY.md](SECURITY.md) — vulnerability disclosure policy
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off, setup, conventions
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [ARCHITECTURE.md](ARCHITECTURE.md) — high-level architecture pointer
