plugins {
    alias(libs.plugins.kotlin.jvm)
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
    api(project(":core"))
    api(libs.selenium.java)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            groupId = "io.furan"
            artifactId = "sdk-selenium"
            // version inherited from gradle.properties (0.5.0)

            pom {
                name.set("Furan SDK — Selenium adapter")
                description.set("Selenium WebDriver adapter for Furan visual regression testing — exposes Furan(driver).snapshot(name)")
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
        // See core/build.gradle.kts for the rationale on the centralPortal URL.
        // docs/runbooks/maven-central-publish.md documents the full release flow.
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
