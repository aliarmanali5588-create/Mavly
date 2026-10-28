/**
 * ═══ CREDIT RPC BOUNDARY ════════════════════════════════════════════════════
 *
 * Every credit mutation is a SECURITY DEFINER function in migration 31. This
 * module is the only place TypeScript calls them, and it maps their structured
 * failures into codes the rest of the app can act on.
 *
 * ⚠️ NOTHING HERE FABRICATES A BALANCE. An unknown value stays `null`; an
 * RPC that did not answer is an error, not zero credits.
 *
 * The caller's RLS-scoped client is the default. Only the generation worker and
 * the service-role-only functions pass the confined service client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseCreditClient } from "@/lib/supabase/worker";
import { normalizeRun, type RunRow } from "@/lib/mavly/store";
import {
  creditBalance,
  creditNumber,
  insufficientCreditsFrom,
  type CreditBalance,
  type CreditReservationStatus,
} from "./state";

export type CreditsFailureCode =
  | "MIGRATION_REQUIRED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INSUFFICIENT_CREDITS"
  | "CONFLICT"
  | "INVALID"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type CreditsFailure = {
  ok: false;
  error: string;
  code: CreditsFailureCode;
  available?: number | null;
  required?: number | null;
};

export type CreditsResult<T> = { ok: true; data: T } | CreditsFailure;

export function isCreditsFailure<T>(result: CreditsResult<T>): result is CreditsFailure {
  return result.ok === false;
}

export interface CreditReservationRow {
  id: string;
  userId: string;
  projectId: string;
  runId: string;
  amount: number;
  consumed: number;
  released: number;
  refunded: number;
  status: CreditReservationStatus;
  createdAt: string | null;
  settledAt: string | null;
}

export interface CreditAccountSnapshot {
  exists: boolean;
  balance: number;
  reserved: number;
  available: number;
}

async function client(supabase?: SupabaseClient | null): Promise<SupabaseClient | null> {
  const provided = supabase ?? null;
  if (provided) return provided;
  return createSupabaseServerClient();
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reservationStatusOf(value: unknown): CreditReservationStatus | null {
  return value === "reserved" || value === "consumed" || value === "released" ? value : null;
}

export function normalizeReservation(value: unknown): CreditReservationRow | null {
  const row = recordOf(value);
  if (!row) return null;
  const id = stringOf(row.id);
  const runId = stringOf(row.run_id);
  const status = reservationStatusOf(row.status);
  const amount = creditNumber(row.amount_credits);
  if (!id || !runId || !status || amount === null) return null;
  return {
    id,
    userId: stringOf(row.user_id) ?? "",
    projectId: stringOf(row.project_id) ?? "",
    runId,
    amount,
    consumed: creditNumber(row.consumed_credits) ?? 0,
    released: creditNumber(row.released_credits) ?? 0,
    refunded: creditNumber(row.refunded_credits) ?? 0,
    status,
    createdAt: stringOf(row.created_at),
    settledAt: stringOf(row.settled_at),
  };
}

function accountSnapshot(value: unknown): CreditAccountSnapshot | null {
  const row = recordOf(value);
  if (!row) return null;
  const balance = creditBalance(row.balance, row.reserved);
  if (!balance) return null;
  return { exists: row.exists === true, ...balance };
}

function isMissingFunction(message: string, code?: string): boolean {
  return (
    /function .*does not exist|Could not find the function/i.test(message) ||
    code === "PGRST202" ||
    code === "42883"
  );
}

/** Extract the `detail` JSON Postgres attaches to INSUFFICIENT_CREDITS. */
function insufficientDetail(raw: string | undefined): {
  available: number | null;
  required: number | null;
} {
  const text = raw ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      return insufficientCreditsFrom(parsed.available, parsed.required);
    } catch {
      // Fall through to the loose parse below.
    }
  }
  const available = text.match(/"available"\s*:\s*(\d+)/)?.[1];
  const required = text.match(/"required"\s*:\s*(\d+)/)?.[1];
  return insufficientCreditsFrom(available, required);
}

export function mapCreditsError(
  error: { message?: string | null; code?: string | null; details?: string | null } | null,
): CreditsFailure {
  const message = error?.message ?? "Credit operation failed.";
  const details = error?.details ?? "";
  const combined = `${message} ${details}`;

  if (isMissingFunction(combined, error?.code)) {
    return {
      ok: false,
      error: "Credit accounting needs migration 31_credit_foundation.sql.",
      code: "MIGRATION_REQUIRED",
    };
  }
  if (error?.code === "28000" || /UNAUTHENTICATED/i.test(combined)) {
    return { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" };
  }
  if (error?.code === "42501" || /FORBIDDEN/i.test(combined)) {
    return { ok: false, error: "You don't have access to that account.", code: "FORBIDDEN" };
  }
  if (/INSUFFICIENT_CREDITS/i.test(combined)) {
    const parsed = insufficientDetail(combined);
    return {
      ok: false,
      error: "Not enough available credits for this generation.",
      code: "INSUFFICIENT_CREDITS",
      ...parsed,
    };
  }
  if (/IDEMPOTENCY_CONFLICT/i.test(combined)) {
    return {
      ok: false,
      error: "That idempotency key already names a different credit operation.",
      code: "CONFLICT",
    };
  }
  if (/INVALID_CREDIT|INVALID_REFUND|INVALID_USAGE/i.test(combined)) {
    return { ok: false, error: message.slice(0, 500), code: "INVALID" };
  }
  if (
    /CREDIT_POLICY_NOT_CONFIGURED|CREDIT_POLICY_MISMATCH|CREDIT_WORKER_REQUIRED|CREDIT_RUN_STATE_SERVER_ONLY|CREDIT_RESERVATION_REQUIRED/i.test(
      combined,
    )
  ) {
    return {
      ok: false,
      error: "The credit policy or durable worker is not configured for this project.",
      code: "UNAVAILABLE",
    };
  }
  if (/CREDIT_ACCOUNT_INCONSISTENT|CREDIT_LEDGER_APPEND_ONLY/i.test(combined)) {
    return {
      ok: false,
      error: "The credit account is inconsistent; no change was made.",
      code: "UNKNOWN",
    };
  }
  return { ok: false, error: message.slice(0, 500), code: "UNKNOWN" };
}

// ── Admission ───────────────────────────────────────────────────────────────

export type CreditAdmission =
  | {
      status: "created" | "existing";
      run: RunRow;
      reservation: CreditReservationRow | null;
      balance: number | null;
      reserved: number | null;
    }
  | { status: "conflict"; run: RunRow | null; reason: string | null }
  | { status: "rate_limited"; scope: "user" | "global"; retryAfterSeconds: number };

export interface CreditAdmissionInput {
  userId: string;
  projectId: string;
  model: string;
  prompt: string;
  idempotencyKey?: string | null;
  dispatchMode?: "inline" | "worker";
  amountCredits: number;
}

/**
 * ⚠️ THE JOB AND THE HOLD COMMIT TOGETHER. If the balance is insufficient the
 * RPC raises and the job insert is rolled back; the caller receives
 * `INSUFFICIENT_CREDITS` and no run exists.
 */
export async function createGenerationJobWithCredits(
  input: CreditAdmissionInput,
): Promise<CreditsResult<CreditAdmission>> {
  const supabase = createSupabaseCreditClient();
  if (!supabase) {
    return { ok: false, error: "Credit admission is not configured.", code: "UNAVAILABLE" };
  }

  const { data, error } = await supabase.rpc("create_generation_job_with_credits", {
    p_user_id: input.userId,
    p_project_id: input.projectId,
    p_model: input.model,
    p_prompt: input.prompt.slice(0, 32_000),
    p_idempotency_key: input.idempotencyKey ?? null,
    p_dispatch_mode: input.dispatchMode ?? "inline",
    p_amount_credits: input.amountCredits,
  });

  if (error) return mapCreditsError(error);

  const record = recordOf(data);
  if (!record) {
    return { ok: false, error: "Unexpected credit admission response.", code: "UNKNOWN" };
  }

  const status = record.status;
  if (status === "rate_limited") {
    return {
      ok: true,
      data: {
        status: "rate_limited",
        scope: record.scope === "global" ? "global" : "user",
        retryAfterSeconds:
          typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : 30,
      },
    };
  }
  if (status === "conflict") {
    return {
      ok: true,
      data: {
        status: "conflict",
        run: normalizeRun(record.run),
        reason: stringOf(record.reason),
      },
    };
  }
  if (status !== "created" && status !== "existing") {
    return { ok: false, error: "Unexpected credit admission status.", code: "UNKNOWN" };
  }

  const run = normalizeRun(record.run);
  if (!run) {
    return { ok: false, error: "The admitted run could not be read.", code: "UNKNOWN" };
  }

  return {
    ok: true,
    data: {
      status,
      run,
      reservation: normalizeReservation(record.reservation),
      balance: creditNumber(record.balance),
      reserved: creditNumber(record.reserved),
    },
  };
}

export type CreditResume =
  | {
      status: "resumed";
      run: RunRow;
      reservation: CreditReservationRow | null;
      balance: number | null;
      reserved: number | null;
    }
  | { status: "not_resumable" };

/** Reopen a failed/interrupted run and hold credits only when its hold was released. */
export async function resumeGenerationJobWithCredits(
  userId: string,
  projectId: string,
  runId: string,
  amountCredits: number,
): Promise<CreditsResult<CreditResume>> {
  const supabase = createSupabaseCreditClient();
  if (!supabase) {
    return { ok: false, error: "Credit resume is not configured.", code: "UNAVAILABLE" };
  }

  const { data, error } = await supabase.rpc("resume_generation_job_with_credits", {
    p_user_id: userId,
    p_project_id: projectId,
    p_run_id: runId,
    p_amount_credits: amountCredits,
  });

  if (error) return mapCreditsError(error);

  const record = recordOf(data);
  if (!record || record.status !== "resumed") return { ok: true, data: { status: "not_resumable" } };

  const run = normalizeRun(record.run);
  if (!run) {
    return { ok: false, error: "The resumed run could not be read.", code: "UNKNOWN" };
  }

  return {
    ok: true,
    data: {
      status: "resumed",
      run,
      reservation: normalizeReservation(record.reservation),
      balance: creditNumber(record.balance),
      reserved: creditNumber(record.reserved),
    },
  };
}

// ── Settlement / release / refund ───────────────────────────────────────────

export interface CreditSettlement {
  status: "settled" | "released" | "refunded" | "noop" | "not_found" | "existing";
  amount: number | null;
  balance: number | null;
  reserved: number | null;
  reason: string | null;
}

const SETTLEMENT_STATUSES: ReadonlySet<string> = new Set([
  "settled",
  "released",
  "refunded",
  "noop",
  "not_found",
  "existing",
]);

function settlementOf(value: unknown): CreditSettlement | null {
  const row = recordOf(value);
  if (!row) return null;
  const raw = row.status;
  if (typeof raw !== "string" || !SETTLEMENT_STATUSES.has(raw)) return null;
  return {
    status: raw as CreditSettlement["status"],
    amount: creditNumber(row.amount),
    balance: creditNumber(row.balance),
    reserved: creditNumber(row.reserved),
    reason: stringOf(row.reason),
  };
}

export async function settleGenerationReservation(
  runId: string,
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<CreditSettlement>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("settle_generation_reservation", { p_run_id: runId });
  if (error) return mapCreditsError(error);
  const parsed = settlementOf(data);
  if (!parsed) {
    return { ok: false, error: "Unexpected settlement response.", code: "UNKNOWN" };
  }
  return { ok: true, data: parsed };
}

export async function releaseGenerationReservation(
  runId: string,
  reason: string,
): Promise<CreditsResult<CreditSettlement>> {
  const dbc = createSupabaseCreditClient();
  if (!dbc) return { ok: false, error: "Credit release is not configured.", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("release_generation_reservation", {
    p_run_id: runId,
    p_reason: reason.slice(0, 500),
  });
  if (error) return mapCreditsError(error);
  const parsed = settlementOf(data);
  if (!parsed) {
    return { ok: false, error: "Unexpected release response.", code: "UNKNOWN" };
  }
  return { ok: true, data: parsed };
}

export type CreditRunFinishStatus =
  | "error"
  | "cancelled"
  | "not_credit_project"
  | "already_terminal"
  | "not_found";

/** Owner-checked service RPC for terminal failure/cancellation of credit runs. */
export async function finishCreditGenerationRun(input: {
  userId: string;
  projectId: string;
  runId: string;
  status: "error" | "cancelled";
  stage: "failed" | "interrupted" | "cancelled";
  errorCode?: string | null;
  errorMessage?: string | null;
  reason: string;
}): Promise<CreditsResult<CreditRunFinishStatus>> {
  const supabase = createSupabaseCreditClient();
  if (!supabase) {
    return { ok: false, error: "Credit terminal handling is not configured.", code: "UNAVAILABLE" };
  }
  const { data, error } = await supabase.rpc("finish_credit_generation_run", {
    p_user_id: input.userId,
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_status: input.status,
    p_stage: input.stage,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_reason: input.reason.slice(0, 500),
  });
  if (error) return mapCreditsError(error);
  const status = recordOf(data)?.status;
  if (
    status !== "error" &&
    status !== "cancelled" &&
    status !== "not_credit_project" &&
    status !== "already_terminal" &&
    status !== "not_found"
  ) {
    return { ok: false, error: "Unexpected credit terminal response.", code: "UNKNOWN" };
  }
  return { ok: true, data: status };
}

/** Service-role only; exported for operator tooling and future policy wiring. */
export async function refundGenerationReservation(
  runId: string,
  amountCredits: number | null,
  reason: string,
  idempotencyKey: string | null,
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<CreditSettlement>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("refund_generation_reservation", {
    p_run_id: runId,
    p_amount_credits: amountCredits,
    p_reason: reason.slice(0, 500),
    p_idempotency_key: idempotencyKey,
  });
  if (error) return mapCreditsError(error);
  const parsed = settlementOf(data);
  if (!parsed) {
    return { ok: false, error: "Unexpected refund response.", code: "UNKNOWN" };
  }
  return { ok: true, data: parsed };
}

// ── Balance / reconciliation ────────────────────────────────────────────────

export async function getCreditAccount(
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<CreditAccountSnapshot>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("get_credit_account");
  if (error) return mapCreditsError(error);
  const snapshot = accountSnapshot(data);
  if (!snapshot) {
    return { ok: false, error: "Unexpected credit account response.", code: "UNKNOWN" };
  }
  return { ok: true, data: snapshot };
}

export interface CreditReconciliation {
  settled: number;
  released: number;
  /** Holds released because their run row was deleted (worker sweep only). */
  orphansReleased: number;
  usageRows: number;
}

function reconciliationOf(value: unknown): CreditReconciliation {
  const row = recordOf(value) ?? {};
  const count = (key: string) => creditNumber(row[key]) ?? 0;
  return {
    settled: count("settled"),
    released: count("released"),
    orphansReleased: count("orphansReleased"),
    usageRows: count("usageRows"),
  };
}

export async function reconcileOwnerCredits(
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<CreditReconciliation>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("reconcile_owner_credits");
  if (error) return mapCreditsError(error);
  return { ok: true, data: reconciliationOf(data) };
}

/** Service-role only. Called once per durable worker tick. */
export async function maintainCreditReservations(
  limit: number,
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<CreditReconciliation>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("maintain_credit_reservations", {
    p_limit: Math.max(1, Math.min(Math.floor(limit), 500)),
  });
  if (error) return mapCreditsError(error);
  return { ok: true, data: reconciliationOf(data) };
}

// ── Usage metering ──────────────────────────────────────────────────────────

/** Derive per-attempt usage rows for a run from its server-written attempt list. */
export async function recordAiUsageAttempts(
  runId: string,
  supabase?: SupabaseClient | null,
): Promise<CreditsResult<number>> {
  const dbc = await client(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc.rpc("record_ai_usage_attempts", { p_run_id: runId });
  if (error) return mapCreditsError(error);
  return { ok: true, data: creditNumber(data) ?? 0 };
}

export interface RoleUsageInput {
  attemptKey: string;
  userId: string;
  projectId: string;
  workflowId: string;
  role: string;
  taskKey: string;
  attemptIndex: number;
  model: string;
  provider: string;
  requestedModel: string | null;
  providerRequestId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  actualCostUsd: number | null;
  uncertain: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Service-role only. Orchestration role calls are recorded with the same
 * per-attempt contract as generation attempts, so a workflow's reported cost can
 * be reconciled against the provider's own reports.
 */
export async function recordRoleUsageAttempt(
  input: RoleUsageInput,
  supabase: SupabaseClient,
): Promise<CreditsResult<boolean>> {
  const { data, error } = await supabase.rpc("record_ai_usage_attempt", {
    p_attempt_key: input.attemptKey,
    p_user_id: input.userId,
    p_project_id: input.projectId,
    p_workflow_id: input.workflowId,
    p_role: input.role,
    p_task_key: input.taskKey,
    p_attempt_index: input.attemptIndex,
    p_model: input.model,
    p_provider: input.provider,
    p_requested_model: input.requestedModel,
    p_provider_request_id: input.providerRequestId,
    p_prompt_tokens: input.promptTokens,
    p_completion_tokens: input.completionTokens,
    p_cached_read_tokens: input.cachedReadTokens,
    p_cached_write_tokens: input.cachedWriteTokens,
    p_reasoning_tokens: input.reasoningTokens,
    p_total_tokens: input.totalTokens,
    p_actual_cost_usd: input.actualCostUsd,
    p_uncertain: input.uncertain,
    p_metadata: input.metadata,
  });

  if (error) return mapCreditsError(error);
  return { ok: true, data: data === true };
}

export type { CreditBalance };
