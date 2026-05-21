# Furan

**Self-hostable visual regression testing for small teams.** Capture screenshots from your CI, compare them against an approved baseline, and review the diff in a polished dashboard — all on infrastructure you control. No SaaS account, no per-screenshot pricing, no telemetry phone-home.

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
- Your test framework is **Selenium + JUnit 5** in Kotlin / Java — or you're willing to drive Furan's REST API directly.

If you're an enterprise needing SSO / SCIM / audit log / multi-tenancy, Furan is not there yet. See [Status and roadmap](#status-and-roadmap).

## What you get

- **Pixel + DOM diff pipeline** — `odiff` for fast pixel comparison, `diff-dom` over `jsdom` for layout-aware analysis, with per-region severity scoring.
- **Diff viewer** — `pixi.js`-based renderer with side-by-side / overlay / onion-skin / heatmap modes, per-region keyboard nav, ignore-region drawing, and inline review comments.
- **Element-anchored ignore regions** — drag-draw a region over a button; the SDK captures its CSS selector at snapshot time so the mask survives layout reflows. Falls back to bounding-box masking when the element can't be resolved.
- **Dynamic text regions** — regex-anchored ignore regions with OCR (tesseract.js); the region is only masked when the extracted text matches your pattern, so real layout changes underneath dynamic dates / order numbers still surface as diffs.
- **Branch-aware baselines** — feature branch → PR base → default branch fallback chain with atomic promotion when a PR merges. Feature work doesn't pollute `main`'s baselines.
- **GitHub App** — sticky PR comments, `furan/baselines` status check, auto-promote on merge.
- **Kotlin SDK** — `io.github.qasecret:furan-selenium` on Maven Central, drop-in for any JUnit 5 + Selenium suite.
- **OpenAPI 3.1 spec** — `GET /openapi.json`. **Interactive docs** at `GET /docs` (Scalar).
- **Operations** — per-project retention TTL, nightly Postgres backup sidecar, restore + api-down runbooks.
- **Container images** — cosign-signed (keyless OIDC), Trivy CRITICAL/HIGH scanned, SBOM per release.
- **Apache 2.0** — no telemetry on the server, no feature gates, no upgrade pressure.

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

Open `.env` in your editor and fill in three secrets. The example values are placeholders — your install **will not start** until you replace them.

```bash
# Generate each value and paste it into the matching key in .env:

# JWT_SECRET — minimum 32 chars, the api fails closed if shorter
openssl rand -hex 32

# POSTGRES_PASSWORD and MINIO_ROOT_PASSWORD — any high-entropy value
openssl rand -base64 24
```

Required keys in `.env`:

| Key                   | Purpose                                                |
| --------------------- | ------------------------------------------------------ |
| `JWT_SECRET`          | Signs dashboard session tokens. **Must be ≥32 chars.** |
| `POSTGRES_PASSWORD`   | Database password — used by every backend service.     |
| `MINIO_ROOT_PASSWORD` | Object-storage password for screenshot artifacts.      |

The defaults for `POSTGRES_USER=furan`, `POSTGRES_DB=furan_dev`, `MINIO_BUCKET=furan-dev` are safe to keep.

### Step 2 — Start the full stack

```bash
docker compose -f infra/docker/compose.yml up -d
```

This pulls and starts seven services: `postgres`, `redis`, `minio` (data plane) plus `api`, `dashboard`, `capture-worker`, `diff-worker`, `integrations` (app plane). All images are signed and SBOM-attested per release.

Wait ~30 seconds for healthchecks to settle, then verify everything is up:

```bash
docker compose -f infra/docker/compose.yml ps
```

Every service should report `running (healthy)`. The `minio-init` container will show `exited (0)` — that's intentional; it's a one-shot bucket creator.

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
docker compose -f infra/docker/compose.yml exec api \
  node dist/cli/seed-admin.js \
  --email another@example.com \
  --password '<pick-a-strong-passphrase>'
```

Reset a password:

```bash
docker compose -f infra/docker/compose.yml exec api \
  node dist/cli/reset-password.js \
  --email someone@example.com
```

The CLI prompts for the new password and prints nothing on success.

## Send your first snapshot

The fastest path is from a JUnit 5 + Selenium test using the Kotlin SDK. A copy-paste-runnable example lives at [`packages/sdk-kotlin/examples/sdk-selenium-junit5`](packages/sdk-kotlin/examples/sdk-selenium-junit5).

Add Furan as a test dependency:

```kotlin
// build.gradle.kts
testImplementation("io.github.qasecret:furan-selenium:0.7.0")
```

In your test:

```kotlin
import io.github.qasecret.furan.Furan
import io.github.qasecret.furan.FuranConfig
import org.openqa.selenium.chrome.ChromeDriver

class CheckoutTest {
    @Test
    fun `checkout page renders correctly`() {
        val driver = ChromeDriver()
        val furan = Furan(driver, FuranConfig.fromEnv())
        try {
            driver.get("https://app.example.com/checkout")
            furan.snapshot("checkout-page")
        } finally {
            furan.close()
            driver.quit()
        }
    }
}
```

Set three environment variables (locally for development, as CI secrets in production):

```bash
export FURAN_API_URL=http://localhost:3000          # or your deployed host
export FURAN_API_TOKEN=furan_pat_<paste-from-step-5>
export FURAN_PROJECT_ID=<paste-from-step-4>
```

Run the test. Furan will:

1. Capture a PNG + per-element bbox map of the page.
2. Upload to the API → enqueue capture + diff jobs.
3. Compare against the project's baseline for this `(test name, browser, viewport)` tuple. The first run has no baseline, so it auto-creates one.
4. Surface the run in the dashboard at `/projects/<projectId>` with status **New** (first ever) or **Unresolved** (diff awaiting review) on subsequent runs.

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
docker pull qasecret/furan-api:v1.0.6
docker pull qasecret/furan-dashboard:v1.0.6
docker pull qasecret/furan-capture-worker:v1.0.6
docker pull qasecret/furan-diff-worker:v1.0.6
docker pull qasecret/furan-integrations:v1.0.6
```

GHCR mirrors are published per release at `ghcr.io/qasecret/furan-*:v1.0.6`. Every image is cosign-signed (keyless OIDC) and ships with an SBOM artifact.

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
│   ├── diff-worker/      diff-engine + diff-dom consumer
│   └── integrations/     GitHub App + Slack webhook
├── packages/
│   ├── db/               Drizzle schema + migrations + scope helpers
│   ├── diff-engine/      Pixel L1 + DOM L2 diff implementations
│   ├── sdk-kotlin/       Kotlin SDK (core + Selenium adapter)
│   ├── storage/          S3 client wrapper (MinIO-compatible)
│   ├── queue/            BullMQ wrappers
│   ├── telemetry/        pino + OpenTelemetry + prom-client
│   └── shared-types/     Zod schemas shared across apps
├── infra/docker/         compose.yml + dev overlay + backup sidecar
└── docs/                 install/, runbooks/, integrations/
```

## Runbooks

Operator one-pagers for common scenarios in [`docs/runbooks/`](docs/runbooks/):

- [`api-down.md`](docs/runbooks/api-down.md) — first-call triage decision tree
- [`restore-from-backup.md`](docs/runbooks/restore-from-backup.md) — backup + restore lifecycle
- [`migration-deploy-order.md`](docs/runbooks/migration-deploy-order.md) — schema-additive-first deploy ordering
- [`alpha-install.md`](docs/runbooks/alpha-install.md) — structured-feedback template for new installers
- [`maven-central-publish.md`](docs/runbooks/maven-central-publish.md) — Kotlin SDK release flow
- [`security-dry-run-v1.md`](docs/runbooks/security-dry-run-v1.md) — v1.0 security posture sign-off

## Status and roadmap

**v1.0.6 is the current release** (released 2026-05-21). The v1.0 line is in feature-complete patch mode while we onboard the first external installers — if you'd like to be one, see [`docs/runbooks/alpha-install.md`](docs/runbooks/alpha-install.md).

Deferred to v1.1+ (no schedule, will land when there's user signal):

- **More SDKs** — Playwright, Cypress, TypeScript / JavaScript, Storybook
- **More VCS integrations** — GitLab, Bitbucket, Azure DevOps
- **Enterprise features** — multi-tenancy, SSO / SCIM / SAML, audit log, role-based access beyond the current 3 roles
- **VLM / AI diff narration** — natural-language explanations of what changed

Design docs, ADRs, and the v1.1+ planning live in the separate `furan-design` workspace (not part of this repo; maintained internally).

## License and governance

- [LICENSE](LICENSE) — Apache 2.0
- [SECURITY.md](SECURITY.md) — vulnerability disclosure policy
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off, setup, conventions
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [ARCHITECTURE.md](ARCHITECTURE.md) — high-level architecture pointer
