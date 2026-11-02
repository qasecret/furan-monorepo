# Changelog

Release notes for the Furan **app images** (`qasecret/furan-*`, tagged
`v1.1.x`). The Kotlin SDK keeps its own changelog in
[`packages/sdk-kotlin/CHANGELOG.md`](packages/sdk-kotlin/CHANGELOG.md).
Earlier app releases are listed under
[Releases](https://github.com/qasecret/furan-monorepo/releases) and
[tags](https://github.com/qasecret/furan-monorepo/tags).

All images are cosign-signed, Trivy-scanned, and multi-arch (amd64 / arm64).

## v1.1.33 — 2026-11-01

Use this release rather than v1.1.32: the release scan stopped v1.1.32's api,
capture-worker, diff-worker and integrations images, so only its dashboard was
published. v1.1.33 ships everything v1.1.32 was meant to.

### Security

- Patches the two HIGH advisories the v1.1.32 scan found: systeminformation
  CVE-2026-116576 (api and workers) and libbrotli CVE-2026-111497 (capture
  worker).
- Moves request validation to zod 4.6.7 (CVE-2023-54404), so the build no
  longer carries an exception for it. API validation messages now use zod 4's
  wording; status codes and Furan's own error codes are unchanged.

### Fixes

- A dashboard opened over plain http now keeps its session. On v1.1.31 and
  earlier, signing in from another machine (`http://<host>:8080`) did not keep
  the session in any browser, Safari lost it even on `http://localhost:8080`,
  and drawing or pasting ignore regions failed.

### Upgrading

- From v1.1.31: no database migrations.
- From v1.1.30 or earlier: applies eight migrations (0035–0042), so back up
  first.

## v1.1.32 — 2026-11-01

Superseded by v1.1.33. Only the dashboard image was published.

## v1.1.31 — 2026-10-28

A security release that also ships the new review flow. Everyone on v1.1.30 or
earlier should upgrade.

### Security

- Next.js 15.5.28 fixes a critical advisory (GHSA-2464-fhr4-w9xw, remote code
  execution through image optimization) and a Server Actions denial of service.
- undici, Fastify, fast-uri and ip-address are patched.
- Request bodies are capped at 1 MB (50 MB only for screenshot uploads), and
  every list in a request is size-checked before it is validated.

### Review

- Decide per checkpoint, and undo until the decision is superseded.
- A review loop that walks pending steps (J/K, Next pending, Start reviewing),
  with a command palette and a keyboard cursor.
- A diff viewer with five comparison modes (side by side, swipe, flicker,
  overlay, diff), the mode kept in the link, and a resizable details rail.

### Pipeline

- Each step is diffed in its own job against its own baseline.
- A failed step shows why and can be retried.
- Approvals cover every checkpoint, keep saved ignore regions, and are audited.

### Also new

- Light and graphite-dark themes on semantic design tokens.
- `/metrics` series for diff jobs, queue depth, and HTTP/tRPC latency.
- The one-file install's nginx lets screenshot-sized uploads through.

## The v1.1 line

Beyond the v1.0 baseline, the v1.1 line adds the Playwright and Appium SDK
adapters, the image-first Visual-AI (VLM) diff layer, an opt-in Postgres
row-level-security tenant-isolation backstop, an audit log with an admin
viewer, a four-tier role hierarchy, and a one-file, single-origin quick-start
install.
