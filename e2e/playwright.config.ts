import { defineConfig } from "@playwright/test";

import { DASH_URL as DASH } from "./src/env.js";

/**
 * Two projects:
 *  - `s3-full`   — every area except storage-specific HDD tests (runs against
 *                  the S3/MinIO primary deployment).
 *  - `hdd-smoke` — the storage round-trip + any `@hdd-smoke`-tagged happy path
 *                  (runs against a separate HDD deployment).
 *
 * Serial (workers: 1, fullyParallel: false) because all tests share one mutable
 * backend — determinism beats speed for an opt-in suite.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./scripts/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["./src/coverage/reporter.ts"],
  ],
  use: {
    baseURL: DASH,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Everything except HDD-specific tests, against the S3/MinIO deployment.
    { name: "s3-full", grepInvert: /@hdd-smoke/ },
    // Only @hdd-smoke-tagged tests, against a separate HDD deployment.
    { name: "hdd-smoke", grep: /@hdd-smoke/ },
  ],
});
