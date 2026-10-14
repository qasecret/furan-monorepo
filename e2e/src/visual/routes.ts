import { expect, type Page } from "@playwright/test";

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
 */
async function openStep(p: Page, name: string): Promise<void> {
  const stepRow = p.getByTestId("test-info-sidebar").getByText(/^\d+\/\d+ \S/);
  const next = p.getByTestId("contextual-header-next");
  let current = "";
  for (let hops = 0; hops < 8; hops++) {
    current = (await stepRow.innerText()).trim();
    if (current.replace(/^\d+\/\d+ /, "") === name) return;
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

/** The toast a review decision raised, which carries the Undo action. */
const decisionToast = (p: Page, label: string) =>
  p.locator("[data-sonner-toast]").filter({ hasText: label });

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
  // ---- the review flow --------------------------------------------------
  // Added at the END, in this order: the first two only look, the last one
  // changes the fixture (and puts it back, see `cleanup`), so it must run last.
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
