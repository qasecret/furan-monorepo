# Furan

**Self-hostable visual regression testing for small teams.**
Install with `docker compose up -d`, hook into CI in one workflow file,
branch-aware baselines that don't pollute `main`.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/qasecret/furan-monorepo?label=release)](https://github.com/qasecret/furan-monorepo/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/qasecret/furan-monorepo/ci.yml?branch=main&label=CI)](https://github.com/qasecret/furan-monorepo/actions)
[![Docker Hub](https://img.shields.io/badge/docker-qasecret%2Ffuran--*-blue?logo=docker)](https://hub.docker.com/u/qasecret)
[![Maven Central](https://img.shields.io/maven-central/v/io.github.qasecret/furan-selenium?label=sdk-kotlin)](https://central.sonatype.com/namespace/io.github.qasecret)

## What you get

- **Pixel + DOM diff pipeline** — odiff (L1) + diff-dom over jsdom (L2), per-region severity scoring
- **Diff viewer** — pixi.js renderer with side-by-side, overlay, onion-skin, and heatmap modes; per-region jump + keyboard nav
- **Branch-aware baselines** — feature → PR base → default fallback chain with atomic merge promotion
- **GitHub App** — sticky PR comments + `furan/baselines` status check + auto-promote on merge
- **Kotlin SDK** — `io.github.qasecret:furan-selenium` on Maven Central, drop-in for JUnit 5 + Selenium
- **Operations** — per-project retention TTL, nightly Postgres backup sidecar, api-down + restore runbooks
- **Container images** — cosign-signed (keyless OIDC), Trivy CRITICAL/HIGH scanned, SBOM per release
- **Apache 2.0**, no telemetry on the server, no upgrade gate

## Install

Compose-based install (data plane + all 5 app services from Docker Hub):

```bash
git clone https://github.com/qasecret/furan-monorepo
cd furan-monorepo
cp .env.example .env   # set POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, JWT_SECRET
docker compose -f infra/docker/compose.yml up -d
```

Then seed the first admin:

```bash
docker compose -f infra/docker/compose.yml exec api node dist/cli/seed-admin.js \
  --email you@example.com --password '<pick a strong one>'
```

Browse to the dashboard, mint a personal access token at `/account/tokens`, create a project, and you're ready to capture.

Full walkthrough including CI wiring: [`docs/install/quickstart.md`](docs/install/quickstart.md).

### Direct image pulls

```
docker pull qasecret/furan-api:latest
docker pull qasecret/furan-dashboard:latest
docker pull qasecret/furan-capture-worker:latest
docker pull qasecret/furan-diff-worker:latest
docker pull qasecret/furan-integrations:latest
```

GHCR mirrors at `ghcr.io/qasecret/furan-*` are also published per release.

### Kotlin SDK

```kotlin
testImplementation("io.github.qasecret:furan-selenium:0.6.1")
```

[JUnit 5 example project](packages/sdk-kotlin/examples/sdk-selenium-junit5) · [SDK CHANGELOG](packages/sdk-kotlin/CHANGELOG.md).

## Hook into CI

Drop the [reference GitHub Actions workflow](docs/integrations/.examples/visual-regression.yml) into `.github/workflows/` and set `FURAN_API_URL` + `FURAN_API_TOKEN` repo secrets. The Slack incoming-webhook delivery + the GitHub App sticky-comment / status-check integration are documented in [`docs/integrations/github-actions.md`](docs/integrations/github-actions.md).

## Repository layout

```
furan-monorepo/
├── apps/                 api, dashboard, capture-worker, diff-worker, integrations
├── packages/             db, storage, queue, telemetry, diff-engine, shared-types, sdk-kotlin
├── infra/docker/         compose stack + backup sidecar overlay
└── docs/                 install/, runbooks/, integrations/, feedback/
```

## Runbooks

Operator one-pagers in [`docs/runbooks/`](docs/runbooks/):

- [`api-down.md`](docs/runbooks/api-down.md) — first-call triage decision tree
- [`restore-from-backup.md`](docs/runbooks/restore-from-backup.md) — backup + restore lifecycle
- [`alpha-install.md`](docs/runbooks/alpha-install.md) — structured-feedback template for new installers
- [`maven-central-publish.md`](docs/runbooks/maven-central-publish.md) — Kotlin SDK release flow
- [`security-dry-run-v1.md`](docs/runbooks/security-dry-run-v1.md) — v1.0 security posture sign-off

## Status

v1.0.3 is the current release. v1.0 line is in patch mode while we onboard the first external installers — see [`docs/feedback/alpha-1-pending.md`](docs/feedback/alpha-1-pending.md) if you'd like to be the first.

Design docs and v1.1+ roadmap (TypeScript SDK, GitLab / Bitbucket / Azure DevOps bots, multi-tenancy spine, SSO/SCIM, audit log) live in the separate [furan-design](https://github.com/qasecret/furan-design) repo.

## License + governance

- [LICENSE](LICENSE) — Apache 2.0
- [SECURITY.md](SECURITY.md) — disclosure
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO + setup
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [ARCHITECTURE.md](ARCHITECTURE.md) — pointer at the `furan-design` repo
