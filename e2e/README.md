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

# Build the stack's images from HEAD (only those missing):
pnpm --filter @furan/e2e e2e:images

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

The stack is isolated on host ports **3010** / **3011** via
`scripts/compose.e2e.yml` so it coexists with a dev `pnpm dev` on 3000/3001:

- **3010** is the api, which the test clients (`ApiClient`, the virtual SDK)
  call directly.
- **3011** is the browser's **single origin**: nginx serving the dashboard,
  with the api under `/api/`, the same shape as `infra/docker/furan-compose.yml`.
  The dashboard image is the `-proxy` variant (`:local-proxy`, built with
  `NEXT_PUBLIC_API_URL=/api`), so its browser bundle fetches the relative
  `/api/...` and client-side data (the diff viewer's run and screenshots, the
  review flow's decisions) works on the remapped port. SSR and Server Actions
  reach the api over the compose network (`API_INTERNAL_URL`).

The overlay replaces the base port mappings with Compose's `!override` /
`!reset` YAML tags, which need **Docker Compose ≥ 2.24.4** (`docker compose
version`); older versions don't support them. Output: `e2e-coverage.md` /
`e2e-coverage.json` + `playwright-report/`.

## Visual sweep

`tests/ui/visual-sweep.spec.ts` (tag `@visual`, project `visual`, never part of
`s3-full` or CI) captures every dashboard route in **light** and **dark** as a
full-page PNG at a 1440×900 viewport (the states that resize the window are
named below), plus the interaction states in
`STATES` (the ⌘K palette on the viewer's actions and searching batches, the `?`
sheet on each page, the Help menu, a menu open, a dialog open, the list cursor
on a Batches row and on a step card, the top bar at tablet and phone widths, a
step card hovered, a decided step, the Approve-pending question, a batch's
viewport filter open and matching nothing, the batch-done card, the Undo
toast), and runs axe `color-contrast` on each. The dashboard scrolls inside
its own containers, never the document, so before capturing,
`src/visual/unclip.ts` lets those containers grow to their content: the PNG
and axe cover the whole page, not just the first 900px. It fails the route if
any part of the page is still clipped afterwards, so a dashboard layout change
can't quietly shrink the shot.

It is the before/after safety net for dashboard UI changes. A contrast
problem is an axe violation, or a node axe could not measure because it lies
outside the viewport. Every route and state is checked, in both themes:
problems are reported as test annotations (also written to
`visual-out/<label>/color-contrast.json`) and collected, and the
`contrast-enforced` test, which runs after both theme passes, fails once per
theme with that theme's whole list. Uncaught page errors are annotated `pageerror`
(hiding Next's dev overlay also hides its error dialog). A route answering
4xx/5xx fails; a route that redirects elsewhere is annotated
`landed-elsewhere`. The routes the dashboard redirects on the client
(`project`, `builds`, `runs`, `run`, `run-multi`) declare where they must
land (`lands`), and the sweep waits for it before the shot, failing if the
page stays put. Routes admins are redirected away from (`as: "editor"`:
`/account/tokens`, `/projects`) are captured from the seeded editor's
session.

The dashboard runs as a **dev server** rather than the stack's dashboard image,
so a checkout switch between `before` and `after` shows up without rebuilding
the image. A dev server compiles each route
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
both runs capture the same data. Both are gitignored. A `.visual-sweep.json`
from before the multi-step run or the loop batch existed is upgraded in
place: the project and everything it holds stay as they are, and only the
missing batch is added (the file is written after each addition). The fixture
holds three batches: the single-step build, the multi-step build, and a
"loop" batch (two runs, one at a phone viewport, each with one pending changed
step) that is always the newest. The fixture also makes
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

- **The project, builds and runs screens as such.** `project`, `builds` and
  `runs` redirect to the latest batch (the loop batch), so those three shots
  are the same screen. The loop batch has no dedicated route; those three
  shots show it. `build` shows the single-step build and `build-multi` the
  multi-step one.
- **States the fixture never renders:** error states, empty states other
  than a filter that matches nothing, a selected region, menus opened from
  the keyboard, settings tabs other than the default, and toasts other than
  the review Undo toast. (The multi-step run
  covers step arrows and the approved, rejected and pending-`new` steps;
  `state-step-hover` covers a step card's hover toolbar; `state-decided-step`
  the decision chip; `state-approve-pending` the Approve-pending question;
  `state-facets-open` the loop batch's Viewport filter open;
  `state-filtered-empty` a shared link whose filter matches nothing;
  `state-batch-done` the card J raises at a batch's end, here "Done with the
  filtered steps"; `state-undo-toast` the toast with its Undo action.) The
  keyboard and command surface adds `state-palette-actions` (the viewer's
  Actions group), `state-palette-search` (typing "visual"), `state-sheet-batches`,
  `state-sheet-batch` and `state-sheet-viewer` (the `?` sheet), `state-help-menu`,
  `state-cursor-batches` and `state-cursor-step` (the cursor's focus ring).
  Each waits for what it shows (and, for the palette search, that the selected
  row is the first batch). Five also measure, and resize the window to do it:
  `state-cursor-batches-scrolled` and `state-cursor-batch-scrolled` (a short
  window; End, then K back up: no row or step is under the
  sticky header), `state-cursor-step-sideways` (a narrower window; a card's
  ring clears the sideways scroller's edges) and `state-topbar-tablet` /
  `state-topbar-phone` (768 and 375 wide; the project label and the palette
  button do not overlap, the bar does not scroll sideways). Not covered here: the stale-step Confirm moving the cursor
  on (it needs a step with a newer capture, which the fixture does not have);
  it is checked in the dashboard's jsdom tests only. The
  All caught up card is not reachable here: the fixture always has pending
  work. `tests/ui/review-loop.spec.ts` shoots it instead, with the same axe
  `color-contrast` check in both themes (see Coverage matrix).
- **Contrast axe cannot decide.** axe `incomplete` results (text over an
  image or gradient, overlapped or pseudo-element backgrounds, …) are counted
  by reason (`messageKey`) per shot in `color-contrast.json` and annotated
  `color-contrast-incomplete`. They are reported, not enforced: only
  `outsideViewport` counts toward `contrast-enforced`.

**A state that changes the fixture** (`state-undo-toast` approves the pending
`profile` step to raise its toast) gives its `VisualState` a `cleanup`. The
sweep runs it after the shot, in a `finally`, whether or not the shot
succeeded: if the state clicked Approve it first waits (up to 15s) for that
request to land or answer, so it cannot look before the approval commits; it
then takes the decision back through the API and waits (up to 60s: an undo
queues a re-diff) until every step has a verdict and `profile` reads `new`
again, or fails the state. Such states are kept last in `STATES`, and the
fixture must be left as it was found: every state, and both themes, share it.
The other states never confirm or change anything. The ones that resize the
viewport (to make a list scroll, or to check the top bar at 768 and 375px) put
it back in their `cleanup`, so the next state opens at 1440×900.

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
- The stack's images, listed in `IMAGES` (`scripts/compose.ts`): four
  `qasecret/furan-*:local` (as in `infra/docker/compose.local-all.yml`) and the
  single-origin `qasecret/furan-dashboard:local-proxy`. The orchestrator builds
  any that are missing; present ones are reused as they are, so rebuild (or
  `docker image rm`) after pulling new code.
- `playwright install chromium` (once) for the UI tests.
- Optional: a JDK (real Kotlin-SDK smoke) and a local **ollama** (VLM layer) —
  absent → those capabilities are marked _config-gated_, not failed.

## Layout

```
scripts/    e2e.ts (orchestrator) · compose.ts · wait-health.ts · global-setup.ts
            check-coverage.ts · compose.e2e.yml
src/        env.ts (canonical URLs) · clients/{api-client,virtual-sdk} ·
            seed/{seed,load-seed} · coverage/{manifest,reporter} · fixtures/*.png ·
            visual/{fixture,routes,masks,unclip,upload}
tests/      deploy · sdk · diff · rbac · branch · review · storage · ui
```

## Coverage matrix

`src/coverage/manifest.ts` is the capability denominator; each test tags the
IDs it covers via `coverAnnotations([...])`; the reporter renders
`area → capability → state` (passed / failed / config-gated / MISSING). Add a
capability by adding it to the manifest and tagging a test.

`tests/ui/review-flow.spec.ts` (capability `review.ui_flow`, not `@visual`)
drives the review flow in a real browser on data of its own: a project
`review-flow-ui` and, per run, a branch of its own. It approves a step with `A`,
takes it back with Ctrl+Z / ⌘Z, then confirms "Approve pending" on the batch
page. It never touches the visual sweep's fixture. It runs in `s3-full`: like
the diff viewer, it reads and writes through the dashboard's client-side calls,
which reach the api through the stack's single origin (3011).

`tests/ui/review-loop.spec.ts` (capability `review.loop`, not `@visual`)
drives the review loop in a real browser, also on data of its own, in a
project created fresh for every run (`review-loop-ui-<timestamp>`): "Start
reviewing" and "All caught up" speak for the whole project, so nothing may be
pending there but this run's steps. Two batches need review on one branch, an
older one with two tests and a newer one with one. From Batches (Needs review,
"Start reviewing (2)") it opens the newer batch, approves with `A`, continues
from the "Batch done" card to the older one with Enter, approves its first
test and is moved to the second with the "Next test" cue, and approves that to
reach "All caught up". That card is shot, and checked with axe
`color-contrast`, in light and dark (problems fail the test, as in the sweep).
It then goes back to a batch from the viewer with a `viewport` filter set and
checks the filter is kept, and opens an old `/runs/:r/diffs/:step` link to
check it lands on that exact step. Batches lists the signed-in user's default
project, so for its run the spec makes its project the bootstrap admin's
default (keeping their memberships) and puts the old assignment back in
`afterAll`. It runs in `s3-full`, like `review-flow.spec.ts`.

## Known constraints

- **The bootstrap admin can sign in 10 times per 15 minutes** (the api's
  per-account login brake, ADR-063). A run signs in 5 times (the seeder, then
  the login, dashboard, review-flow and review-loop specs), so repeated
  Playwright runs against a kept stack trip it after a few iterations: the
  login form then reads "Invalid email or password" and the api logs
  `login_account_rate_limited` (429). Wait out the window, or recreate the
  stack (`e2e:down` / `e2e:up`).
- **`branch.parent_fallback` is skipped** pending a product-side investigation
  (an identical feature-branch capture returns `new`, not `passed`).
- **Element-map-dependent** diff capabilities (ignore/layout regions, axe a11y,
  auto-rules) need the multipart + element-map upload path; the base64 variant
  the virtual-SDK uses omits `matchLevel`/`regions`.

## CI

`.github/workflows/e2e.yml` runs this suite on `workflow_dispatch` + a nightly
schedule — never on push/PR (too heavy, and needs a full compose stack). It
synthesizes an ephemeral `infra/docker/.env` with runtime-random secrets,
builds the images (`e2e:images`), runs `e2e:s3`, gates on coverage, and uploads
the matrix + report.
