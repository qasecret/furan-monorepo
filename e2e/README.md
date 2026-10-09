# @furan/e2e — end-to-end test suite

Boots a **Docker-from-HEAD** Furan deployment and validates it end to end —
deploy → SDK-triggered runs → diff pipeline → dashboard UI — across the major
configs, emitting a **capability-coverage matrix**. Playwright Test is the
runner; a TypeScript "virtual SDK" replays the SDK's REST wire flow for breadth.

Design/plan: `furan-design/specs/2026-07-02-e2e-suite-design.md`,
`furan-design/plans/2026-07-02-e2e-suite.md`.

## Run it

```bash
# One shot: build images (if missing) → compose up (S3) → seed → test → down
pnpm --filter @furan/e2e e2e

# Keep the stack up between iterations, then run Playwright directly:
pnpm --filter @furan/e2e e2e:up
E2E_API_URL=http://localhost:3010 E2E_DASH_URL=http://localhost:3011 \
  pnpm --filter @furan/e2e exec playwright test --project=s3-full
pnpm --filter @furan/e2e e2e:down

# HDD storage smoke (separate deployment):
pnpm --filter @furan/e2e e2e:hdd

# Coverage gate (fails only on a REGRESSED capability):
pnpm --filter @furan/e2e coverage      # reads e2e-coverage.json
```

The stack is isolated on host ports **3010** (api) / **3011** (dashboard) via
`scripts/compose.e2e-ports.yml` so it coexists with a dev `pnpm dev` on
3000/3001. The overlay replaces the base port mappings with Compose's
`!override` YAML tag, which needs **Docker Compose ≥ 2.24.4** (`docker compose
version`); older versions don't support it. Output: `e2e-coverage.md` /
`e2e-coverage.json` + `playwright-report/`.

## Visual sweep

`tests/ui/visual-sweep.spec.ts` (tag `@visual`, project `visual`, never part of
`s3-full` or CI) captures every dashboard route in **light** and **dark** as a
full-page PNG at a 1440×900 viewport, plus the interaction states in
`STATES` (⌘K open, a menu open, a dialog open), and runs axe `color-contrast`
on each. The dashboard scrolls inside its own containers, never the document,
so before capturing, `src/visual/unclip.ts` lets those containers grow to
their content: the PNG and axe cover the whole page, not just the first
900px. It fails the route if any part of the page is still clipped
afterwards, so a dashboard layout change can't quietly shrink the shot.

It is the before/after safety net for dashboard UI changes. A contrast
problem is an axe violation, or a node axe could not measure because it lies
outside the viewport. Every route and state is checked, in both themes:
problems are reported as test annotations (also written to
`visual-out/<label>/color-contrast.json`) and collected, and the
`contrast-enforced` test, which runs after both theme passes, fails once per
theme with that theme's whole list. Uncaught page errors are annotated `pageerror`
(hiding Next's dev overlay also hides its error dialog). A route answering
4xx/5xx fails; a route that redirects elsewhere is annotated
`landed-elsewhere`. Routes admins are redirected away from (`as: "editor"`:
`/account/tokens`, `/projects`) are captured from the seeded editor's
session.

The dashboard runs as a **dev server** rather than the stack's dashboard image:
the image bakes `localhost:3000` for client-side calls, so the diff viewer's
images would not load on the remapped ports. A dev server compiles each route
on its first visit, so `beforeAll` visits every static route once before the
theme passes, and a navigation that times out (90s) is retried once
(annotated `nav-retry`). Every browser context sets
`reducedMotion: "reduce"`, so the diff canvas draws its region ring static
and the `run` and `diff` shots come out byte-identical from run to run.

```bash
pnpm --filter @furan/e2e e2e:up
NEXT_PUBLIC_API_URL=http://localhost:3010 API_INTERNAL_URL=http://localhost:3010 \
  pnpm --filter @furan/dashboard exec next dev --port 3012
E2E_API_URL=http://localhost:3010 E2E_DASH_URL=http://localhost:3012 VISUAL_LABEL=before \
  pnpm --filter @furan/e2e exec playwright test --project=visual
```

Then check out the branch in that worktree (the dev server hot-reloads) and
re-run with `VISUAL_LABEL=after`. PNGs land in
`visual-out/<VISUAL_LABEL>/<theme>/<route>.png` (override the root with
`VISUAL_OUT`); the fixture project's IDs are kept in `.visual-sweep.json` so
both runs capture the same data. Both are gitignored. The fixture also makes
that project the bootstrap admin's default project (keeping its other
memberships), so `/inbox` captures the batches table rather than "No project
assigned".

**Or against a dev stack.** Any running api + diff-worker whose bootstrap admin
is `e2e-admin@furan.test` (see `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD` in
`scripts/compose.ts`), and whose `FURAN_DASHBOARD_ORIGIN` allows the dashboard
dev server, works the same way — point the two URLs at it, e.g. one dashboard
dev server per checkout so `before` and `after` can run back to back:

```bash
E2E_API_URL=http://localhost:<api> E2E_DASH_URL=http://localhost:<dash-on-main> VISUAL_LABEL=before \
  pnpm --filter @furan/e2e exec playwright test --project=visual
E2E_API_URL=http://localhost:<api> E2E_DASH_URL=http://localhost:<dash-on-branch> VISUAL_LABEL=after \
  pnpm --filter @furan/e2e exec playwright test --project=visual
```

**Passing.** On a dashboard with the design foundation (PR 1 onward), every
test must pass. A `before` run against an older `main` is the exception: that
dashboard had no system theme, so `system theme follows prefers-color-scheme`
fails, and its screens predate the AA token palette, so `contrast-enforced`
can fail too (which then skips the system-theme test). Both run last, after
every screenshot test, so neither failure skips a shot. For such a run, "pass"
means every screenshot test passed.

**What the sweep does not cover.** A green sweep says nothing about:

- **The project, builds, build and runs screens as such.** `project`,
  `builds`, `build` and `runs` all redirect to the fixture's batch page, so
  those four shots are the same screen.
- **States the fixture never renders:** multi-checkpoint step arrows, empty
  and error states, a selected region, menus opened from the keyboard,
  settings tabs other than the default, and toasts.
- **Contrast axe cannot decide.** axe `incomplete` results (text over an
  image or gradient, overlapped or pseudo-element backgrounds, …) are counted
  by reason (`messageKey`) per shot in `color-contrast.json` and annotated
  `color-contrast-incomplete`. They are reported, not enforced: only
  `outsideViewport` counts toward `contrast-enforced`.

**Reviewing in Furan:**

1. Set `FURAN_VISUAL_URL`, `FURAN_VISUAL_PAT` and `FURAN_VISUAL_PROJECT_ID` to
   point at any Furan instance other than this e2e stack; each run then
   uploads its shots as build `sweep-<VISUAL_LABEL>` on branch
   `FURAN_VISUAL_BRANCH` (default `visual-sweep`). Keep that branch the same
   for `before` and `after`: baselines are per branch, so an `after` build on
   another branch would show every screen as new instead of diffed.
2. Approve every run in the `before` build there to make the shots the
   baseline.
3. The `after` build then shows each screen's diff in the diff viewer.

## Prerequisites

- A healthy **Docker daemon** (the from-HEAD image build is heavy). If a build
  fails with a BuildKit I/O error, `docker builder prune -f` / restart Docker.
- The 5 `qasecret/furan-*:local` images (the orchestrator builds any missing).
- `playwright install chromium` (once) for the UI tests.
- Optional: a JDK (real Kotlin-SDK smoke) and a local **ollama** (VLM layer) —
  absent → those capabilities are marked _config-gated_, not failed.

## Layout

```
scripts/    e2e.ts (orchestrator) · compose.ts · wait-health.ts · global-setup.ts
            check-coverage.ts · compose.e2e-ports.yml
src/        env.ts (canonical URLs) · clients/{api-client,virtual-sdk} ·
            seed/{seed,load-seed} · coverage/{manifest,reporter} · fixtures/*.png ·
            visual/{fixture,routes,masks,unclip,upload}
tests/      deploy · sdk · diff · rbac · branch · storage · ui
```

## Coverage matrix

`src/coverage/manifest.ts` is the capability denominator; each test tags the
IDs it covers via `coverAnnotations([...])`; the reporter renders
`area → capability → state` (passed / failed / config-gated / MISSING). Add a
capability by adding it to the manifest and tagging a test.

## Known constraints

- **`ui.diff_viewer` is skipped on the coexistence ports.** The dashboard
  browser bundle bakes `NEXT_PUBLIC_API_URL` at build time (default
  `localhost:3000`) for _client-side_ fetches, while SSR reads it from the
  runtime env. With the api remapped to 3010, no single baked URL serves both.
  Server-rendered pages (login, builds, admin) work; client-data pages (the
  pixi diff viewer) need the api on the standard port **3000** — a
  dedicated-ports run (stop dev servers) or CI.
- **`branch.parent_fallback` is skipped** pending a product-side investigation
  (an identical feature-branch capture returns `new`, not `passed`).
- **Element-map-dependent** diff capabilities (ignore/layout regions, axe a11y,
  auto-rules) need the multipart + element-map upload path; the base64 variant
  the virtual-SDK uses omits `matchLevel`/`regions`.

## CI

`.github/workflows/e2e.yml` runs this suite on `workflow_dispatch` + a nightly
schedule — never on push/PR (too heavy, and needs a full compose stack). It
synthesizes an ephemeral `infra/docker/.env` with runtime-random secrets,
builds the images, runs `e2e:s3`, gates on coverage, and uploads the matrix +
report.
