plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
    signing
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
    // Sources + javadoc jars are required by Maven Central.
    withSourcesJar()
    withJavadocJar()
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

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            groupId = "io.furan"
            artifactId = "sdk-core"
            // version inherited from gradle.properties (0.5.0)

            pom {
                name.set("Furan SDK — Core")
                description.set("Core HTTP client, batching, retry, and DTOs for Furan visual regression testing")
                url.set("https://github.com/qasecret/furan-monorepo")
                licenses {
                    license {
                        name.set("Apache License, Version 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                    }
                }
                developers {
                    developer {
                        id.set("furan-team")
                        name.set("Furan Maintainers")
                        email.set("maintainers@furan.dev")
                    }
                }
                scm {
                    connection.set("scm:git:git://github.com/qasecret/furan-monorepo.git")
                    developerConnection.set("scm:git:ssh://github.com:qasecret/furan-monorepo.git")
                    url.set("https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin")
                }
            }
        }
    }
    repositories {
        // mavenLocal is auto-available via the publishToMavenLocal task — no repo declaration needed.
        //
        // For Maven Central we point at the Central Portal upload API. Native Gradle support
        // for the new Central Portal is still maturing (the official central-publishing-maven-plugin
        // is a Maven, not Gradle, plugin). We wire the raw upload URL here so `./gradlew :core:publish`
        // can authenticate and upload; if the Portal proves flaky for direct repo uploads,
        // .github/workflows/release.yml can fall back to a curl-driven upload step.
        // See docs/runbooks/maven-central-publish.md for the full release flow.
        maven {
            name = "centralPortal"
            url = uri("https://central.sonatype.com/api/v1/publisher/upload")
            credentials {
                username = System.getenv("MAVEN_CENTRAL_USERNAME")
                password = System.getenv("MAVEN_CENTRAL_PASSWORD")
            }
        }
    }
}

signing {
    val signingKey = System.getenv("SIGNING_KEY")
    val signingPassword = System.getenv("SIGNING_PASSWORD")
    if (signingKey != null && signingPassword != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["maven"])
    }
}
