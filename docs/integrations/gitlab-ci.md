# GitLab CI recipe

Run the Furan Kotlin SDK from GitLab CI/CD: baselines follow your branches and
merge request targets, parallel jobs report into one Furan build, and the job
result tells you whether the screenshots matched.

Assumes a self-hosted Furan deployment (see [docs/install/quickstart.md](https://github.com/qasecret/furan-monorepo/blob/main/docs/maintainers/development.md))
and a Furan project already created. Unlike the [GitHub Actions recipe](./github-actions.md),
there is no merge request comment or commit status for GitLab: results are
reviewed in the Furan dashboard, and the pipeline gate is the job exit status.

## Quick start

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH

stages: [furan, test]

.furan:
  before_script:
    - export FURAN_BRANCH="${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-$CI_COMMIT_REF_NAME}"
    - export FURAN_PARENT_BRANCH="${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}"

furan-build:
  extends: .furan
  stage: furan
  image: alpine:3.20
  script:
    - apk add --no-cache curl jq
    - |
      set -eu
      BODY=$(jq -nc --arg ciBuildId "gitlab-$CI_PIPELINE_ID" --arg branchName "$FURAN_BRANCH" \
        --arg name "$CI_PROJECT_PATH #$CI_PIPELINE_IID" --argjson number "$CI_PIPELINE_IID" \
        '{ciBuildId: $ciBuildId, branchName: $branchName, name: $name, number: $number}')
      RESP=$(curl -fsS -X POST "$FURAN_API_URL/projects/$FURAN_PROJECT_ID/builds" \
        -H "Authorization: Bearer $FURAN_API_TOKEN" \
        -H 'Content-Type: application/json' -d "$BODY")
      ID=$(printf '%s' "$RESP" | jq -er .id)
      echo "FURAN_BUILD_ID=$ID" > furan.env
  artifacts:
    reports:
      dotenv: furan.env

visual-tests:
  extends: .furan
  stage: test
  image: your-registry/jdk21-chrome:latest # any image with JDK 21 and Chrome
  needs: [furan-build]
  parallel:
    matrix:
      - SUITE: [Checkout, Account]
  script:
    - ./gradlew test --tests "*${SUITE}VisualTest*"
  artifacts:
    when: always
    reports:
      junit: build/test-results/test/*.xml
```

## 1. Configure secrets

Add three CI/CD variables (**Settings → CI/CD → Variables → Add variable**, at
project, group or instance level):

| Variable           | Source                                                              | Flags                                                              |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `FURAN_API_URL`    | Your self-hosted Furan API URL, see below                           | Visible                                                            |
| `FURAN_API_TOKEN`  | Mint at `/account/tokens` in the Furan dashboard (token shown once) | Masked (or Masked and hidden), clear **Expand variable reference** |
| `FURAN_PROJECT_ID` | UUID from the project URL: `/projects/<UUID>`                       | Visible                                                            |

`FURAN_API_URL` is the URL the SDK sends its requests to, written without a
trailing slash:

- `compose.yml` stack: `http://<host>:3000`
- one-file `furan-compose.yml` (nginx): `http://<host>:8080/api`
- behind your own reverse proxy: whatever origin and path serves the API

GitLab can only mask values that meet its masking rules; a `furan_pat_…` token
contains underscores, so clear **Expand variable reference** on that variable if
the form rejects it (the token has no `$` to expand).

**Do not mark these variables Protected unless every pipeline that needs them
runs on a protected ref.** A protected variable is only exposed to pipelines on
protected branches and tags (merge request pipelines only if you allow them to
use protected variables), so a feature branch pipeline would otherwise fail with
`FURAN_API_URL is required`.

Optional: set `FURAN_DASHBOARD_URL` (the dashboard origin, e.g.
`https://furan.your-domain.com`) so assertion errors in the job log include a
direct link to the diff viewer.

## 2. Branch and build names

Outside GitHub Actions the SDK has no CI auto-detection. `FuranConfig.fromEnv()`
reads only the `FURAN_*` variables, so the pipeline must set them. GitLab
provides the inputs:

| Furan input            | Value in the Quick start                                         | Where it comes from                                                                  |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `FURAN_BRANCH`         | `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME`, else `CI_COMMIT_REF_NAME` | The merge request source branch in MR pipelines; the branch name in branch pipelines |
| `FURAN_PARENT_BRANCH`  | `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, else empty                | The MR target branch. Empty in branch pipelines, which is treated as "no parent"     |
| build `ciBuildId`      | `gitlab-$CI_PIPELINE_ID`                                         | `CI_PIPELINE_ID` is unique across the instance                                       |
| build `number`, `name` | `CI_PIPELINE_IID`, `"$CI_PROJECT_PATH #$CI_PIPELINE_IID"`        | Shown in the Furan build list                                                        |

The `CI_MERGE_REQUEST_*` variables exist only in merge request pipelines, and
`CI_COMMIT_BRANCH` does not exist there, which is why the Quick start uses
`CI_COMMIT_REF_NAME` as the fallback. The `workflow:rules` block runs one
pipeline per push (the MR pipeline when a merge request is open, the branch
pipeline otherwise) so you do not capture twice.

GitLab does not expand shell defaults (`${A:-$B}`) in a `variables:` block, so
the exports live in a `before_script` that both jobs inherit via `extends`.

### How baselines follow branches

A baseline belongs to a test variation (checkpoint name, viewport, browser, OS,
device) **on a branch**. For each checkpoint the diff worker looks for a
baseline in this order and uses the first hit:

1. the same branch (`FURAN_BRANCH`);
2. the parent branch (`FURAN_PARENT_BRANCH`), one hop;
3. the project's main branch (**Project settings → main branch**, default
   `main`).

So a merge request branch diffs against its target branch's baseline until it
earns baselines of its own. In a plain branch pipeline `FURAN_PARENT_BRANCH` is
empty and the lookup falls straight through to the project's main branch.

### One Furan build per pipeline

`FURAN_BUILD_ID` is the **Furan build UUID**, not a CI number. When it is set the
SDK uses it as-is and skips creating a build, and `POST /runs` rejects anything
that is not a UUID. So do not set it to `CI_PIPELINE_ID` or a commit SHA.

When `FURAN_BUILD_ID` is unset, every `Furan` (or `FuranImages`) instance creates
its own Furan build on first use, so a test class using `Furan.use(...)` per test
scatters its runs over many builds. To group everything a pipeline captures,
create the build once, in an earlier stage, and hand its UUID to every job. That
is what the `furan-build` job does:

- `POST $FURAN_API_URL/projects/$FURAN_PROJECT_ID/builds` with a bearer token.
- The body accepts `ciBuildId`, `number`, `branchName`, `name` and `properties`
  (all optional).
- It is **find-or-create on `ciBuildId`**: the first call returns `201` and the
  build; any later call with the same `ciBuildId` returns `200` and the same
  build. Re-running the job is safe.
- The response `id` is written to a [`dotenv` artifact](https://docs.gitlab.com/ci/yaml/artifacts_reports/#artifactsreportsdotenv),
  so every job that lists `furan-build` under `needs` gets it as `FURAN_BUILD_ID`.

Because the SDK skips build creation when `FURAN_BUILD_ID` is set,
`FURAN_BUILD_NAME` and `FURAN_BUILD_PROPERTIES` are ignored in that case. Put the
name and properties in the request body instead.

The job builds the JSON with `jq --arg`, so a branch name containing quotes
cannot break or inject into the request. Branch names are controlled by whoever
pushes, so never hand-quote them into JSON. The job image needs `curl` and `jq`
(the Quick start installs them into `alpine`).

### Report to a GitHub pull request

Optional, and only for a repository on GitHub that GitLab builds through its
CI/CD for external repositories, with the [GitHub App](./github-app.md) installed
and linked to the Furan project. A merge request of a GitLab-hosted repository
has nothing to report to. Three more variables let a run find its pull request,
so Furan can post the sticky comment and the `furan/baselines` commit status:

| Variable           | Value in an external pull request pipeline                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `FURAN_REPO`       | `CI_EXTERNAL_PULL_REQUEST_TARGET_REPOSITORY`: the repository the pull request is on, as `owner/name` |
| `FURAN_PR_NUMBER`  | `CI_EXTERNAL_PULL_REQUEST_IID`                                                                       |
| `FURAN_COMMIT_SHA` | `CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_SHA`: the pull request's **head** commit                     |

Add them to the `before_script` that exports the other `FURAN_*` values:

```yaml
- export FURAN_REPO="${CI_EXTERNAL_PULL_REQUEST_TARGET_REPOSITORY:-}"
- export FURAN_PR_NUMBER="${CI_EXTERNAL_PULL_REQUEST_IID:-}"
- export FURAN_COMMIT_SHA="${CI_EXTERNAL_PULL_REQUEST_SOURCE_BRANCH_SHA:-}"
```

Those `CI_EXTERNAL_PULL_REQUEST_*` variables exist only in external pull request
pipelines, so other pipelines export empty values, which the SDK treats as unset
and reports nothing for. What gets posted, and how to check it, is in
[github-app.md](./github-app.md#what-a-run-needs-to-reach-a-pull-request).

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

`furan-selenium` brings `furan-core` and Selenium with it. The job image needs
JDK 21 and Chrome (Selenium Manager resolves the matching driver).

## 4. Write a test

Canonical reference:
[`packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutAwaitTest.kt`](https://github.com/qasecret/furan-monorepo/blob/main/packages/sdk-kotlin/examples/sdk-selenium-junit5/src/test/kotlin/CheckoutAwaitTest.kt).

Short version:

```kotlin
import io.furan.sdk.FuranConfig
import io.furan.sdk.selenium.Furan
import org.junit.jupiter.api.Test
import org.openqa.selenium.chrome.ChromeDriver
import org.openqa.selenium.chrome.ChromeOptions

class CheckoutVisualTest {
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

`FuranConfig.fromEnv()` requires `FURAN_API_URL`, `FURAN_API_TOKEN` and
`FURAN_PROJECT_ID`, and reads `FURAN_BUILD_ID`, `FURAN_BRANCH` and
`FURAN_PARENT_BRANCH` (plus the optional variables in the SDK
[configuration table](../sdk/kotlin.mdx#configuration)) from the
process environment. `FURAN_BRANCH` defaults to `main` when unset, so a missing
branch variable silently compares against, and writes baselines to, `main`.

## 5. Run in CI

`parallel:matrix` fans `visual-tests` out into one job per `SUITE` value
(`visual-tests: [Checkout]`, `visual-tests: [Account]`). Every one of them gets
the same `FURAN_BUILD_ID` from `furan-build`, so all their runs land in one
Furan build, shown together in the dashboard at `/projects/<id>/builds`. To split
a browser matrix instead, add a `FURAN_BROWSER` value (a label that is part of
the baseline identity) to the matrix so each combination keeps its own
baselines.

Retrying a failed job in the same pipeline reuses the pipeline's `furan-build`
artifact, so the retried runs join the same Furan build.

### What the exit status means

Gradle's `test` task exits non-zero when any test fails, and GitLab fails the
job (and, by default, the pipeline). What fails a test depends on how the test
talks to Furan:

| Outcome in the test                                                                 | Exception thrown by the SDK | Job result |
| ----------------------------------------------------------------------------------- | --------------------------- | ---------- |
| `snapshotAndAwait` sees `passed`                                                    | none                        | pass       |
| run is `unresolved`, `failed` or `aborted`                                          | `FuranAssertionException`   | **fail**   |
| no baseline yet (`new`)                                                             | `FuranNoBaselineException`  | **fail**   |
| no verdict within `FURAN_POLL_TIMEOUT_SECONDS` (default 60)                         | `FuranTimeoutException`     | **fail**   |
| bad or missing config                                                               | `FuranConfigException`      | **fail**   |
| API unreachable, or a `4xx`/`5xx` such as `401` (bad token) or `403` (not a member) | `FuranTransportException`   | **fail**   |

Two things to know:

- **Fire-and-forget does not gate the pipeline.** `furan.snapshot(...)` returns
  immediately, and `close()` only throws when `FURAN_FAIL_ON_DIFF` is
  `AfterEach`. With the default (`None`) the job passes even if every
  screenshot differs. Use `snapshotAndAwait`, or set `FURAN_FAIL_ON_DIFF=AfterEach`
  (a non-`passed` verdict at `close()` throws `FuranDiffException`).
- **An unresolved diff is not a pass.** A reviewer approves or rejects it in the
  dashboard. Approving does not retroactively change the finished job; retry the
  job or re-run the pipeline and the new run diffs against the baseline you just
  approved.

To report diffs without blocking merges, add `allow_failure: true` to
`visual-tests`: the job still turns orange when screenshots differ, and the
pipeline continues. `FURAN_SOFT_ASSERT=true` instead makes `snapshotAndAwait`
return the result instead of throwing, so you can assert in test code.

> **First run of each test needs a baseline.** With the default
> `autoApproveFeature=false`, a test's first run has nothing to diff against, so
> the SDK throws `FuranNoBaselineException` and the job fails until you approve
> that run in the dashboard ("Save as baseline"). To make first runs green in CI
> without manual approval, either flip the project's `autoApproveFeature=true`
> (auto-seed) or set `FURAN_SOFT_ASSERT=true` and assert in test code.

## 6. Troubleshooting

| Symptom                                          | Likely cause                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FURAN_API_URL is required`                      | The variable is not defined for this project or group, or it is Protected and the pipeline is not on a protected ref                              |
| `401 unauthorized`                               | `FURAN_API_TOKEN` wrong, expired, or revoked at `/account/tokens`                                                                                 |
| `403 not_a_project_member`                       | The token user is not a member of that project, or `FURAN_PROJECT_ID` is wrong (a non-admin token cannot be a member of a missing project)        |
| `404 project_not_found`                          | An admin token with a `FURAN_PROJECT_ID` that does not exist                                                                                      |
| `furan-build` fails with HTTP 400                | `ciBuildId`, `branchName` or `name` over 200 characters, or an empty value; check the branch name                                                 |
| `400 invalid_body` on the first snapshot         | `FURAN_BUILD_ID` is not a Furan build UUID (a CI number or SHA was exported)                                                                      |
| `FURAN_BUILD_ID` empty in the test job           | The job does not list `furan-build` in `needs`, so the `dotenv` artifact is not loaded                                                            |
| Parallel jobs land in separate builds            | Same cause, or the jobs created their own builds because `FURAN_BUILD_ID` was unset                                                               |
| Every MR compares against `main`                 | `FURAN_PARENT_BRANCH` is empty: a branch pipeline (no `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`), or MR pipelines are not enabled in `workflow:rules` |
| Baselines written to `main` from a feature build | `FURAN_BRANCH` is unset (defaults to `main`) or resolved to the wrong value                                                                       |
| Chrome fails to start                            | The image has no Chrome; add `--no-sandbox --disable-dev-shm-usage` for container runners                                                         |
| `FuranNoBaselineException` on a first run        | Expected: approve the run in the dashboard, set the project's `autoApproveFeature=true`, or `FURAN_SOFT_ASSERT=true`                              |
| Job passes although screenshots differ           | The test uses `snapshot()` without `FURAN_FAIL_ON_DIFF=AfterEach`, see above                                                                      |

## See also

- [Jenkins recipe](./jenkins.md) and [GitHub Actions recipe](./github-actions.md)
- [SDK reference and configuration table](../sdk/kotlin.mdx)
- [SDK example project](https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin/examples/sdk-selenium-junit5): runnable Gradle reference
