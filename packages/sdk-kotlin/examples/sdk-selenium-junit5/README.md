# sdk-selenium-junit5 example

Standalone Gradle project demonstrating the Furan Selenium adapter from a
plain JUnit 5 test. Intentionally _not_ part of the parent SDK multi-module
build — it consumes the published `io.furan:sdk-selenium` artifact the same
way a downstream user would.

## Layout

- `build.gradle.kts` — declares `io.furan:sdk-selenium:0.5.0` from
  `mavenLocal()` / `mavenCentral()`.
- `settings.gradle.kts` — standalone root project (`sdk-selenium-junit5`).
- `src/test/kotlin/CheckoutTest.kt` — minimal smoke test that boots Chrome
  via Selenium Manager and takes two snapshots on a `data:` URL.

## Prereqs

- JDK 21 (`export JAVA_HOME=$(/usr/libexec/java_home -v 21)` on macOS)
- Chrome installed somewhere on `PATH` (Selenium Manager resolves the
  matching driver automatically — no manual `chromedriver` setup needed)

## Building

Until `io.furan:sdk-selenium` is published to Maven Central (Phase 4 T6),
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
