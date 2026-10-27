/**
 * ═══ ANDROID BUILD STORE ════════════════════════════════════════════════════
 *
 * Typed wrappers around migration 26. User-facing reads use the caller's
 * RLS-scoped client and never request the service-only columns (bucket, object
 * path, sandbox id, lease). Worker calls use the confined service client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeAndroidArtifactState,
  normalizeAndroidBuildStage,
  normalizeAndroidBuildStatus,
  type AndroidArtifactClaim,
  type AndroidArtifactState,
  type AndroidBuildRecord,
  type AndroidBuildStatus,
  type AndroidBuildView,
  type AndroidCleanupClaim,
  toAndroidBuildView,
} from "./build-state";
import { ANDROID_BUILD_SCHEMA_VERSION } from "./build-config";

export type AndroidBuildStoreCode =
  | "MIGRATION_REQUIRED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE"
  | "UNKNOWN";

export type AndroidBuildStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: AndroidBuildStoreCode };

export function isAndroidBuildStoreFailure<T>(
  result: AndroidBuildStoreResult<T>,
): result is { ok: false; error: string; code: AndroidBuildStoreCode } {
  return result.ok === false;
}

function failure(
  code: AndroidBuildStoreCode,
  error: string,
): { ok: false; code: AndroidBuildStoreCode; error: string } {
  return { ok: false, code, error };
}

function rpcFailure(error: { message?: string; code?: string } | null): AndroidBuildStoreResult<never> {
  const message = error?.message ?? "Android build store failed";
  if (/does not exist|Could not find the function|PGRST202|42883/i.test(message)) {
    return failure(
      "MIGRATION_REQUIRED",
      "Android builds need migration 26_android_builds.sql.",
    );
  }
  if (/UNAUTHENTICATED|28000/i.test(message)) {
    return failure("UNAUTHENTICATED", "You must be signed in to do that.");
  }
  if (/FORBIDDEN|42501/i.test(message)) {
    return failure("FORBIDDEN", "You don't have access to this project.");
  }
  if (/not_found|P0002/i.test(message)) {
    return failure("NOT_FOUND", "That build or snapshot was not found.");
  }
  if (/SNAPSHOT_MISMATCH|INVALID_|NOT_ANDROID_PROJECT|22023/i.test(message)) {
    return failure("CONFLICT", "The Android build input is not valid.");
  }
  return failure("UNKNOWN", "The Android build store is unavailable.");
}

const PUBLIC_COLUMNS = [
  "id",
  "project_id",
  "snapshot_id",
  "source_hash",
  "status",
  "stage",
  "attempt",
  "max_attempts",
  "toolchain",
  "build_variant",
  "deadline_at",
  "next_attempt_at",
  "stage_started_at",
  "cleanup_complete",
  "artifact_state",
  "artifact_file_name",
  "artifact_content_type",
  "artifact_size_bytes",
  "artifact_sha256",
  "application_id",
  "package_name",
  "artifact_expires_at",
  "diagnostics",
  "log_excerpt",
  "log_truncated",
  "error_class",
  "error_summary",
  "cancel_requested_at",
  "correlation_id",
  "created_at",
  "started_at",
  "finished_at",
  "updated_at",
].join(",");

function normalizeRecord(value: unknown): AndroidBuildRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.project_id !== "string") return null;
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: typeof row.user_id === "string" ? row.user_id : "",
    snapshot_id: typeof row.snapshot_id === "string" ? row.snapshot_id : "",
    source_hash: typeof row.source_hash === "string" ? row.source_hash : "",
    status: normalizeAndroidBuildStatus(row.status),
    stage: normalizeAndroidBuildStage(row.stage),
    attempt: Number(row.attempt ?? 0),
    max_attempts: Number(row.max_attempts ?? 0),
    toolchain: typeof row.toolchain === "string" ? row.toolchain : "",
    build_variant: typeof row.build_variant === "string" ? row.build_variant : "debug",
    lease_token: typeof row.lease_token === "string" ? row.lease_token : null,
    lease_expires_at: typeof row.lease_expires_at === "string" ? row.lease_expires_at : null,
    worker_id: typeof row.worker_id === "string" ? row.worker_id : null,
    sandbox_id: typeof row.sandbox_id === "string" ? row.sandbox_id : null,
    deadline_at: typeof row.deadline_at === "string" ? row.deadline_at : null,
    next_attempt_at: typeof row.next_attempt_at === "string" ? row.next_attempt_at : null,
    stage_started_at: typeof row.stage_started_at === "string" ? row.stage_started_at : null,
    cleanup_complete: Boolean(row.cleanup_complete),
    cleanup_claimed_at:
      typeof row.cleanup_claimed_at === "string" ? row.cleanup_claimed_at : null,
    cleanup_token: typeof row.cleanup_token === "string" ? row.cleanup_token : null,
    artifact_state: normalizeAndroidArtifactState(row.artifact_state),
    artifact_bucket: typeof row.artifact_bucket === "string" ? row.artifact_bucket : null,
    artifact_path: typeof row.artifact_path === "string" ? row.artifact_path : null,
    artifact_file_name:
      typeof row.artifact_file_name === "string" ? row.artifact_file_name : null,
    artifact_content_type:
      typeof row.artifact_content_type === "string" ? row.artifact_content_type : null,
    artifact_size_bytes:
      typeof row.artifact_size_bytes === "number"
        ? row.artifact_size_bytes
        : typeof row.artifact_size_bytes === "string"
          ? Number(row.artifact_size_bytes)
          : null,
    artifact_sha256:
      typeof row.artifact_sha256 === "string" ? row.artifact_sha256 : null,
    application_id: typeof row.application_id === "string" ? row.application_id : null,
    package_name: typeof row.package_name === "string" ? row.package_name : null,
    artifact_expires_at:
      typeof row.artifact_expires_at === "string" ? row.artifact_expires_at : null,
    diagnostics: row.diagnostics ?? [],
    log_excerpt: typeof row.log_excerpt === "string" ? row.log_excerpt : null,
    log_truncated: Boolean(row.log_truncated),
    error_class: typeof row.error_class === "string" ? row.error_class : null,
    error_summary: typeof row.error_summary === "string" ? row.error_summary : null,
    cancel_requested_at:
      typeof row.cancel_requested_at === "string" ? row.cancel_requested_at : null,
    correlation_id: typeof row.correlation_id === "string" ? row.correlation_id : null,
    idempotency_key: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    started_at: typeof row.started_at === "string" ? row.started_at : null,
    finished_at: typeof row.finished_at === "string" ? row.finished_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function androidBuildSchemaVersion(
  client: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await client.rpc("android_build_schema_version");
  if (error || typeof data !== "number") return null;
  return data >= ANDROID_BUILD_SCHEMA_VERSION ? data : null;
}

export interface CreateAndroidBuildInput {
  projectId: string;
  snapshotId: string;
  sourceHash: string;
  toolchain: string;
  idempotencyKey?: string | null;
}

export type CreateAndroidBuildOutcome =
  | {
      status: "created" | "existing";
      build: AndroidBuildView;
    }
  | { status: "rate_limited"; scope: "project" | "user" | "global"; retryAfterSeconds: number };

export async function createAndroidBuild(
  client: SupabaseClient,
  input: CreateAndroidBuildInput,
): Promise<AndroidBuildStoreResult<CreateAndroidBuildOutcome>> {
  const { data, error } = await client.rpc("create_android_build", {
    p_project_id: input.projectId,
    p_snapshot_id: input.snapshotId,
    p_source_hash: input.sourceHash,
    p_toolchain: input.toolchain,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) return rpcFailure(error);
  const result = jsonRecord(data);
  const status = result.status;
  if (status === "created" || status === "existing") {
    const record = normalizeRecord(result.build);
    if (!record) return failure("UNKNOWN", "The build response was malformed.");
    return { ok: true, data: { status, build: toAndroidBuildView(record) } };
  }
  if (status === "rate_limited") {
    const scope = result.scope === "user" || result.scope === "global" ? result.scope : "project";
    const retry = Number(result.retryAfterSeconds);
    return {
      ok: true,
      data: {
        status: "rate_limited",
        scope,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60,
      },
    };
  }
  return failure("UNKNOWN", "The Android build could not be created.");
}

export async function listAndroidBuilds(
  client: SupabaseClient,
  projectId: string,
  limit = 20,
): Promise<AndroidBuildStoreResult<AndroidBuildView[]>> {
  const { data, error } = await client
    .from("project_android_builds")
    .select(PUBLIC_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (error) return rpcFailure(error);
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    data: rows
      .map((row) => normalizeRecord(row))
      .filter((row): row is AndroidBuildRecord => !!row)
      .map((row) => toAndroidBuildView(row)),
  };
}

export async function getAndroidBuildForOwner(
  client: SupabaseClient,
  projectId: string,
  buildId: string,
): Promise<AndroidBuildStoreResult<AndroidBuildRecord | null>> {
  const { data, error } = await client
    .from("project_android_builds")
    .select(PUBLIC_COLUMNS)
    .eq("id", buildId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return rpcFailure(error);
  if (!data) return { ok: true, data: null };
  const record = normalizeRecord(data);
  return record ? { ok: true, data: record } : failure("UNKNOWN", "The build row was malformed.");
}

/** Service-role only: includes the private object path and lease columns. */
export async function getAndroidBuildFull(
  client: SupabaseClient,
  projectId: string,
  buildId: string,
): Promise<AndroidBuildStoreResult<AndroidBuildRecord | null>> {
  const { data, error } = await client
    .from("project_android_builds")
    .select("*")
    .eq("id", buildId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return rpcFailure(error);
  if (!data) return { ok: true, data: null };
  const record = normalizeRecord(data);
  return record ? { ok: true, data: record } : failure("UNKNOWN", "The build row was malformed.");
}

export interface ClaimedAndroidBuild {
  mode: "new" | "continue";
  leaseSeconds: number;
  build: AndroidBuildRecord;
}

export async function claimAndroidBuild(
  client: SupabaseClient,
  workerId: string,
  leaseSeconds: number,
  projectIds: readonly string[],
): Promise<AndroidBuildStoreResult<ClaimedAndroidBuild | null>> {
  const { data, error } = await client.rpc("claim_android_build", {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
    p_project_ids: projectIds,
  });
  if (error) return rpcFailure(error);
  const result = jsonRecord(data);
  if (result.status === "empty") return { ok: true, data: null };
  if (result.status !== "claimed") {
    return failure("UNKNOWN", "The Android build claim response was malformed.");
  }
  const build = normalizeRecord(result.build);
  if (!build) return failure("UNKNOWN", "The claimed build row was malformed.");
  return {
    ok: true,
    data: {
      mode: result.mode === "continue" ? "continue" : "new",
      leaseSeconds: Number(result.lease_seconds ?? leaseSeconds),
      build,
    },
  };
}

export async function renewAndroidBuildLease(
  client: SupabaseClient,
  buildId: string,
  leaseToken: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { data, error } = await client.rpc("renew_android_build_lease", {
    p_build_id: buildId,
    p_lease_token: leaseToken,
    p_lease_seconds: leaseSeconds,
  });
  if (error) return false;
  return jsonRecord(data).status === "renewed";
}

export async function releaseAndroidBuild(
  client: SupabaseClient,
  buildId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("release_android_build", {
    p_build_id: buildId,
    p_lease_token: leaseToken,
  });
  if (error) return false;
  return jsonRecord(data).status === "released";
}

export async function noteAndroidBuildStage(
  client: SupabaseClient,
  input: {
    buildId: string;
    leaseToken: string;
    stage: string;
    sandboxId?: string | null;
    diagnostics?: string[];
    logExcerpt?: string | null;
    logTruncated?: boolean;
  },
): Promise<boolean> {
  const { data, error } = await client.rpc("note_android_build_stage", {
    p_build_id: input.buildId,
    p_lease_token: input.leaseToken,
    p_stage: input.stage,
    p_sandbox_id: input.sandboxId ?? null,
    p_diagnostics: input.diagnostics ?? [],
    p_log_excerpt: input.logExcerpt ?? null,
    p_log_truncated: input.logTruncated ?? false,
  });
  if (error) return false;
  return jsonRecord(data).status === "noted";
}

export interface CompleteAndroidBuildInput {
  buildId: string;
  leaseToken: string;
  status: Exclude<AndroidBuildStatus, "queued" | "running">;
  errorClass?: string | null;
  summary?: string | null;
  diagnostics?: string[];
  logExcerpt?: string | null;
  logTruncated?: boolean;
  cleanupComplete: boolean;
  artifact?: {
    bucket: string;
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    applicationId: string;
    packageName: string;
    expiresAt: string;
  } | null;
}

export async function completeAndroidBuild(
  client: SupabaseClient,
  input: CompleteAndroidBuildInput,
): Promise<
  "completed" | "cancelled" | "already_terminal" | "lease_lost" | "not_found" | "failed"
> {
  const artifact = input.artifact ?? null;
  const { data, error } = await client.rpc("complete_android_build", {
    p_build_id: input.buildId,
    p_lease_token: input.leaseToken,
    p_status: input.status,
    p_stage: input.status,
    p_error_class: input.errorClass ?? null,
    p_summary: input.summary ?? null,
    p_diagnostics: input.diagnostics ?? [],
    p_log_excerpt: input.logExcerpt ?? null,
    p_log_truncated: input.logTruncated ?? false,
    p_cleanup_complete: input.cleanupComplete,
    p_artifact_bucket: artifact?.bucket ?? null,
    p_artifact_path: artifact?.path ?? null,
    p_artifact_file_name: artifact?.fileName ?? null,
    p_artifact_content_type: artifact?.contentType ?? null,
    p_artifact_size_bytes: artifact?.sizeBytes ?? null,
    p_artifact_sha256: artifact?.sha256 ?? null,
    p_application_id: artifact?.applicationId ?? null,
    p_package_name: artifact?.packageName ?? null,
    p_artifact_expires_at: artifact?.expiresAt ?? null,
  });
  if (error) return "failed";
  const status = jsonRecord(data).status;
  return status === "completed" ||
    status === "cancelled" ||
    status === "already_terminal" ||
    status === "lease_lost" ||
    status === "not_found"
    ? status
    : "failed";
}

export async function retryAndroidBuild(
  client: SupabaseClient,
  input: {
    buildId: string;
    leaseToken: string;
    errorClass: string;
    summary: string;
    retryAfterSeconds: number;
    sandboxCleared: boolean;
  },
): Promise<
  "retry" | "cancelled" | "exhausted" | "lease_lost" | "already_terminal" | "not_found" | "failed"
> {
  const { data, error } = await client.rpc("retry_android_build", {
    p_build_id: input.buildId,
    p_lease_token: input.leaseToken,
    p_error_class: input.errorClass,
    p_summary: input.summary,
    p_retry_after_seconds: input.retryAfterSeconds,
    p_sandbox_cleared: input.sandboxCleared,
  });
  if (error) return "failed";
  const status = jsonRecord(data).status;
  return status === "retry" ||
    status === "cancelled" ||
    status === "exhausted" ||
    status === "lease_lost" ||
    status === "already_terminal" ||
    status === "not_found"
    ? status
    : "failed";
}

export interface AndroidBuildRecovery {
  buildId: string;
  projectId: string;
  outcome: string;
}

export async function recoverExpiredAndroidBuilds(
  client: SupabaseClient,
  limit = 10,
): Promise<AndroidBuildStoreResult<AndroidBuildRecovery[]>> {
  const { data, error } = await client.rpc("recover_expired_android_builds", {
    p_limit: limit,
  });
  if (error) return rpcFailure(error);
  const result = jsonRecord(data);
  const rows = Array.isArray(result.recovered) ? result.recovered : [];
  return {
    ok: true,
    data: rows
      .map((entry) => jsonRecord(entry))
      .filter((entry) => typeof entry.buildId === "string")
      .map((entry) => ({
        buildId: String(entry.buildId),
        projectId: String(entry.projectId ?? ""),
        outcome: String(entry.outcome ?? "unknown"),
      })),
  };
}

export async function cancelAndroidBuild(
  client: SupabaseClient,
  projectId: string,
  buildId: string,
): Promise<AndroidBuildStoreResult<{ status: string; build: AndroidBuildView | null }>> {
  const { data, error } = await client.rpc("cancel_android_build", {
    p_project_id: projectId,
    p_build_id: buildId,
  });
  if (error) return rpcFailure(error);
  const result = jsonRecord(data);
  const status = typeof result.status === "string" ? result.status : "unknown";
  const record = normalizeRecord(result.build);
  return {
    ok: true,
    data: { status, build: record ? toAndroidBuildView(record) : null },
  };
}

export async function claimAndroidBuildCleanup(
  client: SupabaseClient,
  limit = 5,
): Promise<AndroidCleanupClaim[]> {
  const { data, error } = await client.rpc("claim_android_build_cleanup", { p_limit: limit });
  if (error) return [];
  const result = jsonRecord(data);
  const rows = Array.isArray(result.cleanup) ? result.cleanup : [];
  return rows
    .map((entry) => jsonRecord(entry))
    .filter(
      (entry) =>
        typeof entry.buildId === "string" &&
        typeof entry.sandboxId === "string" &&
        typeof entry.cleanupToken === "string",
    )
    .map((entry) => ({
      buildId: String(entry.buildId),
      projectId: String(entry.projectId ?? ""),
      sandboxId: String(entry.sandboxId),
      cleanupToken: String(entry.cleanupToken),
    }));
}

export async function markAndroidBuildCleanup(
  client: SupabaseClient,
  buildId: string,
  cleanupToken: string,
  cleared: boolean,
): Promise<boolean> {
  const { data, error } = await client.rpc("mark_android_build_cleanup", {
    p_build_id: buildId,
    p_cleanup_token: cleanupToken,
    p_cleared: cleared,
  });
  if (error) return false;
  return jsonRecord(data).status === "updated";
}

export async function claimExpiredAndroidArtifacts(
  client: SupabaseClient,
  limit = 5,
): Promise<AndroidArtifactClaim[]> {
  const { data, error } = await client.rpc("claim_expired_android_artifacts", {
    p_limit: limit,
  });
  if (error) return [];
  const result = jsonRecord(data);
  const rows = Array.isArray(result.artifacts) ? result.artifacts : [];
  return rows
    .map((entry) => jsonRecord(entry))
    .filter(
      (entry) =>
        typeof entry.buildId === "string" &&
        typeof entry.bucket === "string" &&
        typeof entry.path === "string",
    )
    .map((entry) => ({
      buildId: String(entry.buildId),
      projectId: String(entry.projectId ?? ""),
      bucket: String(entry.bucket),
      path: String(entry.path),
    }));
}

export async function markAndroidArtifactDeleted(
  client: SupabaseClient,
  buildId: string,
  deleted: boolean,
): Promise<boolean> {
  const { data, error } = await client.rpc("mark_android_artifact_deleted", {
    p_build_id: buildId,
    p_deleted: deleted,
  });
  if (error) return false;
  return jsonRecord(data).status === "updated";
}
