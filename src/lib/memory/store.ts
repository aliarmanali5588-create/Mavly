/**
 * Persistence for project memory.
 *
 * ⚠️ NO SECOND DATABASE OR VECTOR STORE. Memory is a small relational table with
 * deterministic retrieval. Every query repeats the project AND user predicate;
 * RLS enforces the same ownership for session callers, while the worker's
 * service-role client is used only after run-agent re-verified the owner.
 *
 * ⚠️ USER WRITES ARE DECISIONS. Observed `failure` rows are written by the
 * server through `upsertFailureMemory`; the authenticated table policy forbids a
 * client from creating or updating one.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MemoryCategory, MemoryConfidence, MemoryStatus } from "./types";

export interface MemoryRow {
  id: string;
  project_id: string;
  category: MemoryCategory;
  content: string;
  provenance: string;
  source_kind: "user" | "run" | "system";
  authority: "user" | "observed" | "repository";
  approval_state: "approved" | "proposed" | "not_required";
  confidence: MemoryConfidence;
  status: MemoryStatus;
  dedupe_key: string;
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export type MemoryFailureCode =
  | "unavailable"
  | "migration_required"
  | "unauthorized"
  | "validation"
  | "conflict"
  | "not_found"
  | "error";

export interface MemoryFailure {
  ok: false;
  code: MemoryFailureCode;
  error: string;
}

export type MemoryResult<T> = { ok: true; data: T } | MemoryFailure;

export function isMemoryFailure<T>(result: MemoryResult<T>): result is MemoryFailure {
  return result.ok === false;
}

const COLUMNS =
  "id,project_id,category,content,provenance,source_kind,authority,approval_state,confidence,status,dedupe_key,revision,created_at,updated_at,expires_at";

function failure(code: MemoryFailureCode, error: string): MemoryFailure {
  return { ok: false, code, error };
}

function mapDatabaseError(scope: string, error: { code?: string } | null): MemoryFailure {
  const code = error?.code ?? "unknown";
  console.error(`[memory] ${scope} failed (${code})`);
  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205"
  ) {
    return failure(
      "migration_required",
      "Project memory storage is not installed. Apply supabase/migrations/24_agent_memory.sql.",
    );
  }
  if (code === "42501" || code === "28000") {
    return failure("unauthorized", "This project is not authorized for that memory operation.");
  }
  if (code === "23505") {
    return failure("conflict", "A memory with that topic already exists. Edit the existing decision.");
  }
  if (code === "23514" || code === "22023") {
    return failure("validation", "The memory record was rejected as invalid.");
  }
  return failure("error", "Could not complete the memory operation.");
}

async function resolveClient(
  client: SupabaseClient | null | undefined,
): Promise<SupabaseClient | null> {
  return client ?? (await createSupabaseServerClient());
}

export async function listMemories(input: {
  client?: SupabaseClient | null;
  projectId: string;
  userId: string;
  activeOnly: boolean;
  limit?: number;
}): Promise<MemoryResult<MemoryRow[]>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const limit = Math.max(1, Math.min(100, input.limit ?? (input.activeOnly ? 30 : 100)));
  let query = supabase
    .from("project_memories")
    .select(COLUMNS)
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId);
  if (input.activeOnly) query = query.eq("status", "active");

  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) return mapDatabaseError("list", error);
  const now = Date.now();
  const rows = ((data ?? []) as MemoryRow[]).filter(
    (row) => !row.expires_at || Date.parse(row.expires_at) > now,
  );
  return { ok: true, data: rows };
}

export async function countProjectMemories(input: {
  client?: SupabaseClient | null;
  projectId: string;
  userId: string;
}): Promise<MemoryResult<number>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  /**
   * The cap is only 50, so a bounded page is enough and avoids a complex
   * PostgREST `or` expression containing an ISO timestamp.
   */
  const { data, error } = await supabase
    .from("project_memories")
    .select("id,expires_at")
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .neq("status", "archived")
    .limit(100);

  if (error) return mapDatabaseError("count", error);
  const now = Date.now();
  const count = ((data ?? []) as { expires_at: string | null }[]).filter(
    (row) => !row.expires_at || Date.parse(row.expires_at) > now,
  ).length;
  return { ok: true, data: count };
}

export async function insertUserDecision(input: {
  client?: SupabaseClient | null;
  id: string;
  projectId: string;
  userId: string;
  content: string;
  dedupeKey: string;
  now: string;
}): Promise<MemoryResult<MemoryRow>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_memories")
    .insert({
      id: input.id,
      project_id: input.projectId,
      user_id: input.userId,
      category: "decision",
      content: input.content,
      provenance: "user",
      source_kind: "user",
      authority: "user",
      approval_state: "approved",
      confidence: "verified",
      status: "active",
      dedupe_key: input.dedupeKey,
      revision: 1,
      created_at: input.now,
      updated_at: input.now,
      expires_at: null,
    })
    .select(COLUMNS)
    .single();

  if (error) return mapDatabaseError("create decision", error);
  return { ok: true, data: data as MemoryRow };
}

/**
 * Server-only observation. Upsert keeps one note per `(project, run)` even when
 * a worker retries; it never creates a decision. Failure notes expire.
 */
export async function upsertFailureMemory(input: {
  client?: SupabaseClient | null;
  projectId: string;
  userId: string;
  runId: string;
  content: string;
  expiresAt: string;
  now: string;
}): Promise<MemoryResult<MemoryRow>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_memories")
    .upsert(
      {
        project_id: input.projectId,
        user_id: input.userId,
        category: "failure",
        content: input.content,
        provenance: `run:${input.runId}`,
        source_kind: "run",
        authority: "observed",
        approval_state: "not_required",
        confidence: "verified",
        status: "active",
        dedupe_key: `run:${input.runId}`,
        updated_at: input.now,
        expires_at: input.expiresAt,
      },
      { onConflict: "project_id,category,dedupe_key" },
    )
    .select(COLUMNS)
    .single();

  if (error) return mapDatabaseError("record failure", error);
  return { ok: true, data: data as MemoryRow };
}

/**
 * Inline-generation failure path. The authenticated owner may ask the server to
 * derive a note from THEIR OWN terminal run; it accepts no content or decision
 * fields, and the RPC re-checks ownership and the run's terminal status.
 */
export async function recordRunFailureMemoryForOwner(input: {
  client?: SupabaseClient | null;
  projectId: string;
  runId: string;
}): Promise<MemoryResult<null>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { error } = await supabase.rpc("record_run_failure_memory", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
  });
  if (error) return mapDatabaseError("record owner failure", error);
  return { ok: true, data: null };
}

export async function updateUserDecision(input: {
  client?: SupabaseClient | null;
  id: string;
  projectId: string;
  userId: string;
  revision: number;
  content?: string;
  status?: "active" | "archived";
  now: string;
}): Promise<MemoryResult<MemoryRow>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const patch: Record<string, unknown> = {
    revision: input.revision + 1,
    updated_at: input.now,
  };
  if (input.content !== undefined) patch.content = input.content;
  if (input.status !== undefined) {
    patch.status = input.status;
    // Activating a proposed decision is the user's approval; never inferred.
    if (input.status === "active") patch.approval_state = "approved";
  }

  const { data, error } = await supabase
    .from("project_memories")
    .update(patch)
    .eq("id", input.id)
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .eq("category", "decision")
    .eq("revision", input.revision)
    .select(COLUMNS)
    .maybeSingle();

  if (error) return mapDatabaseError("update", error);
  if (!data) {
    return failure("conflict", "That decision changed or was removed. Refresh and try again.");
  }
  return { ok: true, data: data as MemoryRow };
}

export async function deleteMemory(input: {
  client?: SupabaseClient | null;
  id: string;
  projectId: string;
  userId: string;
}): Promise<MemoryResult<{ deleted: true }>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_memories")
    .delete()
    .eq("id", input.id)
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .select("id")
    .maybeSingle();

  if (error) return mapDatabaseError("delete", error);
  if (!data) return failure("not_found", "Memory not found.");
  return { ok: true, data: { deleted: true } };
}

export async function deleteAllProjectMemory(input: {
  client?: SupabaseClient | null;
  projectId: string;
  userId: string;
}): Promise<MemoryResult<{ deleted: number }>> {
  const supabase = await resolveClient(input.client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_memories")
    .delete()
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .select("id");

  if (error) return mapDatabaseError("clear", error);
  return { ok: true, data: { deleted: (data ?? []).length } };
}
