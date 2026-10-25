/**
 * Persistence for project secrets.
 *
 * Every query uses the caller's RLS-scoped Supabase client and repeats both the
 * project and user predicate. The table policy additionally requires an owned
 * parent row, so a secret id from another project is simply not found.
 *
 * ⚠️ ONLY CIPHERTEXT IS WRITTEN. Reads select metadata columns only; the
 * database grants prevent the authenticated role from selecting
 * `value_ciphertext` at all.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SecretEnvironment } from "./validation";

export interface ProjectSecretMetadataRow {
  id: string;
  project_id: string;
  secret_name: string;
  environment: SecretEnvironment;
  created_at: string;
  updated_at: string;
}

export type ProjectSecretStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "conflict"
  | "not_found"
  | "error";

export interface ProjectSecretStoreFailure {
  ok: false;
  code: ProjectSecretStoreFailureCode;
  error: string;
}

export type ProjectSecretStoreResult<T> =
  | { ok: true; data: T }
  | ProjectSecretStoreFailure;

export function isProjectSecretStoreFailure<T>(
  result: ProjectSecretStoreResult<T>,
): result is ProjectSecretStoreFailure {
  return result.ok === false;
}

const METADATA_COLUMNS =
  "id,project_id,secret_name,environment,created_at,updated_at";

function failure(
  code: ProjectSecretStoreFailureCode,
  error: string,
): ProjectSecretStoreFailure {
  return { ok: false, code, error };
}

/**
 * Map a PostgREST/Postgres error to an actionable failure without ever logging
 * the statement, the row, or any submitted value.
 */
function mapDatabaseError(scope: string, error: { code?: string } | null): ProjectSecretStoreFailure {
  const code = error?.code ?? "unknown";
  console.error(`[project-secrets] ${scope} failed (${code})`);

  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST205"
  ) {
    return failure(
      "migration_required",
      "Project secret storage is not installed. Apply supabase/migrations/11_project_secrets.sql.",
    );
  }
  if (code === "42501") {
    return failure(
      "unavailable",
      "Project secret storage is not accessible with the current database permissions.",
    );
  }
  if (code === "23505") {
    return failure(
      "conflict",
      "A secret with that name already exists for that environment.",
    );
  }
  return failure("error", "Could not complete the secret operation.");
}

export async function listProjectSecretMetadata(
  projectId: string,
  userId: string,
): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_secrets")
    .select(METADATA_COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .order("secret_name", { ascending: true })
    .order("environment", { ascending: true });

  if (error) return mapDatabaseError("list", error);
  return { ok: true, data: (data ?? []) as ProjectSecretMetadataRow[] };
}

export async function insertProjectSecret(input: {
  id: string;
  projectId: string;
  userId: string;
  secretName: string;
  environment: SecretEnvironment;
  valueCiphertext: string;
  now: string;
}): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_secrets")
    .insert({
      id: input.id,
      project_id: input.projectId,
      user_id: input.userId,
      secret_name: input.secretName,
      environment: input.environment,
      value_ciphertext: input.valueCiphertext,
      created_at: input.now,
      updated_at: input.now,
    })
    .select(METADATA_COLUMNS)
    .single();

  if (error) return mapDatabaseError("create", error);
  return { ok: true, data: data as ProjectSecretMetadataRow };
}

export async function updateProjectSecretRow(input: {
  id: string;
  projectId: string;
  userId: string;
  secretName?: string;
  environment?: SecretEnvironment;
  valueCiphertext?: string;
  now: string;
}): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const patch: Record<string, unknown> = { updated_at: input.now };
  if (input.secretName !== undefined) patch.secret_name = input.secretName;
  if (input.environment !== undefined) patch.environment = input.environment;
  if (input.valueCiphertext !== undefined) patch.value_ciphertext = input.valueCiphertext;

  const { data, error } = await supabase
    .from("project_secrets")
    .update(patch)
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .eq("id", input.id)
    .select(METADATA_COLUMNS)
    .maybeSingle();

  if (error) return mapDatabaseError("update", error);
  if (!data) return failure("not_found", "Secret not found.");
  return { ok: true, data: data as ProjectSecretMetadataRow };
}

export async function deleteProjectSecretRow(
  projectId: string,
  userId: string,
  secretId: string,
): Promise<ProjectSecretStoreResult<{ deleted: true }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("project_secrets")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .eq("id", secretId)
    .select("id")
    .maybeSingle();

  if (error) return mapDatabaseError("delete", error);
  if (!data) return failure("not_found", "Secret not found.");
  return { ok: true, data: { deleted: true } };
}
