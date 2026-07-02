import { defineConfig } from "@playwright/test";

const DASH = process.env.E2E_DASH_URL ?? "http://localhost:3001";

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
    { name: "s3-full", testIgnore: /tests\/storage\// },
    { name: "hdd-smoke", grep: /@hdd-smoke/ },
  ],
});
