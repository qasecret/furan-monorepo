import { defineConfig } from "@playwright/test";

import { DASH_URL as DASH } from "./src/env.js";

/**
 * Three projects:
 *  - `s3-full`   — every area except storage-specific HDD tests and the visual
 *                  sweep (runs against the S3/MinIO primary deployment).
 *  - `hdd-smoke` — the storage round-trip + any `@hdd-smoke`-tagged happy path
 *                  (runs against a separate HDD deployment).
 *  - `visual`    — the `@visual` before/after screenshot + axe colour-contrast
 *                  sweep, run on demand (see README "Visual sweep").
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
    // Everything except HDD-specific tests and the visual sweep, against the
    // S3/MinIO deployment.
    { name: "s3-full", grepInvert: /@hdd-smoke|@visual/ },
    // Only @hdd-smoke-tagged tests, against a separate HDD deployment.
    { name: "hdd-smoke", grep: /@hdd-smoke/ },
    // Only the @visual sweep (on demand, never in CI).
    { name: "visual", grep: /@visual/ },
  ],
});
