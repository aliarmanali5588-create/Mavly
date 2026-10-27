/**
 * ═══ ANDROID CAPABILITY ═════════════════════════════════════════════════════
 *
 * What this deployment can and cannot do with an Android project. It is a
 * truthful answer, not a feature flag: isolated debug builds are OFF until the
 * operator enables the cohort, supplies a digest-pinned Vercel Container
 * Registry image, applies migration 26 and configures a private artifact
 * bucket. When any prerequisite is missing, no APK can be produced or downloaded
 * and the exact blocker is reported.
 *
 * Native Kotlin/Compose SOURCE generation is available through the existing
 * Groq pipeline. A saved source tree is not a build, an installable app, a
 * store submission or a verified device run.
 */

import { androidMainActivityPath, androidPackageForProject } from "./contract";
import { generationWorkerConfig } from "@/lib/generation/worker-config";

import {
  androidBuildConfig,
  androidBuildProblemMessage,
  isProjectInAndroidBuildCohort,
  type AndroidBuildConfig,
} from "./build-config";

export type AndroidBuildCapabilityStatus = "available" | "not_configured";

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
    available: boolean;
    status: AndroidBuildCapabilityStatus;
    reason: string;
    requirements: readonly string[];
  };
  artifact: {
    available: boolean;
    reason: string;
  };
  limits: {
    debugApk: boolean;
    releaseApk: false;
    aab: false;
    releaseSigning: false;
    googlePlayPublish: false;
    emulatorPreview: false;
  };
}

export const ANDROID_BUILD_REQUIREMENTS: readonly string[] = [
  "An operator-pinned Vercel Container Registry image digest containing JDK 17, Gradle 8.9, Android SDK 35 and aapt.",
  "Migration 26_android_builds.sql.",
  "A private artifact bucket with short-lived, owner-authorized downloads and retention cleanup.",
  "The generation worker enabled and scheduled; only its cohort projects may build.",
];

export function androidCapability(
  projectId?: string,
  config: AndroidBuildConfig = androidBuildConfig(),
): AndroidCapability {
  const applicationId = projectId ? androidPackageForProject(projectId) : null;
  const workerReady = generationWorkerConfig().ready;
  const buildAvailable = Boolean(
    projectId &&
      config.ready &&
      workerReady &&
      isProjectInAndroidBuildCohort(projectId, config),
  );
  const notConfiguredReason = !config.ready
    ? androidBuildProblemMessage(config.problems[0] ?? "disabled")
    : !workerReady
      ? "The durable generation worker is not enabled, so Android builds cannot be claimed."
      : projectId
        ? "This project is outside the Android build cohort."
        : "Android builds are cohort-scoped.";

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
      available: buildAvailable,
      status: buildAvailable ? "available" : "not_configured",
      reason: buildAvailable
        ? "Isolated Android debug builds are enabled for this project."
        : notConfiguredReason,
      requirements: buildAvailable ? [] : ANDROID_BUILD_REQUIREMENTS,
    },
    artifact: {
      available: buildAvailable,
      reason: buildAvailable
        ? "A verified debug APK can be stored privately and downloaded through a short-lived signed URL."
        : "No build can run until the Android build image, migration and private bucket are configured.",
    },
    limits: {
      debugApk: buildAvailable,
      releaseApk: false,
      aab: false,
      releaseSigning: false,
      googlePlayPublish: false,
      emulatorPreview: false,
    },
  };
}
