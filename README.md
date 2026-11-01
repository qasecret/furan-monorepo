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
- Your tests run on **JUnit 5 (Kotlin / Java)** with **Selenium, Playwright, or Appium**, or on **Node** (Playwright Test, Cypress, or anything that writes PNGs) — or you're willing to drive Furan's REST API directly.

If you're an enterprise needing SSO / SCIM / SAML or multi-organization tenancy, Furan is not there yet. See [Status and roadmap](#status-and-roadmap).

## What you get

- **Image-first diff pipeline** — the rendered screenshot is the source of truth: per-project pixel comparison (`odiff` / `pixelmatch` / `looks-same`) or an optional **VLM mode** (Ollama / Gemini / Anthropic) that runs pixel-first and only invokes a vision model when a pixel diff is detected. Per-region severity scoring, plus an opt-in `axe-core` accessibility pass.
- **Diff viewer** — `pixi.js`-based renderer with side-by-side / overlay / onion-skin / heatmap modes, per-region keyboard nav, ignore-region drawing, and inline review comments.
- **Element-anchored ignore regions** — drag-draw a region over a button; the SDK captures its CSS selector at snapshot time so the mask survives layout reflows. Falls back to bounding-box masking when the element can't be resolved.
- **Dynamic text regions** — regex-anchored ignore regions with OCR (tesseract.js); the region is only masked when the extracted text matches your pattern, so real layout changes underneath dynamic dates / order numbers still surface as diffs.
- **Branch-aware baselines** — feature branch → PR base → default branch fallback chain with atomic promotion when a PR merges. Feature work doesn't pollute `main`'s baselines.
- **GitHub App** — sticky PR comments, `furan/baselines` status check, auto-promote on merge.
- **JVM SDK family** — `furan-selenium`, `furan-playwright`, and `furan-appium` on Maven Central (`4.2.0`), each a drop-in for a JUnit 5 suite on that driver over a shared capture core, plus a `furan-junit5` `@FuranTest` annotation.
- **JavaScript / TypeScript** — `furan upload` (`@furan/cli`) sends PNG folders from any CI and fails the job when a screenshot needs review, with a GitHub Action around it; `@furan/playwright` is a Playwright Test fixture (`await furan.check("cart")`); `@furan/client` is the zero-dependency client underneath. See [`docs/integrations/javascript.md`](docs/integrations/javascript.md).
- **Access control & audit** — four-tier role hierarchy (owner ⊇ admin ⊇ editor ⊇ guest) enforced per request, an admin audit-log viewer, and an opt-in Postgres row-level-security backstop for tenant isolation.
- **OpenAPI 3.1 spec** — `GET /openapi.json` on the API. **Interactive API reference** (Scalar) at the API's `/docs`: `http://<host>:8080/api/docs` on the one-file install.
- **Operations** — per-project retention TTL, nightly Postgres backup sidecar, restore + api-down runbooks.
- **Container images** — multi-arch (amd64 / arm64), cosign-signed (keyless OIDC), Trivy CRITICAL/HIGH scanned, SBOM per release.
- **Apache 2.0** — no telemetry on the server, no feature gates, no upgrade pressure.

## See it in action

A visual regression caught in review: a CI run's screenshot no longer matches the approved baseline, so Furan flags it, highlights the **exact changed regions** (here: a new badge, the price `$9 → $12`, and the CTA), and scores the severity. **Approve** to accept the new look as the baseline, or **Reject** to keep the old one.

![Furan diff viewer — side-by-side baseline vs current with the changed regions highlighted and a 2.01% pixel-diff / 2-region / Minor-severity summary](docs/images/demo-03-diff.png)

Each CI run lands in a review queue, grouped by status (unresolved changes vs. passing checkpoints):

![Furan review queue — recent batch runs showing an unresolved build and a passed baseline, with a per-checkpoint results table](docs/images/demo-02-review.png)

> Everything above runs on the [one-file install](#fastest-install-evaluation) below — sign in, push a screenshot from your CI or the SDK, and review the diff in the dashboard. _(Screenshots are from a live `furan-compose.yml` deploy; the sample app is a mock pricing page.)_

## Fastest install (evaluation)

One file, one command, no clone and no `.env` — like ReportPortal:

```bash
curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
docker compose -f furan-compose.yml up -d
# open http://localhost:8080  →  sign in as  admin@furan.local / FuranAdmin123!
```

nginx serves the whole thing on `:8080`; migrations self-apply from the image. This ships **default credentials and a default JWT secret** for zero-friction evaluation — before anything network-reachable, override `FURAN_BOOTSTRAP_ADMIN_PASSWORD`, `JWT_SECRET`, `POSTGRES_PASSWORD`, and `MINIO_ROOT_PASSWORD` (export them before `up`), or keep the defaults off the network with `FURAN_BIND=127.0.0.1`. For a hardened, secret-generating install use [`./deploy.sh`](deploy.sh) or the [production install](docs/install/compose.md).

> **v1.1.29+** is single-origin: nginx on `:8080` serves both the UI and the API, so the dashboard works from **any** browser (browse `http://<host>:8080`), not just the Docker host. Over plain http the password and the session cross the network unencrypted, so beyond a trusted network put HTTPS in front ([`reverse-proxy-tls.md`](docs/runbooks/reverse-proxy-tls.md)).

## Documentation

Everything else (installing for production, sending screenshots, approving
baselines, CI, operations) lives in the **documentation portal**: published at
<https://qasecret.github.io/furan-monorepo/> with each release, served at
`/docs` on your own install (for example `http://localhost:8080/docs`; releases
after v1.1.32) so it matches the version you run, and written in [`docs/`](docs/README.md) here.

- [Getting started](docs/getting-started/install.md): from the one-file install to your first reviewed diff, in seven short pages.
- [Production install (Docker Compose)](docs/install/compose.md), and the [production deploy runbook](docs/runbooks/production-deploy.md) for upgrades and image ↔ migration lockstep.
- [Kotlin SDK](docs/sdk/kotlin.mdx) (Selenium, Playwright, Appium), [JavaScript / TypeScript](docs/integrations/javascript.md) (`furan upload`, the Playwright fixture, the client) and [REST API upload](docs/sdk/rest.md).
- CI: [GitHub Actions](docs/integrations/github-actions.md) (PR comments and a `furan/baselines` status check), [Jenkins](docs/integrations/jenkins.md), [GitLab CI](docs/integrations/gitlab-ci.md) and the [GitHub App](docs/integrations/github-app.md).
- [First-install problems](docs/troubleshooting/first-install.md) and the operations runbooks: [HTTPS on a domain](docs/runbooks/reverse-proxy-tls.md), [storage backends](docs/runbooks/storage-backends.md), [backup and restore](docs/runbooks/restore-from-backup.md), [API down](docs/runbooks/api-down.md).

Working on Furan itself? See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [development setup](docs/maintainers/development.md).

## Repository layout

```
furan-monorepo/
├── apps/
│   ├── api/              Fastify + tRPC + Drizzle backend (REST + /trpc)
│   ├── dashboard/        Next.js 15 + React 19 + pixi.js diff viewer
│   ├── capture-worker/   Playwright + sharp; BullMQ consumer
│   ├── diff-worker/      diff-engine consumer (BullMQ)
│   ├── integrations/     GitHub App + Slack webhook
│   └── docs/             Docusaurus documentation portal (served at /docs)
├── packages/
│   ├── client/           @furan/client — JS/TS REST client (npm)
│   ├── cli/              @furan/cli — `furan upload` + the GitHub Action (npm)
│   ├── playwright/       @furan/playwright — Playwright Test fixture (npm)
│   ├── db/               Drizzle schema + migrations + scope helpers
│   ├── diff-engine/      Image-first: pixel (odiff/pixelmatch/looks-same) + VLM + axe
│   ├── rules-engine/     Project auto-rules that auto-resolve known diffs
│   ├── sdk-kotlin/       Kotlin/JVM SDK (core + selenium/playwright/appium adapters)
│   ├── storage/          S3 (MinIO-compatible) + HDD storage backends
│   ├── queue/            BullMQ wrappers
│   ├── telemetry/        pino + OpenTelemetry + prom-client
│   └── shared-types/     Zod schemas shared across apps
├── infra/docker/         compose.yml + dev overlay + backup sidecar
└── docs/                 portal content: getting-started/, install/, sdk/, runbooks/, …
```

## Status and roadmap

**v1.1.33 is the current release** (2026-11-01). Use it rather than v1.1.32: the release scan stopped v1.1.32's api, capture-worker, diff-worker and integrations images, so only its dashboard was published. v1.1.33 patches the two HIGH advisories that scan found (systeminformation CVE-2026-116576 in the api and workers, libbrotli CVE-2026-111497 in the capture worker) and ships everything v1.1.32 was meant to. It fixes a dashboard opened over plain http: on v1.1.31 and earlier, signing in from another machine (`http://<host>:8080`) did not keep the session in any browser, Safari lost it even on `http://localhost:8080`, and drawing or pasting ignore regions failed. It also moves request validation to zod 4.6.7 (CVE-2023-54404), so the build no longer carries an exception for it; API validation messages now use zod 4's wording, while status codes and Furan's own error codes are unchanged. v1.1.31 (2026-10-28) was a security release that also shipped the new review flow, so everyone on v1.1.30 or earlier should upgrade: Next.js 15.5.28 fixes a critical advisory (GHSA-2464-fhr4-w9xw, remote code execution through image optimization) and a Server Actions denial of service; undici, Fastify, fast-uri and ip-address are patched; and request bodies are capped at 1 MB (50 MB only for screenshot uploads), with every list in a request size-checked before it is validated. Review: decide per checkpoint and undo until the decision is superseded; a review loop that walks pending steps (J/K, Next pending, Start reviewing) with a command palette and a keyboard cursor; and a diff viewer with five comparison modes (including Swipe and Flicker), the mode kept in the link, and a resizable details rail. Pipeline: each step is diffed in its own job against its own baseline, a failed step shows why and can be retried, and approvals cover every checkpoint, keep saved ignore regions and are audited. Also new: light and graphite-dark themes on semantic design tokens, `/metrics` series for diff jobs, queue depth and HTTP/tRPC latency, and a one-file install whose nginx lets screenshot-sized uploads through. Upgrading from v1.1.31 applies no database migrations; from v1.1.30 it applies eight (0035–0042), so back up first. All images are cosign-signed, Trivy-scanned, and multi-arch (amd64 / arm64). Beyond the v1.0 baseline, the v1.1 line adds the Playwright and Appium SDK adapters, the image-first Visual-AI (VLM) diff layer, an opt-in Postgres row-level-security tenant-isolation backstop, an audit log with an admin viewer, a four-tier role hierarchy, and a one-file, single-origin quick-start install. Feedback from early installers is very welcome — [open an issue](https://github.com/qasecret/furan-monorepo/issues).

Not yet built (no schedule, will land when there's user signal):

- **More SDKs** — Python, C#, plus a Cypress plugin and Storybook. The JVM adapters (Selenium, Playwright, Appium) and the JavaScript / TypeScript packages (`furan upload`, the Playwright Test fixture, the client) already ship.
- **More VCS integrations** — GitLab, Bitbucket, Azure DevOps. The GitHub App already ships.
- **Enterprise identity** — SSO / SCIM / SAML and multi-organization tenancy. Furan is single-organization today; role-based access control and the audit log already ship.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the services, data flow, and key design decisions. Detailed design notes and decision records are maintained by the core team.

## License and governance

- [LICENSE](LICENSE) — Apache 2.0
- [SECURITY.md](SECURITY.md) — vulnerability disclosure policy
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO sign-off, setup, conventions
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [ARCHITECTURE.md](ARCHITECTURE.md) — services, data flow, and key design decisions
