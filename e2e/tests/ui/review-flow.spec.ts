import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient, ApiError } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

/** The slice of `runs.listCheckpoints` this flow reads. */
interface CheckpointRow {
  id: string;
  name: string;
  state: string | null;
}

/** Fixed name: the project is reused from run to run; each run gets its own branch. */
const PROJECT_NAME = "review-flow-ui";

/**
 * Reviewing in the dashboard, driven with a real browser: approve a step from
 * the keyboard, take it back with ⌘Z, then approve what is left of the build
 * from the batch page. It builds its OWN data (never the visual sweep's, which
 * the sweep's states approve and undo): one project, and on a branch of its own
 * a three-step test approved as the baseline, then re-run with two steps
 * changed and one identical.
 *
 *   baseline : home, cart, checkout   (approved wholesale → baselines)
 *   candidate: home changed, cart changed, checkout identical
 *
 * Serial: every step builds on the state the previous one left.
 */
test.describe.serial("ui: review flow", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let candidate: CaptureRunResult;

  /** A step's page in the diff viewer. */
  const stepUrl = (name: string): RegExp =>
    new RegExp(
      `/projects/${projectId}/runs/${candidate.runId}/checkpoints/${candidate.checkpointIds[name]}$`,
    );

  /** The candidate run's steps as the reviewer sees them, in capture order. */
  const checkpoints = async (): Promise<CheckpointRow[]> =>
    (
      await api.trpcQuery<{ items: CheckpointRow[] }>(
        admin,
        "runs.listCheckpoints",
        { runId: candidate.runId },
      )
    ).items;
  /** `name → review state`, or `null` for a step with no verdict yet. */
  const states = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries((await checkpoints()).map((c) => [c.name, c.state]));
  /**
   * Wait for every step to have a verdict again. Undoing an approval queues a
   * re-diff, so for a moment the run is not reviewable; this poll (never a
   * fixed sleep) tolerates that and waits it out.
   */
  const settled = async (): Promise<Record<string, string | null>> => {
    await expect
      .poll(async () => Object.values(await states()).includes(null), {
        intervals: [500, 1_000, 2_000],
        timeout: 60_000,
      })
      .toBe(false);
    return states();
  };

  /** What a CSS custom property resolves to, as the browser computes a colour. */
  const tokenColour = (token: string): Promise<string> =>
    page.evaluate(
      `(() => {
        const probe = document.createElement("div");
        probe.style.color = "var(${token})";
        document.body.appendChild(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      })()`,
    ) as Promise<string>;

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    ({ admin, pat } = ownerCreds());

    try {
      projectId = (await api.createProject(admin, { name: PROJECT_NAME })).id;
    } catch (e) {
      // Left by an earlier run: reuse it.
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      const found = (await api.listProjects(admin)).find(
        (p) => p.name === PROJECT_NAME,
      );
      if (!found) throw e;
      projectId = found.id;
    }

    // A branch of its own, so this run's baselines are nobody else's.
    const branchName = `ui-flow-${Date.now()}`;
    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName,
      buildName: "ui-flow-baseline",
      checkpoints: [
        { name: "home", fixture: "baseline" },
        { name: "cart", fixture: "baseline" },
        { name: "checkout", fixture: "baseline" },
      ],
    });
    expect(baseline.status).toBe("new");
    await api.approveRun(admin, baseline.runId);

    candidate = await captureRun(api, {
      pat,
      projectId,
      branchName,
      buildName: "ui-flow-candidate",
      checkpoints: [
        { name: "home", fixture: "changed" },
        { name: "cart", fixture: "changed" },
        { name: "checkout", fixture: "identical" },
      ],
    });
    expect(candidate.status).toBe("unresolved");
    expect(await states()).toEqual({
      home: "unresolved",
      cart: "unresolved",
      checkout: "passed",
    });

    // One session for the whole flow: the undo stack lives in the page, and
    // ⌘Z only takes back what this session decided.
    context = await browser.newContext({ colorScheme: "light" });
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
    await context?.close();
  });

  test("A approves the pending step and its chip shows who decided it", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.ui_flow"]));

    // The bare run URL forwards to the run's first step: home, pending.
    await page.goto(`/projects/${projectId}/runs/${candidate.runId}`);
    await expect(page).toHaveURL(stepUrl("home"));
    const approve = page.getByTestId("approve-checkpoint-button");
    await expect(approve).toBeVisible();
    await expect(approve).toBeEnabled();
    await expect(page.getByTestId("decision-chip")).toHaveCount(0);

    await page.keyboard.press("a");

    // The toast carries an Undo action, in the themed look and not the
    // library's own: this is what pins that the app's rule outranks it.
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Approved 'home'" });
    const toastUndo = toast.getByRole("button", { name: "Undo" });
    await expect(toastUndo).toBeVisible();
    await expect(toastUndo).toHaveCSS("border-radius", "6px");
    await expect(toastUndo).toHaveCSS(
      "background-color",
      await tokenColour("--overlay-hover"),
    );
    await expect(toastUndo).toHaveCSS("color", await tokenColour("--fg"));

    // Approving moves on to the next step that needs a reviewer.
    await expect(page).toHaveURL(stepUrl("cart"));
    // Going back to the decided step, its header says who decided it.
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(stepUrl("home"));
    const chip = page.getByTestId("decision-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Approved");
    await expect(page.getByTestId("decision-undo")).toBeVisible();
    await expect(approve).toHaveCount(0);

    expect(await settled()).toEqual({
      home: "approved",
      cart: "unresolved",
      checkout: "passed",
    });
  });

  test("Ctrl+Z / ⌘Z takes the approval back and the step is pending again", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.ui_flow"]));

    // Still in the session that approved it, on its page.
    await expect(page).toHaveURL(stepUrl("home"));
    await expect(page.getByTestId("shortcut-hint-undo")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+z");

    await expect(page.getByTestId("decision-chip")).toHaveCount(0);
    const approve = page.getByTestId("approve-checkpoint-button");
    await expect(approve).toBeVisible();
    // Nothing left to undo.
    await expect(page.getByTestId("shortcut-hint-undo")).toHaveCount(0);

    expect(await settled()).toEqual({
      home: "unresolved",
      cart: "unresolved",
      checkout: "passed",
    });
  });

  test("Approve pending asks first, then approves what is left of the build", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["review.ui_flow"]));

    await page.goto(`/projects/${projectId}/builds/${candidate.buildId}`);
    const approveAll = page.getByTestId("batch-approve-all");
    await expect(approveAll).toContainText("Approve pending (2)");
    await expect(approveAll).not.toHaveAttribute("aria-disabled", "true");

    await approveAll.click();
    const dialog = page.getByTestId("approve-pending-dialog");
    await expect(dialog.getByText("Approve 2 pending steps?")).toBeVisible();
    // The safe answer has focus.
    await expect(dialog.getByTestId("approve-pending-cancel")).toBeFocused();
    await dialog.getByTestId("approve-pending-confirm").click();

    await expect(dialog).toHaveCount(0);
    // The toast counts what the server decided.
    await expect(page.getByText("Approved 2 steps in 1 test")).toBeVisible();
    // Nothing is pending: the button is left in place but unavailable.
    await expect(approveAll).toContainText("Approve pending (0)");
    await expect(approveAll).toHaveAttribute("aria-disabled", "true");

    expect(await states()).toEqual({
      home: "approved",
      cart: "approved",
      checkout: "passed",
    });
    // And the run reads passed, for the SDK too.
    await expect
      .poll(async () => (await api.getRun(pat, candidate.runId)).status, {
        intervals: [500, 1_000, 2_000],
        timeout: 30_000,
      })
      .toBe("passed");
  });
});
