rootProject.name = "furan-sdk-kotlin"

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
    // Version catalog auto-imported from gradle/libs.versions.toml
}

include("core", "selenium", "junit5")
