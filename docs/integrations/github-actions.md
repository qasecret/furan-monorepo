# GitHub Actions CI recipe

Run the Furan Selenium SDK from GitHub Actions, get baselines reviewed via a
sticky PR comment and a `furan/baselines` status check.

Assumes a self-hosted Furan deployment (see [docs/install/quickstart.md](../install/quickstart.md))
and a Furan project already created. Repository-to-project mapping is wired by
the GitHub App + a one-time admin-UI link (see step 2 below).

> **The PR comment and `furan/baselines` status are not posted yet.** The
> service that would post them is deployed and tracks installations, but no
> component currently sends it the repository, pull request and commit it needs.
> Runs, diffs and baselines work; review them in the dashboard. See
> [What works today](./github-app.md#what-works-today).

Using another CI system? See the [Jenkins](./jenkins.md) and
[GitLab CI](./gitlab-ci.md) recipes.

## Quick start

```yaml
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: "21" }
- uses: browser-actions/setup-chrome@v1
- name: Open Furan build
  id: furan_build
  env:
    FURAN_API_URL: ${{ secrets.FURAN_API_URL }}
    FURAN_API_TOKEN: ${{ secrets.FURAN_API_TOKEN }}
    FURAN_PROJECT_ID: ${{ secrets.FURAN_PROJECT_ID }}
    CI_BUILD_ID: github-${{ github.run_id }}
    BRANCH_NAME: ${{ github.head_ref || github.ref_name }}
  run: |
    BODY=$(jq -nc --arg ciBuildId "$CI_BUILD_ID" --arg branchName "$BRANCH_NAME" \
      '{ciBuildId: $ciBuildId, branchName: $branchName}')
    RESP=$(curl -fsS -X POST "$FURAN_API_URL/projects/$FURAN_PROJECT_ID/builds" \
      -H "Authorization: Bearer $FURAN_API_TOKEN" \
      -H 'Content-Type: application/json' -d "$BODY")
    ID=$(printf '%s' "$RESP" | jq -er .id)
    echo "id=$ID" >> "$GITHUB_OUTPUT"
- run: ./gradlew test
  env:
    FURAN_API_URL: ${{ secrets.FURAN_API_URL }}
    FURAN_API_TOKEN: ${{ secrets.FURAN_API_TOKEN }}
    FURAN_PROJECT_ID: ${{ secrets.FURAN_PROJECT_ID }}
    FURAN_BUILD_ID: ${{ steps.furan_build.outputs.id }}
    FURAN_BRANCH: ${{ github.head_ref || github.ref_name }}
    FURAN_PARENT_BRANCH: ${{ github.base_ref }}
```

Full copy-paste workflow, including the build step inline:
[`.examples/visual-regression.yml`](./.examples/visual-regression.yml).

## 1. Configure secrets

Three repository (or org-level) secrets are required.

| Secret             | Source                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `FURAN_API_URL`    | Your self-hosted Furan URL, e.g. `https://furan.your-domain.com`    |
| `FURAN_API_TOKEN`  | Mint at `/account/tokens` in the Furan dashboard (token shown once) |
| `FURAN_PROJECT_ID` | UUID from the project URL: `/projects/<UUID>`                       |

The `FURAN_BUILD_ID`, `FURAN_BRANCH`, and `FURAN_PARENT_BRANCH` env vars in the
snippet above are **not** secrets. `FURAN_BRANCH` and `FURAN_PARENT_BRANCH` come
from `github.head_ref` / `github.base_ref` and are what Furan resolves baselines
against. `github.base_ref` is set only on `pull_request` events (empty on a
push), so on a branch push no parent is sent and baseline resolution falls back
to the project's main branch — exactly as before.

`FURAN_BUILD_ID` is the **Furan build UUID**, not a CI id. When it is set the
SDK uses it as-is and skips creating a build, and `POST /runs` rejects anything
that is not a UUID, so do **not** set it to `github.sha` or `github.run_id`.
The `Open Furan build` step creates the build with `POST
/projects/<id>/builds` and passes the returned `id` on. That call is
find-or-create on `ciBuildId` (`201` the first time, `200` and the same build
afterwards), so re-running the workflow is safe. If you leave `FURAN_BUILD_ID`
unset, every `Furan` instance creates its own build.

Because the SDK skips build creation when `FURAN_BUILD_ID` is set,
`FURAN_BUILD_NAME` and `FURAN_BUILD_PROPERTIES` are then ignored. Put `name` and
`properties` in the request body of the build step instead (the example
workflow sets `name` and `number`).

Set secrets via **Settings → Secrets and variables → Actions → New repository
secret** (or use `gh secret set FURAN_API_TOKEN`).

## 2. Install the Furan GitHub App

The GitHub App posts the sticky PR comment and the `furan/baselines` status
check (see the note at the top: not yet). Each Furan deployment provisions its
own App: create a GitHub App on your account or organization, then give the
`integrations` service its credentials: `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` (see
`apps/integrations/src/env.ts` for the full list). The step-by-step
provisioning guide is [github-app.md](./github-app.md).

The App's install URL is `https://github.com/apps/<slug>`, where `<slug>` comes
from the name you give the App on GitHub. The `integrations` service does not
read a slug, so share the install URL with your team yourself.

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
  testImplementation("io.github.qasecret:furan-selenium:4.2.0")
  testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
```

## 4. Write a test

Canonical reference:
[`packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutTest.kt`](../../packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutTest.kt).

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
    try {
      Furan.use(FuranConfig.fromEnv(), driver, "checkout") { furan ->
        driver.get("https://staging.example.com/checkout")
        furan.snapshotAndAwait("checkout-step-1")
      }
    } finally { driver.quit() }
  }
}
```

`Furan.use` opens the run before the block and closes it after (`snapshot` and
`snapshotAndAwait` need an open run; constructing `Furan(...)` alone is not
enough). `FuranConfig.fromEnv()` requires `FURAN_API_URL`, `FURAN_API_TOKEN` and
`FURAN_PROJECT_ID`, and reads `FURAN_BUILD_ID`, `FURAN_BRANCH` and
`FURAN_PARENT_BRANCH` from the process env — the same vars set in step 1.
`FURAN_BRANCH` defaults to `main` when unset.

`snapshotAndAwait` blocks until the diff worker has a verdict and fails the test
(so the job) on a regression. `snapshot` is fire-and-forget and does not gate
the job unless `FURAN_FAIL_ON_DIFF=AfterEach` is set. The exit-status table in
the [Jenkins recipe](./jenkins.md#what-the-exit-status-means) applies unchanged.

## 5. Run in CI

When the workflow runs:

- **Furan dashboard** — a new run appears at `/projects/<id>/runs/<runId>`
  showing every snapshot and any pixel diff vs. its baseline (this branch's
  first, then the parent branch's, then the project's main branch).
- **Job result** — with `snapshotAndAwait` the job fails on a regression or a
  missing baseline.

The two items below need the GitHub App installed with the
`installations.project_id` link in place, **and are not posted yet** (see the
note at the top of this page):

- **PR comment** — a sticky comment marked with `<!-- furan-run-{runId} -->`
  is posted (or edited in place on subsequent pushes) summarizing the diff
  count and linking to the dashboard.
- **Status check** — the `furan/baselines` context is set to `pending` while
  the run is processing, then `success` / `failure` once the diff worker
  completes.

Once they are posted, branch-protection rules can require `furan/baselines` to
pass before merge.

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
| `403 not_a_project_member`                     | The token user is not a member of that project, or `FURAN_PROJECT_ID` is wrong (a non-admin token cannot be a member of a missing project)                                                             |
| `404 project_not_found`                        | An admin token with a `FURAN_PROJECT_ID` that does not exist                                                                                                                                           |
| `400 invalid_body` on the first snapshot       | `FURAN_BUILD_ID` is not a Furan build UUID (a SHA or run id was exported); use the `Open Furan build` step's output                                                                                    |
| `FuranNoBaselineException` on a first run      | Expected — the test has no baseline yet. Approve the run in the dashboard (Save as baseline), or set the project's `autoApproveFeature=true`, or `FURAN_SOFT_ASSERT=true` to tolerate first runs in CI |
| Chrome fails to start in CI                    | Add `uses: browser-actions/setup-chrome@v1` before `./gradlew test`                                                                                                                                    |
| Sticky comment not appearing on PR             | Not posted yet in the current release (see the note at the top). Once it is: Furan GitHub App not installed on the repo, or `installations.project_id` is still NULL                                   |
| `furan/baselines` check stays `pending`        | Diff worker not running, or the run's snapshots failed to enqueue — check worker logs                                                                                                                  |
| SDK build can't resolve `io.github.qasecret:*` | Pre-Maven-Central: publish locally via `./gradlew :core:publishToMavenLocal :selenium:publishToMavenLocal` from `packages/sdk-kotlin`                                                                  |

For deeper debugging, hit `GET /projects/<id>/runs/<runId>/events` (SSE) or
inspect the `test_runs` and `screenshots` tables directly.

## See also

- [GitHub App setup](./github-app.md) — create, configure and verify the App
- [Jenkins recipe](./jenkins.md) and [GitLab CI recipe](./gitlab-ci.md)
- [SDK example project](../../packages/sdk-kotlin/examples/sdk-selenium-junit5/) — runnable Gradle reference
- [Production deploy runbook](../runbooks/production-deploy.md) — running the full stack, including the `integrations` service
- [`.examples/visual-regression.yml`](./.examples/visual-regression.yml) — copy-paste workflow
