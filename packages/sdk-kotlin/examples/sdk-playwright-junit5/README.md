# sdk-playwright-junit5 example

Standalone Gradle project demonstrating the Furan Playwright-Java adapter from
a plain JUnit 5 test. Intentionally _not_ part of the parent SDK multi-module
build — it consumes the published `io.github.qasecret:furan-playwright` artifact
the same way a downstream user would.

## Layout

- `build.gradle.kts` — declares `io.github.qasecret:furan-playwright:$sdkVersion`
  + `com.microsoft.playwright:playwright` from `mavenLocal()` / `mavenCentral()`.
  The version is read at config time from `../../version.txt` so it tracks
  release-please bumps automatically.
- `settings.gradle.kts` — standalone root project (`sdk-playwright-junit5`).
- `src/test/kotlin/`
  - `PlaywrightExampleTest.kt` — `FuranPlaywright.use(config, page) { … }` with
    `snapshotAndAwait()`. Boots a Playwright `Page`, navigates to a `data:` URL,
    takes a snapshot, blocks until the diff worker produces a terminal status.
    Same `open → snapshot → close` lifecycle as the Selenium adapter; the
    `browserName` baseline label is reported as `playwright-<type>`
    (`playwright-chromium` here) so chromium/firefox/webkit keep separate
    baselines.

## Prereqs

- JDK 21 (`export JAVA_HOME=$(/usr/libexec/java_home -v 21)` on macOS)
- Playwright fetches its own browser binaries on first `pw.chromium().launch()`
  (no manual driver/browser install needed); the download requires network on
  the first run.

## Building

Until `io.github.qasecret:furan-playwright` is published to Maven Central,
install it to your local Maven cache first:

```bash
cd ../..                     # packages/sdk-kotlin
./gradlew :core:publishToMavenLocal :playwright:publishToMavenLocal
cd examples/sdk-playwright-junit5
gradle build                 # or use the parent wrapper: ../../gradlew -p . build
```

Once the SDK is on Maven Central, `gradle build` works without the local
publish step.

## Running the test

`gradle build` compiles the test but does not execute it (it is gated on
`FURAN_API_URL` via JUnit 5's `@EnabledIfEnvironmentVariable`). Feed the SDK its
credentials either via a gitignored `local.properties` (copy
[`local.properties.example`](./local.properties.example) → `local.properties`,
which `build.gradle.kts` loads into the test task's environment) or inline:

```bash
export FURAN_API_URL=http://localhost:3000
export FURAN_API_TOKEN=<your token>
export FURAN_PROJECT_ID=<project id>
gradle test
```

Without those vars the test is skipped, which is the intended behavior in CI for
the example itself.
