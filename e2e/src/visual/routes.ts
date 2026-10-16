import { expect, type Locator, type Page } from "@playwright/test";

import type { ApiClient } from "../clients/api-client.js";

import type { VisualFixture } from "./fixture.js";

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
// Every one of those states only looks: the viewport a few of them change is
// put back by their `cleanup` (`restoreViewport`).

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
        hasText: new RegExp(`^${heading}$`),
      }),
    });

/** A Batches row: the list cursor's items on that page. */
const batchRows = (p: Page): Locator =>
  p.locator("tbody[data-batches-list] tr[data-cursor-id]");

/** The Batches table's scroller: the box that scrolls, under the sticky header. */
const BATCHES_SCROLLER = "#inbox-batches-table > div";

/** A step card on the batch page. */
const stepCards = (p: Page): Locator =>
  p.locator('[data-testid^="step-card-"]');

/** The cursor's items on the batch page, in walking order: run rows and steps. */
const batchItems = (p: Page): Locator =>
  p.getByTestId("batch-results").locator("[data-cursor-id]");

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
  resizedFrom ??= p.viewportSize();
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
 * Make `scroller` scroll: shrink the viewport's height until it shows
 * `overflow` px less than its `content` (so a list the fixture makes short
 * has somewhere to scroll to). The page is as tall as the viewport and the
 * scroller takes what is left, so the two move one for one. Fails, saying
 * what it measured, if the scroller does not end up that much shorter.
 */
async function shrinkToScroll(
  p: Page,
  scroller: Locator,
  content: number,
  overflow: number,
): Promise<void> {
  const size = p.viewportSize();
  if (size === null) throw new Error("visual: the page has no viewport");
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
 * How far an element is scrolled down, in px. `element` is a page-side
 * expression for it (a string, like every page-side script here: the e2e
 * tsconfig has no DOM lib), e.g. `document.querySelector("main")`.
 */
async function scrollTopOf(p: Page, element: string): Promise<number> {
  return (await p.evaluate(`(${element}).scrollTop`)) as number;
}

/**
 * Fail unless `item`'s top is at or below the bottom of the sticky `header`:
 * the item is in view, not under the header. (Within a pixel: layout rounds.)
 */
async function expectBelowHeader(
  item: Locator,
  header: Locator,
  what: string,
): Promise<void> {
  const [at, bar] = await Promise.all([boxOf(item), boxOf(header)]);
  expect(
    at.y,
    `${what}: its top is at ${at.y}px, the header ends at ${bar.y + bar.height}px`,
  ).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
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
  // These only look. The few that resize the viewport (to make a list scroll,
  // or to check the top bar at narrow widths) put it back in `cleanup`.
  {
    // Batches, the palette key, then "visual" typed in the palette: the
    // project's batches that match, in their own Batches group. The letters
    // are the search's, though one of them (`s`) is the page's Start
    // reviewing key.
    name: "state-palette-search",
    path: "/inbox",
    open: async (p) => {
      await expect(batchRows(p).first()).toBeVisible();
      await openPalette(p);
      const input = p.getByTestId("command-input");
      await input.pressSequentially("visual");
      await expect(input).toHaveValue("visual");
      await expect(
        paletteGroup(p, "Batches").locator("[cmdk-item]").first(),
      ).toBeVisible();
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
    name: "state-sheet-batch",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      await expect(
        p.locator('[data-testid^="result-row-"]').first(),
      ).toBeVisible();
      await openSheet(p, "On this page (Batch)");
    },
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
      await p.keyboard.press("j");
      await expect(first).toBeFocused();
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
      const count = await rows.count();
      expect(
        count,
        "the fixture should hold at least three batches that need review",
      ).toBeGreaterThanOrEqual(3);
      const table = await boxOf(p.locator("#inbox-batches-table table"));
      await shrinkToScroll(p, p.locator(BATCHES_SCROLLER), table.height, 100);
      const header = p.locator("#inbox-batches-table thead");

      await p.keyboard.press("j");
      await expect(rows.first()).toBeFocused();
      await p.keyboard.press("End");
      await expect(rows.nth(count - 1)).toBeFocused();
      expect(
        await scrollTopOf(
          p,
          `document.querySelector(${JSON.stringify(BATCHES_SCROLLER)})`,
        ),
        "End should have scrolled the list",
      ).toBeGreaterThan(0);
      await expectBelowHeader(rows.nth(count - 1), header, `row ${count}`);
      for (let i = count - 2; i >= 0; i--) {
        await p.keyboard.press("k");
        await expect(rows.nth(i)).toBeFocused();
        await expectBelowHeader(rows.nth(i), header, `row ${i + 1}`);
      }
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
    // A step card's ring in the sideways scroller (`scroll-px-4`). At the sweep's
    // width the multi-step run's three cards fit in their row, so nothing
    // scrolls; at 900px they do, and the second card, partly out of view, is
    // brought in: its ring (2px, 2px out) must clear both edges of the row.
    name: "state-cursor-step-sideways",
    path: (f) => `/projects/${f.projectId}/builds/${f.multiBuildId}`,
    open: async (p) => {
      const cards = stepCards(p);
      await expect(cards.nth(2)).toBeVisible();
      const size = p.viewportSize();
      if (size === null) throw new Error("visual: the page has no viewport");
      await resizeViewport(p, { width: 900, height: size.height });
      const row = cards.first().locator("xpath=..");
      const [scrollWidth, clientWidth] = (await p.evaluate(
        `(() => { const row = document.querySelector('[data-testid^="step-card-"]').parentElement; return [row.scrollWidth, row.clientWidth]; })()`,
      )) as [number, number];
      expect(
        scrollWidth,
        "the step cards should overflow their row at 900px",
      ).toBeGreaterThan(clientWidth);

      await pressUntilFocused(p, "j", cards.nth(1), 6);
      await expect(cards.nth(1)).toHaveCSS("outline-style", "solid");
      const [card, bounds] = await Promise.all([
        boxOf(cards.nth(1)),
        boxOf(row),
      ]);
      // The row has a 1px border; the ring reaches 2px + 2px past the card.
      const RING = 4;
      expect(
        card.x - (bounds.x + 1),
        "the card's ring should clear the row's left edge",
      ).toBeGreaterThanOrEqual(RING);
      expect(
        bounds.x + bounds.width - 1 - (card.x + card.width),
        "the card's ring should clear the row's right edge",
      ).toBeGreaterThanOrEqual(RING);
    },
    cleanup: restoreViewport,
  },
  {
    // The batch page scrolling under its sticky column header (`scroll-pt-9`,
    // against a 33px header), on the loop batch (two runs, so a run row and a
    // step card sit above the last item). The window is made short enough to
    // scroll the list; End, then K back up to the first row: no item the cursor
    // lands on may be under the header.
    name: "state-cursor-batch-scrolled",
    path: (f) => `/projects/${f.projectId}/builds/${f.loopBuildId}`,
    open: async (p) => {
      const results = p.getByTestId("batch-results");
      const items = batchItems(p);
      await expect
        .poll(() => items.count(), {
          message: "the loop batch should show two run rows and their steps",
        })
        .toBeGreaterThanOrEqual(4);
      const count = await items.count();
      const scroller = results.locator("xpath=..");
      const header = scroller.locator(":scope > div.sticky");
      const content =
        (await boxOf(header)).height + (await boxOf(results)).height;
      await shrinkToScroll(p, scroller, content, 120);

      await p.keyboard.press("j");
      await expect(items.first()).toBeFocused();
      await p.keyboard.press("End");
      await expect(items.nth(count - 1)).toBeFocused();
      expect(
        await scrollTopOf(
          p,
          `document.querySelector('[data-testid="batch-results"]').parentElement`,
        ),
        "End should have scrolled the list",
      ).toBeGreaterThan(0);
      await expectBelowHeader(items.nth(count - 1), header, `item ${count}`);
      for (let i = count - 2; i >= 0; i--) {
        await p.keyboard.press("k");
        await expect(items.nth(i)).toBeFocused();
        await expectBelowHeader(items.nth(i), header, `item ${i + 1}`);
      }
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
