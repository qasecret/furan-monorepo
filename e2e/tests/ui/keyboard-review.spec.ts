import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

const DESKTOP = "400x300";

/** The two batches that need review; the older one is captured first. */
const BATCH_OLDER = "kbd-batch-older";
const BATCH_NEWER = "kbd-batch-newer";

const THEMES = ["light", "dark"] as const;

/** The single-key switch's storage key, which the Help menu flips. */
const SINGLE_KEYS_KEY = "furan:keys:single";

/** The open dialog: the palette and the `?` sheet are both Radix dialogs. */
const OPEN_DIALOG = '[role="dialog"][data-state="open"]';

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type AxeNode = AxeResults["violations"][number]["nodes"][number];

const isOutsideViewport = (n: AxeNode): boolean =>
  n.any.some(
    (c) =>
      (c.data as { messageKey?: string } | null)?.messageKey ===
      "outsideViewport",
  );

/**
 * The colour-contrast problems in `r`, as the visual sweep counts them: every
 * violation node, and every node axe skipped as outside the viewport (it
 * could not check it, which must not pass as fine). One line each.
 */
function contrastProblems(r: AxeResults): string[] {
  const nodes = [
    ...r.violations.flatMap((rule) => rule.nodes),
    ...r.incomplete.flatMap((rule) => rule.nodes.filter(isOutsideViewport)),
  ];
  return nodes.map((n) => {
    const d = (n.any[0]?.data ?? {}) as {
      fgColor?: string;
      bgColor?: string;
      contrastRatio?: number;
      expectedContrastRatio?: string;
    };
    const where = n.target.join(" ");
    return isOutsideViewport(n)
      ? `${where}: not measured, outside the viewport`
      : `${where}: ${d.fgColor ?? "?"} on ${d.bgColor ?? "?"} = ${d.contrastRatio ?? "?"}:1 (needs ${d.expectedContrastRatio ?? "?"})`;
  });
}

/**
 * Why axe could not measure the pairs it left incomplete, one reason per node
 * (its `messageKey`), leaving out those outside the viewport, which
 * `contrastProblems` already counts as problems.
 */
const unmeasuredReasons = (r: AxeResults): string[] =>
  r.incomplete.flatMap((rule) =>
    rule.nodes
      .filter((n) => !isOutsideViewport(n))
      .map(
        (n) =>
          n.any
            .map((c) => (c.data as { messageKey?: string } | null)?.messageKey)
            .find((k) => k !== undefined) ?? "none",
      ),
  );

/**
 * Two animation frames in the page: long enough for a key press that did act
 * to have rendered and sent what it sends, so a check that nothing happened
 * is not just early.
 */
const TWO_FRAMES =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))";

/** The viewer's comparison modes, as their radios read, on keys 1–5. */
const VIEWER_MODES = ["Side by side", "Swipe", "Flicker", "Overlay", "Diff"];

/**
 * The canvas label's text, then every text it changes to, over 1.5 s: three
 * swaps at Flicker's 500 ms rate, had it been playing. A MutationObserver,
 * so a change between two looks is not missed.
 */
const LABEL_OVER_1500MS = `new Promise((resolve) => {
  const read = () =>
    document.querySelector('[data-testid="canvas-mode-label"]')?.textContent ?? null;
  const seen = [read()];
  const watch = new MutationObserver(() => {
    const now = read();
    if (now !== seen[seen.length - 1]) seen.push(now);
  });
  watch.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  setTimeout(() => {
    watch.disconnect();
    resolve(seen);
  }, 1500);
})`;

/** A review decision sent to the server (`review.approve`, `review.reject`…). */
const isDecision = (req: Request): boolean =>
  /\/trpc\/[^?]*\breview\.(approve|reject)/.test(req.url());

/** How many nodes of `rules` axe reported. */
const nodeCount = (rules: AxeResults["passes"]): number =>
  rules.reduce((n, rule) => n + rule.nodes.length, 0);

/**
 * First-visit page tours (components/tour) open over the page behind a scrim
 * that takes the keys (and would skew the contrast check) until dismissed;
 * dismissal lives in localStorage per page (`furan:tour:dismissed:<pageId>`).
 * Report every tour as already dismissed, as the other UI specs do.
 */
const NO_TOURS = `(() => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    return typeof key === "string" && key.startsWith("furan:tour:dismissed:")
      ? "1"
      : getItem.call(this, key);
  };
})();`;

/** What a user's project assignment was, to put it back afterwards. */
interface Assignment {
  userId: string;
  projectIds: string[];
  defaultProjectId: string | null;
}

/** `text` as a RegExp source that matches exactly it. */
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Press `key` until `target` has focus, at most `max` presses, and say how
 * many it took (0 when it already had it). Focus is where the keyboard is, so
 * "got there" is "has focus": nothing is slept on, and a target the keys
 * never reach fails saying so.
 */
async function pressUntilFocused(
  page: Page,
  key: string,
  target: Locator,
  max: number,
): Promise<number> {
  const focused = async (): Promise<boolean> =>
    (await target.and(page.locator(":focus")).count()) === 1;
  if (await focused()) return 0;
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press(key);
    if (await focused()) return presses;
  }
  throw new Error(
    `focus did not reach ${String(target)} in ${max} "${key}" presses`,
  );
}

/**
 * The keyboard on screen, driven with a real browser: a reviewer clears two
 * batches without touching the mouse. Every navigation and every decision is a
 * key press (`page.keyboard`); the only things not done with keys are setting
 * the data up through the API and the page loads that start the flow.
 *
 * It builds its OWN data in a project of its own, created fresh for every run:
 * Start reviewing speaks for the whole project, so nothing may be pending
 * there but this run's steps. On one branch:
 *
 *   baseline : cart, profile, checkout, settings   (one run each, approved)
 *   older    : test checkout changed, test settings changed
 *   newer    : test cart changed,     test profile changed     (newest)
 *
 * so both batches need review, by two steps each.
 *
 * Batches lists the signed-in user's CURRENT project, their default: the
 * flow makes this project the bootstrap admin's default for its run and puts
 * the old assignment back afterwards. The admin can sign in about 10 times in
 * 15 minutes (ADR-063), so the flow signs in ONCE, in `beforeAll`.
 *
 * Serial: every test builds on the state the previous one left.
 */
test.describe.serial("ui: keyboard review", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let branch = "";
  let restore: Assignment | undefined;
  let cart: CaptureRunResult; // newer batch, first test
  let profile: CaptureRunResult; // newer batch, second test
  let checkout: CaptureRunResult; // older batch, first test
  let settings: CaptureRunResult; // older batch, second test

  /** A step's page in the diff viewer (its path; the URL may carry a context). */
  const stepPath = (run: CaptureRunResult, name: string): string =>
    `/projects/${projectId}/runs/${run.runId}/checkpoints/${run.checkpointIds[name]}`;
  const atStep =
    (run: CaptureRunResult, name: string) =>
    (url: URL): boolean =>
      url.pathname === stepPath(run, name);
  /** A batch's page. */
  const atBatch =
    (run: CaptureRunResult) =>
    (url: URL): boolean =>
      url.pathname === `/projects/${projectId}/builds/${run.buildId}`;

  /** A run's step cards on the batch page, and its row. */
  const stepCard = (run: CaptureRunResult, name: string): Locator =>
    page.getByTestId(`step-card-${run.checkpointIds[name]}`);
  const runRow = (run: CaptureRunResult): Locator =>
    page.getByTestId(`result-row-${run.runId}`);

  /** How many batches of the project need review, as the server counts them. */
  const pendingBatches = async (): Promise<number> =>
    (
      await api.trpcQuery<{ total: number }>(admin, "builds.pendingCount", {
        projectId,
      })
    ).total;

  /** `step name → review state` of a run, as the server has it. */
  const states = async (
    run: CaptureRunResult,
  ): Promise<Record<string, string | null>> => {
    const { items } = await api.trpcQuery<{
      items: Array<{ name: string; state: string | null }>;
    }>(admin, "runs.listCheckpoints", { runId: run.runId });
    return Object.fromEntries(items.map((c) => [c.name, c.state]));
  };
  /**
   * Wait for the server to say `run`'s steps are `expected`. Undoing an
   * approval queues a re-diff, so for a moment a step has no verdict: this
   * poll (never a fixed sleep) waits it out.
   */
  const expectStates = async (
    run: CaptureRunResult,
    expected: Record<string, string | null>,
  ): Promise<void> => {
    await expect
      .poll(() => states(run), {
        intervals: [500, 1_000, 2_000],
        timeout: 60_000,
      })
      .toEqual(expected);
  };

  /**
   * The Undo button of the newest toast (Sonner's front one) when that toast
   * is the approval of `name`. The undo entry is made as the decision's
   * answer arrives, with this toast: ⌘Z is pressed once it is offered, not as
   * soon as the server has the decision. Older toasts can still be up (an
   * earlier approval of the same step among them), so only the front counts.
   */
  const frontToast = (): Locator =>
    page.locator('[data-sonner-toast][data-front="true"]');
  const undoOffered = (name: string): Locator =>
    frontToast()
      .filter({ hasText: `Approved '${name}'` })
      .getByRole("button", { name: "Undo" });

  /** The page's polite live region, which says where a move went. */
  const announcer = (): Locator => page.getByTestId("review-announcer");
  /** The viewer's pill: how many steps are left in the batch. */
  const pill = (): Locator => page.getByTestId("header-loop-remaining");

  /** Approve the step on screen with A, once it can be approved. */
  const approveWithA = async (): Promise<void> => {
    const approve = page.getByTestId("approve-checkpoint-button");
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("a");
  };

  /** The palette, its search box, and one of its groups by heading. */
  const palette = (): Locator => page.getByTestId("command-palette");
  const paletteInput = (): Locator => page.getByTestId("command-input");
  const paletteGroup = (heading: string): Locator =>
    palette()
      .locator("[cmdk-group]")
      .filter({
        has: page.locator("[cmdk-group-heading]", {
          hasText: new RegExp(`^${escapeRegExp(heading)}$`),
        }),
      });
  /** The rows the palette has chosen: always exactly one. */
  const chosenRow = (): Locator =>
    palette().locator('[cmdk-item][aria-selected="true"]');

  /** Open the palette with ⌘K / Ctrl+K (lower-case: the key is `k`). */
  const openPalette = async (): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette()).toBeVisible();
    await expect(paletteInput()).toBeFocused();
  };

  /**
   * R30: the search box names the chosen row by its id, whatever chose it.
   * Retried until it holds, as the palette repairs a name after it renders.
   */
  const expectChosenRowNamed = async (): Promise<void> => {
    await expect
      .poll(async () => {
        const id = await chosenRow().getAttribute("id");
        return (
          id !== null &&
          id === (await paletteInput().getAttribute("aria-activedescendant"))
        );
      })
      .toBe(true);
  };

  /** The top bar's Help button and its menu. */
  const help = (): Locator => page.getByTestId("top-bar-help");
  const singleKeysItem = (): Locator =>
    page.getByRole("menuitemcheckbox", { name: "Single-key shortcuts" });
  const storedSingleKeys = (): Promise<string | null> =>
    page.evaluate(
      `window.localStorage.getItem(${JSON.stringify(SINGLE_KEYS_KEY)})`,
    ) as Promise<string | null>;

  /**
   * Flip "Single-key shortcuts" in the Help menu with the keyboard alone:
   * Shift+Tab back to the Help button (it may already have focus), Enter opens
   * its menu, End to the checkbox, Space flips it and the menu closes,
   * giving Help its focus back. The announcer says which way.
   *
   * Backwards, because Help is in the top bar, a few stops before the page.
   * Forwards would run through the whole page and into the toast region, which
   * sends focus back to where it was while a toast is up (Sonner), so a walk
   * of any length could go round in a circle: the last decision's toast is
   * still up here.
   *
   * The assumption: on the viewer, after a client-side navigation, nothing
   * has focus and Chromium starts the sequential walk at the top of the page
   * (`<main>`), so Help is 3 stops back (Account menu, Theme, Help; the bell
   * is not focusable). The bound of 12 allows for a few more top-bar stops,
   * and a page that starts the walk elsewhere fails here, saying so.
   */
  const flipSingleKeysInHelp = async (now: "on" | "off"): Promise<void> => {
    await pressUntilFocused(page, "Shift+Tab", help(), 12);
    await page.keyboard.press("Enter");
    // The menu gives its first item the focus as it opens: an arrow pressed
    // before that would be the trigger's, not the menu's.
    await expect(
      page.getByRole("menuitem", { name: "Keyboard shortcuts" }),
    ).toBeFocused();
    // End goes to the last item, the checkbox (a page with a tour has a Replay
    // tour item before it, so a count of ArrowDown presses would depend on it).
    await page.keyboard.press("End");
    await expect(singleKeysItem()).toBeFocused();
    await expect(singleKeysItem()).toHaveAttribute(
      "aria-checked",
      now === "on" ? "false" : "true",
    );
    await page.keyboard.press("Space");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(help()).toBeFocused();
    await expect(announcer()).toHaveText(`Single-key shortcuts ${now}`);
    expect(await storedSingleKeys()).toBe(now === "on" ? "1" : "0");
  };

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Eight captures, each waiting on the diff pipeline, and a login.
    test.setTimeout(240_000);
    ({ admin, pat } = ownerCreds());

    // The admin's assignment as it is before this run touches anything:
    // creating a project may make its creator a member, which the restore
    // must not keep.
    const me = await api.me(admin);
    restore = {
      userId: me.id,
      projectIds: await api.listUserProjects(admin, me.id),
      defaultProjectId: me.defaultProjectId ?? null,
    };

    const stamp = Date.now();
    projectId = (
      await api.createProject(admin, { name: `kbd-review-ui-${stamp}` })
    ).id;
    branch = `kbd-ui-${stamp}`;

    /**
     * One run per test, each with the one step named like it, in one batch:
     * the batch is created by the first (`buildName`), the others join it.
     */
    const batch = async (
      buildName: string,
      tests: string[],
      fixture: "baseline" | "changed",
    ): Promise<CaptureRunResult[]> => {
      const runs: CaptureRunResult[] = [];
      for (const name of tests) {
        runs.push(
          await captureRun(api, {
            pat,
            projectId,
            branchName: branch,
            viewport: DESKTOP,
            checkpoints: [{ name, fixture }],
            ...(runs[0] ? { buildId: runs[0].buildId } : { buildName }),
          }),
        );
      }
      return runs;
    };

    // The baselines, approved wholesale.
    for (const run of await batch(
      "kbd-baseline",
      ["cart", "profile", "checkout", "settings"],
      "baseline",
    )) {
      expect(run.status).toBe("new");
      await api.approveRun(admin, run.runId);
    }
    // The older batch, then the newer: Start reviewing opens the newest.
    const two = (
      runs: CaptureRunResult[],
    ): [CaptureRunResult, CaptureRunResult] => {
      const [first, second] = runs;
      if (!first || !second) throw new Error("a batch needs two runs");
      return [first, second];
    };
    [checkout, settings] = two(
      await batch(BATCH_OLDER, ["checkout", "settings"], "changed"),
    );
    [cart, profile] = two(
      await batch(BATCH_NEWER, ["cart", "profile"], "changed"),
    );
    for (const run of [checkout, settings, cart, profile]) {
      expect(run.status).toBe("unresolved");
    }
    // Nothing else in the project needs review.
    expect(await pendingBatches()).toBe(2);

    // Make the project the reviewer's current one (Batches shows the default
    // project), keeping every membership the admin already had.
    await api.setUserProjects(admin, {
      userId: me.id,
      projectIds: [...new Set([...restore.projectIds, projectId])],
      defaultProjectId: projectId,
    });

    // One session for the whole flow (the undo stack and the single-key
    // switch live in the page). Reduced motion: the dialogs' entrance
    // animations fade them in, and axe must not measure them half-faded. No
    // stored theme, so the app follows the colour scheme.
    context = await browser.newContext({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript({ content: NO_TOURS });
    page = await context.newPage();
    await page.goto("/login");
    await page.fill("#email", BOOTSTRAP_EMAIL);
    await page.fill("#password", BOOTSTRAP_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 20_000,
    });
  });

  test.afterAll(async () => {
    // Put the admin's projects and default back as they were, first: a
    // context that fails to close must not leave them changed.
    try {
      if (restore) await api.setUserProjects(admin, restore);
    } finally {
      await context?.close();
    }
  });

  test("Batches: J focuses the first row and S starts reviewing; A moves on with the cue, A again shows Batch done, Enter continues to the older batch", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    await page.goto("/inbox");
    // Wait for what the keys act on: the count (so S can start) and the rows.
    const start = page.getByTestId("inbox-start-reviewing");
    await expect(start).toContainText("Start reviewing (2)");
    await expect(start).toBeEnabled();
    const newerRow = page.getByTestId(`inbox-batch-row-${cart.buildId}`);
    await expect(newerRow).toBeVisible();

    // J: the first row, the newest batch.
    await page.keyboard.press("j");
    await expect(newerRow).toBeFocused();

    // S: the viewer, on the first pending step of the newest batch.
    await page.keyboard.press("s");
    await expect(page).toHaveURL(atStep(cart, "cart"));
    // The pill says the loop has its answer, so the keys act.
    await expect(pill()).toHaveText("2 left in batch");

    // A: the step is decided and the loop moves on, saying so.
    await approveWithA();
    await expect(page).toHaveURL(atStep(profile, "profile"));
    await expect(announcer()).toHaveText(
      "Next test: profile · 1 left in batch",
    );
    await expect(pill()).toHaveText("1 left in batch");

    // A again: nothing is left in the batch.
    await approveWithA();
    const done = page.getByRole("dialog", { name: "Batch done" });
    await expect(done).toBeVisible();
    const proceed = done.getByRole("button", {
      name: `Continue to ${BATCH_OLDER} · ${branch} · 2 pending`,
      exact: true,
    });
    await expect(proceed).toBeFocused();

    // The card is not modal, so the app's own keys pass it (R33): ⌘K opens
    // the palette over it, and Esc gives the card its focus back; `?` opens
    // this page's sheet, and Esc closes it the same way.
    await openPalette();
    await page.keyboard.press("Escape");
    await expect(palette()).toHaveCount(0);
    await expect(proceed).toBeFocused();
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("heading", {
        name: "On this page (Diff viewer)",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(done).toBeVisible();
    await expect(proceed).toBeFocused();

    // Enter: the older batch, on its first pending step.
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(atStep(checkout, "checkout"));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectStates(cart, { cart: "approved" });
    await expectStates(profile, { profile: "approved" });
  });

  test("G I goes back to Batches; J and Enter open a batch; on its page J reaches a step card, A approves it and the cursor moves on, ⌘Z takes it back", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).toHaveURL((url) => url.pathname === "/inbox");

    // A decided step leaves the Needs review list, and with it the card: to
    // see a card read Approved the reviewer shows All, from the palette (a
    // command of this page). The newer batch, now all approved, is listed.
    const newerRow = page.getByTestId(`inbox-batch-row-${cart.buildId}`);
    const olderRow = page.getByTestId(`inbox-batch-row-${checkout.buildId}`);
    await expect(olderRow).toBeVisible();
    await openPalette();
    await page.keyboard.type("Show: All");
    await expect(chosenRow()).toHaveText("Show: All");
    await page.keyboard.press("Enter");
    await expect(palette()).toHaveCount(0);
    await expect(page.getByTestId("inbox-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(newerRow).toBeVisible();

    // J, J, Enter: newest first, so the older batch is the second row.
    await page.keyboard.press("j");
    await expect(newerRow).toBeFocused();
    await page.keyboard.press("j");
    await expect(olderRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      (url) =>
        atBatch(checkout)(url) && url.searchParams.get("status") === "all",
    );

    // The cursor walks a run row, then its step card. The keys act on the
    // rows once they have loaded their steps.
    const checkoutCard = stepCard(checkout, "checkout");
    const settingsCard = stepCard(settings, "settings");
    await expect(checkoutCard).toBeVisible();
    await expect(settingsCard).toBeVisible();
    await page.keyboard.press("j");
    await expect(runRow(checkout)).toBeFocused();
    await page.keyboard.press("j");
    await expect(checkoutCard).toBeFocused();
    await expect(checkoutCard).toHaveAttribute(
      "aria-label",
      "checkout, Unresolved",
    );

    // A: the card reads Approved, and the cursor moves on to the next step
    // that needs review (past the next run's row).
    await page.keyboard.press("a");
    await expect(checkoutCard).toHaveAttribute(
      "aria-label",
      "checkout, Approved",
    );
    await expect(settingsCard).toBeFocused();
    await expectStates(checkout, { checkout: "approved" });

    // ⌘Z / Ctrl+Z takes it back, with focus where the cursor moved.
    await expect(undoOffered("checkout")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(checkoutCard).toHaveAttribute(
      "aria-label",
      "checkout, Unresolved",
    );
    await expectStates(checkout, { checkout: "unresolved" });
    await expect(settingsCard).toBeFocused();
  });

  test("⌘K finds a batch by its name, and Enter opens it", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // The newer batch (all approved): its name lists it under Batches, as the
    // first row chosen, and the search box names that row (R29, R30).
    await openPalette();
    await page.keyboard.type(BATCH_NEWER);
    const hit = paletteGroup("Batches").locator("[cmdk-item]");
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveText(`${BATCH_NEWER} · ${branch} · 0 pending`);
    await expect(chosenRow()).toHaveText(
      `${BATCH_NEWER} · ${branch} · 0 pending`,
    );
    await expectChosenRowNamed();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(atBatch(cart));
    await expect(palette()).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `Test results of batch: ${BATCH_NEWER}`,
    );

    // And back to the older one, the same way, for the rest of the flow.
    await openPalette();
    await page.keyboard.type(BATCH_OLDER);
    const olderHit = paletteGroup("Batches").locator("[cmdk-item]");
    await expect(olderHit).toHaveCount(1);
    await expect(olderHit).toHaveText(
      new RegExp(
        `^${escapeRegExp(`${BATCH_OLDER} · ${branch} · `)}\\d+ pending$`,
      ),
    );
    await expect(chosenRow()).toHaveText(/^kbd-batch-older/);
    await expectChosenRowNamed();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(atBatch(checkout));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `Test results of batch: ${BATCH_OLDER}`,
    );
  });

  test("Guard: with Approve pending open, G I keeps the page and ? shows no sheet; Esc closes only the question", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // The palette's pick opened the batch at its default view: both steps
    // are pending again after the undo.
    await expect(stepCard(checkout, "checkout")).toBeVisible();
    await expect(stepCard(settings, "settings")).toBeVisible();
    // J to the first row (the list's one Tab stop), Shift+Tab to the button
    // before the list.
    await page.keyboard.press("j");
    await expect(runRow(checkout)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    const approveAll = page.getByTestId("batch-approve-all");
    await expect(approveAll).toBeFocused();
    await expect(approveAll).toContainText("Approve pending (2)");

    await page.keyboard.press("Enter");
    const question = page.getByRole("alertdialog");
    await expect(question).toBeVisible();
    await expect(question.getByText("Approve 2 pending steps?")).toBeVisible();
    await expect(question.getByTestId("approve-pending-cancel")).toBeFocused();
    const batchUrl = page.url();

    // Neither key may reach the page through the question.
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await page.keyboard.press("?");
    // Esc closes the question and only it: had `?` opened the sheet over the
    // question, Esc would close the sheet and leave the question here.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(page.url()).toBe(batchUrl);
    await expect(approveAll).toBeFocused();

    // The control: with nothing open `?` does open this page's sheet, and the
    // page is still the batch (G I never went anywhere).
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole("heading", { name: "On this page (Batch)", exact: true }),
    ).toBeVisible();
    expect(page.url()).toBe(batchUrl);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(page.url()).toBe(batchUrl);

    // And G I is live on this page: with nothing open it goes to Batches.
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).toHaveURL((url) => url.pathname === "/inbox");

    // Back to the batch, at its default view, as the palette opens a batch.
    await openPalette();
    await page.keyboard.type(BATCH_OLDER);
    await expect(paletteGroup("Batches").locator("[cmdk-item]")).toHaveCount(1);
    await expect(chosenRow()).toHaveText(/^kbd-batch-older/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      (url) => atBatch(checkout)(url) && !url.searchParams.has("status"),
    );
  });

  test("Needs review: A on a step card takes its run off the list, the next card has focus, and ⌘Z brings it back", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // The batch at its default view (Needs review): both steps pending.
    const checkoutCard = stepCard(checkout, "checkout");
    const settingsCard = stepCard(settings, "settings");
    await expect(checkoutCard).toBeVisible();
    await expect(settingsCard).toBeVisible();
    await pressUntilFocused(page, "j", checkoutCard, 3);

    // A: decided, the run leaves the list (it no longer needs review), and
    // the cursor is on the next step that does, with focus (spec §6: focus is
    // never lost with an item).
    await page.keyboard.press("a");
    await expect(runRow(checkout)).toHaveCount(0);
    await expect(checkoutCard).toHaveCount(0);
    await expect(settingsCard).toBeFocused();
    await expectStates(checkout, { checkout: "approved" });

    // ⌘Z, once the Undo is offered: the run is back on the list, pending, and
    // focus stays on the card it was on.
    await expect(undoOffered("checkout")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expectStates(checkout, { checkout: "unresolved" });
    await expect(checkoutCard).toHaveAttribute(
      "aria-label",
      "checkout, Unresolved",
    );
    await expect(settingsCard).toBeFocused();

    // The cursor back on the first card, where the next test starts.
    await pressUntilFocused(page, "k", checkoutCard, 3);
  });

  test("Switch: Single-key shortcuts off in the Help menu stops A; Approve step in the palette still approves", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // Into the viewer from the batch page: J to the step card, Enter opens it.
    await pressUntilFocused(page, "j", stepCard(checkout, "checkout"), 3);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(atStep(checkout, "checkout"));
    const approve = page.getByTestId("approve-checkpoint-button");
    await expect(approve).toBeEnabled();
    await expect(pill()).toHaveText("2 left in batch");

    await flipSingleKeysInHelp("off");

    // A does nothing: no decision is sent, and the step is still the one on
    // screen and still pending. The checks wait two frames first: the loop
    // moves on as soon as a decision is made, so an A that did act would have
    // shown it (and sent it) by then.
    const decisions: string[] = [];
    const onRequest = (req: Request): void => {
      if (isDecision(req)) decisions.push(req.url());
    };
    page.on("request", onRequest);
    try {
      await page.keyboard.press("a");
      await page.evaluate(TWO_FRAMES);
      await expect(approve).toBeVisible();
      await expect(approve).toBeEnabled();
      await expect(page).toHaveURL(atStep(checkout, "checkout"));
      expect(decisions, "a decision sent after A with the switch off").toEqual(
        [],
      );

      // The command is all there in the palette, and approves THAT step: had
      // A worked above, this would approve the next one.
      await openPalette();
      await page.keyboard.type("Approve step");
      await expect(palette().locator("[cmdk-item]")).toHaveCount(1);
      await expect(chosenRow()).toHaveText("Approve step");
      await page.keyboard.press("Enter");
      await expect(palette()).toHaveCount(0);
      // Its toast is the newest (earlier approvals of checkout may still be
      // up).
      await expect(frontToast()).toContainText("Approved 'checkout'");
      // The control: the same watch sees the palette's decision, so its
      // silence after A meant something.
      expect(decisions.length, "the palette's decision was seen").toBe(1);
    } finally {
      page.off("request", onRequest);
    }
    await expect(page).toHaveURL(atStep(settings, "settings"));
    await expect(announcer()).toHaveText(
      "Next test: settings · 1 left in batch",
    );
    await expectStates(checkout, { checkout: "approved" });
    await expectStates(settings, { settings: "unresolved" });

    // And back on, from the same menu.
    await flipSingleKeysInHelp("on");
  });

  test("The viewer's keys: 1–5 pick each comparison mode, → on the swipe handle moves it 2%, with motion reduced Flicker stands still until F swaps it, T hides and shows the details", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    await expect(page).toHaveURL(atStep(settings, "settings"));
    const modes = page.getByRole("radiogroup", { name: "Comparison mode" });

    // 1–5: each key checks its mode's radio, and only it.
    for (const [i, name] of VIEWER_MODES.entries()) {
      await page.keyboard.press(String(i + 1));
      await expect(
        modes.getByRole("radio", { name, exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        modes.locator('[role="radio"][aria-checked="true"]'),
      ).toHaveCount(1);
    }

    // Swipe: Tab to its handle, the slider, and → twice moves it 2% each.
    await page.keyboard.press("2");
    await expect(
      modes.getByRole("radio", { name: "Swipe", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    const handle = page.getByRole("slider", { name: "Swipe position" });
    await expect(handle).toHaveAttribute("aria-valuenow", "50");
    await pressUntilFocused(page, "Tab", handle, 60);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "54");
    await expect(handle).toHaveAttribute("aria-valuetext", "54% baseline");

    // Flicker with motion reduced: no Play, and the frame stands still (for
    // 1.5 s, three swaps at its rate) until F swaps it, saying so. The flow's
    // context prefers reduced motion throughout (see beforeAll), so nothing
    // is emulated here, and nothing is left for the tests after this one.
    // (`emulateMedia({ reducedMotion: null })` would not put the context's
    // preference back: it lifts the emulation, motion and all.)
    expect(
      await page.evaluate(
        'matchMedia("(prefers-reduced-motion: reduce)").matches',
      ),
      "the flow's context prefers reduced motion",
    ).toBe(true);
    await page.keyboard.press("3");
    await expect(
      modes.getByRole("radio", { name: "Flicker", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    const label = page.getByTestId("canvas-mode-label");
    await expect(label).toHaveText("Baseline");
    await expect(page.getByTestId("flicker-play-toggle")).toHaveCount(0);
    expect(
      await page.evaluate(LABEL_OVER_1500MS),
      "the canvas label's texts over 1.5 s",
    ).toEqual(["Baseline"]);
    await page.keyboard.press("f");
    await expect(label).toHaveText("Current");
    await expect(page.getByTestId("flicker-status")).toHaveText(
      "Showing current",
    );

    // T: the details rail folds to its strip, and T opens it again.
    const rail = page.getByTestId("test-info-sidebar");
    await expect(rail).not.toHaveAttribute("data-collapsed");
    await page.keyboard.press("t");
    await expect(rail).toHaveAttribute("data-collapsed", "");
    await expect(
      rail.getByRole("button", { name: "Show details", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("t");
    await expect(rail).not.toHaveAttribute("data-collapsed");
    await expect(
      rail.getByRole("button", { name: "Hide details", exact: true }),
    ).toBeVisible();

    // Back to side by side for the rest of the flow.
    await page.keyboard.press("1");
    await expect(
      modes.getByRole("radio", { name: "Side by side", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("The palette and the ? sheet are legible in both themes", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // The switch is on again: the sheet opens with `?`, here for the viewer,
    // the page with the most keys. Tall enough for all of it, so that axe can
    // measure every row of the sheet and not skip those below the fold.
    await expect(page).toHaveURL(atStep(settings, "settings"));
    await expect(page.getByTestId("approve-checkpoint-button")).toBeEnabled();
    await page.setViewportSize({ width: 1280, height: 1800 });

    const found: Record<string, string[]> = {};
    /** Axe colour-contrast on the open dialog; problems are what the sweep counts. */
    const check = async (what: string): Promise<void> => {
      const results = await new AxeBuilder({ page })
        .withRules(["color-contrast"])
        .include(OPEN_DIALOG)
        .analyze();
      found[what] = contrastProblems(results);
      const passed = nodeCount(results.passes);
      const reasons = unmeasuredReasons(results);
      testInfo.annotations.push({
        type: "color-contrast",
        description: `${what}: ${found[what]?.length ?? 0} problem(s), ${passed} node(s) passed, ${nodeCount(results.incomplete)} incomplete (${[...new Set(reasons)].join(", ") || "none"})`,
      });
      // Only symbol-only text (the arrow glyphs on key caps: `nonBmp`) may go
      // unmeasured. Any other reason (an overlap, a translucent colour) would
      // hide a real pair from the check.
      expect(
        reasons.filter((reason) => reason !== "nonBmp"),
        `${what}: text axe could not measure`,
      ).toEqual([]);
      // An empty result must not pass for a clean one: axe saw text.
      expect(
        passed + nodeCount(results.violations),
        `${what}: axe measured no text`,
      ).toBeGreaterThan(0);
    };

    try {
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme });
        const html = page.locator("html");
        if (theme === "dark") {
          await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
        } else {
          await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
        }

        // The palette on its own, then with a search that finds a batch.
        await openPalette();
        await expect(paletteGroup("Actions")).toBeVisible();
        await check(`${theme} palette`);
        await page.keyboard.type(BATCH_OLDER);
        await expect(
          paletteGroup("Batches").locator("[cmdk-item]"),
        ).toHaveCount(1);
        await expectChosenRowNamed();
        await check(`${theme} palette, searching`);
        await page.keyboard.press("Escape");
        await expect(palette()).toHaveCount(0);

        // The sheet.
        await page.keyboard.press("?");
        const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
        await expect(sheet).toBeVisible();
        await expect(
          sheet.getByRole("heading", {
            name: "On this page (Diff viewer)",
            exact: true,
          }),
        ).toBeVisible();
        await check(`${theme} sheet`);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    } finally {
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    expect(
      found,
      "colour-contrast problems on the palette and the sheet",
    ).toEqual(Object.fromEntries(Object.keys(found).map((what) => [what, []])));
    // Both dialogs were checked in both themes.
    expect(Object.keys(found)).toHaveLength(6);
  });

  test("The done card at the end of the work: G I goes to Batches from it", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.keyboard"]));

    // A on the last pending step: nothing is left anywhere in the project.
    await expect(page).toHaveURL(atStep(settings, "settings"));
    await approveWithA();
    const done = page.getByRole("dialog", { name: "All caught up" });
    await expect(done).toBeVisible();
    await expect(
      done.getByRole("link", { name: "Back to batches", exact: true }),
    ).toBeFocused();
    await expectStates(settings, { settings: "approved" });

    // The card keeps the viewer's keys, but the app's G I passes it (R33).
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).toHaveURL((url) => url.pathname === "/inbox");
  });
});
