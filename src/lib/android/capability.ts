/**
 * ═══ ANDROID CAPABILITY ═════════════════════════════════════════════════════
 *
 * What this deployment can and cannot do with an Android project. It is a
 * static, truthful answer, not a feature flag: there is no build queue, no
 * pinned Android toolchain image and no artifact bucket in this build, so an
 * APK/AAB cannot be produced or downloaded.
 *
 * Native Kotlin/Compose SOURCE generation is available through the existing
 * Groq pipeline. A saved source tree is not a build, an installable app, a
 * store submission or a verified device run.
 */

import { androidMainActivityPath, androidPackageForProject } from "./contract";

export type AndroidBuildStatus = "not_configured";

export interface AndroidCapability {
  sourceGeneration: {
    available: true;
    provider: "groq";
    languages: readonly ["kotlin"];
    ui: readonly ["jetpack-compose"];
  };
  /** Read-only profile. The package is derived; it is not client-editable. */
  profile: {
    applicationId: string | null;
    mainActivityPath: string | null;
    compileSdk: 35;
    targetSdk: 35;
    minSdk: 26;
    toolchain: "Kotlin 2.0.21 / Jetpack Compose / Gradle 8.9 / JDK 17";
  };
  build: {
    available: false;
    status: AndroidBuildStatus;
    reason: string;
    requirements: readonly string[];
  };
  artifact: {
    available: false;
    reason: string;
  };
  limits: {
    debugApk: false;
    releaseApk: false;
    aab: false;
    releaseSigning: false;
    googlePlayPublish: false;
    emulatorPreview: false;
  };
}

export const ANDROID_BUILD_REASON =
  "No isolated Android build executor is configured: this deployment has no pinned Android toolchain image and no artifact storage. Source can be generated and downloaded, but no APK/AAB is built or served.";

export function androidCapability(projectId?: string): AndroidCapability {
  const applicationId = projectId ? androidPackageForProject(projectId) : null;
  return {
    sourceGeneration: {
      available: true,
      provider: "groq",
      languages: ["kotlin"],
      ui: ["jetpack-compose"],
    },
    profile: {
      applicationId,
      mainActivityPath: applicationId ? androidMainActivityPath(applicationId) : null,
      compileSdk: 35,
      targetSdk: 35,
      minSdk: 26,
      toolchain: "Kotlin 2.0.21 / Jetpack Compose / Gradle 8.9 / JDK 17",
    },
    build: {
      available: false,
      status: "not_configured",
      reason: ANDROID_BUILD_REASON,
      requirements: [
        "An operator-pinned Vercel Sandbox image digest containing JDK 17, Gradle 8.9 and Android SDK 35.",
        "A durable, fenced Android build queue advanced by the existing generation worker.",
        "A private artifact bucket with short-lived, owner-authorized downloads and retention cleanup.",
      ],
    },
    artifact: {
      available: false,
      reason: "No build runs, so no APK/AAB artifact exists to store, sign or serve.",
    },
    limits: {
      debugApk: false,
      releaseApk: false,
      aab: false,
      releaseSigning: false,
      googlePlayPublish: false,
      emulatorPreview: false,
    },
  };
}
