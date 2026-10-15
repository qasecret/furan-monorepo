import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
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

/** The virtual SDK's default viewport, and a phone's for the second test. */
const DESKTOP = "400x300";
const PHONE = "375x812";

/** The two batches that need review; A is the older one. */
const BATCH_A = "review-loop-batch-a";
const BATCH_B = "review-loop-batch-b";

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** The done card, for axe. */
const CARD = '[data-testid="batch-done-card"]';

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

/** How many nodes of `rules` axe reported. */
const nodeCount = (rules: AxeResults["passes"]): number =>
  rules.reduce((n, rule) => n + rule.nodes.length, 0);

/**
 * First-visit page tours (components/tour) open over the page behind a scrim
 * that takes the clicks (and would skew the contrast check) until dismissed;
 * dismissal lives in localStorage per page (`furan:tour:dismissed:<pageId>`).
 * Report every tour as already dismissed, as the visual sweep does.
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

/**
 * The review loop in the dashboard, driven with a real browser: Start
 * reviewing on Batches opens the newest batch that needs review, A decides
 * each step and the loop moves on, through a second test of the batch (with
 * its cue) and into the next batch (through the Batch done card), and ends on
 * All caught up.
 *
 * It builds its OWN data in a project of its own, created fresh for every run:
 * Start reviewing's count and All caught up both speak for the whole project,
 * so nothing may be pending there but this run's steps. On one branch:
 *
 *   baseline : cart + cart-empty, profile (phone), settings  (approved wholesale)
 *   batch A  : test cart     cart changed, cart-empty identical
 *              test profile  profile changed (phone viewport)
 *   batch B  : test settings settings changed                (newest)
 *
 * so B and A need review (one and two steps), and the baseline batch none.
 * `cart-empty` is there for the legacy link: a step that is not its run's
 * first, so landing on the first step instead would show.
 *
 * Batches lists the signed-in user's CURRENT project, their default: the
 * flow makes this project the bootstrap admin's default for its run and puts
 * the old assignment back afterwards.
 *
 * Serial: every step builds on the state the previous one left.
 */
test.describe.serial("ui: review loop", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let branch = "";
  let restore: Assignment | undefined;
  let baselineBuildId = "";
  let first: CaptureRunResult; // batch A, test cart
  let second: CaptureRunResult; // batch A, test profile
  let newest: CaptureRunResult; // batch B, test settings

  /** A step's page in the diff viewer. */
  const stepPath = (run: CaptureRunResult, name: string): string =>
    `/projects/${projectId}/runs/${run.runId}/checkpoints/${run.checkpointIds[name]}`;
  /** That page with no review context in its URL (the default status). */
  const stepUrl = (run: CaptureRunResult, name: string): RegExp =>
    new RegExp(`${stepPath(run, name)}$`);

  /** How many batches of the project need review, as the server counts them. */
  const pendingBatches = async (): Promise<number> =>
    (
      await api.trpcQuery<{ total: number }>(admin, "builds.pendingCount", {
        projectId,
      })
    ).total;

  /** Approve the step on screen with A, once it can be approved. */
  const approveWithA = async (): Promise<void> => {
    const approve = page.getByTestId("approve-checkpoint-button");
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("a");
  };

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Six captures, each waiting on the diff pipeline, and a login.
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
      await api.createProject(admin, { name: `review-loop-ui-${stamp}` })
    ).id;
    branch = `ui-loop-${stamp}`;

    // The baselines, one test at a time in one batch, approved wholesale.
    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: "review-loop-baseline",
      viewport: DESKTOP,
      checkpoints: [
        { name: "cart", fixture: "baseline" },
        { name: "cart-empty", fixture: "baseline" },
      ],
    });
    baselineBuildId = baseline.buildId;
    const baselines = [
      baseline,
      await captureRun(api, {
        pat,
        projectId,
        branchName: branch,
        buildId: baselineBuildId,
        viewport: PHONE,
        checkpoints: [{ name: "profile", fixture: "baseline" }],
      }),
      await captureRun(api, {
        pat,
        projectId,
        branchName: branch,
        buildId: baselineBuildId,
        viewport: DESKTOP,
        checkpoints: [{ name: "settings", fixture: "baseline" }],
      }),
    ];
    for (const run of baselines) {
      expect(run.status).toBe("new");
      await api.approveRun(admin, run.runId);
    }

    // Batch A: two tests, captured in this order (the loop's order in it).
    first = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: BATCH_A,
      viewport: DESKTOP,
      checkpoints: [
        { name: "cart", fixture: "changed" },
        { name: "cart-empty", fixture: "identical" },
      ],
    });
    second = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildId: first.buildId,
      viewport: PHONE,
      checkpoints: [{ name: "profile", fixture: "changed" }],
    });
    // Batch B, after A: the newest batch that needs review.
    newest = await captureRun(api, {
      pat,
      projectId,
      branchName: branch,
      buildName: BATCH_B,
      viewport: DESKTOP,
      checkpoints: [{ name: "settings", fixture: "changed" }],
    });
    for (const run of [first, second, newest]) {
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

    // One session for the whole flow (the loop's state lives in the page).
    // Reduced motion: the done card's entrance animation fades it in, and
    // axe must not measure it half-faded. No stored theme, so the app follows
    // the colour scheme and the card can be checked in both without a reload.
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

  test("Batches opens on Needs review and offers Start reviewing (2)", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-chip-needs-review")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The two batches that need review are listed; the baseline batch is not.
    await expect(
      page.getByTestId(`inbox-batch-row-${newest.buildId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`inbox-batch-row-${first.buildId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`inbox-batch-row-${baselineBuildId}`),
    ).toHaveCount(0);

    const start = page.getByTestId("inbox-start-reviewing");
    await expect(start).toContainText("Start reviewing (2)");
    await expect(start).toBeEnabled();
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
  });

  test("Start reviewing opens the newest batch; A ends it with Batch done", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    await page.getByTestId("inbox-start-reviewing").click();
    // Batch B, the newest, at its one pending step.
    await expect(page).toHaveURL(stepUrl(newest, "settings"));

    await approveWithA();

    // Nothing is left in B: the card offers the next batch, and has the focus.
    const card = page.getByRole("dialog", { name: "Batch done" });
    await expect(card).toBeVisible();
    const proceed = card.getByRole("button", {
      name: `Continue to ${BATCH_A} · ${branch} · 2 pending`,
      exact: true,
    });
    await expect(proceed).toBeVisible();
    await expect(proceed).toBeFocused();
  });

  test("Enter continues to batch A; K wraps to its other test and J comes back; A moves on with the cue", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    const sidebar = page.getByTestId("test-info-sidebar");
    const pill = page.getByTestId("header-loop-remaining");

    await page.keyboard.press("Enter");
    // Batch A's first pending step: its first test, `cart`.
    await expect(page).toHaveURL(stepUrl(first, "cart"));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Two steps need review in A, `cart` on screen and `profile` (R33). The
    // pill also says the loop has its answer, so the keys act.
    await expect(sidebar).toContainText("1/2 cart");
    await expect(pill).toHaveText("2 left in batch");

    // K: nothing needs review before `cart` in the batch, so it wraps to the
    // batch's other end, the other test's step. A backward move has no cue.
    await page.keyboard.press("k");
    await expect(page).toHaveURL(stepUrl(second, "profile"));
    await expect(sidebar).toContainText("1/1 profile");
    await expect(pill).toHaveText("2 left in batch");

    // J: nothing after `profile`, so it wraps back to `cart`, with the cue,
    // whose count is the pill's there.
    await page.keyboard.press("j");
    await expect(page).toHaveURL(stepUrl(first, "cart"));
    await expect(page.getByTestId("review-announcer")).toHaveText(
      "Next test: cart · 2 left in batch",
    );
    await expect(sidebar).toContainText("1/2 cart");
    await expect(pill).toHaveText("2 left in batch");

    await approveWithA();

    // The loop opens A's other test on its own, and says so.
    await expect(page).toHaveURL(stepUrl(second, "profile"));
    await expect(page.getByTestId("review-announcer")).toHaveText(
      "Next test: profile · 1 left in batch",
    );
  });

  test("A on the last pending step shows All caught up, legible in both themes", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    await approveWithA();

    const card = page.getByRole("dialog", { name: "All caught up" });
    await expect(card).toBeVisible();
    await expect(card).toHaveAccessibleDescription(
      "Nothing needs review in this project.",
    );
    // Nowhere to continue to: Back to batches is the way on, and has the focus.
    await expect(card.getByTestId("batch-done-continue")).toHaveCount(0);
    const batches = card.getByRole("link", { name: "Back to batches" });
    await expect(batches).toBeFocused();
    await expect(batches).toHaveAttribute("href", "/inbox");
    // And the server agrees: nothing in the project needs review.
    await expect
      .poll(pendingBatches, { intervals: [500, 1_000, 2_000], timeout: 30_000 })
      .toBe(0);

    // Ruling R29: the card's screenshot and colour contrast, in both themes.
    // The card is not reachable in the visual sweep (its fixture always has
    // pending work), so it is checked here. Contrast problems are what the
    // sweep counts: violations, and nodes axe skipped as outside the viewport.
    const found: Record<Theme, string[]> = { light: [], dark: [] };
    // Park the pointer: a hover left by the last click would show in the shot.
    await page.mouse.move(0, 0);
    try {
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme });
        const html = page.locator("html");
        if (theme === "dark") {
          await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
        } else {
          await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
        }
        await expect(card).toBeVisible();
        await testInfo.attach(`all-caught-up-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        const results = await new AxeBuilder({ page })
          .withRules(["color-contrast"])
          .include(CARD)
          .analyze();
        found[theme] = contrastProblems(results);
        const passed = nodeCount(results.passes);
        testInfo.annotations.push({
          type: "color-contrast",
          description: `${theme}: ${found[theme].length} problem(s), ${passed} node(s) passed, ${nodeCount(results.incomplete)} incomplete`,
        });
        // An empty result must not pass for a clean one: axe saw the card.
        expect(
          passed + nodeCount(results.violations),
          `${theme}: axe measured no text on the card`,
        ).toBeGreaterThan(0);
      }
    } finally {
      await page.emulateMedia({ colorScheme: "light" });
    }
    expect(found, "colour-contrast problems on the All caught up card").toEqual(
      { light: [], dark: [] },
    );
  });

  test("Back to batch keeps a viewport filter in the URL and the select; browser Back returns to the step", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    // The phone test's step, with the batch filtered to the phone viewport.
    await page.goto(`${stepPath(second, "profile")}?viewport=${PHONE}`);
    const back = page.getByTestId("contextual-header-back");
    await expect(back).toBeVisible();
    await back.click();

    // The batch, still filtered, scrolled to the test the reviewer left.
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/projects/${projectId}/builds/${first.buildId}`,
    );
    const url = new URL(page.url());
    expect(url.searchParams.get("viewport")).toBe(PHONE);
    expect(url.hash).toBe(`#run-${second.runId}`);
    const select = page.getByTestId("facet-select-viewport");
    await expect(select).toHaveText(PHONE);
    await expect(select).toHaveAccessibleName(`Viewport: ${PHONE}`);

    // The browser's Back, once: the step again, its filter still in the URL.
    await page.goBack();
    await expect(page).toHaveURL(
      new RegExp(`${stepPath(second, "profile")}\\?viewport=${PHONE}$`),
    );
    await expect(page.getByTestId("contextual-header-back")).toBeVisible();
  });

  test("An old /diffs/ link lands on its exact step, filter kept", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.loop"]));

    // Old links put the step's id after /diffs/. `cart-empty` is the second
    // step of its run: falling back to the first step would land on `cart`.
    const step = first.checkpointIds["cart-empty"];
    await page.goto(
      `/projects/${projectId}/runs/${first.runId}/diffs/${step}?viewport=${DESKTOP}`,
    );
    await expect(page).toHaveURL(
      new RegExp(
        `/projects/${projectId}/runs/${first.runId}/checkpoints/${step}\\?viewport=${DESKTOP}$`,
      ),
    );
    await expect(page.getByTestId("test-info-sidebar")).toContainText(
      "2/2 cart-empty",
    );
  });
});
