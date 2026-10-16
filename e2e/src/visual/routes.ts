import { expect, type Locator, type Page } from "@playwright/test";

import type { ApiClient } from "../clients/api-client.js";

import type { VisualFixture } from "./fixture.js";
import { timeMasks } from "./masks.js";

/**
 * Where a route or state goes: a fixed path, or one built from the fixture
 * (whose ids are only known once `beforeAll` has made it). Resolve with
 * {@link resolvePath}.
 */
export type VisualPath = string | ((f: VisualFixture) => string);

export const resolvePath = (path: VisualPath, f: VisualFixture): string =>
  typeof path === "function" ? path(f) : path;

/**
 * Every dashboard route the visual sweep captures (spec §7.1).
 *
 * Every shot — route, discovered route and state — is also checked with axe
 * `color-contrast`, in both themes. Its problems are annotated on the test and
 * fail the single `contrast-enforced` test, which runs once after both theme
 * passes and lists every problem, per theme. A problem is an axe violation,
 * or a node axe could not measure because it lies outside the viewport.
 */
export interface VisualRoute {
  name: string;
  path: VisualPath;
  /**
   * Capture from a seeded editor session instead of the admin one: admins are
   * redirected from these routes to their `/admin/*` counterparts, so the
   * non-admin screen would otherwise never be captured.
   */
  as?: "editor";
  /**
   * For a route the dashboard redirects on the CLIENT (`/builds` and `/runs`
   * through `LatestBuildRedirect`, `_first` to the first step), after the
   * document has loaded: the pathname the page must reach before it is shot.
   * Without it a shot taken between the redirect's first render and its
   * landing is a blank right-hand pane that passes. The sweep waits for it
   * (as long as a navigation) and fails, saying where the page stayed, if it
   * is never reached. Routes that redirect on the server need none.
   */
  lands?: RegExp;
}

/** `/builds/:buildId`, the batch page a Builds index redirects to. */
const LANDS_ON_BATCH = /\/builds\/[^/]+$/;
/** A viewer on a real step: not still on the `_first` placeholder. */
const LANDS_ON_STEP = /\/runs\/[^/]+\/checkpoints\/(?!_first$)[^/]+$/;

const ADMIN_AREAS = [
  "api-keys",
  "audit-log",
  "auto-rules",
  "installations",
  "members",
  "projects",
] as const;

export function staticRoutes(f: VisualFixture): VisualRoute[] {
  const P = `/projects/${f.projectId}`;
  return [
    { name: "landing", path: "/" },
    { name: "login", path: "/login" },
    { name: "inbox", path: "/inbox" },
    { name: "analytics", path: "/analytics" },
    { name: "account-tokens", path: "/account/tokens", as: "editor" },
    ...ADMIN_AREAS.map((x) => ({ name: `admin-${x}`, path: `/admin/${x}` })),
    {
      name: "admin-project-members",
      path: `/admin/projects/${f.projectId}/members`,
    },
    { name: "projects", path: "/projects", as: "editor" },
    { name: "project", path: P, lands: LANDS_ON_BATCH },
    { name: "builds", path: `${P}/builds`, lands: LANDS_ON_BATCH },
    { name: "build", path: `${P}/builds/${f.buildId}` },
    // The multi-step run's build and run: result rows of several steps, with
    // an approved, a rejected and a pending step.
    { name: "build-multi", path: (x) => `${P}/builds/${x.multiBuildId}` },
    { name: "runs", path: `${P}/runs`, lands: LANDS_ON_BATCH },
    {
      name: "run",
      path: `${P}/runs/${f.unresolvedRunId}`,
      lands: LANDS_ON_STEP,
    },
    // `/runs/:id` redirects to its first checkpoint, whose viewer shows the
    // step arrows between the run's steps.
    {
      name: "run-multi",
      path: (x) => `${P}/runs/${x.multiRunId}`,
      lands: LANDS_ON_STEP,
    },
    { name: "settings", path: `${P}/settings` },
    { name: "variations", path: `${P}/variations` },
  ];
}

/**
 * Routes whose IDs aren't known up front: the sweep opens `from`, follows the
 * first link matching each `via` pattern in turn, then takes the FIRST
 * `a[href]` whose pathname matches `href` and captures that page. Zero
 * matching links fails the test — a missing link is itself a regression.
 *
 * Where the links actually are (checked in the DOM, 2026-10-15):
 *  - `/runs/:runId/checkpoints/:checkpointId` is linked from a variation's
 *    history table ("View diff" opens the exact step of that run), so `diff`
 *    goes variations → variation → that step. The legacy
 *    `/runs/:runId/diffs/:diffId` is only a redirect to the same step now and
 *    nothing links to it. (The run page and the viewer itself render no such
 *    anchors; they reach a step by `router.push`/`replace`.)
 *  - The `run` static route is the same viewer, reached by redirect:
 *    `/runs/:runId` goes to the run's first checkpoint.
 */
export const DISCOVERED: ReadonlyArray<{
  name: string;
  from: (f: VisualFixture) => string;
  /** Links to follow, in order, from `from` before looking for `href`. */
  via?: ReadonlyArray<RegExp>;
  href: RegExp;
}> = [
  {
    name: "diff",
    from: (f) => `/projects/${f.projectId}/variations`,
    via: [/\/variations\/[^/]+$/],
    href: /\/runs\/[^/]+\/checkpoints\/[^/]+$/,
  },
  {
    name: "variation",
    from: (f) => `/projects/${f.projectId}/variations`,
    href: /\/variations\/[^/]+$/,
  },
];

/**
 * Interaction states: open `path`, let it settle, `open` the state, then
 * capture it (and contrast-check it, as every route is).
 */
export interface VisualState {
  name: string;
  path: VisualPath;
  /** Capture from the seeded editor's session (see {@link VisualRoute.as}). */
  as?: "editor";
  /** Put the settled page into the state; resolves once the state shows. */
  open: (p: Page) => Promise<void>;
  /**
   * For a state the POINTER holds (a hover): runs after the page is un-clipped,
   * just before the shot. The sweep parks the pointer in a corner first, and
   * un-clipping re-lays the page out, so either would undo a hover `open` made.
   */
  hold?: (p: Page) => Promise<void>;
  /**
   * For a state that CHANGES the fixture: puts it back and waits until it is
   * back. The sweep runs it after the shot whether or not the shot (or `open`)
   * succeeded, and a failure of its own fails the state. A state that only
   * looks, as every other does, has none. The fixture is shared by every state
   * and both theme passes, so a state that leaves it changed corrupts the rest.
   */
  cleanup?: (p: Page, env: VisualStateEnv) => Promise<void>;
}

/** What a state's `cleanup` may use to read and restore the fixture. */
export interface VisualStateEnv {
  fixture: VisualFixture;
  api: ApiClient;
  /** The bootstrap admin's JWT: it may revert any decision. */
  admin: string;
}

/**
 * Hover the first step card of the multi-step build's result row, so its
 * action toolbar (approve, reject or undo, and open) shows. Looked up from
 * the page rather than by id: step ids are different on every stack. A
 * collapsed row is expanded first.
 */
async function hoverFirstStep(p: Page): Promise<void> {
  const row = p.locator('[data-testid^="result-row-"]').first();
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
  const card = p.locator('[data-testid^="step-card-"]').first();
  await expect(card).toBeVisible();
  await card.hover();
  // The toolbar is `opacity-0` until the card is hovered. It is found by its
  // test id, not by a neighbouring button, so the buttons in it can change.
  const toolbar = card.locator('[data-testid^="step-toolbar-"]');
  await expect(toolbar).toHaveCSS("opacity", "1");
}

/**
 * Go to the step called `name` of the run in the viewer, with the header's
 * "next step" arrow, starting from wherever the viewer opened (the run's first
 * step). The header shows the run's name and a "2 / 3" count, not the step's
 * name; the Info panel's "Step" row ("2/3 cart") does, so that is what is read.
 * Found by name, never by id: step ids are different on every stack.
 *
 * Returns once the step's URL has committed. The viewer shows a step the
 * moment the arrow is clicked, but Next mounts a new viewer there only when
 * the route commits, a few hundred milliseconds later; a state that acts
 * before then (Approve) would act on the viewer being replaced.
 */
async function openStep(p: Page, name: string): Promise<void> {
  const stepRow = p.getByTestId("test-info-sidebar").getByText(/^\d+\/\d+ \S/);
  const next = p.getByTestId("contextual-header-next");
  let current = "";
  for (let hops = 0; hops < 8; hops++) {
    current = (await stepRow.innerText()).trim();
    if (current.replace(/^\d+\/\d+ /, "") === name) {
      await stepUrlCommitted(p);
      return;
    }
    // On the last step the arrow is natively disabled: say so, not "timed out
    // waiting for it to be enabled".
    if (!(await next.isEnabled())) break;
    await next.click();
    await expect(stepRow).not.toHaveText(current);
  }
  throw new Error(
    `visual: no step named "${name}" within 8 steps of the first (stopped at "${current}")`,
  );
}

/**
 * Wait until the URL names the step the viewer shows (its `data-diff-id`): the
 * route of the last step change has committed, and the viewer on screen is
 * the one mounted for it.
 */
async function stepUrlCommitted(p: Page): Promise<void> {
  const id = await p
    .locator("[data-diff-id]")
    .first()
    .getAttribute("data-diff-id");
  if (!id || id === "_first") {
    throw new Error(`visual: the viewer names no step (data-diff-id=${id})`);
  }
  await p.waitForURL((url) => url.pathname.endsWith(`/checkpoints/${id}`));
}

/** The toast a review decision raised, which carries the Undo action. */
const decisionToast = (p: Page, label: string) =>
  p.locator("[data-sonner-toast]").filter({ hasText: label });

// ---- the keyboard and command surface -------------------------------------
// Helpers for the palette, `?` sheet, list cursor and top-bar states below.
// None of those states changes the fixture. The few that resize the viewport
// put it back in their `cleanup` (`restoreViewport`).

/** `text` as a RegExp source that matches exactly it. */
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The palette button's name, in the top bar and at every width (Ruling R19). */
const PALETTE_BUTTON = "Search or run a command…";

/** The ⌘K palette's dialog, mounted once by the protected layout. */
const paletteDialog = (p: Page): Locator => p.getByTestId("command-palette");

/**
 * One of the palette's groups, by its heading ("Actions", "Batches"): cmdk's
 * own `cmdk-group`, found through its `cmdk-group-heading`, so the "Batches"
 * row of the Go to group is not mistaken for the Batches group.
 */
const paletteGroup = (p: Page, heading: string): Locator =>
  paletteDialog(p)
    .locator("[cmdk-group]")
    .filter({
      has: p.locator("[cmdk-group-heading]", {
        hasText: new RegExp(`^${escapeRegExp(heading)}$`),
      }),
    });

/** A Batches row: the list cursor's items on that page. */
const batchRows = (p: Page): Locator =>
  p.locator("tbody[data-batches-list] tr[data-cursor-id]");

/** The Batches table's scroller: the box that scrolls, under the sticky header. */
const batchesScroller = (p: Page): Locator =>
  p.locator("#inbox-batches-table > div");

/** A step card on the batch page. */
const stepCards = (p: Page): Locator =>
  p.locator('[data-testid^="step-card-"]');

/** The sideways scroller that holds a run row's step cards. */
const stepRow = (p: Page): Locator => stepCards(p).first().locator("xpath=..");

/** The cursor's items on the batch page, in walking order: run rows and steps. */
const batchItems = (p: Page): Locator =>
  p.getByTestId("batch-results").locator("[data-cursor-id]");

/**
 * The batch page's list scroller: it holds the sticky column header, then the
 * results.
 */
const batchScroller = (p: Page): Locator =>
  p.getByTestId("batch-results").locator("xpath=..");

/**
 * How far a focus ring reaches outside its element: `focus-ring` is a 2px
 * outline drawn 2px out. (A Batches or run row's ring is inset, `-outline-offset-2`.)
 */
const RING_OUT = 4;

/**
 * Open the palette with its key: ⌘K on macOS, Ctrl+K elsewhere. Lower-case:
 * the command matches `e.key === "k"`, and "Meta+K" would send key "K".
 */
async function openPalette(p: Page): Promise<void> {
  await p.keyboard.press("ControlOrMeta+k");
  await expect(paletteDialog(p)).toBeVisible();
}

/**
 * Open the `?` sheet with its key and wait for the page's own section, whose
 * heading ("On this page (Batches)", "(Batch)" or "(Diff viewer)") only shows
 * once the page has registered its commands. The key is a bare "?", as on a
 * layout where it needs no Shift.
 */
async function openSheet(p: Page, section: string): Promise<void> {
  await p.keyboard.press("?");
  const sheet = p.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("heading", { name: section, exact: true }),
  ).toBeVisible();
}

/**
 * Press `key` until `target` has focus, at most `max` times: the list cursor
 * is real DOM focus, so "the cursor is there" is "focus is there". Fails,
 * saying so, if it never gets there.
 */
async function pressUntilFocused(
  p: Page,
  key: string,
  target: Locator,
  max: number,
): Promise<void> {
  const focused = target.and(p.locator(":focus"));
  for (let i = 0; i < max; i++) {
    await p.keyboard.press(key);
    const there = await focused
      .waitFor({ state: "attached", timeout: 500 })
      .then(
        () => true,
        () => false,
      );
    if (there) return;
  }
  throw new Error(
    `visual: focus did not reach ${String(target)} in ${max} "${key}" presses`,
  );
}

/** The page's viewport; a page with none is an error. */
function viewportOf(p: Page): { width: number; height: number } {
  const size = p.viewportSize();
  if (size === null) throw new Error("visual: the page has no viewport");
  return size;
}

/** An element's box on the page; an element that is not on screen is an error. */
async function boxOf(
  l: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await l.boundingBox();
  if (box === null) throw new Error(`visual: ${String(l)} is not on screen`);
  return box;
}

/**
 * The viewport a state resized the page from, for `restoreViewport`. Set by
 * the state's first resize and cleared by the cleanup, so a state that resizes
 * twice still restores the original size.
 */
let resizedFrom: { width: number; height: number } | null = null;

/** Resize the viewport for this state; `restoreViewport` puts it back. */
async function resizeViewport(
  p: Page,
  size: { width: number; height: number },
): Promise<void> {
  resizedFrom ??= viewportOf(p);
  await p.setViewportSize(size);
}

/**
 * The cleanup of every state that resized the viewport. The sweep runs it
 * after the shot, whether or not the shot (or `open`) succeeded: the next
 * state navigates in the same page, and must find it as wide as every other.
 */
async function restoreViewport(p: Page): Promise<void> {
  const from = resizedFrom;
  resizedFrom = null;
  if (from !== null) await p.setViewportSize(from);
}

/**
 * Make `scroller` scroll: set the viewport's height so that the scroller shows
 * `overflow` px less than its `content` (so a list the fixture makes short has
 * somewhere to scroll to; the window grows if the list already overflows by
 * more). The page is as tall as the viewport and the scroller takes what is
 * left, so the two move one for one. Fails, saying what it measured, if the
 * scroller does not end up that much shorter.
 */
async function fitHeightToScroll(
  p: Page,
  scroller: Locator,
  content: number,
  overflow: number,
): Promise<void> {
  const size = viewportOf(p);
  const shown = (await boxOf(scroller)).height;
  const height = Math.round(size.height - (shown - (content - overflow)));
  if (height < 200) {
    throw new Error(
      `visual: scrolling ${String(scroller)} (content ${content}px, shown ${shown}px) needs a ${height}px viewport`,
    );
  }
  await resizeViewport(p, { width: size.width, height });
  await expect
    .poll(async () => content - (await boxOf(scroller)).height, {
      message: `${String(scroller)} should be ${overflow}px shorter than its ${content}px of content`,
    })
    .toBeGreaterThanOrEqual(overflow - 4);
}

/**
 * A scroller's `scrollTop`, `scrollWidth` or `clientWidth`. Read in the page,
 * from the element the locator finds: one way to name a scroller, the locator.
 */
async function scrollMetric(
  scroller: Locator,
  metric: "scrollTop" | "scrollWidth" | "clientWidth",
): Promise<number> {
  return scroller.evaluate((el, key) => el[key], metric);
}

/**
 * Fail unless `item`'s top is at or below the bottom of the sticky `header`:
 * the item is in view, not under the header. What counts is where the focus
 * ring starts: for a step card (its ring is outside its box, `RING_OUT`) that
 * is above the box, for a row (an inset ring) it is the box. Within half a
 * pixel: layout rounds.
 */
async function expectBelowHeader(
  item: Locator,
  header: Locator,
  what: string,
): Promise<void> {
  const ring = (await item.getAttribute("data-testid"))?.startsWith(
    "step-card-",
  )
    ? RING_OUT
    : 0;
  const [at, bar] = await Promise.all([boxOf(item), boxOf(header)]);
  const top = at.y - ring;
  expect(
    top,
    `${what}: its ${ring > 0 ? "ring" : "top"} starts at ${top}px, the header ends at ${bar.y + bar.height}px`,
  ).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
}

/**
 * The list cursor under a sticky header: J to the first item, End to the last
 * (the list must have scrolled by then), then K back up to the first. Every
 * item the cursor lands on must be clear of the `header` (`expectBelowHeader`),
 * so the scroller's `scroll-pt-*` leaves room for it.
 */
async function expectCursorClearsHeader(
  p: Page,
  {
    items,
    scroller,
    header,
    what,
  }: {
    items: Locator;
    scroller: Locator;
    header: Locator;
    what: string;
  },
): Promise<void> {
  const count = await items.count();
  await pressUntilFocused(p, "j", items.first(), 6);
  await p.keyboard.press("End");
  await expect(items.nth(count - 1)).toBeFocused();
  expect(
    await scrollMetric(scroller, "scrollTop"),
    `${what}: End should have scrolled the list`,
  ).toBeGreaterThan(0);
  await expectBelowHeader(items.nth(count - 1), header, `${what} ${count}`);
  for (let i = count - 2; i >= 0; i--) {
    await p.keyboard.press("k");
    await expect(items.nth(i)).toBeFocused();
    await expectBelowHeader(items.nth(i), header, `${what} ${i + 1}`);
  }
}

/**
 * For a state whose dialog is over text the shared time masks cover: hide that
 * text. A mask is painted over the page, the dialog included, at the box of
 * every element it finds, hidden or not; a `display: none` element has no
 * box, so nothing is painted for it. Only for that state: every other keeps
 * its masks.
 */
async function hideMaskedTimes(p: Page): Promise<void> {
  for (const mask of timeMasks(p)) {
    await mask.evaluateAll((els) => {
      for (const el of els) el.style.display = "none";
    });
  }
}

/**
 * The top bar's width budget (Ruling R20): the project label gives way
 * (its name truncates) instead of reaching the palette button, and nothing
 * pushes the bar wider than the viewport. The button is found by its name, so
 * this also holds when the words are visually hidden (below `md`) and the name
 * remains. Polled: the bar lays out again a frame after the viewport resizes.
 */
async function expectTopBarFits(p: Page): Promise<void> {
  const label = p.getByTestId("project-selector-label");
  const button = p.getByRole("button", { name: PALETTE_BUTTON });
  await expect(label).toBeVisible();
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName(PALETTE_BUTTON);
  await expect
    .poll(
      async () => {
        const [l, b] = await Promise.all([boxOf(label), boxOf(button)]);
        return b.x - (l.x + l.width);
      },
      {
        message:
          "the palette button should start at or after the project label's right edge (a negative number is how far they overlap)",
      },
    )
    .toBeGreaterThanOrEqual(0);
  const overflow = (await p.evaluate(
    `(() => { const bar = document.querySelector('[data-testid="app-top-bar"]'); return bar.scrollWidth - bar.clientWidth; })()`,
  )) as number;
  expect(
    overflow,
    "the top bar should hold its controls without scrolling sideways",
  ).toBeLessThanOrEqual(0);
}

/** A multi-step run's steps as the reviewer reads them. */
async function multiRunSteps({ api, admin, fixture }: VisualStateEnv): Promise<
  Array<{
    name: string;
    state: string | null;
    decision: { actionId: string } | null;
  }>
> {
  const { items } = await api.trpcQuery<{
    items: Array<{
      name: string;
      state: string | null;
      decision: { actionId: string } | null;
    }>;
  }>(admin, "runs.listCheckpoints", { runId: fixture.multiRunId });
  return items;
}

/**
 * The Approve click `state-undo-toast` made, until its request has answered.
 * Set just before the click, read and cleared by the cleanup: a click is a
 * request in flight, and an `open` that fails after it (the toast never shows)
 * leaves the approval free to land AFTER the cleanup looked.
 */
let profileApprove: { answered: boolean } | null = null;

/**
 * Put the multi-step run's `profile` step back to pending `new`, and wait
 * until the run is whole again.
 *
 * First, if the state clicked Approve, wait (up to 15s) until that decision has
 * landed (a `profile` decision exists) or its request has answered without one
 * (it was refused, or never went out), so the check below cannot run before
 * the approval commits. Then take back whatever decision `profile` holds (the
 * fixture never has one: it is the pending step), through the API with the
 * decision's own action id, so it works whatever the page is doing. Undoing
 * an approval queues a re-diff of the run (it reads `running` for a moment), so
 * finally wait, up to 60s, for every step to have a verdict and `profile` to
 * read `new` again. Throws if it does not: a fixture left changed would
 * corrupt every shot after it.
 */
async function restoreProfile(_p: Page, env: VisualStateEnv): Promise<void> {
  const profileDecision = async (): Promise<{ actionId: string } | null> =>
    (await multiRunSteps(env)).find((c) => c.name === "profile")?.decision ??
    null;

  const clicked = profileApprove;
  profileApprove = null;
  if (clicked) {
    await expect
      .poll(
        async () => clicked.answered || (await profileDecision()) !== null,
        {
          message: "the profile approval neither landed nor answered",
          intervals: [250, 500, 1_000],
          timeout: 15_000,
        },
      )
      .toBe(true);
  }

  const decision = await profileDecision();
  if (decision) {
    await env.api.trpcMutate(env.admin, "review.revert", {
      actionId: decision.actionId,
    });
  }
  await expect
    .poll(
      async () => {
        const steps = await multiRunSteps(env);
        return (
          steps.every((c) => c.state !== null) &&
          steps.find((c) => c.name === "profile")?.state === "new"
        );
      },
      {
        message: "the multi-step run's profile step did not come back to new",
        intervals: [500, 1_000, 2_000],
        timeout: 60_000,
      },
    )
    .toBe(true);
}

// ---- the viewer's comparison modes and its rail ---------------------------
// Helpers for the mode, mismatch and rail states below. None of them changes
// the fixture. Each one that changes a viewer preference (the mode, the rail's
// width or whether it is collapsed: stored per user in localStorage) notes the
// stored preferences first and puts them back in `cleanup`, so the next state
// opens the viewer as every other does: side by side, the rail open at 320px.
// A mode also goes into the URL (`?view`), which needs no putting back: every
// state starts with a navigation of its own.

/** The viewer's stored preferences: one key per user under this prefix. */
const VIEWER_PREFS = "furan:viewer:prefs:v1:";

/** The page's stored viewer preferences, by key (none: `{}`). */
async function storedViewerPrefs(p: Page): Promise<Record<string, string>> {
  // A string: the e2e tsconfig has no DOM lib.
  return (await p.evaluate(
    `(() => { const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null && k.startsWith(${JSON.stringify(VIEWER_PREFS)})) out[k] = localStorage.getItem(k); } return out; })()`,
  )) as Record<string, string>;
}

/**
 * The signed-in user's stored preference `field`: the one stored object's,
 * or undefined while none is stored.
 */
async function storedViewerPref(p: Page, field: string): Promise<unknown> {
  const stored = Object.values(await storedViewerPrefs(p));
  if (stored.length > 1) {
    throw new Error(
      `visual: ${stored.length} users' viewer preferences are stored, expected one`,
    );
  }
  const [json] = stored;
  return json === undefined
    ? undefined
    : (JSON.parse(json) as Record<string, unknown>)[field];
}

/**
 * The stored viewer preferences as a state found them, for `restorePrefs`.
 * Set by the state's first `notePrefs` (before it changes any) and cleared by
 * the cleanup.
 */
let prefsBefore: Record<string, string> | null = null;

/** Note the stored viewer preferences, for `restorePrefs` to put back. */
async function notePrefs(p: Page): Promise<void> {
  prefsBefore ??= await storedViewerPrefs(p);
}

/**
 * The cleanup of every state that changed a viewer preference: the stored
 * ones go back to what `notePrefs` found (in the sweep, none), and fails if
 * they are not. The page keeps the changed ones in memory until the next
 * state's navigation, which reads them again from storage.
 */
async function restorePrefs(p: Page): Promise<void> {
  const before = prefsBefore;
  prefsBefore = null;
  if (before === null) return;
  await p.evaluate(
    `((before) => { for (const k of Object.keys(localStorage)) if (k.startsWith(${JSON.stringify(VIEWER_PREFS)})) localStorage.removeItem(k); for (const [k, v] of Object.entries(before)) localStorage.setItem(k, v); })(${JSON.stringify(before)})`,
  );
  expect(
    await storedViewerPrefs(p),
    "the stored viewer preferences should be back as the state found them",
  ).toEqual(before);
}

/** A comparison mode: its key, its radio's name and its `?view` value. */
interface ModeKey {
  key: string;
  name: string;
  view: string;
}

/** The five modes, on keys 1–5 (spec §4.1). */
const MODE = {
  swipe: { key: "2", name: "Swipe", view: "swipe" },
  flicker: { key: "3", name: "Flicker", view: "flicker" },
  overlay: { key: "4", name: "Overlay", view: "overlay" },
  diff: { key: "5", name: "Diff", view: "diff" },
} as const satisfies Record<string, ModeKey>;

/** One of the "Comparison mode" radio group's radios, by its name. */
const modeRadio = (p: Page, name: string): Locator =>
  p
    .getByRole("radiogroup", { name: "Comparison mode", exact: true })
    .getByRole("radio", { name, exact: true });

/**
 * The words on the canvas naming what it shows (in side by side, one per
 * pane). Read with `textContent`: the label is upper-cased by CSS only.
 */
const canvasLabel = (p: Page): Locator => p.getByTestId("canvas-mode-label");

/** The single stage every mode but side by side draws on. */
const singleStage = (p: Page): Locator => p.getByTestId("single-stage-host");

/**
 * Switch the viewer, on a real step, to `mode` with its key: from side by
 * side, which every state must open in (a state that left its mode stored
 * would fail the next here). The radio is then checked, and the mode is both
 * in the URL (`?view`, replaced in place) and stored as the user's
 * preference. Notes the stored preferences first, for `restorePrefs`.
 */
async function pressMode(p: Page, mode: ModeKey): Promise<void> {
  await stepUrlCommitted(p);
  await expect(modeRadio(p, "Side by side")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await notePrefs(p);
  await p.keyboard.press(mode.key);
  await expect(modeRadio(p, mode.name)).toHaveAttribute("aria-checked", "true");
  await expect(modeRadio(p, "Side by side")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect
    .poll(() => new URL(p.url()).searchParams.get("view"), {
      message: `the URL should name the mode (view=${mode.view})`,
    })
    .toBe(mode.view);
  await expect
    .poll(() => storedViewerPref(p, "mode"), {
      message: `the mode should be stored as the user's (${mode.view})`,
    })
    .toBe(mode.view);
}

/**
 * Fail unless `l`'s text stays `text` for `ms`, read every 100ms: what a
 * paused animation does, and a playing one (a swap every 500ms) does not.
 */
async function expectSteady(
  p: Page,
  l: Locator,
  text: string,
  ms: number,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(
      (await l.textContent())?.trim(),
      `${String(l)} should stay "${text}" for ${ms}ms`,
    ).toBe(text);
    await p.waitForTimeout(100);
  }
}

/**
 * Flicker, paused with `f` on `frame`. The sweep's window prefers reduced
 * motion, under which Flicker never plays, so motion is allowed for this,
 * once Flicker is on screen: a view reset before then (the step's route
 * committing) would read the motion allowed and start Flicker playing. The
 * step was opened under reduced motion, so Flicker starts paused on the
 * baseline (spec §6.2), and allowing motion does not start it: Play does.
 * Flicker plays (Pause shows, and the label swaps to "Current" on its own),
 * `f` pauses it (Play shows), and then each `f` swaps the frame by hand, once
 * or twice, so the last swap ends on `frame` and the live region names it.
 * The frame then stays. Reduced motion comes back for the shot (the canvas's
 * region ring pulses otherwise): the frame stays, and Play goes.
 */
async function pauseFlickerOn(
  p: Page,
  frame: "Baseline" | "Current",
): Promise<void> {
  await pressMode(p, MODE.flicker);
  await p.emulateMedia({ reducedMotion: "no-preference" });
  const label = canvasLabel(p);
  const toggle = p.getByTestId("flicker-play-toggle");
  await expect(label).toHaveText("Baseline");
  await expect(toggle).toHaveText("Play");
  await toggle.click();
  await expect(toggle).toHaveText("Pause");
  // It plays: from the baseline, it swaps to the current screenshot on its
  // own. Read every 100ms: a slower read could keep landing on one frame.
  await expect
    .poll(async () => (await label.textContent())?.trim(), {
      message: "Flicker should swap to the current screenshot as it plays",
      intervals: [100],
    })
    .toBe("Current");
  await p.keyboard.press("f");
  await expect(toggle).toHaveText("Play");
  const other = frame === "Baseline" ? "Current" : "Baseline";
  if ((await label.textContent())?.trim() === frame) {
    await p.keyboard.press("f");
    await expect(label).toHaveText(other);
  }
  await p.keyboard.press("f");
  await expect(label).toHaveText(frame);
  await expect(p.getByTestId("flicker-status")).toHaveText(
    `Showing ${frame.toLowerCase()}`,
  );
  // Longer than two swaps of a playing flicker.
  await expectSteady(p, label, frame, 1_200);
  await p.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle).toHaveCount(0);
  await expect(label).toHaveText(frame);
}

/** The cleanup of a flicker state: reduced motion and the preferences back. */
async function restoreFlicker(p: Page): Promise<void> {
  try {
    await p.emulateMedia({ reducedMotion: "reduce" });
  } finally {
    await restorePrefs(p);
  }
}

/** The viewer's info rail, open or collapsed, outside the editor. */
const detailsRail = (p: Page): Locator =>
  p.getByRole("complementary", { name: "Details", exact: true });

/** The rail's resize handle, along its left edge. */
const railSeparator = (p: Page): Locator =>
  p.getByRole("separator", { name: "Resize details", exact: true });

/**
 * The viewer on a real step with its rail as every state finds it: open, at
 * the default 320px (a state that left its rail stored would fail the next
 * here).
 */
async function railAtDefault(p: Page): Promise<void> {
  await stepUrlCommitted(p);
  await expect(detailsRail(p)).not.toHaveAttribute("data-collapsed");
  await expect(railSeparator(p)).toHaveAttribute("aria-valuenow", "320");
}

/**
 * Fail unless `rail` is the collapsed 40px strip whose buttons are, in order,
 * `names` (each found by its accessible name: they are icons), with no
 * resize handle.
 */
async function expectStrip(
  p: Page,
  rail: Locator,
  names: ReadonlyArray<string | RegExp>,
): Promise<void> {
  await expect(rail).toHaveAttribute("data-collapsed", "");
  await expect(railSeparator(p)).toHaveCount(0);
  const buttons = rail.getByRole("button");
  await expect(buttons).toHaveCount(names.length);
  for (const [i, name] of names.entries()) {
    await expect(buttons.nth(i)).toHaveAccessibleName(name);
  }
  expect((await boxOf(rail)).width, "the collapsed strip is 40px wide").toBe(
    40,
  );
}

/** The size-mismatch step's screenshots (`VisualFixture.mismatch`). */
const MISMATCH_BASELINE = "1280×800";
const MISMATCH_CURRENT = "1280×1100";

/** Diff mode's message for screenshots of different sizes, verbatim (spec §8). */
const SIZE_MISMATCH_MESSAGE = `The screenshots are different sizes (${MISMATCH_BASELINE} and ${MISMATCH_CURRENT}), so there's no pixel diff. Compare them with Side by side, Swipe or Flicker.`;

/** The viewer on the size-mismatch step. */
const mismatchStep = (f: VisualFixture): string =>
  `/projects/${f.mismatch.projectId}/runs/${f.mismatch.runId}/checkpoints/${f.mismatch.checkpointId}`;

export const STATES: ReadonlyArray<VisualState> = [
  {
    // The viewer on the multi-step run, then the palette key: the palette opens
    // on the page's own commands (Actions), ahead of Go to and the rest.
    name: "state-palette-actions",
    path: (f) => `/projects/${f.projectId}/runs/${f.multiRunId}`,
    open: async (p) => {
      // The viewer's commands are registered once it is on a real step.
      await stepUrlCommitted(p);
      await openPalette(p);
      const actions = paletteGroup(p, "Actions");
      await expect(actions).toBeVisible();
      await expect(actions.locator("[cmdk-item]").first()).toBeVisible();
    },
  },
  {
    name: "state-menu",
    path: "/inbox",
    open: async (p) => {
      const toggle = p.locator('[data-testid="theme-toggle"]');
      await toggle.click();
      // Before the Light/Dark/System menu (main @ 7e4fcd6) the toggle was a
      // plain button; only expect a menu when the trigger says it opens one.
      if ((await toggle.getAttribute("aria-haspopup")) === "menu") {
        await expect(p.getByRole("menu")).toBeVisible();
      }
    },
  },
  {
    // The editor's own tokens page: admins are redirected to /admin/api-keys,
    // which is not the screen this state is about.
    name: "state-dialog",
    path: "/account/tokens",
    as: "editor",
    open: async (p) => {
      await p.getByRole("button", { name: /token/i }).first().click();
      await expect(p.getByRole("dialog")).toBeVisible();
    },
  },
  {
    // The multi-step build, first step hovered: the card's toolbar shows.
    name: "state-step-hover",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: hoverFirstStep,
    hold: hoverFirstStep,
  },
  // ---- the review flow --------------------------------------------------
  // Added at the END, in this order: all but the last only look (or, as the
  // done card's J, only read the fixture), the last one changes it (and puts
  // it back, see `cleanup`), so it must run last.
  {
    // The multi-step run opens on `home`, an approved step: the header shows
    // who decided it, and when, with Undo.
    name: "state-decided-step",
    path: (f) => `/projects/${f.projectId}/runs/${f.multiRunId}`,
    open: async (p) => {
      await openStep(p, "home");
      await expect(p.getByTestId("decision-chip")).toBeVisible();
    },
  },
  {
    // The multi-step build's "Approve pending" question, open on its counts.
    // Never confirmed.
    name: "state-approve-pending",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      const approveAll = p.getByTestId("batch-approve-all");
      await expect(approveAll).toBeVisible();
      await expect(approveAll).not.toHaveAttribute("aria-disabled", "true");
      await approveAll.click();
      const dialog = p.getByTestId("approve-pending-dialog");
      await expect(dialog).toBeVisible();
      // Open on the counts, not on "Checking what is pending…".
      await expect(
        dialog.getByText(/^Approve \d+ pending steps?\?$/),
      ).toBeVisible();
      await expect(dialog.getByTestId("approve-pending-confirm")).toBeEnabled();
    },
  },
  {
    // The loop batch with its Viewport filter open: "Any viewport" and the
    // batch's two viewports, each with its pending count, so the list is a real
    // choice.
    name: "state-facets-open",
    path: (f) => `/projects/${f.projectId}/builds/${f.loopBuildId}`,
    open: async (p) => {
      // The select is drawn only once the batch's values are known.
      const trigger = p.getByTestId("facet-select-viewport");
      await expect(trigger).toBeVisible();
      // Radix Select closes itself on a window `resize` (and `blur`), and each
      // full-page screenshot resizes the window: without this the list is shut
      // by the time the sweep's first shot is taken, and the state passes with
      // the select closed. Registered (capturing) before the list opens, so it
      // runs before Radix's own listeners; it lasts until the next navigation.
      // Only the window's own events: a capturing `blur` listener on the
      // window also sees every element's blur, which must go on as usual.
      await p.evaluate(
        `(() => { const keep = (e) => { if (e.target === window) e.stopImmediatePropagation(); }; for (const t of ["resize", "blur"]) window.addEventListener(t, keep, true); })()`,
      );
      await trigger.click();
      await expect(p.getByRole("listbox")).toBeVisible();
      await expect(
        p.getByRole("option", { name: /^\d+x\d+ · \d+ pending$/ }),
      ).toHaveCount(2);
    },
  },
  {
    // A viewport the batch has none of, as a shared link can name one: the
    // empty list and the select that says why ("0x0 (not in this batch)").
    name: "state-filtered-empty",
    path: (f) =>
      `/projects/${f.projectId}/builds/${f.multiBuildId}?viewport=0x0`,
    open: async (p) => {
      await expect(p.getByTestId("batch-empty-filtered")).toBeVisible();
      await expect(p.getByTestId("facet-select-viewport")).toContainText(
        "not in this batch",
      );
    },
  },
  {
    // J on the multi-step run's decided `home` step, with a browser filter that
    // no step of the project matches: nothing is left inside the filter, so the
    // viewer shows the done card instead of moving (here "Done with the
    // filtered steps": `profile` still needs review outside the filter). The
    // step is decided, so J lands on the boundary rather than announcing "last
    // step" (a pending one shows a header chip, not a card). The fixture's
    // steps are all chromium, so no step inside `browser=firefox` can pull J
    // elsewhere. Only reads; nothing to put back.
    name: "state-batch-done",
    path: (f) =>
      `/projects/${f.projectId}/runs/${f.multiRunId}?browser=firefox`,
    open: async (p) => {
      await openStep(p, "home");
      await expect(p.getByTestId("decision-chip")).toBeVisible();
      await p.keyboard.press("j");
      await expect(
        p.getByRole("dialog", {
          name: /^(Batch done|Done with the filtered steps)$/,
        }),
      ).toBeVisible();
    },
  },
  // ---- the keyboard and command surface ----------------------------------
  // None of these changes the fixture. The few that resize the viewport (to
  // make a list scroll, or to check the top bar at narrow widths) put it back
  // in `cleanup`.
  {
    // Batches, the palette key, then "visual" typed in the palette: the
    // project's batches that match, in their own Batches group. The letters
    // are the search's, though one of them (`s`) is the page's Start
    // reviewing key. The admin's project is called "visual-sweep", so the
    // Projects group also has a row for it; once the batches have answered
    // the selected row must be the first one in the list, a batch, and not
    // the project's (Ruling R29: cmdk only picks a first row when nothing is
    // selected, so a row that was selected before the answer came kept it).
    name: "state-palette-search",
    path: "/inbox",
    open: async (p) => {
      await expect(batchRows(p).first()).toBeVisible();
      await openPalette(p);
      const input = p.getByTestId("command-input");
      await input.pressSequentially("visual");
      await expect(input).toHaveValue("visual");
      const batches = paletteGroup(p, "Batches");
      await expect(batches.locator("[cmdk-item]").first()).toBeVisible();

      const items = paletteDialog(p).locator("[cmdk-item]");
      const selected = '[cmdk-item][aria-selected="true"]';
      await expect(
        paletteDialog(p).locator(selected),
        "one row should be selected",
      ).toHaveCount(1);
      await expect(
        items.first(),
        "the selected row should be the first in the list",
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        batches.locator(selected),
        "the selected row should be in the Batches group",
      ).toHaveCount(1);
    },
  },
  {
    name: "state-sheet-batches",
    path: "/inbox",
    open: async (p) => {
      await expect(batchRows(p).first()).toBeVisible();
      await openSheet(p, "On this page (Batches)");
    },
  },
  {
    // The batch page's "Recent batch runs" panel has times in it, which the
    // sweep masks; behind the sheet they would be painted over its rows.
    name: "state-sheet-batch",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      await expect(
        p.locator('[data-testid^="result-row-"]').first(),
      ).toBeVisible();
      await openSheet(p, "On this page (Batch)");
    },
    hold: hideMaskedTimes,
  },
  {
    name: "state-sheet-viewer",
    path: (f) => `/projects/${f.projectId}/runs/${f.multiRunId}`,
    open: async (p) => {
      await stepUrlCommitted(p);
      await openSheet(p, "On this page (Diff viewer)");
    },
  },
  {
    // The top bar's Help menu: Keyboard shortcuts, Replay tour (when the page
    // has a tour) and the single-key switch.
    name: "state-help-menu",
    path: "/inbox",
    open: async (p) => {
      await p.getByRole("button", { name: "Help", exact: true }).click();
      const menu = p.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: "Keyboard shortcuts" }),
      ).toBeVisible();
      await expect(
        menu.getByRole("menuitemcheckbox", { name: "Single-key shortcuts" }),
      ).toBeVisible();
    },
  },
  {
    // Batches, then J: the cursor is on the first row. It is real focus, so the
    // focus ring is what shows it (a 2px outline), and it must draw.
    name: "state-cursor-batches",
    path: "/inbox",
    open: async (p) => {
      const first = batchRows(p).first();
      await expect(first).toBeVisible();
      await pressUntilFocused(p, "j", first, 6);
      await expect(first).toHaveCSS("outline-style", "solid");
      await expect(first).toHaveCSS("outline-width", "2px");
    },
  },
  {
    // The Batches list scrolling under its sticky header (`scroll-pt-11`).
    // The fixture's few batches fit in the window, so the window is made short
    // enough to scroll the list. End, then K back up to the first row: no row
    // the cursor lands on may be under the header.
    name: "state-cursor-batches-scrolled",
    path: "/inbox",
    open: async (p) => {
      const rows = batchRows(p);
      await expect(rows.first()).toBeVisible();
      expect(
        await rows.count(),
        "the fixture should hold at least three batches that need review",
      ).toBeGreaterThanOrEqual(3);
      const table = await boxOf(p.locator("#inbox-batches-table table"));
      const scroller = batchesScroller(p);
      await fitHeightToScroll(p, scroller, table.height, 100);
      await expectCursorClearsHeader(p, {
        items: rows,
        scroller,
        header: p.locator("#inbox-batches-table thead"),
        what: "row",
      });
    },
    cleanup: restoreViewport,
  },
  {
    // The multi-step build, J until a step card has the cursor: the card's
    // focus ring (a 2px outline) is the cursor and must draw.
    name: "state-cursor-step",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      const cards = stepCards(p);
      await expect(cards.first()).toBeVisible();
      await pressUntilFocused(p, "j", cards, 6);
      const focused = cards.and(p.locator(":focus"));
      await expect(focused).toHaveCSS("outline-style", "solid");
      await expect(focused).toHaveCSS("outline-width", "2px");
    },
  },
  {
    // A step card's ring in the sideways scroller (`scroll-px-4`). The row of
    // cards is the window's width less a constant (the sidebar, and the batch
    // page's "Recent batch runs" panel beside the results), so one measure
    // gives the window that makes it ROW px wide: room for a card and its
    // scroll padding on both sides, but not for all three cards, so the second
    // is partly out of view. The cursor walks 1, 2, 3, 2, 1, and at each card
    // its ring (`RING_OUT`) must clear both edges of the row. Without the
    // padding the second card would be flush with the right edge, and the
    // first, coming back, with the left one.
    name: "state-cursor-step-sideways",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      const cards = stepCards(p);
      const row = stepRow(p);
      await expect(cards.nth(2)).toBeVisible();
      const size = viewportOf(p);
      const ROW = 520;
      const rowWidth = () => scrollMetric(row, "clientWidth");
      await resizeViewport(p, {
        width: size.width - ((await rowWidth()) - ROW),
        height: size.height,
      });
      await expect(async () => {
        const width = await rowWidth();
        expect(
          Math.abs(width - ROW),
          `the row of cards is ${width}px wide, not ${ROW}px (within 2px)`,
        ).toBeLessThanOrEqual(2);
      }).toPass({ timeout: 10_000 });
      expect(
        await scrollMetric(row, "scrollWidth"),
        "the step cards should overflow their row",
      ).toBeGreaterThan(await rowWidth());

      const expectRingClear = async (index: number): Promise<void> => {
        await expect(cards.nth(index)).toHaveCSS("outline-style", "solid");
        const [card, bounds] = await Promise.all([
          boxOf(cards.nth(index)),
          boxOf(row),
        ]);
        // The row has a 1px border, outside the box that scrolls.
        expect(
          card.x - (bounds.x + 1),
          `card ${index + 1}: its ring should clear the row's left edge`,
        ).toBeGreaterThanOrEqual(RING_OUT);
        expect(
          bounds.x + bounds.width - 1 - (card.x + card.width),
          `card ${index + 1}: its ring should clear the row's right edge`,
        ).toBeGreaterThanOrEqual(RING_OUT);
      };

      await pressUntilFocused(p, "j", cards.nth(0), 6);
      await expectRingClear(0);
      for (const [from, to] of [
        [0, 1],
        [1, 2],
        [2, 1],
        [1, 0],
      ] as const) {
        await p.keyboard.press(to > from ? "j" : "k");
        await expect(cards.nth(to)).toBeFocused();
        await expectRingClear(to);
      }
    },
    cleanup: restoreViewport,
  },
  {
    // The batch page scrolling under its sticky column header (`scroll-pt-10`,
    // against a 33px header), on the loop batch (two runs, so a run row and a
    // step card sit above the last item). The window is made short enough to
    // scroll the list; End, then K back up to the first row: no item the cursor
    // lands on may be under the header (for a step card, its ring, which is
    // outside its box, counts).
    name: "state-cursor-batch-scrolled",
    path: (f) => `/projects/${f.projectId}/builds/${f.loopBuildId}`,
    open: async (p) => {
      const items = batchItems(p);
      await expect
        .poll(() => items.count(), {
          message: "the loop batch should show two run rows and their steps",
        })
        .toBeGreaterThanOrEqual(4);
      const scroller = batchScroller(p);
      const header = scroller.locator(":scope > div.sticky");
      const content =
        (await boxOf(header)).height +
        (await boxOf(p.getByTestId("batch-results"))).height;
      await fitHeightToScroll(p, scroller, content, 120);
      await expectCursorClearsHeader(p, {
        items,
        scroller,
        header,
        what: "item",
      });
    },
    cleanup: restoreViewport,
  },
  {
    // The top bar on a tablet (Ruling R20), the sidebar open beside the page:
    // the palette button is 160px wide from `md`, and the project label gives
    // way before it. Fails if they overlap.
    name: "state-topbar-tablet",
    path: "/inbox",
    open: async (p) => {
      await resizeViewport(p, { width: 768, height: 1024 });
      await expect(p.getByTestId("app-sidebar")).toBeVisible();
      await expect(p.getByTestId("sidebar-collapse-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expectTopBarFits(p);
    },
    cleanup: restoreViewport,
  },
  {
    // The top bar on a phone (Ruling R20): the sidebar is a drawer, the palette
    // button is its icon (its words still its name), and the label gives way.
    // Fails if they overlap.
    name: "state-topbar-phone",
    path: "/inbox",
    open: async (p) => {
      await resizeViewport(p, { width: 375, height: 812 });
      await expect(p.getByTestId("sidebar-toggle")).toBeVisible();
      await expectTopBarFits(p);
    },
    cleanup: restoreViewport,
  },
  // ---- the viewer's comparison modes and its rail ------------------------
  // None of these changes the fixture. Each that changes a viewer preference
  // (a mode, the rail) puts the stored preferences back in `cleanup`.
  {
    // The single-step run's changed step in Swipe (key 2): the divider starts
    // at 50%, in the middle of the stage, its handle a slider saying so.
    name: "state-mode-swipe",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      await pressMode(p, MODE.swipe);
      await expect(canvasLabel(p)).toHaveText("Baseline | Current");
      const handle = p.getByRole("slider", {
        name: "Swipe position",
        exact: true,
      });
      await expect(handle).toHaveAttribute("aria-valuenow", "50");
      await expect(handle).toHaveAttribute("aria-valuetext", "50% baseline");
      const [stage, divider] = await Promise.all([
        boxOf(singleStage(p)),
        boxOf(p.getByTestId("swipe-divider")),
      ]);
      expect(
        Math.abs(divider.x + divider.width / 2 - (stage.x + stage.width / 2)),
        "the divider should be in the middle of the stage (within 1px)",
      ).toBeLessThanOrEqual(1);
    },
    cleanup: restorePrefs,
  },
  {
    // Flicker (key 3) paused with `f` on the baseline: see `pauseFlickerOn`.
    name: "state-mode-flicker-baseline",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: (p) => pauseFlickerOn(p, "Baseline"),
    cleanup: restoreFlicker,
  },
  {
    // The same, paused on the current screenshot.
    name: "state-mode-flicker-current",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: (p) => pauseFlickerOn(p, "Current"),
    cleanup: restoreFlicker,
  },
  {
    // Overlay (key 4): the current screenshot over the baseline, at the
    // default 50% opacity.
    name: "state-mode-overlay",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      await pressMode(p, MODE.overlay);
      await expect(canvasLabel(p)).toHaveText("Current over baseline");
      await expect(singleStage(p)).toHaveAttribute("data-mode", "overlay");
      await expect(
        p.getByRole("slider", { name: "Overlay opacity" }),
      ).toHaveAttribute("aria-valuenow", "50");
    },
    cleanup: restorePrefs,
  },
  {
    // Diff (key 5) on a step with its own diff image (never the run's
    // stand-in): once the images are in, the stage says nothing, neither
    // "No pixel changes…" nor "No diff image was kept…".
    name: "state-mode-diff",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      await pressMode(p, MODE.diff);
      await expect(canvasLabel(p)).toHaveText("Current");
      const stage = singleStage(p);
      await expect(stage).toHaveAttribute("data-mode", "diff");
      await expect(p.locator("#diff-viewer-canvas")).not.toHaveAttribute(
        "data-diff-image-legacy-missing",
      );
      await expect(stage).not.toHaveAttribute("aria-busy");
      await expect(p.getByTestId("stage-states")).toHaveText("");
    },
    cleanup: restorePrefs,
  },
  {
    // The size-mismatch step side by side (the default): the size chip names
    // both sizes, and pane A hatches the bottom 300px of the 1100 the
    // baseline lacks, its hit area (over the pane's whole width, down to its
    // bottom) titled "Not in the baseline". Pane B, the taller current
    // screenshot, has none. Only looks.
    name: "state-size-mismatch",
    path: mismatchStep,
    open: async (p) => {
      await stepUrlCommitted(p);
      await expect(modeRadio(p, "Side by side")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(p.getByTestId("diff-viewer-size-chip-mismatch")).toHaveText(
        `${MISMATCH_BASELINE}→${MISMATCH_CURRENT}`,
      );
      const paneA = p.getByTestId("baseline-canvas-host");
      const hatch = paneA.getByTestId("hatch-tooltip");
      await expect(hatch).toHaveCount(1);
      await expect(hatch).toHaveAttribute("title", "Not in the baseline");
      await expect(
        p.getByTestId("candidate-canvas-host").getByTestId("hatch-tooltip"),
      ).toHaveCount(0);
      const [pane, area] = await Promise.all([boxOf(paneA), boxOf(hatch)]);
      expect(
        Math.abs(area.width - pane.width),
        "the hatching spans the pane's width (within 1px)",
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(area.y + area.height - (pane.y + pane.height)),
        "the hatching reaches the pane's bottom (within 1px)",
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(area.height / pane.height - 300 / 1100),
        "the hatching is the 300px of 1100 the baseline lacks",
      ).toBeLessThanOrEqual(0.01);
    },
  },
  {
    // The size-mismatch step in Diff (key 5): there is no pixel diff, and the
    // stage says why, verbatim.
    name: "state-size-mismatch-diff",
    path: mismatchStep,
    open: async (p) => {
      await pressMode(p, MODE.diff);
      await expect(canvasLabel(p)).toHaveText("Current");
      await expect(
        p
          .getByTestId("stage-states")
          .getByText(SIZE_MISMATCH_MESSAGE, { exact: true }),
      ).toBeVisible();
    },
    cleanup: restorePrefs,
  },
  {
    // `t` collapses the rail to its strip, opens it again, and collapses it
    // once more for the shot: "Show details", then Info, History and
    // Comments. Collapsed is stored.
    name: "state-rail-collapsed",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      await railAtDefault(p);
      await notePrefs(p);
      const rail = detailsRail(p);
      const strip = ["Show details", "Info", "History", "Comments"];
      await p.keyboard.press("t");
      await expectStrip(p, rail, strip);
      await p.keyboard.press("t");
      await expect(rail).not.toHaveAttribute("data-collapsed");
      await expect(railSeparator(p)).toHaveAttribute("aria-valuenow", "320");
      await p.keyboard.press("t");
      await expectStrip(p, rail, strip);
      await expect
        .poll(() => storedViewerPref(p, "railCollapsed"), {
          message: "the collapsed rail should be stored",
        })
        .toBe(true);
    },
    cleanup: restorePrefs,
  },
  {
    // The rail at its widest in a 1440px window: End on its resize handle
    // takes it to 560px (45% of the window would be 648), stored.
    name: "state-rail-wide",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      expect(viewportOf(p).width, "the state is shot in a 1440px window").toBe(
        1440,
      );
      await railAtDefault(p);
      const separator = railSeparator(p);
      await expect(separator).toHaveAttribute("aria-valuemax", "560");
      await notePrefs(p);
      await separator.focus();
      await p.keyboard.press("End");
      await expect(separator).toHaveAttribute("aria-valuenow", "560");
      await expect
        .poll(async () => (await boxOf(detailsRail(p))).width, {
          message: "the rail should be 560px wide",
        })
        .toBe(560);
      await expect
        .poll(() => storedViewerPref(p, "railWidth"), {
          message: "the rail's width should be stored",
        })
        .toBe(560);
    },
    cleanup: restorePrefs,
  },
  {
    // The ignore-region editor (`i`) in the rail: one rail, named by its
    // "Ignore regions" heading, and no "Details" beside it. `t` collapses it
    // to one strip button, "Ignore regions (N)", and opens it again for the
    // shot. The editor is the page's, and goes with the next navigation.
    name: "state-editor-rail",
    path: (f) => `/projects/${f.projectId}/runs/${f.unresolvedRunId}`,
    open: async (p) => {
      await railAtDefault(p);
      await notePrefs(p);
      await p.keyboard.press("i");
      const rail = p.getByRole("complementary", {
        name: "Ignore regions",
        exact: true,
      });
      const heading = rail.getByRole("heading", {
        name: "Ignore regions",
        exact: true,
      });
      await expect(rail).toHaveCount(1);
      await expect(heading).toBeVisible();
      await expect(detailsRail(p)).toHaveCount(0);
      await p.keyboard.press("t");
      await expectStrip(p, rail, [/^Ignore regions \(\d+\)$/]);
      await p.keyboard.press("t");
      await expect(rail).not.toHaveAttribute("data-collapsed");
      await expect(heading).toBeVisible();
      await expect(rail).toHaveCount(1);
      await expect(detailsRail(p)).toHaveCount(0);
    },
    cleanup: restorePrefs,
  },
  {
    // Approve the pending `profile` step and shoot while the toast, with its
    // Undo action, is up. The decision is taken back in `cleanup`, so the next
    // state, and the other theme's pass, find the fixture as it was.
    name: "state-undo-toast",
    path: (f) => `/projects/${f.projectId}/runs/${f.multiRunId}`,
    open: async (p) => {
      await openStep(p, "profile");
      const approve = p.getByTestId("approve-checkpoint-button");
      await expect(approve).toBeEnabled();
      // Note the request before it goes out, for `cleanup` (which must not
      // look at the fixture while an approval is still on its way).
      const sent = { answered: false };
      profileApprove = sent;
      void p
        .waitForResponse((r) => r.url().includes("review.approve"), {
          timeout: 10_000,
        })
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          sent.answered = true;
        });
      await approve.click();
      await expect(
        decisionToast(p, "Approved 'profile'").getByRole("button", {
          name: "Undo",
        }),
      ).toBeVisible();
    },
    // The toast goes after 10s, which a slow settle and unclip could use up;
    // a pointer on it holds it open (the sweep parked the pointer in a corner,
    // which let it go).
    hold: async (p) => {
      await decisionToast(p, "Approved 'profile'").hover();
    },
    cleanup: restoreProfile,
  },
];
