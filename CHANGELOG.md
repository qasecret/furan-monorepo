# Changelog

Release notes for the Furan **app images** (`qasecret/furan-*`, tagged
`v1.1.x`). The Kotlin SDK keeps its own changelog in
[`packages/sdk-kotlin/CHANGELOG.md`](packages/sdk-kotlin/CHANGELOG.md).
Earlier app releases are listed under
[Releases](https://github.com/qasecret/furan-monorepo/releases) and
[tags](https://github.com/qasecret/furan-monorepo/tags).

All images are cosign-signed, Trivy-scanned, and multi-arch (amd64 / arm64).

## v1.1.35 — 2026-11-03

Fixes from an end-to-end run of the documentation against a real install: a
privilege escalation, small changes that failed with nothing to review, and a
stricter default for new projects. It applies one database migration.

### Security

- Only an owner can make someone an owner. An admin could create an owner, or
  promote anyone to owner, and then demote or deactivate the real owners.
  While no active owner exists, an admin still appoints the first one.
- The GitHub App verifies webhook signatures over the exact bytes GitHub
  sent. Re-serializing the body first rejected genuine deliveries whose JSON
  escaped characters differently, so their PR comment and status never came.

### Changed

- **New projects count any changed pixel as a change** (diff threshold 0%).
  Before, they started at 0.1%, under which a changed heading or price at
  1280×720 passed. Existing projects keep their threshold: check it under
  project Settings → Diff behavior.

### Fixes

- A step that fails on a small change (a timestamp, a price) now gets a region
  for it. It used to fail with no region: the viewer outlined nothing, and an
  auto rule had nothing to match, so a rule such as "Ignore timestamps" never
  resolved it. Changes inside ignore areas no longer show as regions.
- `/api/docs` opens the API reference on the one-file install. It redirected
  to `/docs/`, the documentation portal.
- An expired session, or one from a previous install, sends you to sign in
  instead of showing "No project assigned".
- The audit log shows a project change's details instead of
  `[object Object]`. The viewer's "No baseline yet" card reads as one sentence,
  and its header fits a 1024 px window.

### Kotlin SDK 5.1.0

Released alongside (Maven Central, `io.github.qasecret:furan-*:5.1.0`): a run
stays reviewable when `snapshotAndAwait` fails the test (before, it was aborted,
so the first baseline could not be saved and a change could not be approved),
and `FURAN_CI_BUILD_ID` puts a CI pipeline's tests into one batch. See
[`packages/sdk-kotlin/CHANGELOG.md`](packages/sdk-kotlin/CHANGELOG.md).

### Upgrading

- From v1.1.34: applies one migration (0047, a column default only); no
  downtime needed. Back up first as usual.
- From v1.1.33 or earlier: also read [v1.1.34](#v1134--2026-11-03)'s upgrade
  notes (four migrations, Legacy tokens).

## v1.1.34 — 2026-11-03

Scoped CI tokens, pull request feedback from CI runs, faster review on large
projects, and the documentation built into every install. It applies four
database migrations, so read [Upgrading](#upgrading) before you pull.

### Security

- API tokens are scoped, bound to a project and expire. A new token is
  **SDK & CI** (uploads and reads; it can save a new test's first baseline but
  never approves a change) or **Read-only**, works on one project or all of
  yours, and expires after 90 days by default (7 days to 1 year;
  `FURAN_PAT_MAX_LIFETIME_DAYS` sets the cap, `0` allows tokens that never
  expire). The token list shows each token's access, project, expiry, and when
  and from which address it was last used.
- A guest can no longer fetch a project's captures, diff images or element
  maps through the storage proxy (`/api/v1/storage/:key`), the one project
  read that was still open to guests. The proxy answers 404.

### New

- **Pull request feedback.** When a run made from CI completes, the GitHub App
  posts a sticky comment on the pull request and a `furan/baselines` commit
  status. The Kotlin SDK (4.3.0 and later) sends the repository, pull request
  and commit (`FURAN_REPO`, `FURAN_PR_NUMBER`, `FURAN_COMMIT_SHA`, or GitHub
  Actions' own variables).
- **Faster review on large projects.** Each run stores how many of its steps
  still need review, so the review queue, pending counts and "Needs review"
  filters no longer scan the whole project. New indexes serve the batch and run
  lists, the diff viewer reads one step at a time and prefetches its
  neighbours, and the storage proxy's access check is indexed.
- **Documentation at `/docs`.** Every install serves the documentation portal
  for its own version, with a Getting started journey and offline search. The
  empty Builds and Batches pages show how to connect the SDK, API tokens are in
  the account menu, and Getting started and Documentation are in Help and ⌘K.

### Fixes

- Regions sent with a multipart screenshot upload (the Kotlin SDK sends them
  on every upload) are stored. The route dropped them, so SDK ignore regions
  were never applied or promoted on approve. Invalid regions are refused with
  400 `invalid_regions`.
- The default image comparison engine moves to odiff 4.5.0, which changes diff
  percentages. Ignore regions hide only their own rectangle (before, they also
  hid every pixel in the same rows across the page), edge pixels of solid
  shapes count as changed (text antialiasing is still ignored), and "Allow diff
  dimensions" compares only the area both images share, whether the page grew
  or shrank. Screenshots close to their diff threshold may now fail; baselines
  and past results are unchanged.
- The capture worker runs on the Playwright image that matches its locked
  Playwright version. The images since v1.1.31 shipped a Chromium the worker
  could not launch; no capture job used it yet.

### Under the hood

- The dashboard moves to Next.js 16.

### Upgrading

- From v1.1.33: applies four migrations (0043–0046). **Back up first**, and
  follow [`server-reads-upgrade.md`](docs/runbooks/server-reads-upgrade.md):
  stop api, capture-worker and diff-worker while `migrate` runs, then verify
  the review counters.
- Existing API tokens become **Legacy** tokens. They keep working as before
  but expire 90 days after the upgrade; the dashboard shows the date. Replace
  them with scoped tokens before then.
- From v1.1.32 or earlier: also read the upgrade notes of the releases in
  between.

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
