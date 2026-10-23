/**
 * Mavly's local persistence layer.
 *
 * Every function uses the caller's own Supabase session client, never a
 * service-role key. RLS on public.projects and its child tables is the access
 * boundary. Project queries also repeat the `user_id` predicate; child queries
 * rely on the ownership policies, which require an owned parent row.
 */

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

export interface RunRow {
  id: string;
  project_id: string;
  status: "init" | "done" | "error";
  model: string;
  prompt: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
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

export async function createRun(
  projectId: string,
  model: string,
  prompt: string,
): Promise<StoreResult<RunRow>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_runs")
    .insert({ project_id: projectId, model, prompt: prompt.slice(0, 32_000) })
    .select("id,project_id,status,model,prompt,started_at,finished_at,error_message")
    .single();

  if (error || !data) return dbError("create run", error?.message ?? "insert failed", error?.code);
  return { ok: true, data: data as RunRow };
}

export async function finishRun(
  runId: string,
  status: "done" | "error",
  errorMessage?: string,
): Promise<void> {
  const supabase = await client();
  if (!supabase) return;
  const { error } = await supabase
    .from("project_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      error_message: errorMessage?.slice(0, 2_000) ?? null,
    })
    .eq("id", runId);
  if (error) console.error("[mavly] finish run:", error.message);
}

export async function latestRun(projectId: string): Promise<StoreResult<RunRow | null>> {
  const supabase = await client();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_runs")
    .select("id,project_id,status,model,prompt,started_at,finished_at,error_message")
    .eq("project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return dbError("latest run", error.message, error.code);
  return { ok: true, data: (data as RunRow | null) ?? null };
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
