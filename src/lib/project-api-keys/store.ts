/**
 * Persistence for project API keys. Keys are stored as hashes only.
 */

import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface ProjectApiKeyRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_last4: string;
  scopes: string[];
  env: "live" | "dev" | "both";
  managed: "app" | "env" | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type ProjectApiKeyStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "conflict"
  | "not_found"
  | "error";

export interface ProjectApiKeyStoreFailure {
  ok: false;
  code: ProjectApiKeyStoreFailureCode;
  error: string;
}

export type ProjectApiKeyStoreResult<T> =
  | { ok: true; data: T }
  | ProjectApiKeyStoreFailure;

export function isProjectApiKeyStoreFailure<T>(
  result: ProjectApiKeyStoreResult<T>,
): result is ProjectApiKeyStoreFailure {
  return result.ok === false;
}

const COLUMNS =
  "id,project_id,user_id,name,key_prefix,key_last4,scopes,env,managed,created_at,last_used_at,revoked_at";

function failure(
  code: ProjectApiKeyStoreFailureCode,
  error: string,
): ProjectApiKeyStoreFailure {
  return { ok: false, code, error };
}

function mapDatabaseError(scope: string, error: { code?: string } | null): ProjectApiKeyStoreFailure {
  const code = error?.code ?? "unknown";
  console.error(`[project-api-keys] ${scope} failed (${code})`);

  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205"
  ) {
    return failure(
      "migration_required",
      "Project API key storage is not installed. Apply supabase/migrations/12_project_api_keys.sql.",
    );
  }
  if (code === "42501") {
    return failure(
      "unavailable",
      "Project API key storage is not accessible with the current database permissions.",
    );
  }
  if (code === "23505") {
    return failure("conflict", "A key with that configuration already exists.");
  }
  return failure("error", "Could not complete the API key operation.");
}

export async function listProjectApiKeys(
  projectId: string,
  userId: string,
): Promise<ProjectApiKeyStoreResult<ProjectApiKeyRow[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_api_keys")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) return mapDatabaseError("list", error);
  // Ensure scopes is array
  const rows = (data ?? []).map((row: any) => ({
    ...row,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  })) as ProjectApiKeyRow[];
  return { ok: true, data: rows };
}

export async function insertProjectApiKey(input: {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  keyLast4: string;
  scopes: string[];
  env: "live" | "dev" | "both";
  managed?: "app" | "env" | null;
  now: string;
}): Promise<ProjectApiKeyStoreResult<ProjectApiKeyRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_api_keys")
    .insert({
      id: input.id,
      project_id: input.projectId,
      user_id: input.userId,
      name: input.name,
      key_prefix: input.keyPrefix,
      key_hash: input.keyHash,
      key_last4: input.keyLast4,
      scopes: input.scopes,
      env: input.env,
      managed: input.managed ?? null,
      created_at: input.now,
      last_used_at: null,
      revoked_at: null,
    })
    .select(COLUMNS)
    .single();

  if (error) return mapDatabaseError("create", error);
  const row = {
    ...(data as any),
    scopes: Array.isArray((data as any)?.scopes) ? (data as any).scopes : [],
  } as ProjectApiKeyRow;
  return { ok: true, data: row };
}

export async function revokeProjectApiKey(
  projectId: string,
  userId: string,
  keyId: string,
  now: string,
): Promise<ProjectApiKeyStoreResult<ProjectApiKeyRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  // First check if key exists and is owned/custom? UI allows revoke for custom keys
  const { data: existing, error: fetchErr } = await supabase
    .from("project_api_keys")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("id", keyId)
    .maybeSingle();

  if (fetchErr) return mapDatabaseError("revoke_fetch", fetchErr);
  if (!existing) return failure("not_found", "Key not found.");

  const { data, error } = await supabase
    .from("project_api_keys")
    .update({ revoked_at: now })
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("id", keyId)
    .select(COLUMNS)
    .maybeSingle();

  if (error) return mapDatabaseError("revoke", error);
  if (!data) return failure("not_found", "Key not found.");
  const row = {
    ...(data as any),
    scopes: Array.isArray((data as any)?.scopes) ? (data as any).scopes : [],
  } as ProjectApiKeyRow;
  return { ok: true, data: row };
}

export async function rotateProjectApiKey(
  projectId: string,
  userId: string,
  keyId: string,
  input: {
    keyPrefix: string;
    keyHash: string;
    keyLast4: string;
    now: string;
  },
): Promise<ProjectApiKeyStoreResult<ProjectApiKeyRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  // For rotation, we need to create a new key or update - UI expects to get new plaintext back
  // Create a new key entry (rotation typically gives new key). We'll create new one with same name/scopes/env/managed.
  const { data: existing, error: fetchErr } = await supabase
    .from("project_api_keys")
    .select(COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("id", keyId)
    .maybeSingle();

  if (fetchErr) return mapDatabaseError("rotate_fetch", fetchErr);
  if (!existing) return failure("not_found", "Key not found.");

  // Revoke old
  await supabase
    .from("project_api_keys")
    .update({ revoked_at: input.now })
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("id", keyId);

  const newId = randomUUID();
  const { data, error } = await supabase
    .from("project_api_keys")
    .insert({
      id: newId,
      project_id: projectId,
      user_id: userId,
      name: (existing as any).name,
      key_prefix: input.keyPrefix,
      key_hash: input.keyHash,
      key_last4: input.keyLast4,
      scopes: (existing as any).scopes ?? [],
      env: (existing as any).env,
      managed: (existing as any).managed ?? null,
      created_at: input.now,
      last_used_at: null,
      revoked_at: null,
    })
    .select(COLUMNS)
    .single();

  if (error) return mapDatabaseError("rotate_create", error);
  const row = {
    ...(data as any),
    scopes: Array.isArray((data as any)?.scopes) ? (data as any).scopes : [],
  } as ProjectApiKeyRow;
  return { ok: true, data: row };
}
