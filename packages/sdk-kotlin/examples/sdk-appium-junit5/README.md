# sdk-appium-junit5 example

Standalone Gradle project demonstrating the Furan Appium adapter (native mobile)
from a plain JUnit 5 test. Intentionally _not_ part of the parent SDK
multi-module build — it consumes the published
`io.github.qasecret:furan-appium` artifact the same way a downstream user would.

## Layout

- `build.gradle.kts` — declares `io.github.qasecret:furan-appium:$sdkVersion`
  + `io.appium:java-client` from `mavenLocal()` / `mavenCentral()`. The version
  is read at config time from `../../version.txt` so it tracks release-please
  bumps automatically.
- `settings.gradle.kts` — standalone root project (`sdk-appium-junit5`).
- `src/test/kotlin/`
  - `AppiumExampleTest.kt` — `FuranAppium.use(config, driver) { … }` with
    `snapshotAndAwait()`. Boots an `AppiumDriver` against an Appium server,
    takes one **full-screen native** snapshot, blocks until the diff worker
    produces a terminal status. Same `open → snapshot → close` lifecycle as the
    Selenium / Playwright adapters; the `browserName` baseline label is
    `appium-<platform>` (`appium-android` here) so Android / iOS keep separate
    baselines.

## What "native" means here

The Appium adapter advertises `isNative = true`, so the capture engine uses its
degraded path: **one full-screen screenshot per snapshot — no DOM, no
element-map, and region selectors are not resolved** (numeric ignore/strict
regions still pass through). Webview-context capture and native element → bbox
resolution are planned follow-ups.

## Prereqs

- JDK 21 (`export JAVA_HOME=$(/usr/libexec/java_home -v 21)` on macOS)
- An **Appium server** (`npm i -g appium && appium`) listening on
  `APPIUM_SERVER_URL` (default `http://localhost:4723`).
- A **device or emulator** running the app under test, plus the matching Appium
  driver (`appium driver install uiautomator2` for Android).
- The app under test, addressed via `APPIUM_APP` (path to `.apk`/`.ipa`) or
  `APPIUM_APP_PACKAGE` + `APPIUM_APP_ACTIVITY`.

## Building

Until `io.github.qasecret:furan-appium` is published to Maven Central, install
it to your local Maven cache first:

```bash
cd ../..                     # packages/sdk-kotlin
./gradlew :core:publishToMavenLocal :appium:publishToMavenLocal
cd examples/sdk-appium-junit5
gradle build                 # or use the parent wrapper: ../../gradlew -p . build
```

`gradle build` compiles the test but does **not** execute it (it is gated on
`FURAN_API_URL` via JUnit 5's `@EnabledIfEnvironmentVariable`). That's the
intended CI behavior — the example compiles against the SDK without needing an
emulator.

## Running the test

Provide the Furan credentials and the Appium target, either via a gitignored
`local.properties` (copy [`local.properties.example`](./local.properties.example)
→ `local.properties`) or inline:

```bash
export FURAN_API_URL=http://localhost:3000
export FURAN_API_TOKEN=<your token>
export FURAN_PROJECT_ID=<project id>
export APPIUM_SERVER_URL=http://localhost:4723
export APPIUM_APP_PACKAGE=com.example.app
export APPIUM_APP_ACTIVITY=com.example.app.MainActivity
gradle test
```

Without `FURAN_API_URL` the test is skipped — the intended behavior in CI for
the example itself.
