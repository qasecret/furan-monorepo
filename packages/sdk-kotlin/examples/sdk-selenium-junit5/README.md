# sdk-selenium-junit5 example

Standalone Gradle project demonstrating the Furan Selenium adapter from a
plain JUnit 5 test. Intentionally _not_ part of the parent SDK multi-module
build — it consumes the published `io.github.qasecret:furan-selenium` artifact the same
way a downstream user would.

## Layout

- `build.gradle.kts` — declares `io.github.qasecret:furan-selenium:$sdkVersion`
  and `io.github.qasecret:furan-junit5:$sdkVersion` from `mavenLocal()` /
  `mavenCentral()`. The version is read at config time from `../../version.txt`
  so it tracks release-please bumps automatically.
- `settings.gradle.kts` — standalone root project (`sdk-selenium-junit5`).
- `src/test/kotlin/`
  - `CheckoutTest.kt` — fire-and-forget `furan.snapshot()`. The
    minimal-onboarding shape: boot Chrome, take two snapshots, close.
  - `CheckoutAwaitTest.kt` — `furan.snapshotAndAwait()` typed-result
    path. Blocks until the diff worker produces a terminal status and
    throws `FuranAssertionException` on non-PASSED (unless `softAssert`).
  - `CheckoutJUnit5ExtensionTest.kt` — `@FuranTest` annotation: the
    JUnit5 extension parameter-resolves a `FuranConfig` for each test
    method, removing `FuranConfig.fromEnv()` boilerplate.
  - `CheckoutIgnoreRegionsTest.kt` — per-test `ignoreAreas` + `diffTolerance`
    on the `Furan` constructor, plus a per-snapshot CSS-selector `mask`.
    The two modes compose: rectangles for fixed-position banners,
    selectors for layout-shifting widgets.
  - `CheckoutWithRuntimeTest.kt` — opt-in v2 runtime spine. Bootstraps
    a `FuranRuntime` via `FuranBootstrapper`, subscribes to the event
    bus, takes a snapshot via the ordinary `Furan` adapter, and dumps
    `runtime.diagnostics.snapshot()` for operator visibility. See the
    SDK README's "v2 runtime architecture" section for when this matters.
  - `CheckoutCandidateTest.kt` — paired with `CheckoutTest` to seed a
    CANDIDATE run that diverges from the baseline. Used by the local
    QA pass with a second `FURAN_BUILD_ID` + feature-branch `FURAN_BRANCH`.

## Prereqs

- JDK 21 (`export JAVA_HOME=$(/usr/libexec/java_home -v 21)` on macOS)
- Chrome installed somewhere on `PATH` (Selenium Manager resolves the
  matching driver automatically — no manual `chromedriver` setup needed)

## Building

Until `io.github.qasecret:furan-selenium` is published to Maven Central (Phase 4 T6),
install it to your local Maven cache first:

```bash
cd ../..                     # packages/sdk-kotlin
./gradlew :core:publishToMavenLocal :selenium:publishToMavenLocal
cd examples/sdk-selenium-junit5
gradle build                 # or use the parent wrapper: ../../gradlew -p . build
```

Once the SDK is on Maven Central, `gradle build` works without the local
publish step.

## Running the test

`./gradlew build` compiles the test but does not execute it (the test is
gated on `FURAN_API_URL` via JUnit 5's `@EnabledIfEnvironmentVariable`). To
actually run against a Furan stack:

```bash
export FURAN_API_URL=http://localhost:3000
export FURAN_API_TOKEN=<your token>
export FURAN_PROJECT_ID=<project id>
# optional:
# export FURAN_BUILD_ID=<ci build id>
# export FURAN_BRANCH=<branch name>
gradle test
```

Without those vars the test is skipped, which is the intended behavior in
CI for the example itself.

## See also

For a full CI walkthrough, see [docs/integrations/github-actions.md](../../../../docs/integrations/github-actions.md).
