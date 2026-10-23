/**
 * ═══ PROJECT OWNERSHIP — REGISTRATION AND FILTERED LISTING ═════════════════
 *
 * `public.projects` (migration 02) is the only local answer to "may this user
 * touch this project?", because the upstream Totalum key is account-wide. This
 * module writes that table after a project is created and reads it when an
 * account-wide listing has to be narrowed to the caller's own projects.
 *
 * ⚠️ NO PRIVILEGED CLIENT. Every read and write goes through the caller's own
 * session client (`@supabase/ssr`), so the RLS policies are the boundary: the
 * insert policy only accepts `user_id = auth.uid()`, and there is no UPDATE
 * policy at all. This file never reads a service-role key — this app has none.
 *
 * ⚠️ FAIL CLOSED. A database error is "we could not register" (the caller turns
 * it into an error response), never "assume it worked". An ownership row owned
 * by somebody else is a conflict, never an overwrite.
 *
 * ⚠️ THIS IS NOT A DISTRIBUTED TRANSACTION. Upstream creation and this insert
 * cannot be atomic. If the insert fails after upstream succeeded, the project
 * exists with no owner and the operator must reconcile it explicitly — see the
 * recovery note in `supabase/backfill-ownership.template.sql` and AGENTS.md.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The narrow database surface this module needs. Exported so tests can inject a
 * fake without standing up Supabase; production uses `sessionOwnershipWriter`.
 */
export interface OwnershipInsert {
  ok: boolean;
  /** The PostgREST/SQLSTATE code on failure; a unique violation is `23505`. */
  code?: string;
}

export interface OwnershipWriter {
  /** INSERT (project_id, user_id). A unique violation must surface as code 23505. */
  insert(projectId: string, userId: string): Promise<OwnershipInsert>;
  /** SELECT the row for this exact pair. RLS hides everybody else's rows. */
  owns(projectId: string, userId: string): Promise<"owned" | "not-owned" | "error">;
  /** SELECT every project_id visible to this caller. `null` = lookup failed. */
  listOwned(userId: string): Promise<string[] | null>;
}

export type OwnershipRegistration =
  | { ok: true; alreadyOwned: boolean }
  | { ok: false; reason: "invalid-project-id" | "conflict" | "unavailable" };

/** The caller's session client, or `null` when Supabase is not configured. */
async function sessionOwnershipWriter(): Promise<OwnershipWriter | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  return {
    async insert(projectId, userId) {
      const { error } = await supabase.from("projects").insert({
        project_id: projectId,
        user_id: userId,
      });
      return error ? { ok: false, code: error.code } : { ok: true };
    },

    async owns(projectId, userId) {
      const { data, error } = await supabase
        .from("projects")
        .select("project_id")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .limit(1);
      if (error) {
        console.error("[ownership] ownership re-check failed:", error.message);
        return "error";
      }
      return (data?.length ?? 0) > 0 ? "owned" : "not-owned";
    },

    async listOwned(userId) {
      const { data, error } = await supabase
        .from("projects")
        .select("project_id")
        .eq("user_id", userId);
      if (error) {
        console.error("[ownership] project list lookup failed:", error.message);
        return null;
      }
      return (data ?? [])
        .map((row) => row.project_id)
        .filter((id): id is string => typeof id === "string");
    },
  };
}

/**
 * Register the canonical upstream project id for the verified user.
 *
 * Idempotent by construction: a retry that finds the row already owned by the
 * SAME user succeeds (`alreadyOwned: true`). A unique violation means the id is
 * registered to somebody else — RLS hides that row, so the follow-up `owns()`
 * answers "not-owned" and this returns `conflict` rather than overwriting.
 */
export async function registerProjectOwnership(
  projectId: string,
  userId: string,
  writer?: OwnershipWriter,
): Promise<OwnershipRegistration> {
  if (!isRoutableProjectSlug(projectId)) return { ok: false, reason: "invalid-project-id" };

  const db = writer ?? (await sessionOwnershipWriter());
  if (!db) return { ok: false, reason: "unavailable" };

  const inserted = await db.insert(projectId, userId);
  if (inserted.ok) return { ok: true, alreadyOwned: false };

  if (inserted.code === "23505") {
    const ownership = await db.owns(projectId, userId);
    if (ownership === "owned") return { ok: true, alreadyOwned: true };
    if (ownership === "error") return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "conflict" };
  }

  /**
   * ⚠️ SANITIZED DIAGNOSTIC. The project id is already public in URLs and the
   * caller's dashboard; no user id, cookie, token or key is logged.
   */
  console.error(
    `[ownership] could not register project ${projectId} (db code ${inserted.code ?? "unknown"})`,
  );
  return { ok: false, reason: "unavailable" };
}

/**
 * The canonical id from a create/launch response.
 *
 * ⚠️ THE RESPONSE IS THE AUTHORITY. `POST /projects/launch` may resolve a taken
 * name to a different id, and `POST /projects` may also answer with the id it
 * actually created. Never register the id the client asked for.
 */
export function canonicalCreatedProjectId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as { projectId?: unknown }).projectId;
  if (typeof value !== "string") return null;
  return isRoutableProjectSlug(value) ? value : null;
}

/** The caller's owned project ids, or `null` when the lookup failed (fail closed). */
export async function ownedProjectIds(
  userId: string,
  writer?: OwnershipWriter,
): Promise<ReadonlySet<string> | null> {
  const db = writer ?? (await sessionOwnershipWriter());
  if (!db) return null;
  const ids = await db.listOwned(userId);
  return ids ? new Set(ids) : null;
}
