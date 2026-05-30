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
    api(project(":core"))
    api(libs.selenium.java)

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // 200 MP cap test allocates a 2000x100_000 composed image (~800 MB);
    // raise heap so the JVM worker can handle it.
    maxHeapSize = "1g"
    testLogging {
        events("passed", "failed", "skipped")
    }
}

mavenPublishing {
    // automaticRelease = true matches core/build.gradle.kts — see rationale there.
    publishToMavenCentral(SonatypeHost.CENTRAL_PORTAL, automaticRelease = true)

    if (project.hasProperty("signingInMemoryKey") ||
        System.getenv("ORG_GRADLE_PROJECT_signingInMemoryKey") != null) {
        signAllPublications()
    }

    configure(KotlinJvm(javadocJar = JavadocJar.Empty(), sourcesJar = true))

    coordinates("io.github.qasecret", "furan-selenium", project.version.toString())

    pom {
        name.set("Furan SDK — Selenium adapter")
        description.set("Selenium WebDriver adapter for Furan visual regression testing — exposes Furan(driver).snapshot(name)")
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
