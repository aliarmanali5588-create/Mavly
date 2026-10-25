/**
 * Mavly's local persistence layer.
 *
 * Every function uses the caller's own Supabase session client, never a
 * service-role key. RLS on public.projects and its child tables is the access
 * boundary. Project queries also repeat the `user_id` predicate; child queries
 * rely on the ownership policies, which require an owned parent row.
 */

import { createHash } from "node:crypto";

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AgentFile } from "@/lib/ai/agent";

export interface ProjectRow {
  project_id: string;
  user_id: string;
  label: string | null;
  description: string;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "init" | "done" | "error";

export type RunStage =
  | "queued"
  | "validating"
  | "generating"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  "id,project_id,status,stage,model,prompt,started_at,finished_at,error_message,heartbeat_at,claimed_at,last_progress_at,idempotency_key,attempt_count,provider_request_id,model_used,finish_reason,prompt_tokens,completion_tokens,total_tokens,reasoning_tokens,retry_after_seconds,error_code,provider_attempts,generation_manifest,checkpoint_count,files_written,batch_count";

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

function dbError(scope: string, message: string, code?: string): StoreResult<never> {
  console.error(`[mavly] ${scope}:`, message);
  return { ok: false, error: message, code };
}

export async function createOwnedProject(
  userId: string,
  requestedId: string,
  description: string,
  label?: string | null,
): Promise<StoreResult<ProjectRow>> {
  if (!isRoutableProjectSlug(requestedId)) {
    return { ok: false, error: "Invalid project id", code: "VALIDATION" };
  }

  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  let candidate = requestedId;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await supabase
      .from("projects")
      .insert({
        project_id: candidate,
        user_id: userId,
        description: description.slice(0, 2_000),
        label: label?.slice(0, 120) || null,
      })
      .select("project_id,user_id,label,description,created_at,updated_at")
      .single();

    if (!error && data) return { ok: true, data: data as ProjectRow };
    if (error?.code !== "23505") {
      return dbError("create project", error?.message ?? "insert failed", error?.code);
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

export async function listProjects(userId: string): Promise<StoreResult<ProjectRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("projects")
    .select("project_id,user_id,label,description,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) return dbError("list projects", error.message, error.code);
  return { ok: true, data: (data ?? []) as ProjectRow[] };
}

export async function getProject(userId: string, projectId: string): Promise<StoreResult<ProjectRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("projects")
    .select("project_id,user_id,label,description,created_at,updated_at")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return dbError("get project", error.message, error.code);
  return { ok: true, data: (data as ProjectRow | null) ?? null };
}

export async function updateProject(
  userId: string,
  projectId: string,
  patch: { label?: string | null; description?: string },
): Promise<StoreResult<ProjectRow>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) updates.label = patch.label?.slice(0, 120) || null;
  if (patch.description !== undefined) updates.description = patch.description.slice(0, 2_000);

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .select("project_id,user_id,label,description,created_at,updated_at")
    .single();

  if (error || !data) return dbError("update project", error?.message ?? "update failed", error?.code);
  return { ok: true, data: data as ProjectRow };
}

export async function touchProject(userId: string, projectId: string): Promise<void> {
  const supabase = await client();
  if (!supabase) return;
  const { error } = await supabase
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
  /** The claim this worker owns. A resumed run has a different `claimed_at`. */
  expectedClaimedAt?: string;
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
): Promise<boolean> {
  const supabase = await client();
  if (!supabase) return false;
  const now = new Date().toISOString();
  const stage: RunStage =
    patch.stage ??
    (status === "done" ? "completed" : status === "cancelled" ? "cancelled" : "failed");

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
  if (patch.providerAttempts !== undefined) {
    update.provider_attempts = boundedAttempts(patch.providerAttempts);
  }

  let query = supabase
    .from("project_runs")
    .update(update)
    .eq("id", runId)
    .is("finished_at", null);
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

export async function latestRun(projectId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
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
): Promise<StoreResult<MessageRow>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
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

export async function listFiles(projectId: string): Promise<StoreResult<FileRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
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
): Promise<StoreResult<void>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  if (files.length > 0) {
    const now = new Date().toISOString();
    const rows = files.map((file) => ({
      project_id: projectId,
      path: file.path,
      content: file.content,
      updated_at: now,
    }));
    const { error } = await supabase
      .from("project_files")
      .upsert(rows, { onConflict: "project_id,path" });
    if (error) return dbError("write files", error.message, error.code);
  }

  if (deletedPaths.length > 0) {
    const { error } = await supabase
      .from("project_files")
      .delete()
      .eq("project_id", projectId)
      .in("path", [...deletedPaths]);
    if (error) return dbError("delete files", error.message, error.code);
  }

  await touchProject(userId, projectId);
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

export async function getRun(projectId: string, runId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
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
  });

  if (error) {
    const message = error.message ?? "admission failed";
    if (/function .*does not exist|Could not find the function/i.test(message) || error.code === "PGRST202" || error.code === "42883") {
      return { ok: false, error: "Generation job storage is not installed. Apply migration 10.", code: "MIGRATION_REQUIRED" };
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

function normalizeRun(value: unknown): RunRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.project_id !== "string") return null;
  return row as unknown as RunRow;
}

/** Atomic claim: only one caller can move a queued job to `validating`. */
export async function claimRun(projectId: string, runId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_runs")
    .update({ stage: "validating", claimed_at: now, heartbeat_at: now, last_progress_at: now })
    .eq("id", runId)
    .eq("project_id", projectId)
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
 */
export async function resumeRun(projectId: string, runId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_runs")
    .update({
      status: "init",
      stage: "queued",
      finished_at: null,
      error_message: null,
      error_code: null,
      retry_after_seconds: null,
      claimed_at: null,
      heartbeat_at: now,
      last_progress_at: now,
    })
    .eq("id", runId)
    .eq("project_id", projectId)
    .in("stage", ["interrupted", "failed"])
    .select(RUN_SELECT)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "Another generation is already active for this project.", code: "CONFLICT" };
    }
    if (/RATE_LIMITED_USER/.test(error.message ?? "")) {
      return { ok: false, error: "You already have the maximum number of generations running.", code: "RATE_LIMITED_USER" };
    }
    if (/RATE_LIMITED_GLOBAL/.test(error.message ?? "")) {
      return { ok: false, error: "Mavly is at capacity right now.", code: "RATE_LIMITED_GLOBAL" };
    }
    return dbError("resume run", error.message, error.code);
  }
  return { ok: true, data: (data as RunRow | null) ?? null };
}

export interface RunProgressPatch {
  stage?: RunStage;
  /** When present, only the worker holding this claim may write progress. */
  expectedClaimedAt?: string;
  filesWritten?: number;
  checkpointCount?: number;
  batchCount?: number;
  attemptCount?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  reasoningTokens?: number | null;
  providerRequestId?: string | null;
  retryAfterSeconds?: number | null;
  errorCode?: string | null;
}

/** Best-effort heartbeat/progress. A failure is logged, never user-facing. */
export async function heartbeatRun(runId: string, patch: RunProgressPatch = {}): Promise<void> {
  const supabase = await client();
  if (!supabase) return;

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    heartbeat_at: now,
    last_progress_at: now,
  };
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
  if (patch.retryAfterSeconds !== undefined) update.retry_after_seconds = patch.retryAfterSeconds;
  if (patch.errorCode !== undefined) update.error_code = patch.errorCode;

  let query = supabase
    .from("project_runs")
    .update(update)
    .eq("id", runId)
    .is("finished_at", null);
  if (patch.expectedClaimedAt) {
    query = query.eq("claimed_at", patch.expectedClaimedAt);
  }
  const { error } = await query;
  if (error) console.error("[mavly] run heartbeat:", error.message);
}

/** Persist the plan. A failure is fatal for this attempt: resuming needs it. */
export async function setRunManifest(
  runId: string,
  manifest: unknown,
  expectedClaimedAt?: string,
): Promise<StoreResult<void>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  let query = supabase
    .from("project_runs")
    .update({ generation_manifest: manifest, heartbeat_at: new Date().toISOString() })
    .eq("id", runId)
    .is("finished_at", null);
  if (expectedClaimedAt) {
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
 * Persist one validated batch. The row records a per-path hash of exactly what
 * was written, so a resume can verify the project still contains it.
 */
export async function recordRunBatch(input: {
  runId: string;
  projectId: string;
  batchIndex: number;
  files: readonly AgentFile[];
  filesWritten: number;
  expectedClaimedAt?: string;
}): Promise<StoreResult<RunBatchRow>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const pathHashes: Record<string, string> = {};
  let bytes = 0;
  for (const file of input.files) {
    pathHashes[file.path] = hashFileContent(file.content);
    bytes += Buffer.byteLength(file.content, "utf8");
  }
  const sourceHash = sourceHashFor(pathHashes);

  const row = {
    run_id: input.runId,
    project_id: input.projectId,
    batch_index: input.batchIndex,
    paths: Object.keys(pathHashes),
    path_hashes: pathHashes,
    source_hash: sourceHash,
    bytes,
    status: "done" as const,
    completed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("project_run_batches")
    .upsert(row, { onConflict: "run_id,batch_index" })
    .select("batch_index,paths,path_hashes,source_hash,bytes,status")
    .single();

  if (error || !data) {
    return dbError("record run batch", error?.message ?? "insert failed", error?.code);
  }

  await heartbeatRun(input.runId, {
    stage: "generating",
    checkpointCount: input.batchIndex + 1,
    batchCount: input.batchIndex + 1,
    filesWritten: input.filesWritten,
    expectedClaimedAt: input.expectedClaimedAt,
  });

  return {
    ok: true,
    data: {
      batch_index: Number((data as Record<string, unknown>).batch_index ?? input.batchIndex),
      paths: stringArray((data as Record<string, unknown>).paths),
      path_hashes: stringRecord((data as Record<string, unknown>).path_hashes),
      source_hash: String((data as Record<string, unknown>).source_hash ?? sourceHash),
      bytes: Number((data as Record<string, unknown>).bytes ?? bytes),
      status: (data as Record<string, unknown>).status === "failed" ? "failed" : "done",
    },
  };
}

export async function listRunBatches(runId: string): Promise<StoreResult<RunBatchRow[]>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
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
