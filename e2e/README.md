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
from before the multi-step run, the loop batch or the size-mismatch step
existed is upgraded in place: the project and everything it holds stay as
they are, and only the missing part is added (the file is written after each
addition). The fixture holds three batches: the single-step build, the
multi-step build, and a "loop" batch (two runs, one at a phone viewport, each
with one pending changed step) that is always the newest. The fixture also
makes that project the bootstrap admin's default project (keeping its other
memberships), so `/inbox` captures the batches table rather than "No project
assigned".

The fixture's last part, `mismatch`, is a step whose screenshots differ in
size: a 1280×800 baseline, approved, and a 1280×1100 current screenshot
compared with it and left undecided. It is `unresolved`, and the fixture
accepts nothing else: every engine, odiff (the default) included, fails a
size change as a 100% diff with no diff image or regions, unless the project
turned on "Allow diff dimensions", which this one has not. Both are drawn
with `sharp` and uploaded through
`src/visual/upload.ts`. It lives in a project of its own,
`visual-sweep-mismatch`, so the sweep's project keeps the loop batch as its
newest batch and its batches table as it is; that project is shown only in
the admin's project list. It is reused like the rest, and added again when its
project is gone.

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
  window; End, then K back up: no row or step, ring included, is under the
  sticky header), `state-cursor-step-sideways` (a narrower window; a card's
  ring clears the sideways scroller's edges) and `state-topbar-tablet` /
  `state-topbar-phone` (768 and 375 wide; the project label and the palette
  button do not overlap, the bar does not scroll sideways). The diff viewer's
  comparison modes and its rail add, on the single-step run's changed step:
  `state-mode-swipe` (key 2: the "Swipe position" slider reads 50, "50%
  baseline", and the divider is in the middle of the stage),
  `state-mode-flicker-baseline` and `state-mode-flicker-current` (key 3, with
  motion allowed: Flicker plays, `f` pauses it, `f` swaps it by hand to that
  frame, the canvas label names it and stays; reduced motion is back for the
  shot), `state-mode-overlay` (key 4: "Current over baseline" at 50% opacity),
  `state-mode-diff` (key 5: the step's own diff image, so no message),
  `state-rail-collapsed` (`t` collapses, opens and collapses the rail: the
  40px strip's "Show details", Info, History and Comments),
  `state-rail-wide` (End on "Resize details" takes the rail to 560px in the
  1440px window) and `state-editor-rail` (`i`: one rail, the "Ignore regions"
  landmark and no "Details"; `t` collapses it to one "Ignore regions (N)"
  button and opens it again). On the size-mismatch step: `state-size-mismatch`
  (side by side: the size chip names both sizes, and pane A's hatching, the
  bottom 300px of 1100, has a hit area titled "Not in the baseline") and
  `state-size-mismatch-diff` (key 5: the spec's message, verbatim). Each mode
  state checks its radio, the URL's `?view` and the stored preference; none
  samples the canvas's pixels or counts its image requests
  (`tests/ui/viewer-compare.spec.ts` does, see Coverage matrix). Not covered here:
  the stale-step Confirm moving the cursor
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
it back in their `cleanup`, so the next state opens at 1440×900. The viewer
states that change a viewer preference (a mode, or the rail's width or
collapsed state, stored per user in localStorage under
`furan:viewer:prefs:v1:<userId>`) note the stored preferences first and put
them back in their `cleanup`, so the next state opens the viewer side by side
with the rail open at 320px (each viewer state checks that it does). The
flicker states also put the window's reduced motion back. The `?view` a mode
writes into the URL needs no cleanup: every state starts with a navigation of
its own.

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
- `playwright install chromium webkit firefox` (once) for the UI tests: every
  UI spec runs in Chromium, and `tests/ui/viewer-compare.spec.ts` also opens
  the diff viewer in WebKit and Firefox.
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

`tests/ui/keyboard-review.spec.ts` (capability `review.keyboard`, not
`@visual`) clears two batches without the mouse: every navigation and every
decision is a key press (`page.keyboard`); only the data (through the API) and
the page loads that start the flow are not. It builds its own data in a
project created fresh for every run (`kbd-review-ui-<timestamp>`) and makes it
the bootstrap admin's default for the run, as the review-loop spec does. Two
batches need review, each of two tests with one changed step. On Batches `J`
focuses the first row and `S` starts reviewing; `A` decides the step and the
loop moves on with its cue, `A` again shows "Batch done", and Enter continues
to the older batch. On that "Batch done" card, which is not modal, `⌘K` opens
the palette and `?` the sheet, and Esc gives the card its focus back each
time. `G I` goes back to Batches; "Show: All" from the palette
(a Batches command, so the decided card stays in the list) and `J`, `J`,
Enter open the older batch. On its page `J` reaches the run's row and then a
step card; `A` makes the card read Approved and the cursor moves on to the
next step that needs review, and `⌘Z` / Ctrl+Z takes the approval back (the
server is checked each time). `⌘K` with a batch's name opens that batch
(the chosen row is the batch, and the search box names it:
`aria-activedescendant`). With the "Approve pending" question open, `G I`
keeps the page and `?` opens no sheet (and Esc then closes only the question);
with nothing open `?` opens the page's sheet and `G I` goes to Batches. Back
on the batch at its default view (Needs review), `A` on a step card takes its
run off the list and the next card has focus; `⌘Z` brings it back. Then
"Single-key shortcuts" is turned off in the Help menu (Shift+Tab to the Help
button, Enter, End, Space): `A` in the viewer does nothing and sends no
decision, while "Approve step" in the palette approves that same step; the
switch is turned back on the same way. In the viewer, `1`–`5` check each
comparison mode's radio, and only it; Tab reaches Swipe's handle, the "Swipe
position" slider, and → twice moves it from 50 to 54; with reduced motion
Flicker shows no Play and its canvas label stays "Baseline" for 1.5 s (watched
with a MutationObserver: three swaps at its rate) until `f` swaps it to
"Current" and the live region says "Showing current"; `t` folds the details
rail to its strip ("Show details") and `t` opens it again. Then axe
`color-contrast` runs on the
palette (empty and searching) and on the `?` sheet in light and dark
(problems fail the test, as in the sweep, and only symbol-only text may go
unmeasured). Last, `A` on the last pending step brings up "All caught up",
and `G I` goes to Batches from it. It runs in `s3-full`.

`tests/ui/viewer-compare.spec.ts` (capability `review.viewer_compare`, not
`@visual`) checks that the diff viewer's comparison modes draw the right
pixels and fetch each image once. It builds its own data in a project created
fresh for every run (`viewer-compare-ui-<timestamp>`), made the bootstrap
admin's default for the run as the review-loop spec does: one run of two
steps, drawn with `sharp` and uploaded through `captureRun` (whose checkpoints
can carry a PNG of their own). Step `half`'s baseline is all one colour, A,
and its current is A with a second colour, B, on its right half; step `next`
is there to step to. All six images differ, as storage keys are content
hashes.

Pixels are read from an element screenshot of the stage
(`single-stage-host`), decoded in Node with `sharp`: pixi's WebGL canvas keeps
no drawing buffer, so `toDataURL` would read blank. The samples sit at 25% and
75% of the stage's width, at mid-height, within 3 levels per channel. The
changed right half is one `major` region. Outside Diff, every single-stage
mode draws the step's regions over the images as outlines with no fill, so a
sample inside the box is the image's own colour; the spec reads the region
from the api first and fails if it is not that one box, around the right
sample and clear of the left one.

In Chromium: Swipe at 50% shows A left of the divider and B right of it; → →
on its handle reads 54, and End takes the divider to 100%, where the baseline
shows all the way across. Flicker, standing still under reduced motion, shows
the baseline, and `f` swaps it to the current. Overlay with its opacity slider
("Overlay opacity") at 100% (End) shows the current image on top. The first view requests each of
the step's three images (baseline, current, diff) once, and the next step's
three once (fetched ahead); switching through all five modes requests nothing
more; → to the next step and ← back requests nothing, after which Swipe still
draws both images, so no bitmap was closed. Then the same Swipe and Flicker
checks run in WebKit and Firefox, launched by the spec (`webkit.launch()`,
`firefox.launch()`) against the project's `baseURL` and opened with the
Chromium session (its `storageState`), so the spec signs in once. It runs in
`s3-full`.

`tests/review/viewer-step.spec.ts` (capability `review.viewer_step`, not
`@visual`) checks that the diff viewer reads one step at a time. In a project
created fresh for every run (`viewer-step-ui-<timestamp>`), made the bootstrap
admin's default for the run as the review-loop spec does, a run of three
steps is captured twice, its middle step changed the second time. Opening the
middle step must ask `runs.getStep` for it first, then for the steps either
side of it (fetched ahead), each once and no other step; the run header comes
from `runs.getById`, and `builds.getById` is never called. The step is drawn
(`data-stage-drawn` names it), the sidebar shows its own pixel diff, and its
baseline, current and diff images are fetched. It reads the tRPC calls from
the request URLs, so it works through the single origin and against a dev
stack whose api has an origin of its own. It runs in `s3-full`.

## Known constraints

- **The bootstrap admin can sign in 10 times per 15 minutes** (the api's
  per-account login brake, ADR-063). A run signs in 8 times (the seeder,
  then the login, dashboard, review-flow, review-loop, keyboard-review,
  viewer-compare and viewer-step specs; viewer-compare signs in once, in
  Chromium, and its WebKit and Firefox pages reuse that session), so repeated
  Playwright runs against a kept stack trip it after a few iterations: the login form then reads "Invalid email or password" and
  the api logs `login_account_rate_limited` (429). Wait out the window, or
  recreate the stack (`e2e:down` / `e2e:up`).
- **`branch.parent_fallback` is skipped** pending a product-side investigation
  (an identical feature-branch capture returns `new`, not `passed`).
- **Element-map-dependent** diff capabilities (ignore/layout regions, axe a11y,
  auto-rules) need the multipart + element-map upload path; the base64 variant
  the virtual-SDK uses omits `matchLevel`/`regions`.

## CI

`.github/workflows/e2e.yml` runs this suite on `workflow_dispatch` + a nightly
schedule — never on push/PR (too heavy, and needs a full compose stack). It
installs Playwright's Chromium, WebKit and Firefox, synthesizes an ephemeral
`infra/docker/.env` with runtime-random secrets, builds the images
(`e2e:images`), runs `e2e:s3`, gates on coverage, and uploads the matrix +
report.
