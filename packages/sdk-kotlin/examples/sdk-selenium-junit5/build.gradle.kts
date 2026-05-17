plugins { id("org.jetbrains.kotlin.jvm") version "2.0.21" }
java { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }
// mavenLocal() MUST come before mavenCentral() so the in-tree SDK published by
// the CI workflow's "Publish SDK locally" step wins over the published Maven
// Central artifact. Without this ordering, Gradle would resolve the central
// 0.6.0 artifact (which still has the JSON-null bug) and our local
// publishToMavenLocal would be a no-op against the build cache.
repositories { mavenLocal(); mavenCentral() }
dependencies {
    // Keep in lockstep with packages/sdk-kotlin/version.txt — release-please
    // bumps that file but does NOT update this pin, so each version bump that
    // adds new SDK behavior needed by the example must bump this line too.
    testImplementation("io.github.qasecret:furan-selenium:0.6.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test { useJUnitPlatform() }
