/**
 * ═══ ANDROID BUILD CONFIGURATION ════════════════════════════════════════════
 *
 * Android builds are OFF unless every prerequisite is present:
 *
 *   MAVLY_ANDROID_BUILD_ENABLED        1 / true / yes / on
 *   MAVLY_ANDROID_BUILD_PROJECTS       explicit cohort, never '*' or empty
 *   MAVLY_ANDROID_BUILD_IMAGE          Vercel Container Registry image pinned by
 *                                      @sha256 digest (the provider accepts no
 *                                      arbitrary external registry)
 *   MAVLY_ANDROID_ARTIFACT_BUCKET      private bucket (default android-artifacts)
 *   VERCEL_OIDC_TOKEN                  or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID
 *   SUPABASE_SERVICE_ROLE_KEY          worker/artifact writes only
 *   NEXT_PUBLIC_SUPABASE_URL
 *
 * ⚠️ A TAG IS NOT A PIN. The image must carry an immutable digest, because the
 * toolchain is part of the build provenance. A tag-only image is not ready.
 *
 * ⚠️ NO LOCAL FALLBACK. A missing prerequisite is reported as not ready and the
 * API fails closed; nothing is built on a Mavly host.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { SERVICE_ROLE_ENV, SUPABASE_URL_ENV } from "@/lib/generation/worker-config";
import {
  VERCEL_OIDC_TOKEN_ENV,
  VERCEL_PROJECT_ID_ENV,
  VERCEL_TEAM_ID_ENV,
  VERCEL_TOKEN_ENV,
} from "@/lib/sandbox/config";

export const ANDROID_BUILD_ENABLED_ENV = "MAVLY_ANDROID_BUILD_ENABLED";
export const ANDROID_BUILD_PROJECTS_ENV = "MAVLY_ANDROID_BUILD_PROJECTS";
export const ANDROID_BUILD_IMAGE_ENV = "MAVLY_ANDROID_BUILD_IMAGE";
export const ANDROID_ARTIFACT_BUCKET_ENV = "MAVLY_ANDROID_ARTIFACT_BUCKET";
export const ANDROID_BUILD_VCPUS_ENV = "MAVLY_ANDROID_BUILD_VCPUS";

export const ANDROID_BUILD_SCHEMA_VERSION = 26;
export const ANDROID_BUILD_TOOLCHAIN =
  "android-debug-v1|jdk17|gradle8.9|agp8.7.3|kotlin2.0.21|sdk35";
export const ANDROID_BUILD_VARIANT = "debug";
export const ANDROID_DEFAULT_ARTIFACT_BUCKET = "android-artifacts";

export const ANDROID_BUILD_DEADLINE_MS = 22 * 60 * 1000;
export const ANDROID_BUILD_SESSION_TIMEOUT_MS = 24 * 60 * 1000;
export const ANDROID_BUILD_STAGE_TIMEOUT_MS = 16 * 60 * 1000;
export const ANDROID_ARTIFACT_UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;
export const ANDROID_ARTIFACT_RETENTION_DAYS = 7;
export const ANDROID_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
export const ANDROID_DEFAULT_VCPUS = 2;
export const ANDROID_MAX_VCPUS = 4;
export const ANDROID_MAX_COHORT = 500;

export type AndroidBuildConfigProblem =
  | "disabled"
  | "missing_cohort"
  | "invalid_cohort"
  | "missing_image"
  | "image_not_pinned"
  | "invalid_bucket"
  | "invalid_vcpus"
  | "missing_credentials"
  | "missing_service_role"
  | "missing_supabase_url";

interface ProviderCredentials {
  oidcToken: string | null;
  token: string | null;
  teamId: string | null;
  projectId: string | null;
}

export interface AndroidBuildConfig {
  requested: boolean;
  ready: boolean;
  provider: "vercel" | null;
  cohort: string[];
  image: string | null;
  artifactBucket: string;
  vcpus: number;
  toolchain: string;
  variant: "debug";
  problems: AndroidBuildConfigProblem[];
  /** Server-only. Never serialize or log this field. */
  credentials: ProviderCredentials;
}

export type AndroidBuildEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  const entries = raw
    .split(/[,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique: string[] = [];
  for (const entry of entries) {
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, ANDROID_MAX_COHORT);
}

function isPinnedImage(value: string): boolean {
  return /^[^\s@]+@sha256:[a-f0-9]{64}$/i.test(value);
}

export function parseAndroidBuildConfig(env: AndroidBuildEnvironment): AndroidBuildConfig {
  const requested = isOn(env[ANDROID_BUILD_ENABLED_ENV]);
  const cohort = splitCohort(env[ANDROID_BUILD_PROJECTS_ENV] ?? "");
  const image = env[ANDROID_BUILD_IMAGE_ENV]?.trim() || null;
  const artifactBucket =
    env[ANDROID_ARTIFACT_BUCKET_ENV]?.trim() || ANDROID_DEFAULT_ARTIFACT_BUCKET;
  const rawVcpus = env[ANDROID_BUILD_VCPUS_ENV]?.trim();
  const parsedVcpus = rawVcpus ? Number.parseInt(rawVcpus, 10) : ANDROID_DEFAULT_VCPUS;
  const vcpus =
    Number.isFinite(parsedVcpus) && parsedVcpus >= 1 && parsedVcpus <= ANDROID_MAX_VCPUS
      ? parsedVcpus
      : ANDROID_DEFAULT_VCPUS;

  const problems: AndroidBuildConfigProblem[] = [];
  if (!requested) problems.push("disabled");
  if (cohort.length === 0) problems.push("missing_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }
  if (!image) problems.push("missing_image");
  else if (!isPinnedImage(image)) problems.push("image_not_pinned");
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(artifactBucket)) {
    problems.push("invalid_bucket");
  }
  if (rawVcpus && (!Number.isFinite(parsedVcpus) || parsedVcpus < 1 || parsedVcpus > ANDROID_MAX_VCPUS)) {
    problems.push("invalid_vcpus");
  }

  const credentials: ProviderCredentials = {
    oidcToken: env[VERCEL_OIDC_TOKEN_ENV]?.trim() || null,
    token: env[VERCEL_TOKEN_ENV]?.trim() || null,
    teamId: env[VERCEL_TEAM_ID_ENV]?.trim() || null,
    projectId: env[VERCEL_PROJECT_ID_ENV]?.trim() || null,
  };
  const hasAccessToken = Boolean(
    credentials.token && credentials.teamId && credentials.projectId,
  );
  if (!credentials.oidcToken && !hasAccessToken) problems.push("missing_credentials");

  if (!env[SERVICE_ROLE_ENV]?.trim()) problems.push("missing_service_role");
  if (!env[SUPABASE_URL_ENV]?.trim()) problems.push("missing_supabase_url");

  return {
    requested,
    ready: problems.length === 0,
    provider: requested ? "vercel" : null,
    cohort,
    image,
    artifactBucket,
    vcpus,
    toolchain: ANDROID_BUILD_TOOLCHAIN,
    variant: "debug",
    problems,
    credentials,
  };
}

export function androidBuildConfig(): AndroidBuildConfig {
  return parseAndroidBuildConfig(process.env);
}

export function isProjectInAndroidBuildCohort(
  projectId: string,
  config: AndroidBuildConfig = androidBuildConfig(),
): boolean {
  return config.ready && config.cohort.includes(projectId.toLowerCase());
}

export function androidBuildProblemMessage(problem: AndroidBuildConfigProblem): string {
  switch (problem) {
    case "disabled":
      return "Android build execution is disabled in this deployment.";
    case "missing_cohort":
      return "MAVLY_ANDROID_BUILD_PROJECTS is empty; builds are cohort-scoped.";
    case "invalid_cohort":
      return "MAVLY_ANDROID_BUILD_PROJECTS contains an invalid project id.";
    case "missing_image":
      return "MAVLY_ANDROID_BUILD_IMAGE is not configured.";
    case "image_not_pinned":
      return "The Android build image must be a Vercel Container Registry image pinned by an immutable @sha256 digest.";
    case "invalid_bucket":
      return "MAVLY_ANDROID_ARTIFACT_BUCKET is not a valid private bucket name.";
    case "invalid_vcpus":
      return `MAVLY_ANDROID_BUILD_VCPUS must be between 1 and ${ANDROID_MAX_VCPUS}.`;
    case "missing_credentials":
      return "Vercel Sandbox credentials are not configured.";
    case "missing_service_role":
      return "SUPABASE_SERVICE_ROLE_KEY is not configured for the build worker.";
    case "missing_supabase_url":
      return "NEXT_PUBLIC_SUPABASE_URL is not configured.";
    default:
      return "Android build execution is not configured.";
  }
}
