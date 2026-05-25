plugins { id("org.jetbrains.kotlin.jvm") version "2.0.21" }
java { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }
// mavenLocal() MUST come before mavenCentral() so the in-tree SDK published by
// the CI workflow's "Publish SDK locally" step wins over the published Maven
// Central artifact. Without this ordering, Gradle would resolve the central
// 0.6.0 artifact (which still has the JSON-null bug) and our local
// publishToMavenLocal would be a no-op against the build cache.
repositories { mavenLocal(); mavenCentral() }
// Read packages/sdk-kotlin/version.txt at config time and pin the example
// to whatever the in-tree SDK currently publishes. Avoids the recurring
// "I added a new SDK type but the example still uses last release's
// version and CI fails on Unresolved reference" foot-gun (verified
// 2026-05-25 after PR #128 hit it). release-please bumps version.txt;
// this file now auto-tracks.
val sdkVersion: String = file("../../version.txt").readText().trim()
dependencies {
    testImplementation("io.github.qasecret:furan-selenium:$sdkVersion")
    testImplementation("io.github.qasecret:furan-junit5:$sdkVersion")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test { useJUnitPlatform() }
