import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.KotlinJvm
import com.vanniktech.maven.publish.SonatypeHost

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.vanniktech.mavenPublish)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

dependencies {
    // Depend on core, not selenium. The junit5 extension provides
    // FuranConfig + FuranClient via JUnit5 parameter resolution —
    // pure SDK ergonomics, no browser binding. Selenium consumers
    // pair the resolved config with their own driver.
    api(project(":core"))
    // junit5 API needs to be a compile-time dep so user test code
    // can reference @ExtendWith / ExtensionContext / etc. Same
    // version pinning the catalog uses everywhere else.
    api(libs.junit.jupiter)

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

mavenPublishing {
    // automaticRelease = true matches core/build.gradle.kts.
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = true)

    if (project.hasProperty("signingInMemoryKey") ||
        System.getenv("ORG_GRADLE_PROJECT_signingInMemoryKey") != null) {
        signAllPublications()
    }

    coordinates("io.github.qasecret", "furan-junit5", project.version.toString())

    configure(
        KotlinJvm(
            javadocJar = JavadocJar.Empty(),
            sourcesJar = true,
        ),
    )

    pom {
        name.set("Furan JUnit5")
        description.set("JUnit5 extension for the Furan visual-regression-testing SDK")
        inceptionYear.set("2026")
        url.set("https://github.com/qasecret/furan-monorepo")
        licenses {
            license {
                name.set("Apache License 2.0")
                url.set("https://www.apache.org/licenses/LICENSE-2.0")
            }
        }
        developers {
            developer {
                id.set("qasecret")
                name.set("qasecret")
                url.set("https://github.com/qasecret")
            }
        }
        scm {
            url.set("https://github.com/qasecret/furan-monorepo")
            connection.set("scm:git:git://github.com/qasecret/furan-monorepo.git")
            developerConnection.set("scm:git:ssh://git@github.com/qasecret/furan-monorepo.git")
        }
    }
}
