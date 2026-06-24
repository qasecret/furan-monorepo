import java.util.Properties

plugins { id("org.jetbrains.kotlin.jvm") version "2.0.21" }
java { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }
// mavenLocal() MUST come before mavenCentral() so the in-tree SDK published by
// the CI workflow's publish step wins over any Maven Central artifact.
repositories { mavenLocal(); mavenCentral() }
// Read packages/sdk-kotlin/version.txt at config time and pin the example to
// whatever the in-tree SDK currently publishes. release-please bumps
// version.txt; this file auto-tracks it.
val sdkVersion: String = file("../../version.txt").readText().trim()
dependencies {
    testImplementation("io.github.qasecret:furan-appium:$sdkVersion")
    testImplementation("io.appium:java-client:9.5.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Load local.properties (gitignored, real PAT + Appium caps) into the test
// task's environment so `FuranConfig.fromEnv()` and the APPIUM_* lookups
// resolve locally. Falls back silently when absent — the CI / fresh-clone path.
val localProps: Map<String, String> = run {
    val f = file("local.properties")
    if (!f.exists()) return@run emptyMap()
    val props = Properties()
    f.inputStream().use { props.load(it) }
    props.stringPropertyNames().associateWith { name -> props.getProperty(name) }
}

tasks.test {
    useJUnitPlatform()
    localProps.forEach { (k, v) -> environment(k, v) }
}
