/**
 * ═══ VERIFICATION STORE ═════════════════════════════════════════════════════
 *
 * Typed wrappers around migration 17's RPCs. Two callers, deliberately split:
 *
 *   · the worker tick passes the confined service-role client;
 *   · the status/cancel routes pass the caller's RLS-scoped client.
 *
 * ⚠️ NO PROVIDER CREDENTIAL AND NO SERVICE-ROLE KEY APPEARS IN THIS MODULE.
 * The store only moves already-sanitized rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PREVIEW_UNAVAILABLE_REASON,
  publicVerificationStatus,
  type VerificationErrorClass,
  type VerificationPreviewStatus,
  type VerificationProvider,
  type VerificationRepairStatus,
  type VerificationResult,
  type VerificationStage,
} from "./state";

/** The columns exposed to an authenticated reader. Mirrors migrations 17 and 19. */
const PUBLIC_COLUMNS = [
  "id",
  "project_id",
  "run_id",
  "snapshot_id",
  "source_hash",
  "effective_snapshot_id",
  "effective_source_hash",
  "status",
  "attempt",
  "max_attempts",
  "provider",
  "exit_code",
  "error_class",
  "summary",
  "diagnostics",
  "diagnostics_truncated",
  "cleanup_complete",
  "partial",
  "trace_id",
  "enqueued_at",
  "started_at",
  "finished_at",
  "stage_started_at",
  "updated_at",
  "build_passed",
  "runtime_started",
  "health_passed",
  "runtime_profile",
  "runtime_port",
  "runtime_exit_code",
  "health_http_status",
  "runtime_started_at",
  "runtime_finished_at",
  "health_checked_at",
  "preview_status",
  "preview_reason",
  "repair_attempts",
  "repair_max_attempts",
  "repair_status",
  "repaired_snapshot_id",
].join(",");

interface VerificationRow {
  id: string;
  project_id: string;
  run_id: string;
  snapshot_id: string;
  source_hash: string;
  effective_snapshot_id?: string | null;
  effective_source_hash?: string | null;
  status: VerificationStage;
  attempt: number;
  max_attempts: number;
  provider: string | null;
  exit_code: number | null;
  error_class: string | null;
  summary: string | null;
  diagnostics: unknown;
  diagnostics_truncated: boolean;
  cleanup_complete: boolean;
  partial: boolean;
  trace_id: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  stage_started_at: string | null;
  updated_at: string | null;
  build_passed?: boolean | null;
  runtime_started?: boolean | null;
  health_passed?: boolean | null;
  runtime_profile?: string | null;
  runtime_port?: number | null;
  runtime_exit_code?: number | null;
  health_http_status?: number | null;
  runtime_started_at?: string | null;
  runtime_finished_at?: string | null;
  health_checked_at?: string | null;
  preview_status?: string | null;
  preview_reason?: string | null;
  repair_attempts?: number | null;
  repair_max_attempts?: number | null;
  repair_status?: string | null;
  repaired_snapshot_id?: string | null;
}

interface WorkerVerificationRow extends VerificationRow {
  user_id: string;
  sandbox_id: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  deadline_at: string | null;
}

export interface VerificationRecord extends VerificationResult {
  /** The project owner, needed only to write an immutable repair snapshot. */
  userId: string;
  /** The immutable snapshot hash this verification was enqueued for. */
  sourceHash: string;
  /** The snapshot currently being built: original, or the last repair. */
  effectiveSnapshotId: string | null;
  effectiveSourceHash: string | null;
  sandboxId: string | null;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
  repairStatus: VerificationRepairStatus;
  repairAttempts: number;
  repairMaxAttempts: number;
  repairedSnapshotId: string | null;
}

function providerOf(value: string | null): VerificationProvider | null {
  return value === "vercel" || value === "e2b" ? value : null;
}

function diagnosticsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, 80);
}

function repairStatusOf(value: string | null | undefined): VerificationRepairStatus {
  return value === "requested" ||
    value === "applied" ||
    value === "failed" ||
    value === "rejected" ||
    value === "ineligible"
    ? value
    : "none";
}

function previewOf(row: VerificationRow) {
  const status: VerificationPreviewStatus =
    row.preview_status === "disabled" ? "disabled" : "unavailable";
  return {
    status,
    reason: row.preview_reason ?? PREVIEW_UNAVAILABLE_REASON,
    authenticated: false as const,
  };
}

function toResult(row: VerificationRow): VerificationResult {
  const stage = row.status;
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    snapshotId: row.snapshot_id,
    attempt: Number(row.attempt ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    stage,
    status: publicVerificationStatus(stage),
    provider: providerOf(row.provider),
    // The provider reference is intentionally not exposed to users.
    resourceRef: null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    enqueuedAt: row.enqueued_at,
    stageStartedAt: row.stage_started_at,
    exitCode: row.exit_code,
    errorClass: (row.error_class as VerificationErrorClass | null) ?? null,
    summary: row.summary,
    diagnostics: diagnosticsOf(row.diagnostics),
    diagnosticsTruncated: Boolean(row.diagnostics_truncated),
    cleanupComplete: Boolean(row.cleanup_complete),
    partial: Boolean(row.partial),
    correlationId: row.trace_id,
    buildPassed: row.build_passed ?? null,
    runtimeStarted: row.runtime_started ?? null,
    healthPassed: row.health_passed ?? null,
    runtimeProfile: row.runtime_profile ?? null,
    runtimePort: row.runtime_port ?? null,
    runtimeExitCode: row.runtime_exit_code ?? null,
    healthHttpStatus: row.health_http_status ?? null,
    healthChecked: Boolean(row.health_checked_at),
    runtimeStartedAt: row.runtime_started_at ?? null,
    runtimeFinishedAt: row.runtime_finished_at ?? null,
    healthCheckedAt: row.health_checked_at ?? null,
    preview: previewOf(row),
    repair: {
      status: repairStatusOf(row.repair_status),
      attempts: Number(row.repair_attempts ?? 0),
      maxAttempts: Number(row.repair_max_attempts ?? 0),
      snapshotId: row.repaired_snapshot_id ?? null,
    },
  };
}

function toRecord(row: WorkerVerificationRow): VerificationRecord {
  const result = toResult(row);
  return {
    ...result,
    userId: row.user_id,
    sourceHash: row.source_hash,
    effectiveSnapshotId: row.effective_snapshot_id ?? row.snapshot_id,
    effectiveSourceHash: row.effective_source_hash ?? row.source_hash,
    resourceRef: row.sandbox_id,
    sandboxId: row.sandbox_id,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    deadlineAt: row.deadline_at,
    repairStatus: result.repair.status,
    repairAttempts: result.repair.attempts,
    repairMaxAttempts: result.repair.maxAttempts,
    repairedSnapshotId: result.repair.snapshotId,
  };
}

function storeFailure(operation: string, message: string): { ok: false; error: string } {
  console.error(`[sandbox] ${operation} failed:`, message);
  return { ok: false, error: `${operation} failed` };
}

// ── Enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueVerificationInput {
  projectId: string;
  runId: string;
  snapshotId: string;
  sourceHash: string;
  provider: VerificationProvider;
  traceId: string | null;
  /** The persisted repair budget; 0 disables repair for this row. */
  maxRepairs?: number;
}

export type EnqueueVerificationResult =
  | {
      ok: true;
      status: "created" | "existing" | "rate_limited";
      verification: VerificationResult | null;
      scope?: string;
      retryAfterSeconds?: number;
    }
  | { ok: false; error: string };

export async function enqueueVerification(
  supabase: SupabaseClient,
  input: EnqueueVerificationInput,
): Promise<EnqueueVerificationResult> {
  const { data, error } = await supabase.rpc("enqueue_verification", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_snapshot_id: input.snapshotId,
    p_source_hash: input.sourceHash,
    p_provider: input.provider,
    p_trace_id: input.traceId,
    p_max_repairs: input.maxRepairs ?? 0,
  });
  if (error) return storeFailure("enqueue_verification", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  const status = payload.status;
  if (status !== "created" && status !== "existing" && status !== "rate_limited") {
    return storeFailure("enqueue_verification", "unexpected response");
  }
  const row = payload.verification as VerificationRow | undefined;
  return {
    ok: true,
    status,
    verification: row ? toResult(row) : null,
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    ...(typeof payload.retryAfterSeconds === "number"
      ? { retryAfterSeconds: payload.retryAfterSeconds }
      : {}),
  };
}

// ── Claim / stage / lease ───────────────────────────────────────────────────

export type ClaimVerificationResult =
  | { ok: true; status: "empty" }
  | {
      ok: true;
      status: "claimed";
      mode: "new" | "continue";
      leaseSeconds: number;
      verification: VerificationRecord;
    }
  | { ok: false; error: string };

export async function claimVerification(
  supabase: SupabaseClient,
  workerId: string,
  projectIds: readonly string[],
): Promise<ClaimVerificationResult> {
  const { data, error } = await supabase.rpc("claim_verification", {
    p_worker_id: workerId,
    p_lease_seconds: 120,
    p_project_ids: [...projectIds],
  });
  if (error) return storeFailure("claim_verification", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.status === "empty") return { ok: true, status: "empty" };
  if (payload.status !== "claimed") {
    return storeFailure("claim_verification", "unexpected response");
  }

  const row = payload.verification as WorkerVerificationRow | undefined;
  if (!row) return storeFailure("claim_verification", "missing row");

  return {
    ok: true,
    status: "claimed",
    mode: payload.mode === "continue" ? "continue" : "new",
    leaseSeconds:
      typeof payload.lease_seconds === "number" ? payload.lease_seconds : 120,
    verification: toRecord(row),
  };
}

export type LeaseResult =
  | { ok: true; status: "noted" | "renewed" | "released"; verification?: VerificationRecord }
  | { ok: true; status: "lost" }
  | { ok: false; error: string };

export async function noteVerificationStage(
  supabase: SupabaseClient,
  input: {
    verificationId: string;
    leaseToken: string;
    status:
      | "preparing"
      | "installing"
      | "building"
      | "runtime_starting"
      | "health_checking";
    sandboxId?: string | null;
    exitCode?: number | null;
  },
): Promise<LeaseResult> {
  const { data, error } = await supabase.rpc("note_verification_stage", {
    p_verification_id: input.verificationId,
    p_lease_token: input.leaseToken,
    p_status: input.status,
    p_sandbox_id: input.sandboxId ?? null,
    p_exit_code: input.exitCode ?? null,
  });
  if (error) return storeFailure("note_verification_stage", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.status === "lost") return { ok: true, status: "lost" };
  const row = payload.verification as WorkerVerificationRow | undefined;
  if (payload.status !== "noted" || !row) {
    return storeFailure("note_verification_stage", "unexpected response");
  }
  return { ok: true, status: "noted", verification: toRecord(row) };
}

export async function renewVerificationLease(
  supabase: SupabaseClient,
  verificationId: string,
  leaseToken: string,
): Promise<LeaseResult> {
  const { data, error } = await supabase.rpc("renew_verification_lease", {
    p_verification_id: verificationId,
    p_lease_token: leaseToken,
    p_lease_seconds: 120,
  });
  if (error) return storeFailure("renew_verification_lease", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.status === "lost") return { ok: true, status: "lost" };
  const row = payload.verification as WorkerVerificationRow | undefined;
  if (payload.status !== "renewed" || !row) {
    return storeFailure("renew_verification_lease", "unexpected response");
  }
  return { ok: true, status: "renewed", verification: toRecord(row) };
}

export async function releaseVerification(
  supabase: SupabaseClient,
  verificationId: string,
  leaseToken: string,
): Promise<LeaseResult> {
  const { data, error } = await supabase.rpc("release_verification", {
    p_verification_id: verificationId,
    p_lease_token: leaseToken,
  });
  if (error) return storeFailure("release_verification", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.status === "lost") return { ok: true, status: "lost" };
  if (payload.status !== "released") {
    return storeFailure("release_verification", "unexpected response");
  }
  return { ok: true, status: "released" };
}

// ── Terminal completion ─────────────────────────────────────────────────────

export type TerminalVerificationStage = Extract<
  VerificationStage,
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unsupported_runtime"
  | "configuration_error"
  | "infrastructure_error"
>;

export interface CompleteVerificationInput {
  verificationId: string;
  leaseToken: string;
  status: TerminalVerificationStage;
  exitCode: number | null;
  errorClass: VerificationErrorClass | null;
  summary: string | null;
  diagnostics: readonly string[];
  diagnosticsTruncated: boolean;
  partial: boolean;
  cleanupComplete: boolean;
  buildPassed?: boolean | null;
  runtimeStarted?: boolean | null;
  healthPassed?: boolean | null;
  healthChecked?: boolean;
  runtimeExitCode?: number | null;
  healthHttpStatus?: number | null;
  runtimePort?: number | null;
  runtimeProfile?: string | null;
  previewStatus?: VerificationPreviewStatus;
  previewReason?: string | null;
}

export type CompleteVerificationResult =
  | { ok: true; status: "completed" | "already_terminal"; verification: VerificationResult }
  | { ok: true; status: "not_found" | "lease_lost" }
  | { ok: false; error: string };

export async function completeVerification(
  supabase: SupabaseClient,
  input: CompleteVerificationInput,
): Promise<CompleteVerificationResult> {
  const { data, error } = await supabase.rpc("complete_verification", {
    p_verification_id: input.verificationId,
    p_lease_token: input.leaseToken,
    p_status: input.status,
    p_exit_code: input.exitCode,
    p_error_class: input.errorClass,
    p_summary: input.summary,
    p_diagnostics: input.diagnostics.slice(0, 80),
    p_diagnostics_truncated: input.diagnosticsTruncated,
    p_partial: input.partial,
    p_cleanup_complete: input.cleanupComplete,
    p_build_passed: input.buildPassed ?? null,
    p_runtime_started: input.runtimeStarted ?? null,
    p_health_passed: input.healthPassed ?? null,
    p_health_checked: input.healthChecked ?? false,
    p_runtime_exit_code: input.runtimeExitCode ?? null,
    p_health_http_status: input.healthHttpStatus ?? null,
    p_runtime_port: input.runtimePort ?? null,
    p_runtime_profile: input.runtimeProfile ?? null,
    p_preview_status: input.previewStatus ?? "unavailable",
    p_preview_reason: input.previewReason ?? null,
  });
  if (error) return storeFailure("complete_verification", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.status === "not_found" || payload.status === "lease_lost") {
    return { ok: true, status: payload.status };
  }
  if (payload.status !== "completed" && payload.status !== "already_terminal") {
    return storeFailure("complete_verification", "unexpected response");
  }
  const row = payload.verification as WorkerVerificationRow | undefined;
  if (!row) return storeFailure("complete_verification", "missing row");
  return { ok: true, status: payload.status, verification: toResult(row) };
}

// ── Bounded repair ──────────────────────────────────────────────────────────

export type ClearSandboxResult =
  | { ok: true; status: "cleared" | "not_confirmed" | "lost" }
  | { ok: false; error: string };

/**
 * Forget a sandbox reference only after the provider confirmed deletion. The
 * SQL function refuses to clear it otherwise, so a failed cleanup stays queued.
 */
export async function clearVerificationSandbox(
  supabase: SupabaseClient,
  verificationId: string,
  leaseToken: string,
  confirmed: boolean,
): Promise<ClearSandboxResult> {
  const { data, error } = await supabase.rpc("clear_verification_sandbox", {
    p_verification_id: verificationId,
    p_lease_token: leaseToken,
    p_confirmed: confirmed,
  });
  if (error) return storeFailure("clear_verification_sandbox", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (
    payload.status !== "cleared" &&
    payload.status !== "not_confirmed" &&
    payload.status !== "lost"
  ) {
    return storeFailure("clear_verification_sandbox", "unexpected response");
  }
  return { ok: true, status: payload.status };
}

export type BeginRepairStatus =
  | "begun"
  | "not_found"
  | "already_terminal"
  | "lease_lost"
  | "sandbox_present"
  | "invalid_stage"
  | "exhausted"
  | "duplicate";

export type BeginRepairResult =
  | { ok: true; status: BeginRepairStatus; attempt?: number }
  | { ok: false; error: string };

export async function beginVerificationRepair(
  supabase: SupabaseClient,
  verificationId: string,
  leaseToken: string,
  maxRepairs: number,
): Promise<BeginRepairResult> {
  const { data, error } = await supabase.rpc("begin_verification_repair", {
    p_verification_id: verificationId,
    p_lease_token: leaseToken,
    p_max_repairs: maxRepairs,
  });
  if (error) return storeFailure("begin_verification_repair", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  const status = payload.status;
  if (
    status !== "begun" &&
    status !== "not_found" &&
    status !== "already_terminal" &&
    status !== "lease_lost" &&
    status !== "sandbox_present" &&
    status !== "invalid_stage" &&
    status !== "exhausted" &&
    status !== "duplicate"
  ) {
    return storeFailure("begin_verification_repair", "unexpected response");
  }
  return {
    ok: true,
    status,
    ...(typeof payload.attempt === "number" ? { attempt: payload.attempt } : {}),
  };
}

export interface FinishRepairInput {
  verificationId: string;
  leaseToken: string;
  attempt: number;
  status: "applied" | "failed" | "rejected";
  repairedSnapshotId?: string | null;
  repairedHash?: string | null;
  errorClass?: VerificationErrorClass | null;
  summary?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  costKnown?: boolean;
}

export type FinishRepairResult =
  | { ok: true; status: "applied" | "failed" | "rejected" }
  | {
      ok: true;
      status: "not_found" | "already_terminal" | "lease_lost" | "not_requested";
    }
  | { ok: false; error: string };

export async function finishVerificationRepair(
  supabase: SupabaseClient,
  input: FinishRepairInput,
): Promise<FinishRepairResult> {
  const { data, error } = await supabase.rpc("finish_verification_repair", {
    p_verification_id: input.verificationId,
    p_lease_token: input.leaseToken,
    p_attempt: input.attempt,
    p_status: input.status,
    p_repaired_snapshot_id: input.repairedSnapshotId ?? null,
    p_repaired_hash: input.repairedHash ?? null,
    p_error_class: input.errorClass ?? null,
    p_summary: input.summary ?? null,
    p_model: input.model ?? null,
    p_prompt_tokens: input.promptTokens ?? null,
    p_completion_tokens: input.completionTokens ?? null,
    p_cost_usd: input.costUsd ?? null,
    p_cost_known: input.costKnown ?? false,
  });
  if (error) return storeFailure("finish_verification_repair", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  const status = payload.status;
  if (
    status !== "applied" &&
    status !== "failed" &&
    status !== "rejected" &&
    status !== "not_found" &&
    status !== "already_terminal" &&
    status !== "lease_lost" &&
    status !== "not_requested"
  ) {
    return storeFailure("finish_verification_repair", "unexpected response");
  }
  return { ok: true, status };
}

// ── Recovery / cleanup ──────────────────────────────────────────────────────

export interface CleanupCandidate {
  verificationId: string;
  provider: VerificationProvider | null;
  sandboxId: string;
  cleanupAttempts: number;
}

export async function recoverVerificationLeases(
  supabase: SupabaseClient,
  limit = 10,
): Promise<{ ok: true; recovered: unknown[] } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("recover_expired_verification_leases", {
    p_limit: limit,
  });
  if (error) return storeFailure("recover_expired_verification_leases", error.message);
  const payload = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    recovered: Array.isArray(payload.recovered) ? payload.recovered : [],
  };
}

export async function claimVerificationCleanup(
  supabase: SupabaseClient,
  limit = 5,
): Promise<{ ok: true; candidates: CleanupCandidate[] } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("claim_verification_cleanup", {
    p_limit: limit,
  });
  if (error) return storeFailure("claim_verification_cleanup", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidates: CleanupCandidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.verificationId !== "string" || typeof record.sandboxId !== "string") {
      continue;
    }
    candidates.push({
      verificationId: record.verificationId,
      provider: providerOf(
        typeof record.provider === "string" ? record.provider : null,
      ),
      sandboxId: record.sandboxId,
      cleanupAttempts:
        typeof record.cleanupAttempts === "number" ? record.cleanupAttempts : 0,
    });
  }
  return { ok: true, candidates };
}

export async function markVerificationCleanup(
  supabase: SupabaseClient,
  verificationId: string,
  confirmed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc("mark_verification_cleanup", {
    p_verification_id: verificationId,
    p_confirmed: confirmed,
  });
  if (error) return storeFailure("mark_verification_cleanup", error.message);
  return { ok: true };
}

// ── User-facing read / cancel ────────────────────────────────────────────────

/** The latest verification for one run, read through the caller's RLS client. */
export async function getVerificationForRun(
  supabase: SupabaseClient,
  projectId: string,
  runId: string,
): Promise<VerificationResult | null> {
  const { data, error } = await supabase
    .from("project_verifications")
    .select(PUBLIC_COLUMNS)
    .eq("project_id", projectId)
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    console.error("[sandbox] verification read failed:", error.message);
    return null;
  }
  return data ? toResult(data as unknown as VerificationRow) : null;
}

export type CancelVerificationResult =
  | { ok: true; status: "cancelled" | "none" | "already_terminal" }
  | { ok: false; error: string };

/** The installed verification schema version, or null when it is not there. */
export async function verificationSchemaVersion(
  supabase: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("verification_schema_version");
  if (error) return null;
  return typeof data === "number" ? data : null;
}

export async function cancelVerification(
  supabase: SupabaseClient,
  projectId: string,
  runId: string,
): Promise<CancelVerificationResult> {
  const { data, error } = await supabase.rpc("cancel_verification", {
    p_project_id: projectId,
    p_run_id: runId,
  });
  if (error) return storeFailure("cancel_verification", error.message);

  const payload = (data ?? {}) as Record<string, unknown>;
  if (
    payload.status !== "cancelled" &&
    payload.status !== "none" &&
    payload.status !== "already_terminal"
  ) {
    return storeFailure("cancel_verification", "unexpected response");
  }
  return { ok: true, status: payload.status };
}
