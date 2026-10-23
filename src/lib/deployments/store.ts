/**
 * Persistence for Mavly-managed Vercel deployments.
 *
 * Every read and write uses the caller's own Supabase session client. RLS on
 * public.projects is the access boundary, exactly as for project files and
 * messages; there is no service-role key in this application.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type DeploymentStatus = "queued" | "building" | "ready" | "error" | "canceled";
export type MavlyDomainStatus = "pending" | "verified" | "error";

export interface DeploymentRow {
  project_id: string;
  provider: "vercel";
  vercel_project_id: string | null;
  vercel_project_name: string;
  vercel_deployment_id: string | null;
  status: DeploymentStatus;
  url: string | null;
  error_code: string | null;
  error_message: string | null;
  mavly_hostname: string | null;
  mavly_domain_status: MavlyDomainStatus | null;
  mavly_domain_error: string | null;
  mavly_domain_checked_at: string | null;
  created_at: string;
  updated_at: string;
  last_published_at: string | null;
}

export type DeploymentStoreFailure = { ok: false; error: string; code?: string };
export type DeploymentStoreResult<T> = { ok: true; data: T } | DeploymentStoreFailure;

/**
 * A publish is a few short server calls. A row still queued/building after this
 * long belongs to a process that died (or a Vercel call that never returned), so
 * it is safe for the next publish to claim the slot. Without this a crashed
 * publish would block the project for ever.
 */
const STALE_CLAIM_MS = 15 * 60_000;

export function isDeploymentRowStale(row: DeploymentRow): boolean {
  const updated = Date.parse(row.updated_at);
  return Number.isFinite(updated) && Date.now() - updated > STALE_CLAIM_MS;
}

export function isDeploymentStoreFailure<T>(
  result: DeploymentStoreResult<T>,
): result is DeploymentStoreFailure {
  return result.ok === false;
}

const SELECT =
  "project_id,provider,vercel_project_id,vercel_project_name,vercel_deployment_id,status,url,error_code,error_message,mavly_hostname,mavly_domain_status,mavly_domain_error,mavly_domain_checked_at,created_at,updated_at,last_published_at";

function dbError(scope: string, message: string, code?: string): DeploymentStoreFailure {
  console.error(`[deployments] ${scope}:`, message);
  return { ok: false, error: message, code };
}

export async function getDeploymentRow(projectId: string): Promise<DeploymentStoreResult<DeploymentRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_deployments")
    .select(SELECT)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return dbError("get deployment", error.message, error.code);
  return { ok: true, data: (data as DeploymentRow | null) ?? null };
}

/**
 * Claim the project's single deployment slot.
 *
 * Insert wins for a first publish. If a row already exists, the update only
 * succeeds when the previous status is terminal, so two concurrent publishes
 * cannot both proceed. A losing caller gets `CONFLICT`, never a second Vercel
 * deployment.
 */
export async function beginDeployment(
  projectId: string,
  vercelProjectName: string,
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const inserted = await supabase
    .from("project_deployments")
    .insert({
      project_id: projectId,
      provider: "vercel",
      vercel_project_name: vercelProjectName,
      status: "queued",
      updated_at: now,
      last_published_at: now,
    })
    .select(SELECT)
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, data: inserted.data as DeploymentRow };
  }
  if (inserted.error?.code !== "23505") {
    return dbError("begin deployment", inserted.error?.message ?? "insert failed", inserted.error?.code);
  }

  const claim = {
    provider: "vercel",
    // The previous deployment is still live on Vercel, but it is no longer this
    // row's current attempt. Clearing the id prevents status polling from
    // adopting the old READY state while the new publish is in flight.
    vercel_deployment_id: null,
    status: "queued",
    url: null,
    error_code: null,
    error_message: null,
    updated_at: now,
    last_published_at: now,
  } as const;

  /** Normal republish: a finished row can be claimed at once. */
  const updated = await supabase
    .from("project_deployments")
    .update(claim)
    .eq("project_id", projectId)
    .in("status", ["ready", "error", "canceled"])
    .select(SELECT)
    .maybeSingle();

  if (updated.error) {
    return dbError("claim deployment", updated.error.message, updated.error.code);
  }
  if (updated.data) return { ok: true, data: updated.data as DeploymentRow };

  /**
   * The row may be an abandoned in-flight claim (server died, or Vercel never
   * answered). Re-read it and take it over ONLY when it is still stale and has
   * not changed since the read. The `updated_at` equality is the optimistic
   * lock: a real concurrent publish moves it, so this update matches no row.
   */
  const existing = await getDeploymentRow(projectId);
  if (isDeploymentStoreFailure(existing)) return existing;
  if (!existing.data || !isDeploymentRowStale(existing.data)) {
    return { ok: false, error: "A publish is already in progress.", code: "CONFLICT" };
  }

  const takeover = await supabase
    .from("project_deployments")
    .update(claim)
    .eq("project_id", projectId)
    .eq("updated_at", existing.data.updated_at)
    .in("status", ["queued", "building"])
    .select(SELECT)
    .maybeSingle();

  if (takeover.error) {
    return dbError("claim stale deployment", takeover.error.message, takeover.error.code);
  }
  if (!takeover.data) {
    return { ok: false, error: "A publish is already in progress.", code: "CONFLICT" };
  }
  return { ok: true, data: takeover.data as DeploymentRow };
}

export interface DeploymentPatch {
  vercel_project_id?: string | null;
  vercel_project_name?: string;
  vercel_deployment_id?: string | null;
  status?: DeploymentStatus;
  url?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  mavly_hostname?: string | null;
  mavly_domain_status?: MavlyDomainStatus | null;
  mavly_domain_error?: string | null;
  mavly_domain_checked_at?: string | null;
  last_published_at?: string;
}

export async function updateDeploymentRow(
  projectId: string,
  patch: DeploymentPatch,
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) updates[key] = value;
  }

  const { data, error } = await supabase
    .from("project_deployments")
    .update(updates)
    .eq("project_id", projectId)
    .select(SELECT)
    .maybeSingle();

  if (error) return dbError("update deployment", error.message, error.code);
  if (!data) return { ok: false, error: "Deployment record not found", code: "NOT_FOUND" };
  return { ok: true, data: data as DeploymentRow };
}
