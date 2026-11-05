/**
 * The deployment row that serves a project, read through the CALLER's RLS client.
 *
 * The domain service needs the Vercel project a hostname must be attached to, and
 * a browser must never supply that target. Reading it here means the value comes
 * from the owner's own `project_deployments` row: a foreign project returns no row
 * (RLS), and a project that has never been published returns no target.
 */

import { mapDomainError, type DomainStoreResult } from "./store";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface OwnerDeploymentTarget {
  provider: string | null;
  projectId: string | null;
  target: string | null;
}

export async function readOwnerDeploymentTarget(
  projectId: string,
): Promise<DomainStoreResult<OwnerDeploymentTarget>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, code: "UNAVAILABLE", error: "Supabase is not configured." };
  }

  const { data, error } = await supabase
    .from("project_deployments")
    .select("provider,vercel_project_id,vercel_project_name")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return mapDomainError(error);

  const row = (data ?? null) as Record<string, unknown> | null;
  if (!row) {
    return {
      ok: true,
      data: { provider: null, projectId: null, target: null },
    };
  }

  const provider = typeof row.provider === "string" ? row.provider : null;
  const projectRef =
    typeof row.vercel_project_id === "string" && row.vercel_project_id
      ? row.vercel_project_id
      : typeof row.vercel_project_name === "string" && row.vercel_project_name
        ? row.vercel_project_name
        : null;

  return { ok: true, data: { provider, projectId: projectRef, target: projectRef } };
}
