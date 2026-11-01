# @furan/playwright

A Playwright Test fixture for [Furan](https://github.com/qasecret/furan-monorepo),
the self-hosted visual-testing app: `await furan.check("cart")` uploads a
screenshot, and the test fails with a review link when it changed.

```bash
npm install --save-dev @furan/playwright
```

```ts
import { test, expect } from "@furan/playwright";

test("adds an item", async ({ page, furan }) => {
  await page.goto("/cart");
  await furan.check("cart", { ignore: [page.locator(".clock")] });
});
```

```ts
// playwright.config.ts: one Furan batch per local run (CI needs nothing)
export default defineConfig({ globalSetup: "@furan/playwright/global-setup" });
```

Set `FURAN_API_URL`, `FURAN_API_TOKEN` and `FURAN_PROJECT_ID` in the
environment. Needs `@playwright/test` 1.45 or later and Node 20.19 or later.

Documentation: [JavaScript / TypeScript guide](https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/javascript.md#playwright-test). License: Apache-2.0.
