import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.KotlinJvm
import com.vanniktech.maven.publish.SonatypeHost

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.vanniktech.mavenPublish)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

dependencies {
    api(libs.ktor.client.core)
    api(libs.ktor.client.cio)
    api(libs.ktor.client.content.negotiation)
    api(libs.ktor.client.logging)
    api(libs.ktor.serialization.kotlinx.json)
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    implementation(libs.slf4j.simple)
    implementation(libs.snakeyaml)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // FullyStitchTest.captureFullyPage truncates at 200 MP cap allocates a
    // 2000x100_000 composed image (~800 MB); raise heap so the JVM worker
    // can handle it (mirrors the same setting in selenium/build.gradle.kts).
    maxHeapSize = "1g"
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}

mavenPublishing {
    // Targets the Sonatype Central Portal (the post-OSSRH endpoint).
    // Sources/javadoc jars + POM validation are handled by the plugin.
    //
    // automaticRelease = true: tag push → publish.yml → auto-released to
    // Maven Central with no human-in-the-loop. Maven Central is IMMUTABLE,
    // so trust the CI gate (sdk-build-and-example-compile must be green) +
    // the release-please Release-PR review step. To revert to the manual
    // Portal-click gate, flip to false here and in selenium/build.gradle.kts.
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = true)

    // Sign only when signing keys are present (CI). publishToMavenLocal dry-runs
    // run without signing — see docs/runbooks/maven-central-publish.md "Dry-run".
    if (project.hasProperty("signingInMemoryKey") ||
        System.getenv("ORG_GRADLE_PROJECT_signingInMemoryKey") != null) {
        signAllPublications()
    }

    // KotlinJvm component with Javadoc jar (empty placeholder is fine — kotlin doesn't produce
    // javadoc by default; the empty jar satisfies the Central Portal requirement).
    configure(KotlinJvm(javadocJar = JavadocJar.Empty(), sourcesJar = true))

    coordinates("io.github.qasecret", "furan-core", project.version.toString())

    pom {
        name.set("Furan SDK — Core")
        description.set("Core HTTP client, batching, retry, and DTOs for Furan visual regression testing")
        url.set("https://github.com/qasecret/furan-monorepo")
        licenses {
            license {
                name.set("Apache License, Version 2.0")
                url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("qasecret")
                name.set("Furan Maintainers")
                url.set("https://github.com/qasecret")
            }
        }
        scm {
            connection.set("scm:git:git://github.com/qasecret/furan-monorepo.git")
            developerConnection.set("scm:git:ssh://github.com:qasecret/furan-monorepo.git")
            url.set("https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin")
        }
    }
}
