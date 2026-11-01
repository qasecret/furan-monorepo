# Furan Kotlin SDK

Visual-regression testing client for [Furan](https://github.com/qasecret/furan-monorepo): capture screenshots from JUnit 5 + Selenium, Playwright or Appium tests and compare them against approved baselines.

```kotlin
// build.gradle.kts — pick the adapter for your driver
dependencies {
    testImplementation("io.github.qasecret:furan-selenium:4.2.0") // x-release-please-version
    testImplementation("io.github.qasecret:furan-playwright:4.2.0") // x-release-please-version
    testImplementation("io.github.qasecret:furan-appium:4.2.0") // x-release-please-version
    // Optional — the @FuranTest annotation:
    testImplementation("io.github.qasecret:furan-junit5:4.2.0") // x-release-please-version
}
```

The full guide (configuration, ignore regions, the JUnit 5 extension, every adapter) is in the documentation portal: [Kotlin SDK](https://qasecret.github.io/furan-monorepo/sdk/kotlin), also at `/docs/sdk/kotlin` on Furan installs newer than v1.1.32, with its source in [`docs/sdk/kotlin.mdx`](../../docs/sdk/kotlin.mdx). New to Furan? Start with [Getting started](https://qasecret.github.io/furan-monorepo/getting-started/install).

Runnable examples: [`examples/`](examples/). Changes: [`CHANGELOG.md`](CHANGELOG.md). License: Apache 2.0.
