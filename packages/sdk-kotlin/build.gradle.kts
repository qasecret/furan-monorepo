plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.vanniktech.mavenPublish) apply false
}

// Single source of truth for the SDK version: packages/sdk-kotlin/version.txt.
// The file holds `<version> # x-release-please-version` — the trailing comment
// is the marker release-please's generic updater looks for to know where to
// bump. We strip everything after the `#` so Gradle gets just the version.
//
// (Why not gradle.properties? The `#` marker becomes part of the value in
// Java .properties syntax — `#` is only a line-start comment marker there.
// version.txt sidesteps that.)
val sdkVersion = file("version.txt").readText().substringBefore("#").trim()
allprojects {
    version = sdkVersion
}
