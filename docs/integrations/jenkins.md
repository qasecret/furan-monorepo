# Jenkins CI recipe

Run the Furan Kotlin SDK from a Jenkins Declarative Pipeline: baselines follow
your branches, parallel stages report into one Furan build, and the stage result
tells you whether the screenshots matched.

Assumes a self-hosted Furan deployment (see [Getting started](../getting-started/install.md) or the [production install](../install/compose.md))
and a Furan project already created. Unlike the [GitHub Actions recipe](./github-actions.md),
Jenkins itself gets no pull-request comment or commit status: results are
reviewed in the Furan dashboard, and the pipeline gate is the stage exit status.
A repository hosted on GitHub can still get both through the GitHub App; see
[Report to a GitHub pull request](#report-to-a-github-pull-request).

## Quick start

```groovy
pipeline {
  agent any
  environment {
    FURAN_API_URL    = credentials('furan-api-url')
    FURAN_API_TOKEN  = credentials('furan-api-token')
    FURAN_PROJECT_ID = credentials('furan-project-id')
    FURAN_BRANCH     = "${env.CHANGE_BRANCH ?: env.BRANCH_NAME}"
    FURAN_PARENT_BRANCH = "${env.CHANGE_TARGET ?: ''}"
  }
  stages {
    stage('Open Furan build') {
      steps {
        script {
          env.FURAN_BUILD_ID = sh(returnStdout: true, script: '''
            set +x -eu
            BODY=$(jq -nc --arg ciBuildId "$BUILD_TAG" --arg branchName "$FURAN_BRANCH" \
              --arg name "$JOB_NAME #$BUILD_NUMBER" --argjson number "$BUILD_NUMBER" \
              '{ciBuildId: $ciBuildId, branchName: $branchName, name: $name, number: $number}')
            RESP=$(curl -fsS -X POST "$FURAN_API_URL/projects/$FURAN_PROJECT_ID/builds" \
              -H "Authorization: Bearer $FURAN_API_TOKEN" \
              -H 'Content-Type: application/json' -d "$BODY")
            printf '%s' "$RESP" | jq -er .id
          ''').trim()
        }
      }
    }
    stage('Visual tests') {
      steps { sh './gradlew test' }
    }
  }
}
```

The full parallel version is in [step 5](#5-run-in-ci).

## 1. Configure secrets

Create three **Secret text** credentials (**Manage Jenkins → Credentials →
Add Credentials**, or folder-level credentials for one team):

| Credential ID      | Source                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `furan-api-url`    | Your self-hosted Furan API URL, see below                           |
| `furan-api-token`  | Mint at `/account/tokens` in the Furan dashboard (token shown once) |
| `furan-project-id` | UUID from the project URL: `/projects/<UUID>`                       |

`FURAN_API_URL` is the URL the SDK sends its requests to, written without a
trailing slash:

- `compose.yml` stack: `http://<host>:3000`
- one-file `furan-compose.yml` (nginx): `http://<host>:8080/api`
- behind your own reverse proxy: whatever origin and path serves the API

`credentials('<id>')` in an `environment { }` block exports the secret as an
environment variable of the same name as the block key and masks it in the
console log. The SDK only reads the process environment, so nothing else is
needed. The `FURAN_BRANCH`, `FURAN_PARENT_BRANCH` and `FURAN_BUILD_ID` values
are **not** secrets; see the next section.

Optional: set `FURAN_DASHBOARD_URL` (the dashboard origin, e.g.
`https://furan.your-domain.com`) so assertion errors in the build log include
a direct link to the diff viewer.

## 2. Branch and build names

Outside GitHub Actions the SDK has no CI auto-detection. `FuranConfig.fromEnv()`
reads only the `FURAN_*` variables, so the pipeline must set them. Jenkins
provides the inputs:

| Furan input            | Value in the Quick start                       | Where it comes from                                                                                                                                          |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FURAN_BRANCH`         | `CHANGE_BRANCH ?: BRANCH_NAME`                 | Multibranch Pipeline: `CHANGE_BRANCH` is the PR source branch, `BRANCH_NAME` is the branch itself (`PR-123` on PR builds, which is why it is not used there) |
| `FURAN_PARENT_BRANCH`  | `CHANGE_TARGET`, else empty                    | The PR target branch. Empty on a plain branch build, which is treated as "no parent"                                                                         |
| build `ciBuildId`      | `BUILD_TAG`                                    | Unique per job and build number (`jenkins-<job>-<n>`)                                                                                                        |
| build `number`, `name` | `BUILD_NUMBER`, `"<JOB_NAME> #<BUILD_NUMBER>"` | Shown in the Furan build list                                                                                                                                |

The Quick start assumes a **Multibranch Pipeline**. On a plain Pipeline job
`BRANCH_NAME` and `CHANGE_*` are not set, so the `environment { }` expressions
above would export the literal string `null`. Drop `FURAN_BRANCH` and
`FURAN_PARENT_BRANCH` from the `environment { }` block and set the branch after
the checkout from the Git plugin's `GIT_BRANCH`, which carries the remote name:

```groovy
script { env.FURAN_BRANCH = env.GIT_BRANCH.replaceFirst(/^origin\//, '') }
```

### How baselines follow branches

A baseline belongs to a test variation (checkpoint name, viewport, browser, OS,
device) **on a branch**. For each checkpoint the diff worker looks for a
baseline in this order and uses the first hit:

1. the same branch (`FURAN_BRANCH`);
2. the parent branch (`FURAN_PARENT_BRANCH`), one hop;
3. the project's main branch (**Project settings → main branch**, default
   `main`).

So a new feature branch with `FURAN_PARENT_BRANCH` set diffs against its target
branch's baseline until it earns baselines of its own. When `FURAN_PARENT_BRANCH`
is empty it falls straight through to the project's main branch.

### One Furan build per Jenkins build

`FURAN_BUILD_ID` is the **Furan build UUID**, not a CI number. When it is set the
SDK uses it as-is and skips creating a build, and `POST /runs` rejects anything
that is not a UUID. So do not set it to `BUILD_NUMBER`, `BUILD_TAG` or a commit
SHA.

When `FURAN_BUILD_ID` is unset, every `Furan` (or `FuranImages`) instance creates
its own Furan build on first use, so a test class using `Furan.use(...)` per test
scatters its runs over many builds. To group everything a Jenkins build captures,
create the build once, up front, and hand its UUID to every stage. That is what
the `Open Furan build` stage does:

- `POST $FURAN_API_URL/projects/$FURAN_PROJECT_ID/builds` with a bearer token.
- The body accepts `ciBuildId`, `number`, `branchName`, `name` and `properties`
  (all optional).
- It is **find-or-create on `ciBuildId`**: the first call returns `201` and the
  build; any later call with the same `ciBuildId` returns `200` and the same
  build. Re-running the stage is safe.
- The response `id` is the UUID to export as `FURAN_BUILD_ID`.

Because the SDK skips build creation when `FURAN_BUILD_ID` is set,
`FURAN_BUILD_NAME` and `FURAN_BUILD_PROPERTIES` are ignored in that case. Put the
name and properties in the request body instead.

The pipeline builds the JSON with `jq --arg`, and reads the branch from the
environment inside a single-quoted script. Branch names are controlled by whoever
opens the PR, so never interpolate them into the script text or hand-quote them
into JSON. The agent running this stage needs `curl` and `jq`.

### Report to a GitHub pull request

Optional, and only when the repository is on GitHub with the
[GitHub App](./github-app.md) installed and linked to the Furan project, and
Kotlin SDK 4.3.0 or later. Three
more variables let a run find its pull request, so Furan can post the sticky
comment and the `furan/baselines` commit status:

| Variable           | Value                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `FURAN_REPO`       | The repository as `owner/name`, for example `acme/site`                                       |
| `FURAN_PR_NUMBER`  | `CHANGE_ID`: set on the pull request builds of a Multibranch Pipeline, empty on branch builds |
| `FURAN_COMMIT_SHA` | The pull request's **head** commit, not a merge commit (see below)                            |

```groovy
environment {
  FURAN_REPO      = 'acme/site'
  FURAN_PR_NUMBER = "${env.CHANGE_ID ?: ''}"
}
// ... in a stage, after the checkout:
script {
  env.FURAN_COMMIT_SHA = sh(returnStdout: true,
    script: 'git rev-parse --verify --quiet HEAD^2 || git rev-parse HEAD').trim()
}
```

GitHub only shows a status on a pull request for its head commit. When Jenkins
builds the pull request merged with its target branch, `GIT_COMMIT` is the merge
commit and a status on it never appears; the head commit is the merge's second
parent, which is what the `git rev-parse` line returns (and it returns `HEAD`
itself when the checkout is not a merge). A build with a commit but no
`FURAN_PR_NUMBER` still gets the status and no comment. Empty values count as
unset. What gets posted, and how to check it, is in
[github-app.md](./github-app.md#what-a-run-needs-to-reach-a-pull-request).

## 3. Add the SDK to your Gradle build

```kotlin
// build.gradle.kts
repositories { mavenCentral() }

dependencies {
  testImplementation("io.github.qasecret:furan-selenium:5.0.0")
  testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
```

`furan-selenium` brings `furan-core` and Selenium with it. The agent needs JDK 21
and a Chrome install (Selenium Manager resolves the matching driver).

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

Parallel stages share one Furan build because they share `FURAN_BUILD_ID`. Each
stage in a `parallel` block that runs on its own agent has to check out the
code itself; the `env.FURAN_BUILD_ID` assignment is visible on every node.

```groovy
stage('Visual tests') {
  parallel {
    stage('checkout') {
      agent { label 'chrome' }
      steps {
        checkout scm
        sh './gradlew test --tests "*CheckoutVisualTest*"'
      }
      post { always { junit 'build/test-results/test/*.xml' } }
    }
    stage('account') {
      agent { label 'chrome' }
      steps {
        checkout scm
        sh './gradlew test --tests "*AccountVisualTest*"'
      }
      post { always { junit 'build/test-results/test/*.xml' } }
    }
  }
}
```

Each parallel stage adds its runs to the same build, and the Furan dashboard
shows them together at `/projects/<id>/builds`. To split one browser matrix over
stages, set `FURAN_BROWSER` (a label that is part of the baseline identity) per
stage so each combination keeps its own baselines.

### What the exit status means

Gradle's `test` task ends the stage with a non-zero exit when any test fails, and
Jenkins marks the stage, and the build, failed. What fails a test depends on how
the test talks to Furan:

| Outcome in the test                                                                 | Exception thrown by the SDK | Stage result |
| ----------------------------------------------------------------------------------- | --------------------------- | ------------ |
| `snapshotAndAwait` sees `passed`                                                    | none                        | pass         |
| run is `unresolved`, `failed` or `aborted`                                          | `FuranAssertionException`   | **fail**     |
| no baseline yet (`new`)                                                             | `FuranNoBaselineException`  | **fail**     |
| no verdict within `FURAN_POLL_TIMEOUT_SECONDS` (default 60)                         | `FuranTimeoutException`     | **fail**     |
| bad or missing config                                                               | `FuranConfigException`      | **fail**     |
| API unreachable, or a `4xx`/`5xx` such as `401` (bad token) or `403` (not a member) | `FuranTransportException`   | **fail**     |

Two things to know:

- **Fire-and-forget does not gate the build.** `furan.snapshot(...)` returns
  immediately, and `close()` only throws when `FURAN_FAIL_ON_DIFF` is
  `AfterEach`. With the default (`None`) the stage passes even if every
  screenshot differs. Use `snapshotAndAwait`, or set `FURAN_FAIL_ON_DIFF=AfterEach`
  (a non-`passed` verdict at `close()` throws `FuranDiffException`).
- **An unresolved diff is not a pass.** A reviewer approves or rejects it in the
  dashboard. Approving does not retroactively change the finished stage; re-run
  the build and the new run diffs against the baseline you just approved.

`FURAN_SOFT_ASSERT=true` makes `snapshotAndAwait` return the result instead of
throwing, so you can assert in test code.

> **First run of each test needs a baseline.** A test's first run has nothing
> to diff against, so `snapshotAndAwait` throws `FuranNoBaselineException` and
> the stage fails until you approve that run in the dashboard ("Save as
> baseline"). To make first runs green in CI without manual approval, set
> `FURAN_SAVE_NEW_TESTS=true` (the SDK saves a new step's first capture as its
> baseline; it never approves a change), turn on the project setting
> **Auto-approve feature branches** (Settings → Diff behavior), or set
> `FURAN_SOFT_ASSERT=true` and assert in test code.

## 6. Troubleshooting

| Symptom                                          | Likely cause                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FURAN_API_URL is required`                      | The `environment { }` block is missing, or the credential ID does not exist or is not visible to this job's folder                                           |
| `401 invalid_token` / `401 token_expired`        | `furan-api-token` wrong, expired, or revoked at `/account/tokens`                                                                                            |
| `403 not_a_project_member`                       | The token user is not a member of that project, or `furan-project-id` is wrong (a non-admin token cannot be a member of a missing project)                   |
| `403 token_project_mismatch`                     | The token is bound to another project than `furan-project-id`                                                                                                |
| `403 insufficient_scope`                         | A read-only token tried to upload: mint an **SDK & CI** token                                                                                                |
| `Open Furan build` fails with `jq: parse error`  | `FURAN_API_URL` points at the dashboard: on the one-file install the api is under `/api`                                                                     |
| `404 project_not_found`                          | An admin token with a `furan-project-id` that does not exist                                                                                                 |
| `Open Furan build` fails with HTTP 400           | `ciBuildId`, `branchName` or `name` over 200 characters, or an empty value; check `BUILD_TAG` and the branch name                                            |
| `400 invalid_body` on the first snapshot         | `FURAN_BUILD_ID` is not a Furan build UUID (a CI number or SHA was exported)                                                                                 |
| Parallel stages land in separate builds          | `FURAN_BUILD_ID` was not exported before the `parallel` block, or the stages did not inherit `env.FURAN_BUILD_ID`                                            |
| Every PR compares against `main`                 | `FURAN_PARENT_BRANCH` is empty: not a Multibranch PR build, so `CHANGE_TARGET` is unset                                                                      |
| Baselines written to `main` from a feature build | `FURAN_BRANCH` is unset (defaults to `main`) or resolved to the wrong value                                                                                  |
| Chrome fails to start                            | The agent has no Chrome; add `--no-sandbox --disable-dev-shm-usage` for container agents                                                                     |
| `FuranNoBaselineException` on a first run        | Expected: approve the run in the dashboard, or set `FURAN_SAVE_NEW_TESTS=true`, the project's **Auto-approve feature branches**, or `FURAN_SOFT_ASSERT=true` |
| Stage passes although screenshots differ         | The test uses `snapshot()` without `FURAN_FAIL_ON_DIFF=AfterEach`, see above                                                                                 |

## See also

- [GitLab CI recipe](./gitlab-ci.md) and [GitHub Actions recipe](./github-actions.md)
- [SDK reference and configuration table](../sdk/kotlin.mdx)
- [SDK example project](https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin/examples/sdk-selenium-junit5): runnable Gradle reference
