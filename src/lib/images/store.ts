/**
 * ═══ IMAGE PLAN / ASSET PERSISTENCE — THROUGH THE CALLER'S CLIENT ═══════════
 *
 * Every write goes through a migration 33 SECURITY DEFINER RPC that re-checks
 * `(project_id, user_id)` ownership (or trusts `service_role` in the worker).
 * The authenticated role has SELECT only, so no code path here can insert,
 * rewrite or delete a row directly — which is what makes the claim/complete
 * state machine the single writer of an asset's outcome.
 *
 * No service-role client is created here: the caller passes the run's existing
 * client (`guard.client`), exactly like the generation store.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PlannedImage } from "./manifest";

export type ImageStoreFailure = { ok: false; code: string; error: string };
export type ImageStoreResult<T> = { ok: true; data: T } | ImageStoreFailure;

function failure(error: string, code = "UNAVAILABLE"): ImageStoreFailure {
  return { ok: false, code, error };
}

function rpcFailure(message: string | undefined, details: string | undefined): ImageStoreFailure {
  const text = `${message ?? ""} ${details ?? ""}`;
  if (/PROJECT_FORBIDDEN|42501/i.test(text)) {
    return failure("The project could not be verified for this image plan.", "FORBIDDEN");
  }
  if (/IMAGE_PLAN_TOO_LARGE|IMAGE_PLAN_OVER_BUDGET/i.test(text)) {
    return failure("The image plan exceeds the backend's approved budget.", "BUDGET");
  }
  if (/RUN_NOT_FOUND/i.test(text)) {
    return failure("The generation run for this image plan no longer exists.", "CONFLICT");
  }
  return failure("The image plan could not be saved.", "UNAVAILABLE");
}

export interface SyncImagePlanInput {
  projectId: string;
  runId: string;
  schemaVersion: number;
  model: string;
  siteType: string;
  plannedCount: number;
  approvedCount: number;
  deferredCount: number;
  requiredCount: number;
  maxAssets: number;
  estimatedCostUsd: number;
  maxCostUsd: number;
  /** Approved first, then the deferred rows (status is derived from `deferred`). */
  assets: Array<PlannedImage & { deferred: boolean; maxAttempts: number; estimatedCostUsd: number }>;
}

/**
 * Persist the approved plan and its asset rows. Idempotent: re-syncing the same
 * run rewrites only rows that are still planned/failed/deferred, so completed
 * assets keep their storage reference and are never regenerated.
 */
export async function syncImagePlan(
  client: SupabaseClient | null,
  input: SyncImagePlanInput,
): Promise<ImageStoreResult<{ planId: string; approvedCount: number }>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client.rpc("sync_image_plan", {
    p_project_id: input.projectId,
    p_run_id: input.runId,
    p_schema_version: input.schemaVersion,
    p_model: input.model,
    p_site_type: input.siteType,
    p_planned_count: input.plannedCount,
    p_approved_count: input.approvedCount,
    p_deferred_count: input.deferredCount,
    p_required_count: input.requiredCount,
    p_max_assets: input.maxAssets,
    p_estimated_cost_usd: input.estimatedCostUsd,
    p_max_cost_usd: input.maxCostUsd,
    p_assets: input.assets.map((asset) => ({
      assetKey: asset.assetId,
      reuseKey: asset.reuseKey,
      purpose: asset.purpose,
      pagePath: asset.pagePath,
      sectionId: asset.sectionId,
      productId: asset.productId,
      productImageIndex: asset.productImageIndex,
      alt: asset.alt,
      prompt: asset.prompt,
      aspectRatio: asset.aspectRatio,
      priority: asset.priority,
      required: asset.required,
      deferred: asset.deferred,
      maxAttempts: asset.maxAttempts,
      estimatedCostUsd: asset.estimatedCostUsd,
    })),
  });

  if (error) return rpcFailure(error.message, error.details);
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const planId = typeof record?.planId === "string" ? record.planId : null;
  if (!planId) return failure("The image plan was not persisted.");
  return {
    ok: true,
    data: {
      planId,
      approvedCount:
        typeof record?.approvedCount === "number" ? record.approvedCount : input.approvedCount,
    },
  };
}

export interface ClaimedImageAsset {
  id: string;
  assetKey: string;
  prompt: string;
  aspectRatio: string;
  attempt: number;
  maxAttempts: number;
  pagePath: string;
  purpose: string;
  sectionId: string | null;
  productId: string | null;
  alt: string;
}

function claimedFromPayload(data: unknown): ClaimedImageAsset | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.assetKey !== "string") return null;
  const text = (value: unknown, fallback = "") =>
    typeof value === "string" ? value : fallback;
  return {
    id: record.id,
    assetKey: record.assetKey,
    prompt: text(record.prompt),
    aspectRatio: text(record.aspectRatio, "16:9"),
    attempt: typeof record.attempt === "number" ? record.attempt : 1,
    maxAttempts: typeof record.maxAttempts === "number" ? record.maxAttempts : 2,
    pagePath: text(record.pagePath, "/"),
    purpose: text(record.purpose, "other"),
    sectionId: typeof record.sectionId === "string" ? record.sectionId : null,
    productId: typeof record.productId === "string" ? record.productId : null,
    alt: text(record.alt),
  };
}

/**
 * Claim one asset for one provider attempt. `null` means "do not call the
 * provider": another worker owns it, it is already ready, or its attempts are
 * exhausted.
 *
 * The RPC is addressed by `(project, run, asset key)` — never by a
 * caller-supplied row id — and returns the row id it claimed, which is what the
 * completion and failure writes use.
 */
export async function claimImageAsset(
  client: SupabaseClient | null,
  projectId: string,
  runId: string,
  assetKey: string,
): Promise<ImageStoreResult<ClaimedImageAsset | null>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client.rpc("claim_image_asset", {
    p_project_id: projectId,
    p_run_id: runId,
    p_asset_key: assetKey,
  });
  if (error) return rpcFailure(error.message, error.details);
  return { ok: true, data: claimedFromPayload(data) };
}

export interface CompleteImageAssetInput {
  assetId: string;
  storagePath: string;
  publicUrl: string;
  mediaType: "image/png" | "image/jpeg";
  bytes: number;
  actualCostUsd: number | null;
  costKnown: boolean;
  providerRequestId: string | null;
}

export async function completeImageAsset(
  client: SupabaseClient | null,
  input: CompleteImageAssetInput,
): Promise<ImageStoreResult<boolean>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client.rpc("complete_image_asset", {
    p_asset_id: input.assetId,
    p_storage_path: input.storagePath,
    p_public_url: input.publicUrl,
    p_media_type: input.mediaType,
    p_bytes: input.bytes,
    p_actual_cost_usd: input.actualCostUsd,
    p_cost_known: input.costKnown,
    p_provider_request_id: input.providerRequestId,
  });
  if (error) return rpcFailure(error.message, error.details);
  return { ok: true, data: data === true };
}

export interface FailImageAssetInput {
  assetId: string;
  errorCode: string;
  errorReason: string;
  uncertain: boolean;
  actualCostUsd: number | null;
}

export async function failImageAsset(
  client: SupabaseClient | null,
  input: FailImageAssetInput,
): Promise<ImageStoreResult<boolean>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client.rpc("fail_image_asset", {
    p_asset_id: input.assetId,
    p_error_code: input.errorCode,
    p_error_reason: input.errorReason,
    p_uncertain: input.uncertain,
    p_actual_cost_usd: input.actualCostUsd,
  });
  if (error) return rpcFailure(error.message, error.details);
  return { ok: true, data: data === true };
}

export interface ImagePlanCounts {
  planId: string;
  status: "planned" | "executing" | "completed" | "partial" | "failed";
  ready: number;
  failed: number;
  deferred: number;
  pending: number;
  requiredMissing: number;
  approved: number;
}

export async function finishImagePlan(
  client: SupabaseClient | null,
  projectId: string,
  runId: string,
): Promise<ImageStoreResult<ImagePlanCounts | null>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client.rpc("finish_image_plan", {
    p_project_id: projectId,
    p_run_id: runId,
  });
  if (error) return rpcFailure(error.message, error.details);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true, data: null };
  }
  const record = data as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === "number" ? value : 0);
  const status = record.status;
  return {
    ok: true,
    data: {
      planId: typeof record.planId === "string" ? record.planId : "",
      status:
        status === "completed" || status === "partial" || status === "failed" || status === "executing"
          ? status
          : "executing",
      ready: number(record.ready),
      failed: number(record.failed),
      deferred: number(record.deferred),
      pending: number(record.pending),
      requiredMissing: number(record.requiredMissing),
      approved: number(record.approved),
    },
  };
}

export interface PersistedImageAssetRow {
  id: string;
  assetKey: string;
  pagePath: string;
  sectionId: string | null;
  purpose: string;
  productId: string | null;
  productImageIndex: number | null;
  alt: string;
  aspectRatio: string;
  status: string;
  reuseKey: string | null;
  publicUrl: string | null;
  storagePath: string | null;
  mediaType: "image/png" | "image/jpeg" | null;
}

const ASSET_COLUMNS =
  "id,asset_key,page_path,section_id,purpose,product_id,product_image_index,alt_text,aspect_ratio,status,reuse_key,public_url,storage_path,media_type";

function assetRowFrom(record: Record<string, unknown>): PersistedImageAssetRow {
  const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  return {
    id: text(record.id),
    assetKey: text(record.asset_key),
    pagePath: text(record.page_path, "/"),
    sectionId: typeof record.section_id === "string" ? record.section_id : null,
    purpose: text(record.purpose, "other"),
    productId: typeof record.product_id === "string" ? record.product_id : null,
    productImageIndex:
      typeof record.product_image_index === "number" ? record.product_image_index : null,
    alt: text(record.alt_text),
    aspectRatio: text(record.aspect_ratio, "16:9"),
    status: text(record.status, "planned"),
    reuseKey: typeof record.reuse_key === "string" ? record.reuse_key : null,
    publicUrl: typeof record.public_url === "string" ? record.public_url : null,
    storagePath: typeof record.storage_path === "string" ? record.storage_path : null,
    mediaType:
      record.media_type === "image/png" || record.media_type === "image/jpeg"
        ? record.media_type
        : null,
  };
}

/** The run's own asset rows, so a resume can reuse what already succeeded. */
export async function listRunImageAssets(
  client: SupabaseClient | null,
  projectId: string,
  runId: string,
): Promise<ImageStoreResult<PersistedImageAssetRow[]>> {
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client
    .from("project_image_assets")
    .select(ASSET_COLUMNS)
    .eq("project_id", projectId)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) return failure("The saved image assets could not be read.", "UNAVAILABLE");
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    data: rows.map((row) => assetRowFrom(row as Record<string, unknown>)),
  };
}

/**
 * Ready assets from EARLIER runs of the same project, keyed by `reuse_key`.
 *
 * ⚠️ SAME PROJECT ONLY. Ownership is enforced by `projects` RLS and by the
 * `project_id` equality below; there is no cross-project or shared-asset scope,
 * so one user's imagery can never leak into another project.
 */
export async function findReusableImageAssets(
  client: SupabaseClient | null,
  projectId: string,
  reuseKeys: readonly string[],
): Promise<ImageStoreResult<Map<string, PersistedImageAssetRow>>> {
  const keys = [...new Set(reuseKeys.filter(Boolean))].slice(0, 80);
  if (keys.length === 0) return { ok: true, data: new Map() };
  if (!client) return failure("Supabase is not configured for this run.");

  const { data, error } = await client
    .from("project_image_assets")
    .select(ASSET_COLUMNS)
    .eq("project_id", projectId)
    .eq("status", "ready")
    .in("reuse_key", keys)
    .order("completed_at", { ascending: false });

  if (error) return failure("Reusable image assets could not be read.", "UNAVAILABLE");

  const byKey = new Map<string, PersistedImageAssetRow>();
  for (const row of Array.isArray(data) ? data : []) {
    const asset = assetRowFrom(row as Record<string, unknown>);
    if (!asset.reuseKey || !asset.publicUrl) continue;
    if (!byKey.has(asset.reuseKey)) byKey.set(asset.reuseKey, asset);
  }
  return { ok: true, data: byKey };
}

export function isImageStoreFailure<T>(result: ImageStoreResult<T>): result is ImageStoreFailure {
  return result.ok === false;
}
