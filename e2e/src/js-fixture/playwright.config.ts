import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * A tiny Playwright project that uses @furan/playwright the way a user would.
 * Run by tests/sdk/js-client.spec.ts as a subprocess, with FURAN_* env
 * pointing at the stack under test. Not part of the suite's own testDir.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "shop.spec.ts",
  workers: 2,
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  outputDir: join(tmpdir(), "furan-js-fixture-results"),
  globalSetup: "@furan/playwright/global-setup",
  use: {
    browserName: "chromium",
    viewport: { width: 400, height: 300 },
  },
});
