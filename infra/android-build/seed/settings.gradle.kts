// Mirrors the generated project shape from `src/lib/ai/agent.ts`.
// This file exists only to warm the offline Gradle cache at image build time.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mavly-android-seed"
include(":app")
