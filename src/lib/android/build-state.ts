/**
 * ═══ ANDROID BUILD STATE ════════════════════════════════════════════════════
 *
 * One vocabulary for the migration, worker, API and workspace. A build is
 * `succeeded` only after the fenced completion received verified artifact
 * metadata. `artifact` is present only while a real object is available and
 * unexpired.
 */

export type AndroidBuildStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "configuration_error"
  | "infrastructure_error";

export type AndroidBuildStage =
  | "queued"
  | "preparing"
  | "uploading"
  | "building"
  | "validating_artifact"
  | "uploading_artifact"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "configuration_error"
  | "infrastructure_error";

export type AndroidArtifactState =
  | "none"
  | "available"
  | "expiring"
  | "expired"
  | "delete_failed"
  | "failed";

export const ANDROID_BUILD_TERMINAL_STATUSES: readonly AndroidBuildStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "configuration_error",
  "infrastructure_error",
];

export function isAndroidBuildTerminal(status: AndroidBuildStatus): boolean {
  return ANDROID_BUILD_TERMINAL_STATUSES.includes(status);
}

export type AndroidBuildErrorClass =
  | "source_invalid"
  | "snapshot_mismatch"
  | "build_failed"
  | "artifact_missing"
  | "artifact_invalid"
  | "artifact_package_mismatch"
  | "artifact_storage_failed"
  | "sandbox_create_failed"
  | "sandbox_not_found"
  | "upload_failed"
  | "timeout"
  | "cancelled"
  | "configuration_error"
  | "provider_error"
  | "cleanup_failed"
  | "internal_error";

export interface AndroidBuildArtifact {
  type: "apk";
  fileName: string;
  sizeBytes: number;
  sha256: string;
  applicationId: string;
  expiresAt: string;
}

export interface AndroidBuildView {
  id: string;
  projectId: string;
  status: AndroidBuildStatus;
  stage: AndroidBuildStage;
  attempt: number;
  maxAttempts: number;
  toolchain: string;
  variant: "debug";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stageStartedAt: string | null;
  deadlineAt: string | null;
  cancelRequestedAt: string | null;
  cleanupComplete: boolean;
  artifactState: AndroidArtifactState;
  artifact: AndroidBuildArtifact | null;
  error: { code: string; message: string; logExcerpt?: string } | null;
  logExcerpt: string | null;
  logTruncated: boolean;
  hasLog: boolean;
}

export interface AndroidBuildRecord {
  id: string;
  project_id: string;
  user_id: string;
  snapshot_id: string;
  source_hash: string;
  status: AndroidBuildStatus;
  stage: AndroidBuildStage;
  attempt: number;
  max_attempts: number;
  toolchain: string;
  build_variant: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  worker_id: string | null;
  sandbox_id: string | null;
  deadline_at: string | null;
  next_attempt_at: string | null;
  stage_started_at: string | null;
  cleanup_complete: boolean;
  cleanup_claimed_at: string | null;
  cleanup_token: string | null;
  artifact_state: AndroidArtifactState;
  artifact_bucket: string | null;
  artifact_path: string | null;
  artifact_file_name: string | null;
  artifact_content_type: string | null;
  artifact_size_bytes: number | null;
  artifact_sha256: string | null;
  application_id: string | null;
  package_name: string | null;
  artifact_expires_at: string | null;
  diagnostics: unknown;
  log_excerpt: string | null;
  log_truncated: boolean;
  error_class: string | null;
  error_summary: string | null;
  cancel_requested_at: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AndroidArtifactClaim {
  buildId: string;
  projectId: string;
  bucket: string;
  path: string;
}

export interface AndroidCleanupClaim {
  buildId: string;
  projectId: string;
  sandboxId: string;
  cleanupToken: string;
}

export function normalizeAndroidBuildStatus(value: unknown): AndroidBuildStatus {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "timed_out":
    case "configuration_error":
    case "infrastructure_error":
      return value;
    default:
      return "infrastructure_error";
  }
}

export function normalizeAndroidBuildStage(value: unknown): AndroidBuildStage {
  switch (value) {
    case "queued":
    case "preparing":
    case "uploading":
    case "building":
    case "validating_artifact":
    case "uploading_artifact":
    case "finalizing":
    case "succeeded":
    case "failed":
    case "cancelled":
    case "timed_out":
    case "configuration_error":
    case "infrastructure_error":
      return value;
    default:
      return "failed";
  }
}

export function normalizeAndroidArtifactState(value: unknown): AndroidArtifactState {
  switch (value) {
    case "none":
    case "available":
    case "expiring":
    case "expired":
    case "delete_failed":
    case "failed":
      return value;
    default:
      return "none";
  }
}

function artifactOf(record: AndroidBuildRecord, nowMs: number): AndroidBuildArtifact | null {
  if (record.artifact_state !== "available") return null;
  if (!record.artifact_file_name || !record.artifact_sha256) return null;
  if (!record.artifact_expires_at) return null;
  const expires = Date.parse(record.artifact_expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) return null;
  const size = Number(record.artifact_size_bytes ?? 0);
  if (!Number.isFinite(size) || size <= 0) return null;
  return {
    type: "apk",
    fileName: record.artifact_file_name,
    sizeBytes: size,
    sha256: record.artifact_sha256,
    applicationId: record.application_id ?? "",
    expiresAt: record.artifact_expires_at,
  };
}

export function toAndroidBuildView(
  record: AndroidBuildRecord,
  nowMs: number = Date.now(),
): AndroidBuildView {
  const status = normalizeAndroidBuildStatus(record.status);
  const stage = normalizeAndroidBuildStage(record.stage);
  const artifactState = effectiveArtifactState(record, nowMs);
  const artifact = artifactOf(record, nowMs);
  const log = record.log_excerpt ? String(record.log_excerpt).slice(0, 32768) : null;
  return {
    id: record.id,
    projectId: record.project_id,
    status,
    stage,
    attempt: Number(record.attempt ?? 0),
    maxAttempts: Number(record.max_attempts ?? 0),
    toolchain: record.toolchain,
    variant: "debug",
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    stageStartedAt: record.stage_started_at,
    deadlineAt: record.deadline_at,
    cancelRequestedAt: record.cancel_requested_at,
    cleanupComplete: Boolean(record.cleanup_complete),
    artifactState,
    artifact,
    error:
      record.error_class || record.error_summary
        ? {
            code: record.error_class ?? "internal_error",
            message: record.error_summary ?? "The Android build failed.",
            ...(log ? { logExcerpt: log } : {}),
          }
        : null,
    logExcerpt: log,
    logTruncated: Boolean(record.log_truncated),
    hasLog: Boolean(log),
  };
}

/** The effective artifact state a reader should see, accounting for time. */
export function effectiveArtifactState(
  record: AndroidBuildRecord,
  nowMs: number = Date.now(),
): AndroidArtifactState {
  const state = normalizeAndroidArtifactState(record.artifact_state);
  if (state !== "available") return state;
  if (!record.artifact_expires_at) return "expired";
  const expires = Date.parse(record.artifact_expires_at);
  return Number.isFinite(expires) && expires > nowMs ? "available" : "expired";
}
