/**
 * Persistence for Mavly-managed deployments.
 *
 * Every read and write uses the caller's own Supabase session client. RLS on
 * public.projects is the access boundary, exactly as for project files and
 * messages; there is no service-role key in this application.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type DeploymentStatus =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled"
  | "unpublishing"
  | "unpublished";
export type MavlyDomainStatus = "pending" | "verified" | "error";

/**
 * `vercel` — one per-project Vercel deployment (legacy, still supported);
 * `shared` — an immutable published version served by Mavly's tenant runtime;
 * `aws` — an immutable version published to private S3 and routed by CloudFront.
 */
export type DeploymentProvider = "vercel" | "shared" | "aws";

export interface DeploymentRow {
  project_id: string;
  provider: DeploymentProvider;
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
  /** The published version the shared runtime may serve. NULL for legacy rows. */
  active_version_id?: string | null;
  created_at: string;
  updated_at: string;
  last_published_at: string | null;
  last_unpublished_at: string | null;
}

export type DeploymentStoreFailure = { ok: false; error: string; code?: string };
export type DeploymentStoreResult<T> = { ok: true; data: T } | DeploymentStoreFailure;

/**
 * A publish/unpublish is a few short server calls. A row still queued/building/
 * unpublishing after this long belongs to a process that died (or a Vercel call
 * that never returned), so it is safe for the next operation to claim the slot.
 * Without this a crashed operation would block the project for ever.
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

const SELECT = "project_id,provider,vercel_project_id,vercel_project_name,vercel_deployment_id,status,url,error_code,error_message,mavly_hostname,mavly_domain_status,mavly_domain_error,mavly_domain_checked_at,active_version_id,created_at,updated_at,last_published_at,last_unpublished_at";

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
export interface BeginDeploymentOptions {
  /**
   * Shared publishing keeps `last_published_at` describing the last SUCCESSFUL
   * publication. A failed attempt must not rewrite the timestamp of the version
   * that is still live. The legacy Vercel path keeps its existing behaviour.
   */
  preserveLastPublishedAt?: boolean;
}

export async function beginDeployment(
  projectId: string,
  vercelProjectName: string,
  provider: DeploymentProvider = "vercel",
  options: BeginDeploymentOptions = {},
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const inserted = await supabase
    .from("project_deployments")
    .insert({
      project_id: projectId,
      provider,
      vercel_project_name: vercelProjectName,
      status: "queued",
      updated_at: now,
      ...(options.preserveLastPublishedAt ? {} : { last_published_at: now }),
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
    provider,
    /**
     * The previous deployment is still live (on Vercel, or as the active shared
     * version), but it is no longer this row's current attempt. Clearing the
     * Vercel id prevents status polling from adopting the old READY state while
     * the new publish is in flight. It never clears `active_version_id`: that is
     * the shared runtime's live pointer and is changed only on activation.
     */
    vercel_deployment_id: null,
    status: "queued",
    url: null,
    error_code: null,
    error_message: null,
    updated_at: now,
    ...(options.preserveLastPublishedAt ? {} : { last_published_at: now }),
  } as const;

  /** Normal republish: a finished row can be claimed at once. */
  const updated = await supabase
    .from("project_deployments")
    .update(claim)
    .eq("project_id", projectId)
    .in("status", ["ready", "error", "canceled", "unpublished"])
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
  active_version_id?: string | null;
  last_published_at?: string;
  last_unpublished_at?: string | null;
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

/**
 * Claim this project's single deployment slot for an unpublish.
 *
 * The `updated_at` equality is the optimistic lock. A publish that is queued or
 * building never matches, so it cannot be taken down halfway through; a stale
 * `unpublishing` row left by a died process can be taken over. A loser receives
 * `CONFLICT` and the service re-reads the authoritative row before answering.
 */
export async function claimUnpublish(
  projectId: string,
  current: DeploymentRow,
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const allowed =
    current.status === "unpublishing"
      ? ["unpublishing"]
      : ["ready", "error", "canceled"];

  const { data, error } = await supabase
    .from("project_deployments")
    .update({ status: "unpublishing", updated_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("updated_at", current.updated_at)
    .in("status", allowed)
    .select(SELECT)
    .maybeSingle();

  if (error) return dbError("claim unpublish", error.message, error.code);
  if (!data) return { ok: false, error: "A deployment operation is already in progress.", code: "CONFLICT" };
  return { ok: true, data: data as DeploymentRow };
}

/**
 * Commit the unpublish only if this worker still owns the claim.
 *
 * The public host and production deployment are already gone at this point. The
 * row keeps the Vercel project id/name and the derived `mavly_hostname`, so a
 * later publish can reattach the same address.
 */
export async function finishUnpublish(
  projectId: string,
  leaseUpdatedAt: string,
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("project_deployments")
    .update({
      status: "unpublished",
      vercel_deployment_id: null,
      url: null,
      error_code: null,
      error_message: null,
      /**
       * The published version stops being resolvable here. The version ROWS are
       * preserved (deactivate_published_version supersedes them), so history and
       * rollback survive an unpublish.
       */
      active_version_id: null,
      mavly_domain_status: null,
      mavly_domain_error: null,
      mavly_domain_checked_at: null,
      last_unpublished_at: now,
      updated_at: now,
    })
    .eq("project_id", projectId)
    .eq("status", "unpublishing")
    .eq("updated_at", leaseUpdatedAt)
    .select(SELECT)
    .maybeSingle();

  if (error) return dbError("finish unpublish", error.message, error.code);
  if (!data) {
    return {
      ok: false,
      error: "The unpublish lease was lost before it could be recorded.",
      code: "CONFLICT",
    };
  }
  return { ok: true, data: data as DeploymentRow };
}

/**
 * Put a failed unpublish back to the status it had before the claim.
 *
 * This is what keeps a provider error from falsely marking a live site as
 * unpublished. It is conditional on the same lease; a takeover cannot be
 * overwritten by the previous worker. The optional failure metadata is written
 * in the same statement, so a new claim can never receive an old worker's error.
 */
export async function releaseUnpublish(
  projectId: string,
  leaseUpdatedAt: string,
  previousStatus: Exclude<DeploymentStatus, "unpublishing" | "unpublished">,
  failure?: { code: string; message: string },
): Promise<DeploymentStoreResult<DeploymentRow>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", code: "UNAVAILABLE" };

  const { data, error } = await supabase
    .from("project_deployments")
    .update({
      status: previousStatus,
      updated_at: new Date().toISOString(),
      ...(failure ? { error_code: failure.code, error_message: failure.message } : {}),
    })
    .eq("project_id", projectId)
    .eq("status", "unpublishing")
    .eq("updated_at", leaseUpdatedAt)
    .select(SELECT)
    .maybeSingle();

  if (error) return dbError("release unpublish", error.message, error.code);
  if (!data) {
    return {
      ok: false,
      error: "The unpublish lease was lost before it could be rolled back.",
      code: "CONFLICT",
    };
  }
  return { ok: true, data: data as DeploymentRow };
}
