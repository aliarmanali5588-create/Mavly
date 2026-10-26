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
  publicVerificationStatus,
  type VerificationErrorClass,
  type VerificationProvider,
  type VerificationResult,
  type VerificationStage,
} from "./state";

/** The columns exposed to an authenticated reader. Mirrors migration 17. */
const PUBLIC_COLUMNS = [
  "id",
  "project_id",
  "run_id",
  "snapshot_id",
  "source_hash",
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
].join(",");

interface VerificationRow {
  id: string;
  project_id: string;
  run_id: string;
  snapshot_id: string;
  source_hash: string;
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
  /** The immutable snapshot hash this verification was enqueued for. */
  sourceHash: string;
  sandboxId: string | null;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string | null;
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
  };
}

function toRecord(row: WorkerVerificationRow): VerificationRecord {
  return {
    ...toResult(row),
    sourceHash: row.source_hash,
    resourceRef: row.sandbox_id,
    sandboxId: row.sandbox_id,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    deadlineAt: row.deadline_at,
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
    status: "preparing" | "installing" | "building";
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
