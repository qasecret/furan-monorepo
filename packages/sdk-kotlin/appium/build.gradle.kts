import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.KotlinJvm
import com.vanniktech.maven.publish.SourcesJar

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.vanniktech.mavenPublish)
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

dependencies {
    api(project(":core"))
    api(libs.appium.java.client)
    // java-client 11 brings only selenium-api. The BOM lines up the consumer's
    // other Selenium modules (furan-selenium's selenium-java, or their own) with
    // it, so a project using this adapter never mixes Selenium versions.
    api(platform(libs.selenium.bom))

    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockito.kotlin)
    testRuntimeOnly(libs.junit.platform.launcher)

    constraints {
        // Build-only guard (test configurations are not published): when
        // java-client's selenium-api range no longer admits the catalog's
        // `selenium`, resolution fails here instead of shipping a mixed Selenium
        // that compiles but breaks at runtime. Raise both together. Not
        // `strictly`: a direct strict version would override java-client's
        // range and pass silently.
        val selenium = libs.versions.selenium.get()
        testImplementation("org.seleniumhq.selenium:selenium-api") {
            version {
                require(selenium)
                reject("($selenium,)")
            }
            because("furan-appium and furan-selenium must resolve one Selenium version")
        }
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped") }
}

mavenPublishing {
    publishToMavenCentral(automaticRelease = true)
    if (project.hasProperty("signingInMemoryKey") ||
        System.getenv("ORG_GRADLE_PROJECT_signingInMemoryKey") != null) {
        signAllPublications()
    }
    configure(KotlinJvm(javadocJar = JavadocJar.Empty(), sourcesJar = SourcesJar.Sources()))
    coordinates("io.github.qasecret", "furan-appium", project.version.toString())
    pom {
        name.set("Furan SDK — Appium adapter")
        description.set("Appium (java-client) adapter for Furan visual regression testing — native mobile screenshots via FuranAppium(config, driver).snapshot(name)")
        url.set("https://github.com/qasecret/furan-monorepo")
        licenses { license {
            name.set("Apache License, Version 2.0")
            url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
            distribution.set("repo")
        } }
        developers { developer { id.set("qasecret"); name.set("Furan Maintainers"); url.set("https://github.com/qasecret") } }
        scm {
            connection.set("scm:git:git://github.com/qasecret/furan-monorepo.git")
            developerConnection.set("scm:git:ssh://github.com:qasecret/furan-monorepo.git")
            url.set("https://github.com/qasecret/furan-monorepo/tree/main/packages/sdk-kotlin")
        }
    }
}
