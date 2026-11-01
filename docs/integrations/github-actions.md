# GitHub Actions CI recipe

Run the Furan Selenium SDK from GitHub Actions, get baselines reviewed via a
sticky PR comment and a `furan/baselines` status check.

Assumes a self-hosted Furan deployment (see [Getting started](../getting-started/install.md))
and a Furan project already created. Repository-to-project mapping is wired by
the GitHub App + a one-time admin-UI link (see step 2 below).

Using another CI system? See the [Jenkins](./jenkins.md) and
[GitLab CI](./gitlab-ci.md) recipes.

## Quick start

```yaml
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: "21" }
- uses: browser-actions/setup-chrome@v1
- run: ./gradlew test
  env:
    FURAN_API_URL: ${{ secrets.FURAN_API_URL }}
    FURAN_API_TOKEN: ${{ secrets.FURAN_API_TOKEN }}
    FURAN_PROJECT_ID: ${{ secrets.FURAN_PROJECT_ID }}
    FURAN_BUILD_ID: ${{ github.sha }}
    FURAN_BRANCH: ${{ github.head_ref || github.ref_name }}
    FURAN_PARENT_BRANCH: ${{ github.base_ref }}
```

Full copy-paste workflow: [`.examples/visual-regression.yml`](https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/.examples/visual-regression.yml).

## 1. Configure secrets

Three repository (or org-level) secrets are required.

| Secret             | Source                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `FURAN_API_URL`    | Your self-hosted Furan URL, e.g. `https://furan.your-domain.com`   |
| `FURAN_API_TOKEN`  | Mint at `/account/tokens`: SDK & CI access, this project (see 1.1) |
| `FURAN_PROJECT_ID` | UUID from the project URL: `/projects/<UUID>`                      |

The `FURAN_BUILD_ID`, `FURAN_BRANCH`, and `FURAN_PARENT_BRANCH` env vars in the
snippet above are **not** secrets — they come from `github.sha` /
`github.head_ref` / `github.base_ref` and are what Furan groups runs by and
resolves baselines against. `github.base_ref` is set only on `pull_request`
events (empty on a push), so on a branch push no parent is sent and baseline
resolution falls back to the default branch — exactly as before.

Set secrets via **Settings → Secrets and variables → Actions → New repository
secret** (or use `gh secret set FURAN_API_TOKEN`).

### 1.1 Mint a token that is safe to keep in CI

A CI secret can leak (a fork's logs, a compromised runner), so give the token
only what this workflow needs. In the dashboard's create-token dialog
(`/account/tokens`, or **Admin → API Keys** for admins):

- **Access: SDK & CI** (the default). It creates builds and runs, uploads
  screenshots and reads results. With `saveNewTests` it saves the first baseline
  of a new test, but it never approves a change against an existing baseline:
  that stays with a reviewer in the dashboard. **Read-only** suits a job that
  only reads results.
- **Project:** pick the project in `FURAN_PROJECT_ID`. The token then works
  there and nowhere else. **All my projects** covers the projects you're a
  member of; even an admin's token reaches no further.
- **Expires after:** 90 days by default, up to the operator's cap
  (`FURAN_PAT_MAX_LIFETIME_DAYS`, 365 by default). Note the date: before it,
  mint a replacement, update the secret, then delete the old token.

No token can manage tokens, call admin endpoints or use the dashboard's API;
those need a signed-in session. Each refused use of a token (expired, wrong
project, outside its access) is recorded in the audit log as `token.denied`,
and the token list shows when and from which address each token was last used.
Tokens minted before scopes existed show as **Legacy**: they keep their old,
wider access until they expire, 90 days after the upgrade.

## 2. Install the Furan GitHub App

The GitHub App posts the sticky PR comment and the `furan/baselines` status
check. Each Furan deployment provisions its own App during install; the URL
is **TBD per-deployment** and lives in `apps/integrations` config (`GITHUB_APP_SLUG`).

A reference install slug is `furan-baselines`
(URL pattern `https://github.com/apps/<slug>`). To run your own App, create a
GitHub App on your account or organization, then give the `integrations`
service its credentials: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
`GITHUB_APP_WEBHOOK_SECRET` (see `apps/integrations/src/env.ts` for the full
list), and surface the App's install URL to your team. The step-by-step
provisioning guide is [github-app.md](./github-app.md).

After installing the App on your repository, **link the GitHub installation
to a Furan project** via the admin UI:

1. Open `/admin/installations` in the Furan dashboard (admin-only).
2. Find your installation in the list — rows are sorted by `created_at`
   (oldest first), so the most recent install is at the bottom.
3. Pick the Furan project this installation should route events to from
   the project Select on that row. The change saves automatically.

You can find the GitHub `installation_id` (shown in the table) in the
install URL after accepting (`/settings/installations/<id>`) or in the
`installations` table after the webhook fires — useful for debugging.

## 3. Add the SDK to your Gradle build

```kotlin
// build.gradle.kts
repositories { mavenCentral() }

dependencies {
  testImplementation("io.github.qasecret:furan-selenium:4.0.0")
  testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
```

## 4. Write a test

Canonical reference:
[`packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutTest.kt`](https://github.com/qasecret/furan-monorepo/blob/main/packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutTest.kt).

Short version:

```kotlin
import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

class CheckoutTest {
  @Test fun `captures checkout flow`() {
    val driver = ChromeDriver(ChromeOptions().apply {
      addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage")
    })
    val furan = Furan(FuranConfig.fromEnv(), driver)
    try {
      driver.get("https://staging.example.com/checkout")
      furan.snapshot("checkout-step-1")
    } finally { furan.close(); driver.quit() }
  }
}
```

`FuranConfig.fromEnv()` reads `FURAN_API_URL`, `FURAN_API_TOKEN`,
`FURAN_PROJECT_ID`, `FURAN_BUILD_ID`, `FURAN_BRANCH` from the process env —
the same vars set in step 1.

On GitHub Actions it also detects the repository (`GITHUB_REPOSITORY`), the pull
request number and the pull request's head commit (from the event file at
`GITHUB_EVENT_PATH`) and sends them with every run; that is how the comment and
status in step 5 find their pull request. Nothing needs to be set for this. Set
`FURAN_REPO`, `FURAN_PR_NUMBER` or `FURAN_COMMIT_SHA` only to override a value;
see [github-app.md](./github-app.md#what-a-run-needs-to-reach-a-pull-request).

## 5. Run in CI

When the workflow runs against a PR with the App installed and the
`installations.project_id` link in place:

- **Furan dashboard** — a new run appears at `/projects/<id>/runs/<runId>`
  showing every snapshot and any pixel diff vs. the baseline on `main`.
- **PR comment** — a sticky comment marked with `<!-- furan-run-{runId} -->`
  is posted for each run (one run is one test) and edited in place when that
  run is reported again, summarizing the diff count. It links to the dashboard
  when `DASHBOARD_BASE_URL` is set on the `integrations` service.
- **Status check** — the `furan/baselines` context is one value per commit and
  covers the whole build: `pending` while any of its tests is still running,
  `failure` while any is `unresolved`, `failed` or `empty`, `error` if one was
  aborted, and `success` only when all tests have passed or created a baseline.
  A test that passes does not turn the status green while another test of the
  build still needs review. Approving or rejecting in the dashboard refreshes
  the comment and the status, so approving the last test that needs review turns
  the check green without re-running the job.

Branch-protection rules can require `furan/baselines` to pass before merge.

> **First run of each test needs a baseline.** With the default
> `autoApproveFeature=false`, a test's first run has nothing to diff against, so
> the SDK throws `FuranNoBaselineException` and the job fails until you approve
> that run in the dashboard ("Save as baseline"). To make first runs green in CI
> without manual approval, either flip the project's `autoApproveFeature=true`
> (auto-seed) or set `FURAN_SOFT_ASSERT=true` and assert in test
> code.

## 6. Troubleshooting

| Symptom                                        | Likely cause                                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401 unauthorized` from SDK                    | `FURAN_API_TOKEN` not exported, expired, or revoked at `/account/tokens`                                                                                                                               |
| `401 token_expired`                            | The token's lifetime is over: mint a replacement at `/account/tokens` and update the `FURAN_API_TOKEN` secret                                                                                          |
| `403 token_project_mismatch`                   | The token is bound to a different project than `FURAN_PROJECT_ID`                                                                                                                                      |
| `403 insufficient_scope`                       | A read-only token tried to upload or approve: mint an SDK & CI token                                                                                                                                   |
| `404 project not found`                        | Wrong `FURAN_PROJECT_ID`, or the token user is not a member of that project                                                                                                                            |
| `FuranNoBaselineException` on a first run      | Expected — the test has no baseline yet. Approve the run in the dashboard (Save as baseline), or set the project's `autoApproveFeature=true`, or `FURAN_SOFT_ASSERT=true` to tolerate first runs in CI |
| Chrome fails to start in CI                    | Add `uses: browser-actions/setup-chrome@v1` before `./gradlew test`                                                                                                                                    |
| Sticky comment not appearing on PR             | Furan GitHub App not installed on the repo, or `installations.project_id` is still NULL; otherwise see check 6 in [github-app.md](./github-app.md#5-check-it-works)                                    |
| `furan/baselines` check stays `pending`        | A test of the build is still `running`: diff worker not running, or the run's snapshots failed to enqueue — check worker logs                                                                          |
| SDK build can't resolve `io.github.qasecret:*` | Pre-Maven-Central: publish locally via `./gradlew :core:publishToMavenLocal :selenium:publishToMavenLocal` from `packages/sdk-kotlin`                                                                  |

For deeper debugging, hit `GET /projects/<id>/runs/<runId>/events` (SSE) or
inspect the `test_runs` and `screenshots` tables directly.

## JavaScript / TypeScript: the `furan upload` Action

For a project that produces PNG screenshots (Playwright, Cypress, Storybook
exports, anything), the `furan upload` Action is one step and needs no JVM.
Pin a `cli/v*` tag: the Action runs the `@furan/cli` version it is tagged
with.

```yaml
- run: npx playwright test # or: npx cypress run, …
- uses: qasecret/furan-monorepo/packages/cli@cli/v0.1.0
  with:
    path: screenshots # a folder (recommended), file or glob, one per line
    api-url: ${{ secrets.FURAN_API_URL }}
    token: ${{ secrets.FURAN_API_TOKEN }}
    project-id: ${{ secrets.FURAN_PROJECT_ID }}
    dashboard-url: https://furan.example.com # optional: links in the summary
```

- The branch, the PR's base branch and a per-run build id come from the
  workflow's own context, so every job and matrix shard of a workflow run
  lands in one batch, and a re-run gets a fresh one. No `FURAN_BUILD_ID` or
  `FURAN_BRANCH` is needed.
- The job fails when a screenshot needs review (exit 1). A step with no
  baseline yet passes with a warning; set `fail-on-new: true` to fail instead,
  or `save-new-tests: true` to approve first baselines automatically.
- The job summary gets a table of tests with review links, and the step
  outputs `build-id`, `build-url` and `status`
  (`passed` / `new` / `failed` / `error` / `uploaded`).
- Prefer folders in `path`: each subfolder becomes a test and each step keeps
  its folder in its name. A `**/*.png` glob passes files, and files from
  different folders with the same name would share a baseline, so the CLI
  refuses them.
- Other inputs: `test`, `ignore` (one `x,y,width,height` per line),
  `match-level`, `browser`, `wait`, `timeout`, `version`, and `args` for any
  other `furan upload` flag, one per line. The connection inputs may be left
  out when the job sets `FURAN_API_URL`, `FURAN_API_TOKEN` and
  `FURAN_PROJECT_ID` in `env`.

The same summary and outputs come from a plain
`run: npx @furan/cli upload screenshots` step. The Playwright Test fixture
(`@furan/playwright`) needs no extra step at all: tests fail on their own when
a screenshot changes. See [javascript.md](javascript.md).

## See also

- [GitHub App setup](./github-app.md) — create, configure and verify the App
- [Jenkins recipe](./jenkins.md) and [GitLab CI recipe](./gitlab-ci.md)
- [SDK example project](https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin/examples/sdk-selenium-junit5) — runnable Gradle reference
- [Production deploy runbook](../runbooks/production-deploy.md) — running the full stack, including the `integrations` service
- [`.examples/visual-regression.yml`](https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/.examples/visual-regression.yml) — copy-paste workflow
- [JavaScript / TypeScript guide](javascript.md) — `furan upload`, the Playwright fixture, the client library
