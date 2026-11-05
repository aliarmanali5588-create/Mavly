/**
 * Activate one immutable published version for a Vercel-hosted project.
 *
 * Migration 62's domain registry claims a domain job only when
 * `project_deployments.active_version_id` points at an ACTIVE
 * `project_published_versions` row. The shared publish path writes that pair;
 * this wrapper is the Vercel path's equivalent, and calls the owner-checked
 * SECURITY DEFINER RPC from migration 64.
 *
 * The RPC re-checks project ownership and refuses a row whose provider is not
 * `vercel`, so neither the browser nor this module can rewire an archived AWS
 * row.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";

import type { HostingStoreResult } from "./store";

export async function activateVercelPublication(input: {
  projectId: string;
  versionId: string;
}): Promise<HostingStoreResult<{ versionId: string }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };
  }

  const { data, error } = await supabase.rpc("activate_vercel_publication", {
    p_project_id: input.projectId,
    p_version_id: input.versionId,
  });

  if (error) {
    return { ok: false, error: error.message, code: error.code };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const versionId = typeof row.versionId === "string" ? row.versionId : input.versionId;
  return { ok: true, data: { versionId } };
}
