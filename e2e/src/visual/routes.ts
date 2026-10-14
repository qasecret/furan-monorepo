import { expect, type Page } from "@playwright/test";

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
}

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
    { name: "project", path: P },
    { name: "builds", path: `${P}/builds` },
    { name: "build", path: `${P}/builds/${f.buildId}` },
    // The multi-step run's build and run: result rows of several steps, with
    // an approved, a rejected and a pending step.
    { name: "build-multi", path: (x) => `${P}/builds/${x.multiBuildId}` },
    { name: "runs", path: `${P}/runs` },
    { name: "run", path: `${P}/runs/${f.unresolvedRunId}` },
    // `/runs/:id` redirects to its first checkpoint, whose viewer shows the
    // step arrows between the run's steps.
    { name: "run-multi", path: (x) => `${P}/runs/${x.multiRunId}` },
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
 * Where the links actually are (checked in the DOM, 2026-10-08):
 *  - `/runs/:runId/diffs/:diffId` is linked only from a variation's history
 *    table, so `diff` goes variations → variation → diff. (The run page and the
 *    diff viewer render no `/diffs/` or `/checkpoints/` anchors.)
 *  - `/runs/:runId/checkpoints/:checkpointId` has no anchor anywhere — it is
 *    reached by `router.push`/`replace` only — so it has no entry here. The
 *    `run` static route covers it: `/runs/:runId` redirects to the run's first
 *    checkpoint, which is what that screenshot shows.
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
    href: /\/diffs\/[^/]+$/,
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
}

/**
 * Hover the first step card of the multi-step build's result row, so its
 * action toolbar (quick-approve, open) shows. Looked up from the page rather
 * than by id: step ids are different on every stack. A collapsed row is
 * expanded first.
 */
async function hoverFirstStep(p: Page): Promise<void> {
  const row = p.locator('[data-testid^="result-row-"]').first();
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
  const card = p.locator('[data-testid^="step-card-"]').first();
  await expect(card).toBeVisible();
  await card.hover();
  // The toolbar (the "open in the viewer" button's parent) is `opacity-0`
  // until the card is hovered.
  const toolbar = card
    .getByRole("button", { name: /^Open .+ in the viewer$/ })
    .locator("..");
  await expect(toolbar).toHaveCSS("opacity", "1");
}

export const STATES: ReadonlyArray<VisualState> = [
  {
    name: "state-cmdk",
    path: "/inbox",
    open: async (p) => {
      // ⌘K on macOS, Ctrl+K elsewhere. Lower-case: the palette matches
      // `e.key === "k"`, and "Meta+K" would send key "K".
      await p.keyboard.press("ControlOrMeta+k");
      await expect(p.getByTestId("command-palette")).toBeVisible();
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
];
