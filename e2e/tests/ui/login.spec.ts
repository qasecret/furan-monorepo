import { expect, test } from "@playwright/test";

import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD } from "../../scripts/compose.js";
import { coverAnnotations } from "../../src/coverage/reporter.js";

/**
 * Drive the real dashboard login form (Next server action → /auth/login →
 * furan_jwt cookie → redirect to the landing view). baseURL is the dashboard
 * (E2E_DASH_URL / 3011).
 */
test("dashboard login lands the user in the app shell", async ({
  page,
}, testInfo) => {
  testInfo.annotations.push(...coverAnnotations(["ui.login"]));

  await page.goto("/login");
  await page.fill("#email", BOOTSTRAP_EMAIL);
  await page.fill("#password", BOOTSTRAP_PASSWORD);
  await page.click('button[type="submit"]');

  // A successful login navigates away from /login into the authenticated shell.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  expect(new URL(page.url()).pathname).not.toBe("/login");
});
