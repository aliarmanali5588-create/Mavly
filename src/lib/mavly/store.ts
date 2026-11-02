/**
 * Mavly's local persistence layer.
 *
 * Every function defaults to the caller's own Supabase session client, never a
 * service-role key. RLS on public.projects and its child tables is the access
 * boundary. Project queries also repeat the `user_id` predicate; child queries
 * rely on the ownership policies, which require an owned parent row.
 *
 * ⚠️ THE ONE EXCEPTION IS EXPLICIT. Functions that accept a final `supabase`
 * argument use it instead of the session client. Only the generation worker
 * passes a service-role client, after it has verified the claimed project's
 * owner. No route calls these functions with the service client.
 */

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AgentFile } from "@/lib/ai/agent";
import type { GenerationStage } from "@/lib/generation/state-machine";
import { WORKER_LEASE_SECONDS } from "@/lib/generation/leases";
import { emitGenerationEvent } from "@/lib/observability/events";

export type ProjectType = "website" | "android";

export const normalizeProjectType = (value: unknown): ProjectType => {
  return value === "android" ? "android" : "website";
};

export interface ProjectRow {
  project_id: string;
  user_id: string;
  project_type: ProjectType;
  label: string | null;
  description: string;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "init" | "done" | "error";

/** The durable stage is defined once, in the pure state module. */
export type RunStage = GenerationStage;

export type DispatchMode = "inline" | "worker";

export interface RunRow {
  id: string;
  project_id: string;
  status: RunStatus;
  model: string;
  prompt: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  /** The durable job stage. Present after migration 10. */
  stage: RunStage | null;
  heartbeat_at: string | null;
  claimed_at: string | null;
  last_progress_at: string | null;
  idempotency_key: string | null;
  attempt_count: number;
  provider_request_id: string | null;
  model_used: string | null;
  finish_reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  retry_after_seconds: number | null;
  error_code: string | null;
  provider_attempts: unknown;
  generation_manifest: unknown;
  checkpoint_count: number;
  files_written: number;
  batch_count: number;
  /** Worker lease fields (migration 16). Null for inline runs. */
  lease_token: string | null;
  lease_expires_at: string | null;
  job_attempt: number;
  max_job_attempts: number;
  next_attempt_at: string | null;
  enqueued_at: string | null;
  dispatched_at: string | null;
  cancellation_requested_at: string | null;
  dead_lettered_at: string | null;
  worker_id: string | null;
  trace_id: string | null;
  job_version: number;
  last_error_class: string | null;
  last_error_summary: string | null;
  reported_cost_usd: number | null;
  cost_known: boolean;
  dispatch_mode: DispatchMode;
}

export interface MessageRow {
  id: string;
  project_id: string;
  author: "user" | "agent";
  message: string;
  message_type: string;
  /**
   * ⭐ THE RESTORE TARGET OF THIS MESSAGE. The chat's "Restore Code" action is
   * bound to the persisted snapshot id, not to transient client state, so a
   * reload shows the same action for the same run.
   */
  restore_snapshot_id: string | null;
  created_at: string;
}

export interface FileRow {
  path: string;
  content: string;
  updated_at: string;
}

export const RUN_SELECT =
  "id,project_id,status,stage,model,prompt,started_at,finished_at,error_message,heartbeat_at,claimed_at,last_progress_at,idempotency_key,attempt_count,provider_request_id,model_used,finish_reason,prompt_tokens,completion_tokens,total_tokens,reasoning_tokens,retry_after_seconds,error_code,provider_attempts,generation_manifest,checkpoint_count,files_written,batch_count,lease_token,lease_expires_at,job_attempt,max_job_attempts,next_attempt_at,enqueued_at,dispatched_at,cancellation_requested_at,dead_lettered_at,worker_id,trace_id,job_version,last_error_class,last_error_summary,reported_cost_usd,cost_known,dispatch_mode";

export type StoreFailure = { ok: false; error: string; code?: string };

export type StoreResult<T> = { ok: true; data: T } | StoreFailure;

/**
 * `strict` is off in this repository, so discriminant narrowing on `!result.ok`
 * is not reliable. This explicit guard keeps failure-field access type-safe.
 */
export function isStoreFailure<T>(result: StoreResult<T>): result is StoreFailure {
  return result.ok === false;
}

async function client() {
  return createSupabaseServerClient();
}

/** The caller's client when supplied, otherwise the request-scoped session. */
async function db(supabase?: SupabaseClient | null): Promise<SupabaseClient | null> {
  return supabase ?? (await client());
}

function dbError(scope: string, message: string, code?: string): StoreResult<never> {
  console.error(`[mavly] ${scope}:`, message);
  return { ok: false, error: message, code };
}

export async function createOwnedProject(
  userId: string,
  requestedId: string,
  description: string,
  label?: string | null,
  projectType?: ProjectType,
  creationRequestId?: string,
): Promise<StoreResult<ProjectRow>> {
  if (!isRoutableProjectSlug(requestedId)) {
    return { ok: false, error: "Invalid project id", code: "VALIDATION" };
  }

  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const targetType = normalizeProjectType(projectType);
  const projectColumns = "project_id,user_id,project_type,label,description,created_at,updated_at";

  if (creationRequestId) {
    const existing = await supabase
      .from("projects")
      .select(projectColumns)
      .eq("user_id", userId)
      .eq("creation_request_id", creationRequestId)
      .maybeSingle();

    if (existing.error) {
      return dbError("find project creation request", existing.error.message, existing.error.code);
    }
    if (existing.data) {
      if (
        existing.data.project_type !== targetType ||
        existing.data.description !== description.slice(0, 2_000)
      ) {
        return { ok: false, error: "The creation request id was already used", code: "CONFLICT" };
      }
      return { ok: true, data: existing.data as ProjectRow };
    }
  }

  let candidate = requestedId;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await supabase
      .from("projects")
      .insert({
        project_id: candidate,
        user_id: userId,
        project_type: targetType,
        description: description.slice(0, 2_000),
        label: label?.slice(0, 120) || null,
        ...(creationRequestId ? { creation_request_id: creationRequestId } : {}),
      })
      .select(projectColumns)
      .single();

    if (!error && data) return { ok: true, data: data as ProjectRow };
    if (error?.code !== "23505") {
      return dbError("create project", error?.message ?? "insert failed", error?.code);
    }

    if (creationRequestId) {
      const existing = await supabase
        .from("projects")
        .select(projectColumns)
        .eq("user_id", userId)
        .eq("creation_request_id", creationRequestId)
        .maybeSingle();

      if (existing.error) {
        return dbError("find project creation request", existing.error.message, existing.error.code);
      }
      if (existing.data) {
        if (
          existing.data.project_type !== targetType ||
          existing.data.description !== description.slice(0, 2_000)
        ) {
          return { ok: false, error: "The creation request id was already used", code: "CONFLICT" };
        }
        return { ok: true, data: existing.data as ProjectRow };
      }
    }

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 5);
    const base = requestedId.slice(0, Math.max(1, 62 - suffix.length)).replace(/-+$/, "");
    candidate = `${base}-${suffix}`;
    if (!isRoutableProjectSlug(candidate)) {
      return { ok: false, error: "Could not allocate a project id", code: "CONFLICT" };
    }
  }

  return { ok: false, error: "Could not allocate a project id", code: "CONFLICT" };
}

export async function listProjects(
  userId: string,
  projectType?: ProjectType,
): Promise<StoreResult<ProjectRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  let query = supabase
    .from("projects")
    .select("project_id,user_id,project_type,label,description,created_at,updated_at")
    .eq("user_id", userId);
  if (projectType) query = query.eq("project_type", projectType);

  const { data, error } = await query.order("updated_at", { ascending: false });

  if (error) return dbError("list projects", error.message, error.code);
  return { ok: true, data: (data ?? []) as ProjectRow[] };
}

export async function getProject(
  userId: string,
  projectId: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<ProjectRow | null>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("projects")
    .select("project_id,user_id,project_type,label,description,created_at,updated_at")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return dbError("get project", error.message, error.code);
  return { ok: true, data: (data as ProjectRow | null) ?? null };
}

export async function updateProject(
  userId: string,
  projectId: string,
  patch: { label?: string | null; description?: string; projectType?: ProjectType },
): Promise<StoreResult<ProjectRow>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.projectType !== undefined) updates.project_type = normalizeProjectType(patch.projectType);
  if (patch.label !== undefined) updates.label = patch.label?.slice(0, 120) || null;  if (patch.description !== undefined) updates.description = patch.description.slice(0, 2_000);

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .select("project_id,user_id,project_type,label,description,created_at,updated_at")
    .single();

  if (error || !data) return dbError("update project", error?.message ?? "update failed", error?.code);
  return { ok: true, data: data as ProjectRow };
}

export async function touchProject(
  userId: string,
  projectId: string,
  supabase?: SupabaseClient | null,
): Promise<void> {
  const dbc = await db(supabase);
  if (!dbc) return;
  const { error } = await dbc
    .from("projects")
    .update({ updated_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) console.error("[mavly] touch project:", error.message);
}

export async function deleteProject(userId: string, projectId: string): Promise<StoreResult<void>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { error } = await supabase
    .from("projects")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) return dbError("delete project", error.message, error.code);
  return { ok: true, data: undefined };
}

export interface RunFinishPatch {
  stage?: RunStage;
  errorCode?: string | null;
  retryAfterSeconds?: number | null;
  providerRequestId?: string | null;
  modelUsed?: string | null;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
  attemptCount?: number;
  providerAttempts?: readonly unknown[];
  checkpointCount?: number;
  filesWritten?: number;
  batchCount?: number;
  /** Persisted cancellation metadata; the terminal stage is written in the same update. */
  cancellationRequestedAt?: string | null;
  /** Terminal failure metadata. Written only when the worker lease guard is present. */
  errorClass?: string | null;
  errorSummary?: string | null;
  reportedCostUsd?: number | null;
  costKnown?: boolean;
  deadLetter?: boolean;
  /** The inline claim this worker owns. A resumed run has a different `claimed_at`. */
  expectedClaimedAt?: string;
  /** The worker lease fencing token. A stale worker cannot finish the run. */
  expectedLeaseToken?: string;
}

/**
 * Finish a run only if it is still unfinished. This makes completion, failure
 * and cancellation race-safe: whichever terminal transition lands first wins,
 * and a late worker cannot overwrite a user's cancellation with "done".
 */
export async function finishRun(
  runId: string,
  status: "done" | "error" | "cancelled",
  errorMessage?: string,
  patch: RunFinishPatch = {},
  supabase?: SupabaseClient | null,
): Promise<boolean> {
  const dbc = await db(supabase);
  if (!dbc) return false;
  const now = new Date().toISOString();
  const stage: RunStage =
    patch.stage ??
    (status === "done" ? "completed" : status === "cancelled" ? "cancelled" : "failed");
  const workerGuard = !!patch.expectedLeaseToken;

  const update: Record<string, unknown> = {
    status: status === "cancelled" ? "error" : status,
    stage,
    finished_at: now,
    last_progress_at: now,
    error_message: errorMessage?.slice(0, 2_000) ?? null,
  };

  if (patch.errorCode !== undefined) update.error_code = patch.errorCode;
  if (patch.retryAfterSeconds !== undefined) update.retry_after_seconds = patch.retryAfterSeconds;
  if (patch.providerRequestId !== undefined) update.provider_request_id = patch.providerRequestId;
  if (patch.modelUsed !== undefined) update.model_used = patch.modelUsed;
  if (patch.finishReason !== undefined) update.finish_reason = patch.finishReason;
  if (patch.promptTokens !== undefined) update.prompt_tokens = patch.promptTokens;
  if (patch.completionTokens !== undefined) update.completion_tokens = patch.completionTokens;
  if (patch.totalTokens !== undefined) update.total_tokens = patch.totalTokens;
  if (patch.reasoningTokens !== undefined) update.reasoning_tokens = patch.reasoningTokens;
  if (patch.attemptCount !== undefined) update.attempt_count = patch.attemptCount;
  if (patch.checkpointCount !== undefined) update.checkpoint_count = patch.checkpointCount;
  if (patch.filesWritten !== undefined) update.files_written = patch.filesWritten;
  if (patch.batchCount !== undefined) update.batch_count = patch.batchCount;
  if (patch.cancellationRequestedAt !== undefined) {
    update.cancellation_requested_at = patch.cancellationRequestedAt;
  }
  if (patch.providerAttempts !== undefined) {
    update.provider_attempts = boundedAttempts(patch.providerAttempts);
  }

  /**
   * Worker-only columns are not in the authenticated UPDATE grant. They are
   * written only when the caller presented a lease token, which only the
   * service-role worker does.
   */
  if (workerGuard) {
    update.lease_token = null;
    update.lease_expires_at = null;
    update.next_attempt_at = null;
    if (patch.errorClass !== undefined) update.last_error_class = patch.errorClass;
    if (patch.errorSummary !== undefined) {
      update.last_error_summary = patch.errorSummary?.slice(0, 1_000) ?? null;
    }
    if (patch.reportedCostUsd !== undefined) update.reported_cost_usd = patch.reportedCostUsd;
    if (patch.costKnown !== undefined) update.cost_known = patch.costKnown;
    if (patch.deadLetter) update.dead_lettered_at = now;
  }

  let query = dbc
    .from("project_runs")
    .update(update)
    .eq("id", runId)
    .is("finished_at", null);
  if (patch.expectedLeaseToken) {
    query = query.eq("lease_token", patch.expectedLeaseToken);
  }
  if (patch.expectedClaimedAt) {
    query = query.eq("claimed_at", patch.expectedClaimedAt);
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    console.error("[mavly] finish run:", error.message);
    return false;
  }
  return !!data;
}

export async function latestRun(
  projectId: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<RunRow | null>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("project_runs")
    .select(RUN_SELECT)
    .eq("project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return dbError("latest run", error.message, error.code);
  return { ok: true, data: (data as RunRow | null) ?? null };
}

export interface RunActivityRow {
  id: string;
  status: RunRow["status"];
  stage: RunStage;
  model: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  files_written: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

/**
 * The newest runs of one project, bounded for the activity panel. This is the caller's
 * RLS-scoped read of `project_runs`; it never widens beyond an owned project and never
 * returns prompts, generated content or provider error messages.
 */
export async function listRunActivity(
  projectId: string,
  options: { since: string | null; limit?: number },
): Promise<StoreResult<RunActivityRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const limit = Math.max(1, Math.min(options.limit ?? 500, 500));
  /**
   * `all` passes no lower bound; the epoch is an explicit, harmless lower bound that keeps
   * the query one PostgREST chain (and avoids a union of two builder types).
   */
  const since = options.since ?? "1970-01-01T00:00:00.000Z";
  const { data, error } = await supabase
    .from("project_runs")
    .select(
      "id,status,stage,model,started_at,finished_at,error_code,files_written,prompt_tokens,completion_tokens,total_tokens",
    )
    .eq("project_id", projectId)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) return dbError("list run activity", error.message, error.code);
  return {
    ok: true,
    data: ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id ?? ""),
      status: row.status === "done" ? "done" : row.status === "error" ? "error" : "init",
      stage: (row.stage as RunStage | null) ?? "queued",
      model: String(row.model ?? ""),
      started_at: String(row.started_at ?? ""),
      finished_at: typeof row.finished_at === "string" ? row.finished_at : null,
      error_code: typeof row.error_code === "string" ? row.error_code : null,
      files_written: Number(row.files_written ?? 0),
      prompt_tokens: typeof row.prompt_tokens === "number" ? row.prompt_tokens : null,
      completion_tokens:
        typeof row.completion_tokens === "number" ? row.completion_tokens : null,
      total_tokens: typeof row.total_tokens === "number" ? row.total_tokens : null,
    })),
  };
}

function boundedAttempts(attempts: readonly unknown[]): unknown[] {
  return attempts.slice(-60).map((attempt) => {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return {};
    const record = attempt as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const key of [
      "providerAttemptId",
      "phase",
      "attempt",
      "status",
      "requestedModel",
      "model",
      "finishReason",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "reasoningTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
      "providerRequestId",
      "retryAfterMs",
      "errorCode",
      "costUsd",
      "at",
    ]) {
      if (record[key] !== undefined) safe[key] = record[key];
    }
    return safe;
  });
}

export async function insertMessage(
  projectId: string,
  author: "user" | "agent",
  message: string,
  messageType = "regular",
  restoreSnapshotId?: string | null,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<MessageRow>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("project_messages")
    .insert({
      project_id: projectId,
      author,
      message: message.slice(0, 32_000),
      message_type: messageType,
      restore_snapshot_id: restoreSnapshotId ?? null,
    })
    .select("id,project_id,author,message,message_type,restore_snapshot_id,created_at")
    .single();

  if (error || !data) return dbError("insert message", error?.message ?? "insert failed", error?.code);
  return { ok: true, data: data as MessageRow };
}

export async function listMessages(
  projectId: string,
  options: { limit?: number; offsetFromEnd?: number } = {},
): Promise<StoreResult<MessageRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const limit = Math.max(1, Math.min(options.limit ?? 1_000, 1_000));
  const offset = Math.max(0, options.offsetFromEnd ?? 0);

  const { data, error } = await supabase
    .from("project_messages")
    .select("id,project_id,author,message,message_type,restore_snapshot_id,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return dbError("list messages", error.message, error.code);
  return { ok: true, data: ((data ?? []) as MessageRow[]).reverse() };
}

export async function listFiles(
  projectId: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<FileRow[]>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("project_files")
    .select("path,content,updated_at")
    .eq("project_id", projectId)
    .order("path", { ascending: true });

  if (error) return dbError("list files", error.message, error.code);
  return { ok: true, data: (data ?? []) as FileRow[] };
}

export async function getFile(projectId: string, path: string): Promise<StoreResult<FileRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_files")
    .select("path,content,updated_at")
    .eq("project_id", projectId)
    .eq("path", path)
    .maybeSingle();

  if (error) return dbError("get file", error.message, error.code);
  return { ok: true, data: (data as FileRow | null) ?? null };
}

export async function writeFiles(
  userId: string,
  projectId: string,
  files: readonly AgentFile[],
  deletedPaths: readonly string[] = [],
  supabase?: SupabaseClient | null,
): Promise<StoreResult<void>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  if (files.length > 0) {
    const now = new Date().toISOString();
    const rows = files.map((file) => ({
      project_id: projectId,
      path: file.path,
      content: file.content,
      updated_at: now,
    }));
    const { error } = await dbc
      .from("project_files")
      .upsert(rows, { onConflict: "project_id,path" });
    if (error) return dbError("write files", error.message, error.code);
  }

  if (deletedPaths.length > 0) {
    const { error } = await dbc
      .from("project_files")
      .delete()
      .eq("project_id", projectId)
      .in("path", [...deletedPaths]);
    if (error) return dbError("delete files", error.message, error.code);
  }

  await touchProject(userId, projectId, dbc);
  return { ok: true, data: undefined };
}

export async function insertFilesIfMissing(
  userId: string,
  projectId: string,
  files: readonly AgentFile[],
  supabase?: SupabaseClient | null,
): Promise<StoreResult<void>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };
  if (files.length === 0) return { ok: true, data: undefined };

  const now = new Date().toISOString();
  const rows = files.map((file) => ({
    project_id: projectId,
    path: file.path,
    content: file.content,
    updated_at: now,
  }));
  const { error } = await dbc
    .from("project_files")
    .upsert(rows, { onConflict: "project_id,path", ignoreDuplicates: true });
  if (error) return dbError("insert missing files", error.message, error.code);

  await touchProject(userId, projectId, dbc);
  return { ok: true, data: undefined };
}

export async function hasFile(projectId: string, path: string): Promise<boolean> {
  const supabase = await client();
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("project_files")
    .select("path")
    .eq("project_id", projectId)
    .eq("path", path)
    .limit(1);
  if (error) {
    console.error("[mavly] has file:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// ═══ DURABLE GENERATION JOBS (migration 10) ═════════════════════════════════
//
// One `project_runs` row is one job. These helpers only ever use the caller's
// RLS-scoped client, except `createGenerationJob`, which calls a SECURITY
// DEFINER RPC that verifies auth.uid() and project ownership itself.

export interface RunBatchRow {
  batch_index: number;
  paths: string[];
  path_hashes: Record<string, string>;
  source_hash: string;
  bytes: number;
  status: "done" | "failed";
}

export async function getRun(
  projectId: string,
  runId: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<RunRow | null>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("project_runs")
    .select(RUN_SELECT)
    .eq("id", runId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return dbError("get run", error.message, error.code);
  return { ok: true, data: (data as RunRow | null) ?? null };
}

export type GenerationAdmission =
  | { status: "created" | "existing"; run: RunRow }
  | { status: "conflict"; run: RunRow }
  | { status: "rate_limited"; scope: "user" | "global"; retryAfterSeconds: number };

export interface CreateGenerationJobInput {
  projectId: string;
  model: string;
  prompt: string;
  idempotencyKey?: string | null;
  /**
   * Decided by the server before admission: `worker` only for a project in the
   * enabled cohort. The default keeps every existing caller on the inline path.
   */
  dispatchMode?: DispatchMode;
}

/**
 * Atomic admission. If the RPC is missing (migration 10 not applied) this fails
 * closed with `MIGRATION_REQUIRED`; the route turns that into an actionable 503
 * rather than silently bypassing the distributed limits.
 */
export async function createGenerationJob(
  input: CreateGenerationJobInput,
): Promise<StoreResult<GenerationAdmission>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("create_generation_job", {
    p_project_id: input.projectId,
    p_model: input.model,
    p_prompt: input.prompt.slice(0, 32_000),
    p_idempotency_key: input.idempotencyKey ?? null,
    p_dispatch_mode: input.dispatchMode ?? "inline",
  });

  if (error) {
    const message = error.message ?? "admission failed";
    if (/function .*does not exist|Could not find the function/i.test(message) || error.code === "PGRST202" || error.code === "42883") {
      return {
        ok: false,
        error: "Generation-job admission needs migrations 10 and 16. Apply supabase/migrations/16_durable_generation_worker.sql.",
        code: "MIGRATION_REQUIRED",
      };
    }
    if (error.code === "28000" || /UNAUTHENTICATED/i.test(message)) {
      return { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" };
    }
    if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
      return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
    }
    return dbError("create generation job", message, error.code);
  }

  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
  const status = record?.status;
  const run = normalizeRun(record?.run);

  if ((status === "created" || status === "existing") && run) {
    return { ok: true, data: { status, run } };
  }
  if (status === "conflict" && run) {
    return { ok: true, data: { status: "conflict", run } };
  }
  if (status === "rate_limited") {
    const scope = record?.scope === "global" ? "global" : "user";
    const retry = Number(record?.retryAfterSeconds);
    return {
      ok: true,
      data: {
        status: "rate_limited",
        scope,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 30,
      },
    };
  }

  return dbError("create generation job", "Unexpected admission response", "UNKNOWN");
}

export function normalizeRun(value: unknown): RunRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.project_id !== "string") return null;
  return row as unknown as RunRow;
}

/** Atomic claim: only one inline caller can move a queued job to `validating`. */
export async function claimRun(projectId: string, runId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_runs")
    .update({ stage: "validating", claimed_at: now, heartbeat_at: now, last_progress_at: now })
    .eq("id", runId)
    .eq("project_id", projectId)
    // A worker-dispatched job belongs to the worker and must never be executed
    // by the inline `after()` path.
    .eq("dispatch_mode", "inline")
    .is("finished_at", null)
    .eq("stage", "queued")
    .select(RUN_SELECT)
    .maybeSingle();

  if (error) return dbError("claim run", error.message, error.code);
  return { ok: true, data: (data as RunRow | null) ?? null };
}

/**
 * Re-open a failed/interrupted run so it resumes from its persisted manifest
 * and verified batch checkpoints. It does not create a second run.
 *
 * ⚠️ THIS IS AN RPC, NOT A TABLE UPDATE. A resume must reset the durable job
 * attempt budget and clear every worker field; the authenticated UPDATE grant
 * (migration 16) deliberately cannot write those columns. Migration 16 is
 * required; an older database fails closed with `MIGRATION_REQUIRED`.
 */
export async function resumeRun(
  projectId: string,
  runId: string,
): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("resume_generation_job", {
    p_project_id: projectId,
    p_run_id: runId,
  });

  if (error) {
    const message = error.message ?? "resume failed";
    if (
      /function .*does not exist|Could not find the function/i.test(message) ||
      error.code === "PGRST202" ||
      error.code === "42883"
    ) {
      return {
        ok: false,
        error: "Generation-job resume needs migration 16. Apply supabase/migrations/16_durable_generation_worker.sql.",
        code: "MIGRATION_REQUIRED",
      };
    }
    if (error.code === "28000" || /UNAUTHENTICATED/i.test(message)) {
      return { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" };
    }
    if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
      return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
    }
    // `enforce_active_run_limit` re-checks the limits when the resume reopens
    // the row, so a rate-limited resume is a 429, not a generic failure.
    if (error.code === "P0001" && /RATE_LIMITED_USER/i.test(message)) {
      return {
        ok: false,
        error: "You already have the maximum number of generations running.",
        code: "RATE_LIMITED_USER",
      };
    }
    if (error.code === "P0001" && /RATE_LIMITED_GLOBAL/i.test(message)) {
      return {
        ok: false,
        error: "Mavly is at capacity right now.",
        code: "RATE_LIMITED_GLOBAL",
      };
    }
    if (error.code === "23505") {
      return { ok: false, error: "Another generation is already active for this project.", code: "CONFLICT" };
    }
    return dbError("resume run", message, error.code);
  }

  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
  if (record?.status !== "resumed") return { ok: true, data: null };
  const run = normalizeRun(record.run);
  return { ok: true, data: run };
}

export type HandoffStatus =
  | "handed_off"
  | "already_worker"
  | "no_checkpoint_progress"
  | "claim_mismatch"
  | "not_handoffable"
  | "cancelled"
  | "not_found";

export interface HandoffResult {
  status: HandoffStatus;
  checkpoints: number;
}

/**
 * Hand a LIVE inline run to the durable worker queue (migration 36).
 *
 * Production dispatch is platform-wide: the worker claims across all projects,
 * with no project allowlist. The only caller is `run-agent.ts`, which checks
 * `dispatchModeForProject` before handing an inline run to the queue.
 *
 * ⚠️ THIS IS NOT A FAILURE AND NOT A TERMINAL WRITE. A `handed_off` answer means
 * the run is now `retry_wait` for the worker, with its manifest and verified
 * checkpoints intact; the worker resumes from them rather than from zero.
 *
 * Every other answer is a refusal reason, and the caller must fall back to its
 * own terminal handling instead of pretending the hand-off happened.
 */
export async function handoffRunToWorker(input: {
  projectId: string;
  runId: string;
  claimedAt: string;
}): Promise<StoreResult<HandoffResult>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase.rpc("handoff_generation_job", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_claimed_at: input.claimedAt,
  });

  if (error) {
    const message = error.message ?? "hand-off failed";
    if (
      /function .*does not exist|Could not find the function/i.test(message) ||
      error.code === "PGRST202" ||
      error.code === "42883"
    ) {
      return {
        ok: false,
        error:
          "The inline-to-worker hand-off needs migration 36. Apply supabase/migrations/36_generation_worker_handoff.sql.",
        code: "MIGRATION_REQUIRED",
      };
    }
    if (error.code === "28000" || /UNAUTHENTICATED/i.test(message)) {
      return { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" };
    }
    if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
      return { ok: false, error: "You don't have access to this project.", code: "FORBIDDEN" };
    }
    /**
     * A credit-enforced project cannot be written by an authenticated caller at
     * all (migration 32's run-state guard). Those projects are worker-only, so a
     * hand-off should never reach here — if it does, it is a refusal, not a bug to
     * paper over.
     */
    if (/CREDIT_RUN_STATE_SERVER_ONLY|CREDIT_RESERVATION_REQUIRED/i.test(message)) {
      return { ok: false, error: "This project's runs are managed by the worker.", code: "FORBIDDEN" };
    }
    return dbError("hand off run", message, error.code);
  }

  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
  const status = record?.status;
  const checkpoints = Number(record?.checkpoints ?? 0);

  if (
    status === "handed_off" ||
    status === "already_worker" ||
    status === "no_checkpoint_progress" ||
    status === "claim_mismatch" ||
    status === "not_handoffable" ||
    status === "cancelled" ||
    status === "not_found"
  ) {
    return {
      ok: true,
      data: {
        status,
        checkpoints: Number.isFinite(checkpoints) && checkpoints > 0 ? Math.floor(checkpoints) : 0,
      },
    };
  }

  return { ok: false, error: "Unexpected hand-off response", code: "UNKNOWN" };
}

export interface RunProgressPatch {
  stage?: RunStage;
  /** When present, only the inline worker holding this claim may write progress. */
  expectedClaimedAt?: string;
  /** When present, only the worker holding this lease may write progress. */
  expectedLeaseToken?: string;
  leaseSeconds?: number;
  filesWritten?: number;
  checkpointCount?: number;
  batchCount?: number;
  attemptCount?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
  providerRequestId?: string | null;
  /**
   * The cumulative provider-attempt records for the run.
   *
   * ⚠️ WRITTEN BY THE WORKER BEFORE IT SCHEDULES A RETRY. Provider usage is
   * cumulative for the run, but a retry is a new invocation that only sees the
   * row, so the attempt records have to be persisted with the counters.
   */
  providerAttempts?: readonly unknown[];
  retryAfterSeconds?: number | null;
  errorCode?: string | null;
}

/**
 * Best-effort heartbeat/progress. A failure is logged, never user-facing.
 *
 * ⚠️ A WORKER HEARTBEAT ALSO RENEWS THE LEASE. The renewal is a service-role
 * RPC guarded by the fencing token; `false` means this worker no longer owns
 * the run and must stop writing. The caller checks that answer before its next
 * checkpoint.
 */
export async function heartbeatRun(
  runId: string,
  patch: RunProgressPatch = {},
  supabase?: SupabaseClient | null,
): Promise<boolean> {
  const dbc = await db(supabase);
  if (!dbc) return false;

  const now = new Date().toISOString();

  if (patch.expectedLeaseToken) {
    const { data, error } = await dbc.rpc("renew_generation_lease", {
      p_run_id: runId,
      p_lease_token: patch.expectedLeaseToken,
      p_lease_seconds: patch.leaseSeconds ?? WORKER_LEASE_SECONDS,
    });
    if (error) {
      console.error("[mavly] worker lease renewal failed:", error.message);
      emitGenerationEvent("generation.heartbeat_failed", { runId, reason: "renewal_error" });
      return false;
    }
    const record = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
    if (record?.status !== "renewed") {
      emitGenerationEvent("generation.lease_lost", { runId, reason: "renewal_rejected" });
      return false;
    }
  }

  const update: Record<string, unknown> = {};
  if (!patch.expectedLeaseToken) {
    // The renewal RPC already writes these for a worker.
    update.heartbeat_at = now;
    update.last_progress_at = now;
  }
  if (patch.stage !== undefined) update.stage = patch.stage;
  if (patch.filesWritten !== undefined) update.files_written = patch.filesWritten;
  if (patch.checkpointCount !== undefined) update.checkpoint_count = patch.checkpointCount;
  if (patch.batchCount !== undefined) update.batch_count = patch.batchCount;
  if (patch.attemptCount !== undefined) update.attempt_count = patch.attemptCount;
  if (patch.promptTokens !== undefined) update.prompt_tokens = patch.promptTokens;
  if (patch.completionTokens !== undefined) update.completion_tokens = patch.completionTokens;
  if (patch.totalTokens !== undefined) update.total_tokens = patch.totalTokens;
  if (patch.reasoningTokens !== undefined) update.reasoning_tokens = patch.reasoningTokens;
  if (patch.providerRequestId !== undefined) update.provider_request_id = patch.providerRequestId;
  if (patch.providerAttempts !== undefined) update.provider_attempts = patch.providerAttempts;
  if (patch.retryAfterSeconds !== undefined) update.retry_after_seconds = patch.retryAfterSeconds;
  if (patch.errorCode !== undefined) update.error_code = patch.errorCode;

  if (Object.keys(update).length === 0) return true;

  let query = dbc
    .from("project_runs")
    .update(update)
    .eq("id", runId)
    .is("finished_at", null);
  if (patch.expectedLeaseToken) {
    query = query.eq("lease_token", patch.expectedLeaseToken);
  } else if (patch.expectedClaimedAt) {
    query = query.eq("claimed_at", patch.expectedClaimedAt);
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) {
    console.error("[mavly] run heartbeat:", error.message);
    emitGenerationEvent("generation.heartbeat_failed", { runId, reason: "write_error" });
    return false;
  }
  if (!data) {
    emitGenerationEvent("generation.lease_lost", { runId, reason: "guard_not_matched" });
    return false;
  }
  return true;
}

/** Persist the plan. A failure is fatal for this attempt: resuming needs it. */
export async function setRunManifest(
  runId: string,
  manifest: unknown,
  expectedClaimedAt?: string,
  expectedLeaseToken?: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<void>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  let query = dbc
    .from("project_runs")
    .update({ generation_manifest: manifest, heartbeat_at: new Date().toISOString() })
    .eq("id", runId)
    .is("finished_at", null);
  if (expectedLeaseToken) {
    query = query.eq("lease_token", expectedLeaseToken);
  } else if (expectedClaimedAt) {
    query = query.eq("claimed_at", expectedClaimedAt);
  }
  const { data, error } = await query.select("id").maybeSingle();

  if (error) return dbError("save run manifest", error.message, error.code);
  if (!data) return { ok: false, error: "The run was superseded by a newer attempt.", code: "CONFLICT" };
  return { ok: true, data: undefined };
}

function hashFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sourceHashFor(hashes: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(hashes).sort((a, b) => a.localeCompare(b))) {
    hash.update(path);
    hash.update("\u0000");
    hash.update(hashes[path]);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Persist one validated batch ATOMICALLY: the files and the checkpoint row are
 * written in one database transaction, fenced by the current claim.
 *
 * ⚠️ THIS REPLACED THE WRITE-THEN-CHECKPOINT PAIR. A crash between the two used
 * to leave files without a resumable checkpoint. The RPC now verifies the claim
 * first, so a stale worker writes nothing at all.
 */
export async function recordRunBatch(input: {
  runId: string;
  projectId: string;
  batchIndex: number;
  files: readonly AgentFile[];
  filesWritten: number;
  /** Inline claim token. Ignored when `leaseToken` is present. */
  expectedClaimedAt?: string;
  /** Worker fencing token. */
  leaseToken?: string;
  /** The owner the worker verified. Required by the service-role path. */
  userId?: string;
  leaseSeconds?: number;
  supabase?: SupabaseClient | null;
}): Promise<StoreResult<RunBatchRow>> {
  const dbc = await db(input.supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const pathHashes: Record<string, string> = {};
  let bytes = 0;
  for (const file of input.files) {
    pathHashes[file.path] = hashFileContent(file.content);
    bytes += Buffer.byteLength(file.content, "utf8");
  }
  const sourceHash = sourceHashFor(pathHashes);

  const { data, error } = await dbc.rpc("persist_generation_batch", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_lease_token: input.leaseToken ?? null,
    p_claimed_at: input.leaseToken ? null : input.expectedClaimedAt ?? null,
    p_user_id: input.leaseToken ? input.userId ?? null : null,
    p_batch_index: input.batchIndex,
    p_files: input.files.map((file) => ({ path: file.path, content: file.content })),
    p_path_hashes: pathHashes,
    p_source_hash: sourceHash,
    p_bytes: bytes,
    p_files_written: input.filesWritten,
    p_lease_seconds: input.leaseSeconds ?? WORKER_LEASE_SECONDS,
  });

  if (error) {
    const message = error.message ?? "batch checkpoint failed";
    if (
      /function .*does not exist|Could not find the function/i.test(message) ||
      error.code === "PGRST202" ||
      error.code === "42883"
    ) {
      return {
        ok: false,
        error: "Atomic batch checkpoints need migration 16. Apply supabase/migrations/16_durable_generation_worker.sql.",
        code: "MIGRATION_REQUIRED",
      };
    }
    if (/LEASE_LOST/i.test(message) || error.code === "P0001") {
      return { ok: false, error: "The run is no longer owned by this attempt.", code: "LEASE_LOST" };
    }
    if (/INVALID_PATH|INVALID_BATCH/i.test(message)) {
      return { ok: false, error: "A generated batch was rejected by the store.", code: "INVALID_BATCH" };
    }
    if (error.code === "42501" || /FORBIDDEN/i.test(message)) {
      return { ok: false, error: "This batch does not belong to the caller.", code: "FORBIDDEN" };
    }
    return dbError("record run batch", message, error.code);
  }

  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  return {
    ok: true,
    data: {
      batch_index: Number(record.batch_index ?? input.batchIndex),
      paths: stringArray(record.paths),
      path_hashes: stringRecord(record.path_hashes),
      source_hash: typeof record.source_hash === "string" ? record.source_hash : sourceHash,
      bytes: Number(record.bytes ?? bytes),
      status: record.status === "failed" ? "failed" : "done",
    },
  };
}

export async function listRunBatches(
  runId: string,
  supabase?: SupabaseClient | null,
): Promise<StoreResult<RunBatchRow[]>> {
  const dbc = await db(supabase);
  if (!dbc) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await dbc
    .from("project_run_batches")
    .select("batch_index,paths,path_hashes,source_hash,bytes,status")
    .eq("run_id", runId)
    .order("batch_index", { ascending: true });

  if (error) return dbError("list run batches", error.message, error.code);

  return {
    ok: true,
    data: ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      batch_index: Number(row.batch_index ?? 0),
      paths: stringArray(row.paths),
      path_hashes: stringRecord(row.path_hashes),
      source_hash: typeof row.source_hash === "string" ? row.source_hash : "",
      bytes: Number(row.bytes ?? 0),
      status: row.status === "failed" ? "failed" : "done",
    })),
  };
}

// ═══ WORKER-ONLY RPCs (service_role) ════════════════════════════════════════
//
// These wrappers are called only by the generation worker with the service-role
// client. They are declared here so every database shape stays in one module;
// the scheduled entrypoint and worker never build PostgREST calls of their own.

function isMissingFunction(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return (
    /function .*does not exist|Could not find the function/i.test(error.message ?? "") ||
    error.code === "PGRST202" ||
    error.code === "42883"
  );
}

/** The current worker-schema marker (32). `null` means this database cannot run the worker. */
export async function generationWorkerSchemaVersion(
  supabase: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("generation_worker_schema_version");
  if (error) {
    if (isMissingFunction(error)) return null;
    console.error("[mavly] worker schema check:", error.message);
    return null;
  }
  const version = typeof data === "number" ? data : Number(data);
  return Number.isInteger(version) ? version : 0;
}

/** Migration 49 is required before workers can safely run account-owned work. */
export async function accountRestrictionSchemaVersion(
  supabase: SupabaseClient,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("account_restriction_schema_version");
  if (error) {
    if (isMissingFunction(error)) return null;
    console.error("[mavly] account restriction schema check:", error.code ?? "unknown");
    return null;
  }
  const version = typeof data === "number" ? data : Number(data);
  return Number.isInteger(version) ? version : 0;
}

/** One atomic claim. The raw answer is verified by `parseClaimResult`. */
export async function claimWorkerJob(
  supabase: SupabaseClient,
  input: { workerId: string; leaseSeconds: number },
): Promise<StoreResult<unknown>> {
  const { data, error } = await supabase.rpc("claim_generation_job", {
    p_worker_id: input.workerId,
    p_lease_seconds: input.leaseSeconds,
    p_project_ids: null,
  });
  if (error) {
    if (isMissingFunction(error)) {
      return { ok: false, error: "Generation worker storage is not installed.", code: "MIGRATION_REQUIRED" };
    }
    if (error.code === "42501" || /FORBIDDEN/i.test(error.message ?? "")) {
      return { ok: false, error: "The worker is not authorized to claim jobs.", code: "FORBIDDEN" };
    }
    return dbError("claim worker job", error.message ?? "claim failed", error.code);
  }
  return { ok: true, data };
}

/** Recover expired leases into bounded retries or dead letters. */
export async function recoverExpiredGenerationLeases(
  supabase: SupabaseClient,
  limit = 5,
): Promise<StoreResult<unknown>> {
  const { data, error } = await supabase.rpc("recover_expired_generation_leases", {
    p_limit: limit,
  });
  if (error) {
    if (isMissingFunction(error)) {
      return { ok: false, error: "Generation worker storage is not installed.", code: "MIGRATION_REQUIRED" };
    }
    return dbError("recover expired leases", error.message ?? "recovery failed", error.code);
  }
  return { ok: true, data };
}

export type RetrySchedule =
  | { status: "retry"; retryAfterSeconds: number; retryAt: string | null; attempt: number }
  | { status: "dead_letter"; attempt: number; maxAttempts: number }
  | { status: "lost"; stage: string | null };

/**
 * Record a failed worker attempt. The RPC owns the retry-vs-dead-letter
 * decision; the worker only supplies the classification and a retry hint.
 */
export async function scheduleGenerationRetry(
  supabase: SupabaseClient,
  input: {
    runId: string;
    leaseToken: string;
    errorClass: string;
    errorSummary: string;
    retryAfterSeconds: number;
  },
): Promise<StoreResult<RetrySchedule>> {
  const { data, error } = await supabase.rpc("schedule_generation_retry", {
    p_run_id: input.runId,
    p_lease_token: input.leaseToken,
    p_error_class: input.errorClass.slice(0, 80),
    p_error_summary: input.errorSummary.slice(0, 1_000),
    p_retry_after_seconds: Math.max(1, Math.min(3_600, Math.round(input.retryAfterSeconds))),
  });
  if (error) {
    if (isMissingFunction(error)) {
      return { ok: false, error: "Generation worker storage is not installed.", code: "MIGRATION_REQUIRED" };
    }
    return dbError("schedule generation retry", error.message ?? "retry failed", error.code);
  }

  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  if (record.status === "lost") {
    return {
      ok: true,
      data: { status: "lost", stage: typeof record.stage === "string" ? record.stage : null },
    };
  }
  if (record.status === "dead_letter") {
    return {
      ok: true,
      data: {
        status: "dead_letter",
        attempt: Number(record.attempt ?? 0),
        maxAttempts: Number(record.maxAttempts ?? 0),
      },
    };
  }
  if (record.status === "retry") {
    const retryAfter = Number(record.retryAfterSeconds);
    return {
      ok: true,
      data: {
        status: "retry",
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 15,
        retryAt: typeof record.retryAt === "string" ? record.retryAt : null,
        attempt: Number(record.attempt ?? 0),
      },
    };
  }
  return { ok: false, error: "Unexpected retry response", code: "UNKNOWN" };
}

/** Renew the lease during a long attempt. `false` means this worker lost it. */
export async function renewWorkerLease(
  supabase: SupabaseClient,
  runId: string,
  leaseToken: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("renew_generation_lease", {
    p_run_id: runId,
    p_lease_token: leaseToken,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    console.error("[mavly] worker lease renewal failed:", error.message);
    return false;
  }
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
  return record?.status === "renewed";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
}
