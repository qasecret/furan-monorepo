plugins { id("org.jetbrains.kotlin.jvm") version "2.0.21" }
java { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }
repositories { mavenCentral(); mavenLocal() }
dependencies {
    testImplementation("io.github.qasecret:furan-selenium:0.5.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test { useJUnitPlatform() }
