import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { ApiClient } from "../../src/clients/api-client.js";
import {
  captureRun,
  type CaptureRunResult,
} from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API, DASH_URL } from "../../src/env.js";
import { ownerCreds } from "../../src/seed/load-seed.js";

/** The slice of `runs.listCheckpoints` this spec reads. */
interface CheckpointRow {
  id: string;
  name: string;
  verdict: string | null;
  /** The active decision, else the verdict. */
  state: string | null;
  diffFailedAt: string | null;
  diffError: string | null;
}

/** The slice of `review.approve` this spec reads. */
interface ReviewOutcome {
  runs: Array<{ runId: string; status: string }>;
}

/**
 * Step 2's screenshot: the `changed` fixture without its last 30 bytes (the
 * end of its image data and its IEND chunk). The upload stores the bytes as
 * they are; the worker cannot decode them. The same cut the worker's own
 * classification test feeds sharp and odiff (`diff-error.test.ts`).
 */
const CORRUPT_PNG = ((): Buffer => {
  const png = readFileSync(
    fileURLToPath(new URL("../../src/fixtures/changed.png", import.meta.url)),
  );
  return png.subarray(0, png.length - 30);
})();

/**
 * First-visit page tours open over the page behind a scrim until dismissed
 * (`furan:tour:dismissed:<pageId>` in localStorage): report every tour as
 * dismissed, as the other UI specs do.
 */
const NO_TOURS = `(() => {
  const getItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) {
    return typeof key === "string" && key.startsWith("furan:tour:dismissed:")
      ? "1"
      : getItem.call(this, key);
  };
})();`;

/**
 * A step whose diff fails for good fails only that step (spec 2026-10-23 §6,
 * §10, §11): a three-step test whose second screenshot cannot be decoded.
 *
 *   baseline : home, cart, checkout   (approved wholesale → baselines)
 *   candidate: home changed, cart corrupt, checkout identical
 *
 * The worker retries cart's job, then fails the step with `image_unreadable`.
 * The run is never aborted: it settles `unresolved`, home and checkout get
 * their verdicts, and the batch page shows cart as "Diff failed" with its
 * reason. Home stays reviewable; cart refuses a decision until it is retried,
 * and keeps the run `unresolved` for the SDK (never a false pass).
 *
 * The browser is signed in with the seeded admin's JWT as the dashboard's
 * session cookie, so this spec adds no login to the per-account brake
 * (ADR-063). Serial: each test builds on the state the previous one left.
 */
test.describe.serial("diff: a step's diff fails", () => {
  const api = new ApiClient(API);
  let admin = ""; // the reviewer (dashboard principal)
  let pat = ""; // the SDK / CI principal
  let projectId = "";
  let candidate: CaptureRunResult;
  let context: BrowserContext | undefined;

  /** The candidate's steps as the reviewer reads them, by name. */
  const steps = async (): Promise<Record<string, CheckpointRow>> =>
    Object.fromEntries(
      (
        await api.trpcQuery<{ items: CheckpointRow[] }>(
          admin,
          "runs.listCheckpoints",
          { runId: candidate.runId },
        )
      ).items.map((c) => [c.name, c]),
    );
  /** What the SDK reads: `GET /runs/:id` with the PAT. */
  const sdkStatus = async (): Promise<string> =>
    (await api.getRun(pat, candidate.runId)).status;
  const id = (name: string): string => candidate.checkpointIds[name]!;

  test.beforeAll(async () => {
    ({ admin, pat } = ownerCreds());
    projectId = (
      await api.createProject(admin, {
        name: `e2e-step-failure-${Date.now()}`,
      })
    ).id;
    const baseline = await captureRun(api, {
      pat,
      projectId,
      branchName: "main",
      checkpoints: [
        { name: "home", fixture: "baseline" },
        { name: "cart", fixture: "baseline" },
        { name: "checkout", fixture: "baseline" },
      ],
    });
    expect(baseline.status).toBe("new");
    await api.approveRun(admin, baseline.runId);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("a corrupt image fails only its step", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["diff.step_failure"]));
    // captureRun waits for the run to leave `running` and for every step's
    // verdict: cart's comes only once its last attempt has failed.
    candidate = await captureRun(api, {
      pat,
      projectId,
      branchName: "main",
      checkpoints: [
        { name: "home", fixture: "changed" },
        { name: "cart", png: CORRUPT_PNG },
        { name: "checkout", fixture: "identical" },
      ],
    });
    expect(candidate.status).toBe("unresolved");
    expect(await sdkStatus()).toBe("unresolved");

    const { home, cart, checkout } = await steps();
    expect(cart).toMatchObject({
      verdict: "unresolved",
      diffError: "image_unreadable",
    });
    expect(cart!.diffFailedAt).not.toBeNull();
    // The other two steps were diffed as usual.
    expect(home).toMatchObject({
      verdict: "unresolved",
      diffFailedAt: null,
      diffError: null,
    });
    expect(checkout).toMatchObject({
      verdict: "passed",
      diffFailedAt: null,
      diffError: null,
    });
  });

  test("the batch page shows the failed step and why", async ({
    browser,
  }: {
    browser: Browser;
  }, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["diff.step_failure"]));
    context = await browser.newContext({ colorScheme: "light" });
    await context.addInitScript({ content: NO_TOURS });
    // The dashboard's session is the api's JWT in an HttpOnly cookie.
    await context.addCookies([
      {
        name: "furan_jwt",
        value: admin,
        url: DASH_URL,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page: Page = await context.newPage();
    await page.goto(`/projects/${projectId}/builds/${candidate.buildId}`);

    // The run's row counts the failed step; its status stays the run's own.
    await expect(
      page.getByTestId(`result-diff-failed-${candidate.runId}`),
    ).toHaveText("Diff failed (1)");

    const failed = page.getByTestId(`step-diff-failed-${id("cart")}`);
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("Diff failed");
    await expect(failed).toContainText("The screenshot couldn't be read.");
    // An admin may retry it.
    await expect(
      page.getByTestId(`step-retry-diff-${id("cart")}`),
    ).toBeVisible();
    // Home's card is an ordinary pending step.
    await expect(page.getByTestId(`step-card-${id("home")}`)).toBeVisible();
    await expect(
      page.getByTestId(`step-diff-failed-${id("home")}`),
    ).toHaveCount(0);
  });

  test("the other steps stay reviewable; the failed one keeps the run unresolved", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["diff.step_failure"]));
    // Cart has no result to decide on until it is retried.
    const refused = await api.probe("POST", "/trpc/review.approve", {
      auth: admin,
      body: {
        runId: candidate.runId,
        actionId: randomUUID(),
        checkpointIds: [id("cart")],
      },
    });
    expect(refused.status).toBe(412);
    expect(refused.body).toMatchObject({
      error: {
        data: {
          details: {
            reasons: [{ checkpointId: id("cart"), reason: "diff_failed" }],
          },
        },
      },
    });

    // Home, the one changed step, is approved as usual…
    const approved = await api.trpcMutate<ReviewOutcome>(
      admin,
      "review.approve",
      {
        runId: candidate.runId,
        actionId: randomUUID(),
        checkpointIds: [id("home")],
      },
    );
    // …and the run is still unresolved: cart's failure is a failure to the
    // SDK too, never a pass.
    expect(approved.runs).toEqual([
      { runId: candidate.runId, status: "unresolved" },
    ]);
    expect(await sdkStatus()).toBe("unresolved");
    const { home, cart } = await steps();
    expect(home!.state).toBe("approved");
    expect(cart).toMatchObject({
      state: "unresolved",
      diffError: "image_unreadable",
    });
  });
});
