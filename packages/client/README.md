# @furan/client

Send screenshots to [Furan](https://github.com/qasecret/furan-monorepo), the
self-hosted visual-testing app, from Node: open a build, upload PNG steps with
ignore regions, and get the verdict.

```bash
npm install @furan/client
```

```ts
import { Furan } from "@furan/client";

const furan = Furan.fromEnv(); // FURAN_API_URL, FURAN_API_TOKEN, FURAN_PROJECT_ID + CI detection
const build = await furan.openBuild();
const test = await build.openTest("checkout");
await test.check("checkout/cart", png, {
  ignore: [{ x: 0, y: 0, width: 300, height: 40 }],
});
const result = await test.close(); // { status: "passed" | "new" | "failed" | "error", url, … }
```

No runtime dependencies; Node 20.19 or later. For PNG folders in CI use
[`@furan/cli`](https://www.npmjs.com/package/@furan/cli); for Playwright Test use
[`@furan/playwright`](https://www.npmjs.com/package/@furan/playwright).

Documentation: [JavaScript / TypeScript guide](https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/javascript.md#the-client-library). License: Apache-2.0.
