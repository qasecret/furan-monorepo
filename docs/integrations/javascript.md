# JavaScript / TypeScript

Send screenshots to Furan from Playwright, Cypress or any CI, without a JVM.
Three npm packages share one version:

| Package             | Use it when                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `@furan/cli`        | your tests (or anything else) write PNG files: `furan upload screenshots/` |
| `@furan/playwright` | you use Playwright Test: `await furan.check("cart")` inside a test         |
| `@furan/client`     | you want the REST client and lifecycle in your own code                    |

All three need Node 20.19 or later and are ES modules (CommonJS projects can
`require()` them on Node 20.19+). The GitHub Action wraps the CLI; see
[github-actions.md](github-actions.md#javascript--typescript-the-furan-upload-action).

- [Connect to Furan](#connect-to-furan)
- [`furan upload`](#furan-upload)
- [Playwright Test](#playwright-test)
- [Cypress](#cypress)
- [The client library](#the-client-library)
- [How verdicts work](#how-verdicts-work)

## Connect to Furan

Every package reads the same environment variables as the Kotlin SDK. Three
are required:

```bash
export FURAN_API_URL=https://furan.example.com/api   # the api, not the dashboard
export FURAN_API_TOKEN=furan_pat_...                  # mint one at /account/tokens
export FURAN_PROJECT_ID=<the project's id>
```

With the one-file install the api is served under `/api` on the same origin
as the dashboard (`http://<host>:8080/api`); a split install serves it on its
own port (`http://<host>:3000`).

Optional settings:

| Variable                      | Default                               | Meaning                                                            |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `FURAN_DASHBOARD_URL`         | none                                  | the dashboard origin; enables the batch and review links in output |
| `FURAN_BRANCH`                | from CI, then git, `main`             | the branch whose baselines are compared                            |
| `FURAN_PARENT_BRANCH`         | the PR's base branch                  | fallback baseline branch for a branch with none of its own         |
| `FURAN_CI_BUILD_ID`           | from CI                               | jobs with the same id join one build (batch)                       |
| `FURAN_BUILD_ID`              | none                                  | attach to an existing build by its Furan id (a UUID)               |
| `FURAN_BUILD_NAME`            | from CI                               | the build's name in the dashboard                                  |
| `FURAN_BUILD_PROPERTIES`      | none                                  | `key=value,key=value` labels on the build                          |
| `FURAN_BROWSER`               | `image` (CLI), `playwright-<browser>` | browser label; part of the baseline identity                       |
| `FURAN_OS`, `FURAN_DEVICE`    | none                                  | environment labels; part of the baseline identity                  |
| `FURAN_SAVE_NEW_TESTS`        | off                                   | `1` approves first baselines automatically                         |
| `FURAN_FAIL_ON_NEW`           | off                                   | `1` fails when a screenshot has no baseline yet                    |
| `FURAN_POLL_TIMEOUT_SECONDS`  | `120`                                 | how long to wait for the verdict                                   |
| `FURAN_POLL_INTERVAL_SECONDS` | `2`                                   | how often to ask                                                   |

**CI is detected automatically.** On GitHub Actions, GitLab CI, CircleCI,
Jenkins, Buildkite, Azure Pipelines and Bitbucket Pipelines the branch, the
PR's base branch, the build name and a per-pipeline build id are read from the
CI's own variables. Every job and shard of one pipeline lands in **one batch**;
a re-run attempt gets a fresh one. Set the `FURAN_*` variable to override any
of them.

**Tokens.** The packages use only Furan's REST API: mint the token with
**Access: SDK & CI**, bound to the project in `FURAN_PROJECT_ID`. Store it as a
CI secret; it is never printed (`--dry-run` shows it masked).

## `furan upload`

```bash
npm install --save-dev @furan/cli
npx furan upload screenshots/
```

`furan upload <file.png | folder>…` uploads PNGs, waits for Furan's verdict
and exits with a code your CI understands.

### Folders become tests

Inside a folder you pass, **each subfolder is a test and each PNG a step**.
The step keeps its folder in its name, because a step's baseline is identified
by its name (with the branch, viewport and browser), not by its test:

```
screenshots/                     furan upload screenshots/
├── checkout/
│   ├── cart.png        →  test "checkout", step "checkout/cart"
│   └── pay.png         →  test "checkout", step "checkout/pay"
└── home.png            →  test "screenshots", step "home"
```

A file you pass directly uses its own folder: `furan upload shots/*.png` puts
`shots/home.png` in test `shots` as step `home`. `--test smoke` puts every
step into one test named `smoke`.

Two screenshots that would get the same step name **and** viewport anywhere in
one upload are refused before anything is sent, because they would share one
baseline. That happens with files from different folders that share a name
(`furan upload light/home.png dark/home.png`, or a `**/*.png` glob): pass
their parent folder instead (`furan upload shots/`), so each step keeps its
folder in its name. The same file reached twice is uploaded once.

The **viewport** label is each PNG's size (`--viewport 1280x720` sets one for
all); the **browser** label is `image` (`--browser chrome` to change it). Both
are part of the baseline identity, so keep them stable between runs.

### Ignore regions and per-step options

`--ignore x,y,width,height` (repeatable) ignores a box in every screenshot.
For per-screenshot options, put a sidecar next to the PNG: `cart.furan.json`
beside `cart.png`:

```json
{
  "matchLevel": "Layout",
  "ignore": [{ "x": 0, "y": 0, "width": 300, "height": 40 }],
  "layout": [],
  "content": [],
  "floating": []
}
```

Boxes are in screenshot pixels. The sidecar's regions add to `--ignore`, and
its `matchLevel` (`Strict`, `Layout`, `Content`, `IgnoreColors`, `Dynamic`)
wins over `--match-level`. An unknown key or a bad box is an error, so a typo
never silently drops a region.

**What changes the verdict today.** Only `ignore` regions do. `layout`,
`content` and `floating` regions are accepted and stored with the step, but the
comparison does not use them yet. Every match level compares pixels like
`Strict`: `Layout` relaxes the comparison only with the page's element map,
which the Kotlin SDK's Selenium and Playwright adapters send and these packages
don't. Mask dynamic areas with `ignore`, or raise the project's diff threshold
(project Settings → Diff behavior).

**When regions take effect:** a region masks diffs **once the step is
approved**. Approving a step saves its regions with the new baseline, and they
mask every later comparison of that step. The first upload of a new region
still shows changes inside it until you approve that step (or upload it with
`--save-new-tests` while it has no baseline yet).

### Output and exit codes

```
furan: 3 tests, 4 steps on feature/x  https://furan.example.com/projects/…/builds/…
  ✓ passed      checkout      2 steps
  ✗ unresolved  home          1 step   https://furan.example.com/projects/…/runs/…
  ! new         signup        1 step   no baseline yet: approve it in the dashboard
furan: 1 test needs review
```

| Exit | Meaning                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 0    | every test passed; a test with no baseline yet passes with a warning unless `--fail-on-new`             |
| 1    | a test needs review (a screenshot changed, or failed), or has no baseline under `--fail-on-new`         |
| 2    | bad command line, configuration or input; nothing was uploaded (the message names the file or variable) |
| 3    | no verdict: the api could not be reached, refused the request, or the wait timed out                    |

A test with a definite failure makes the exit 1 even if another had no
verdict. On Ctrl-C, tests still being uploaded are aborted and the CLI exits 130.

On GitHub Actions the CLI also writes a results table to the job summary and
sets the step outputs `build-id`, `build-url` and `status`
(`passed` / `new` / `failed` / `error` / `uploaded`).

### All options

| Flag                                                           | Meaning                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `--test <name>`                                                | put every step into one test                               |
| `--ignore x,y,w,h`                                             | ignore region for every step (repeatable)                  |
| `--match-level <level>`                                        | default match level                                        |
| `--browser`, `--os`, `--device <label>`                        | environment labels                                         |
| `--viewport WxH`                                               | viewport label for every step                              |
| `--branch`, `--parent-branch`, `--build-name`, `--ci-build-id` | override what is detected                                  |
| `--save-new-tests`                                             | approve first baselines automatically                      |
| `--fail-on-new`                                                | fail when a step has no baseline yet                       |
| `--no-wait`                                                    | upload and complete without waiting for verdicts (exit 0)  |
| `--timeout <seconds>`                                          | verdict wait budget (default 120)                          |
| `--concurrency <n>`                                            | parallel requests (default 4, at most 16)                  |
| `--json`                                                       | print the result as JSON                                   |
| `--dry-run`                                                    | show the resolved configuration and the plan; send nothing |

## Playwright Test

```bash
npm install --save-dev @furan/playwright
```

```ts
// tests/cart.spec.ts
import { test, expect } from "@furan/playwright";

test("adds an item", async ({ page, furan }) => {
  await page.goto("/cart");
  await furan.check("cart"); // the viewport
  await furan.check("cart-full", {
    fullPage: true,
    ignore: [page.locator(".clock")], // every element it matches
  });
  await furan.check("summary", { locator: page.locator(".summary") });
});
```

- Each Playwright test that calls `furan.check` becomes one Furan test, named
  by its project (when it has a name) and title path
  (`chromium › cart.spec.ts › adds an item`). Its steps are named
  `<that name> › <check name>`, so two tests that both check `"home"`, or two
  projects that share a browser (light/dark themes, logged-in/out), keep
  separate baselines. Renaming a project, file or test starts new baselines.
- When the test ends, the fixture waits for the verdict (adding the wait to
  the test's timeout). A changed screenshot **fails the test** with the steps
  and the review link; a first run with no baseline passes with a warning
  (`failOnNew` makes it fail). Each test gets a `furan` annotation with its
  review link, shown in the HTML report. If the test already failed, its
  screenshots are still uploaded for review, without waiting.
- Screenshots are taken with animations disabled, the caret hidden and
  `scale: "css"`. `ignore`, `layout` and `content` take locators or boxes; a
  locator's elements are found at screenshot time, so the regions follow the
  page's layout. Only `ignore` changes the verdict today (see
  [what changes the verdict](#ignore-regions-and-per-step-options)). The browser label is `playwright-<browser>` and the viewport
  label is the page's viewport size.

**One batch per run.** In CI every worker joins the pipeline's batch on its
own (a worker that Playwright restarts after a failed test reuses it without
asking the api again). For local runs, add the global setup so all workers
share one batch:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "@furan/playwright/global-setup",
  use: {
    furanOptions: { failOnNew: false, saveNewTests: false },
  },
});
```

If you already have a global setup, call it from yours:
`import furanSetup from "@furan/playwright/global-setup"; furanSetup();`.

**Options** (`use: { furanOptions: { … } }` in the config, or `test.use` per
file): `failOnNew`, `saveNewTests`, `fullPage` (the default for every check),
`timeoutMs`, `os`, `device`, and `config` for connection settings instead of
the environment. Teams with their own extended `test` combine them with
`mergeTests(yourTest, test)`.

## Cypress

Cypress writes `cy.screenshot()` files to `cypress/screenshots/<spec file>/`,
which is exactly the folder layout `furan upload` maps to tests:

```js
// cypress.config.js: keep failure screenshots out of the folder you upload
const { defineConfig } = require("cypress");

module.exports = defineConfig({
  screenshotOnRunFailure: false,
  e2e: {},
});
```

```bash
npx cypress run
npx furan upload cypress/screenshots
```

Each spec file becomes a test and each `cy.screenshot("name")` a step.

## The client library

```ts
import { Furan } from "@furan/client";

const furan = Furan.fromEnv(); // FURAN_* env + CI detection
const build = await furan.openBuild(); // once per process (find-or-create by ciBuildId)
const test = await build.openTest("checkout");
await test.check("checkout/cart", pngBytes, {
  ignore: [{ x: 0, y: 0, width: 300, height: 40 }],
});
const result = await test.close(); // complete → wait → verdict
// result.status: "passed" | "new" | "failed" | "error"
```

`Furan.fromEnv(options)` accepts every setting above as an option
(`apiUrl`, `token`, `projectId`, `branch`, `ciBuildId`, `saveNewTests`,
`failOnNew`, `timeoutMs`, `dashboardUrl`, …). `FuranClient` has one method per
REST route (`createBuild`, `createRun`, `uploadCheckpoint`, `completeRun`,
`getRun`, `waitForRun`, `approveRun`, `abortRun`) for full control. Requests
are retried on network errors, 408, 429 and 5xx; errors are `FuranApiError`
(with the server's `code`), `FuranConfigError`, `FuranInputError` or
`FuranTimeoutError`.

## How verdicts work

| Furan status                                    | Result   | CI                                                                                     |
| ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| passed                                          | `passed` | passes                                                                                 |
| new, with a baseline auto-seeded by the project | `passed` | passes                                                                                 |
| new (no baseline yet)                           | `new`    | passes with a warning; fails with `failOnNew`; approved and passed with `saveNewTests` |
| unresolved (a change), failed, aborted          | `failed` | fails                                                                                  |

The verdict is computed after upload, by Furan's diff pipeline; the packages
poll until it is ready (`FURAN_POLL_TIMEOUT_SECONDS`). Furan never seeds a
first baseline by itself unless the project enables it: review the first run
in the dashboard, or use `saveNewTests` when you trust it.
