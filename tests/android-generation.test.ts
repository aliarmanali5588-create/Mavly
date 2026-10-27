import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ANDROID_REQUIRED_PATHS,
  androidMainActivityPath,
  androidPackageForProject,
  androidPathRejection,
  validateAndroidProject,
  type AndroidSourceFile,
} from "../src/lib/android/contract";
import { androidCapability } from "../src/lib/android/capability";
import { classifyGenerationFailure } from "../src/lib/generation/state-machine";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const AGENT = read("src/lib/ai/agent.ts");
const RUN_AGENT = read("src/lib/mavly/run-agent.ts");
const API = read("src/lib/mavly/api.ts");

const PACKAGE = "com.mavly.demo";

const APP_GRADLE = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "${PACKAGE}"
    compileSdk = 35
    defaultConfig {
        applicationId = "${PACKAGE}"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.compose.material3:material3")
}
`;

const SETTINGS = `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "demo"
include(":app")
`;

const ROOT_GRADLE = `plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
`;

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${PACKAGE}">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="Demo">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

const MAIN_ACTIVITY = `package ${PACKAGE}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { }
    }
}
`;

function validProject(): AndroidSourceFile[] {
  return [
    { path: "settings.gradle.kts", content: SETTINGS },
    { path: "build.gradle.kts", content: ROOT_GRADLE },
    { path: "app/build.gradle.kts", content: APP_GRADLE },
    { path: "app/src/main/AndroidManifest.xml", content: MANIFEST },
    { path: androidMainActivityPath(PACKAGE), content: MAIN_ACTIVITY },
    { path: "README.md", content: "# Demo\n\nA small Android app." },
  ];
}

test("Android application ids are deterministic and path safe", () => {
  assert.equal(androidPackageForProject("my-app"), "com.mavly.myapp");
  assert.equal(androidPackageForProject("123"), "com.mavly.app123");
  assert.equal(androidMainActivityPath("com.mavly.myapp"), "app/src/main/java/com/mavly/myapp/MainActivity.kt");
});

test("Android profile accepts text source and refuses binaries, signing, secrets and build output", () => {
  assert.equal(androidPathRejection("app/src/main/java/com/mavly/demo/MainActivity.kt"), null);
  assert.equal(androidPathRejection("app/build.gradle.kts"), null);
  assert.equal(androidPathRejection(".gitignore"), null);

  for (const path of [
    "app/release/app-release.apk",
    "app/release/app-release.aab",
    "app/libs/library.jar",
    "app/src/main/res/drawable/icon.png",
    "keystore.jks",
    "app/release.keystore",
    "local.properties",
    ".env",
    ".env.local",
    "google-services.json",
    "app/build/outputs/apk/debug/app-debug.apk",
    ".gradle/cache.bin",
    "../outside.kt",
  ]) {
    assert.notEqual(androidPathRejection(path), null, path);
  }
});

test("a complete Kotlin/Compose project passes the contract", () => {
  const result = validateAndroidProject(validProject(), PACKAGE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.contract.packageName, PACKAGE);
    assert.equal(result.contract.applicationId, PACKAGE);
    assert.equal(result.contract.compileSdk, 35);
    assert.equal(result.contract.minSdk, 26);
    assert.equal(result.contract.targetSdk, 35);
  }
});

test("missing required files and a missing Compose entry point fail the contract", () => {
  const missing = validProject().filter(
    (file) =>
      file.path !== "app/src/main/AndroidManifest.xml" && file.path !== "README.md",
  );
  const result = validateAndroidProject(missing, PACKAGE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "GENERATION_CONTRACT_INVALID");
    assert.ok(result.violations.some((line) => line.includes("README.md")));
  }

  const noActivity = validProject().filter(
    (file) => file.path !== androidMainActivityPath(PACKAGE),
  );
  const activityResult = validateAndroidProject(noActivity, PACKAGE);
  assert.equal(activityResult.ok, false);
  if (!activityResult.ok) {
    assert.ok(activityResult.violations.some((line) => line.includes("MainActivity.kt")));
  }
});

test("package, namespace and applicationId must agree", () => {
  const mismatch = validProject().map((file) =>
    file.path === "app/build.gradle.kts"
      ? { ...file, content: file.content.replace(/namespace = "[^"]+"/, 'namespace = "com.example.demo"') }
      : file,
  );
  const result = validateAndroidProject(mismatch, PACKAGE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.violations.some((line) => line.includes("namespace")));
  }

  const otherPackage = validateAndroidProject(validProject(), "com.mavly.other");
  assert.equal(otherPackage.ok, false);
});

test("dangerous manifest settings, signing and unsafe Gradle features are refused", () => {
  const cleartext = validProject().map((file) =>
    file.path === "app/src/main/AndroidManifest.xml"
      ? { ...file, content: file.content.replace("<application", '<application android:usesCleartextTraffic="true"') }
      : file,
  );
  assert.equal(validateAndroidProject(cleartext, PACKAGE).ok, false);

  const sms = validProject().map((file) =>
    file.path === "app/src/main/AndroidManifest.xml"
      ? {
          ...file,
          content: file.content.replace(
            "<uses-permission",
            '<uses-permission android:name="android.permission.READ_SMS" />\n    <uses-permission',
          ),
        }
      : file,
  );
  assert.equal(validateAndroidProject(sms, PACKAGE).ok, false);

  const signing = validProject().map((file) =>
    file.path === "app/build.gradle.kts"
      ? {
          ...file,
          content: `${file.content}\nandroid { signingConfigs { create("release") { storeFile = file("x") } } }\n`,
        }
      : file,
  );
  assert.equal(validateAndroidProject(signing, PACKAGE).ok, false);

  const dynamic = validProject().map((file) =>
    file.path === "app/build.gradle.kts"
      ? {
          ...file,
          content: file.content.replace(
            'implementation("androidx.core:core-ktx:1.13.1")',
            'implementation("androidx.core:core-ktx:1.+")',
          ),
        }
      : file,
  );
  assert.equal(validateAndroidProject(dynamic, PACKAGE).ok, false);

  const customRepo = validProject().map((file) =>
    file.path === "settings.gradle.kts"
      ? {
          ...file,
          content: file.content.replace(
            "mavenCentral()",
            'mavenCentral()\n        maven { url = uri("https://evil.example/repo") }',
          ),
        }
      : file,
  );
  assert.equal(validateAndroidProject(customRepo, PACKAGE).ok, false);
});

test("binary content, credentials and oversized files are refused", () => {
  const binary = validProject().map((file) =>
    file.path === "README.md" ? { ...file, content: "bad\u0000content" } : file,
  );
  const binaryResult = validateAndroidProject(binary, PACKAGE);
  assert.equal(binaryResult.ok, false);

  const credential = validProject().map((file) =>
    file.path === "README.md"
      ? { ...file, content: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }
      : file,
  );
  assert.equal(validateAndroidProject(credential, PACKAGE).ok, false);

  const oversized = validProject().map((file) =>
    file.path === "README.md" ? { ...file, content: "x".repeat(300_000) } : file,
  );
  const oversizedResult = validateAndroidProject(oversized, PACKAGE);
  assert.equal(oversizedResult.ok, false);
  if (!oversizedResult.ok) assert.equal(oversizedResult.code, "GENERATION_TOO_LARGE");
});

test("an Android contract failure is terminal, not a provider retry", () => {
  const result = classifyGenerationFailure({
    code: "GENERATION_CONTRACT_INVALID",
    message: "The Android project failed its source contract.",
  });
  assert.equal(result.errorClass, "source_contract_invalid");
  assert.equal(result.retryable, false);
});

test("the generation agent selects the Android profile and re-validates the full source", () => {
  assert.match(AGENT, /ANDROID_SYSTEM_PROMPT/);
  assert.match(AGENT, /requiredCreatePathsFor/);
  assert.match(AGENT, /validateAndroidProject/);
  assert.match(AGENT, /projectType\?: AgentProjectType/);
  assert.match(AGENT, /if \(profile === "android"\) \{/);
  assert.match(AGENT, /GENERATION_CONTRACT_INVALID/);
  assert.match(AGENT, /androidPathRejection\(path\)/);
  assert.match(ANDROID_REQUIRED_PATHS.join("|"), /AndroidManifest\.xml/);
});

test("the run path uses the native profile and skips website verification for Android", () => {
  assert.match(RUN_AGENT, /androidPackageForProject\(input\.projectId\)/);
  assert.match(RUN_AGENT, /projectType,\s*\n\s*androidPackage,/);
  assert.match(RUN_AGENT, /if \(projectType === "website"\) \{/);
  assert.doesNotMatch(RUN_AGENT, /No website code was generated/);
});

test("Android builds are off by default and report an honest capability", () => {
  const capability = androidCapability();
  assert.equal(capability.sourceGeneration.available, true);
  assert.equal(capability.sourceGeneration.provider, "openrouter");
  assert.equal(capability.build.available, false);
  assert.equal(capability.build.status, "not_configured");
  assert.equal(capability.artifact.available, false);
  assert.equal(capability.limits.debugApk, false);
  assert.equal(capability.limits.aab, false);
  assert.equal(capability.limits.googlePlayPublish, false);
  assert.equal(
    androidCapability("demo-app").profile.applicationId,
    "com.mavly.demoapp",
  );

  assert.match(API, /androidBuildsResponse/);
  assert.match(API, /androidBuildStartResponse/);
  assert.match(API, /ANDROID_BUILD_NOT_CONFIGURED/);
  assert.doesNotMatch(API, /ANDROID_GENERATION_NOT_CONFIGURED/);
});
