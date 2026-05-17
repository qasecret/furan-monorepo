# GitHub Actions CI recipe

Run the Furan Selenium SDK from GitHub Actions, get baselines reviewed via a
sticky PR comment and a `furan/baselines` status check.

Assumes a self-hosted Furan deployment (see [docs/install/quickstart.md](../install/quickstart.md))
and a Furan project already created. Repository-to-project mapping is wired by
the GitHub App + a one-time SQL link (see step 3 below).

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
```

Full copy-paste workflow: [`.examples/visual-regression.yml`](./.examples/visual-regression.yml).

## 1. Configure secrets

Three repository (or org-level) secrets are required.

| Secret             | Source                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `FURAN_API_URL`    | Your self-hosted Furan URL, e.g. `https://furan.your-domain.com`    |
| `FURAN_API_TOKEN`  | Mint at `/account/tokens` in the Furan dashboard (token shown once) |
| `FURAN_PROJECT_ID` | UUID from the project URL: `/projects/<UUID>`                       |

The `FURAN_BUILD_ID` and `FURAN_BRANCH` env vars in the snippet above are
**not** secrets — they come from `github.sha` / `github.head_ref` and are
what Furan groups runs by.

Set secrets via **Settings → Secrets and variables → Actions → New repository
secret** (or use `gh secret set FURAN_API_TOKEN`).

## 2. Install the Furan GitHub App

The GitHub App posts the sticky PR comment and the `furan/baselines` status
check. Each Furan deployment provisions its own App during install; the URL
is **TBD per-deployment** and lives in `apps/integrations` config (`GITHUB_APP_SLUG`).

A reference install slug is `furan-baselines`
(URL pattern `https://github.com/apps/<slug>`). Follow
[docs/runbooks/alpha-install.md](../runbooks/alpha-install.md) to provision
your own App, set the slug in `apps/integrations`, and surface its install
URL to your team.

After installing the App on your repository, **link the GitHub installation
to a Furan project**. In v0.5 this is a one-time SQL command against the
Furan database — a `/admin/integrations` UI is planned for v1.1+.

```sql
UPDATE installations
   SET project_id = '<your-project-uuid>'
 WHERE installation_id = <github-installation-id>;
```

You can find the GitHub `installation_id` in the install URL after accepting
(`/settings/installations/<id>`) or in the `installations` table after the
webhook fires.

## 3. Add the SDK to your Gradle build

```kotlin
// build.gradle.kts
repositories { mavenCentral() }

dependencies {
  testImplementation("io.github.qasecret:furan-selenium:0.5.0")
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
    val furan = Furan(driver, FuranConfig.fromEnv())
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

## 5. Run in CI

When the workflow runs against a PR with the App installed and the
`installations.project_id` link in place:

- **Furan dashboard** — a new run appears at `/projects/<id>/runs/<runId>`
  showing every snapshot and any pixel diff vs. the baseline on `main`.
- **PR comment** — a sticky comment marked with `<!-- furan-run-{runId} -->`
  is posted (or edited in place on subsequent pushes) summarizing the diff
  count and linking to the dashboard.
- **Status check** — the `furan/baselines` context is set to `pending` while
  the run is processing, then `success` / `failure` once the diff worker
  completes.

Branch-protection rules can require `furan/baselines` to pass before merge.

## 6. Troubleshooting

| Symptom                                        | Likely cause                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `401 unauthorized` from SDK                    | `FURAN_API_TOKEN` not exported, expired, or revoked at `/account/tokens`                                                              |
| `404 project not found`                        | Wrong `FURAN_PROJECT_ID`, or the token user is not a member of that project                                                           |
| Chrome fails to start in CI                    | Add `uses: browser-actions/setup-chrome@v1` before `./gradlew test`                                                                   |
| Sticky comment not appearing on PR             | Furan GitHub App not installed on the repo, or `installations.project_id` is still NULL                                               |
| `furan/baselines` check stays `pending`        | Diff worker not running, or the run's snapshots failed to enqueue — check worker logs                                                 |
| SDK build can't resolve `io.github.qasecret:*` | Pre-Maven-Central: publish locally via `./gradlew :core:publishToMavenLocal :selenium:publishToMavenLocal` from `packages/sdk-kotlin` |

For deeper debugging, hit `GET /projects/<id>/runs/<runId>/events` (SSE) or
inspect the `test_runs` and `screenshots` tables directly.

## See also

- [SDK example project](../../packages/sdk-kotlin/examples/sdk-selenium-junit5/) — runnable Gradle reference
- [Alpha install runbook](../runbooks/alpha-install.md) — provisioning the GitHub App on a self-hosted deployment
- [`.examples/visual-regression.yml`](./.examples/visual-regression.yml) — copy-paste workflow
