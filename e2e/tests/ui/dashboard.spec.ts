import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { ApiClient } from "../../src/clients/api-client.js";
import { capture } from "../../src/clients/virtual-sdk.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";
import { API_URL as API, DASH_URL as DASH } from "../../src/env.js";
import { loadSeed, principal } from "../../src/seed/load-seed.js";

/**
 * Dashboard surfaces driven in a real browser. One shared authenticated context
 * (login once) + data seeded via the API (a project with a named build and a
 * run carrying a diff), then navigate to each route.
 */
test.describe.serial("ui: dashboard surfaces", () => {
  const api = new ApiClient(API);
  let context: BrowserContext;
  let page: Page;
  let projectId = "";
  let changedRunId = "";

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const seed = loadSeed();
    const admin = seed.bootstrapAdminJwt;
    const pat = principal(seed, "owner").pat;
    const project = await api.createProject(admin, {
      name: `e2e-ui-${Date.now()}`,
    });
    projectId = project.id;
    const base = await capture(api, {
      pat,
      projectId,
      branchName: "main",
      checkpointName: "home",
      fixture: "baseline",
      buildName: "e2e-ui-build",
    });
    await api.approveRun(admin, base.runId);
    const changed = await capture(api, {
      pat,
      projectId,
      branchName: "main",
      checkpointName: "home",
      fixture: "changed",
      buildName: "e2e-ui-build",
    });
    changedRunId = changed.runId;

    context = await browser.newContext();
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

  test("builds list renders the batches view", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["ui.builds_list"]));
    // /builds redirects to the latest build's batches/review view. NOTE: the
    // "Recent batch runs" copy is a smoke signal — a role/testid locator would
    // resist copy churn, but the batches table exposes no stable testid today.
    await page.goto(`/projects/${projectId}/builds`);
    await expect(page.getByText("Recent batch runs").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  // The viewer loads everything from the BROWSER: the run over tRPC, then the
  // screenshots from the api's storage proxy, both through the stack's single
  // origin (`${DASH}/api/...`, compose.e2e.yml). A canvas alone would draw with
  // no images, so wait for the screenshots to arrive as well.
  test("diff viewer opens the pixi canvas", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["ui.diff_viewer"]));
    const screenshot = page.waitForResponse(
      (res) => res.url().startsWith(`${DASH}/api/api/v1/storage/`) && res.ok(),
      { timeout: 30_000 },
    );
    await page.goto(`/projects/${projectId}/runs/${changedRunId}`);
    await screenshot;
    await expect(page.locator("canvas").first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("admin surfaces load for an admin", async ({}, testInfo) => {
    testInfo.annotations.push(...coverAnnotations(["ui.admin_surfaces"]));
    for (const path of [
      "/admin/members",
      "/admin/projects",
      "/admin/auto-rules",
    ]) {
      await page.goto(path);
      // stays on the admin route (not bounced to /login) and renders the shell
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(
        page.getByRole("heading", { name: "Admin", level: 1 }),
      ).toBeVisible({ timeout: 15_000 });
    }
  });
});
