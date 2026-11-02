import { randomUUID } from "node:crypto";

import { detectCi } from "@furan/client";

/**
 * Playwright `globalSetup`: outside CI, give this `playwright test` run one
 * `FURAN_CI_BUILD_ID`, which every worker inherits, so all of them join one
 * Furan build. In CI the pipeline's own id is used, so this does nothing.
 *
 *   export default defineConfig({ globalSetup: "@furan/playwright/global-setup" });
 *
 * Or call it from an existing global setup.
 */
export default function globalSetup(): void {
  const env = process.env;
  if (env.FURAN_CI_BUILD_ID?.trim() || env.FURAN_BUILD_ID?.trim()) return;
  if (detectCi(env)?.ciBuildId) return;
  env.FURAN_CI_BUILD_ID = `local-${randomUUID()}`;
}
