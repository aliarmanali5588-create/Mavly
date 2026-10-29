/**
 * ═══ ONE BOUNDED IMAGE STAGE PER GENERATION RUN ═════════════════════════════
 *
 * Runs INSIDE the existing generation run (after the plan, before the code
 * batches), not as a second pipeline:
 *
 *   1. the already-validated plan is approved against the backend policy;
 *   2. the approved plan and its rows are persisted (idempotent, one row/asset);
 *   3. each asset is CLAIMED in the database before a paid provider call, so a
 *      second worker or a retried run cannot generate it twice;
 *   4. the returned bytes are validated, uploaded, and only then marked ready;
 *   5. every failure is recorded with its provider cost or an explicit
 *      "unknown", and the plan's status is settled from the rows.
 *
 * ⚠️ WHAT THIS MODULE DOES NOT DO: it does not touch credits, it does not write
 * project files, and it does not decide deployment. Provider cost is provider
 * cost; a user is never charged for an image by this code.
 *
 * ⚠️ BOUNDED ON PURPOSE. The stage stops at a wall-clock deadline, at the
 * concurrency limit, at the per-asset attempt cap and at the approved plan
 * count. Whatever it did not start stays `planned` and is truthful about being
 * pending — it is never reported as generated.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveImageModel } from "@/lib/ai/image-models";
import {
  generateImage,
  isImageGenerationFailure,
  type ImageGenerationResult,
} from "@/lib/ai/openrouter-images";
import type { ImageOutputFormat } from "@/lib/image-generation-options";
import { uploadImageAsset, type ImageUploadResult } from "./asset-store";
import {
  approveImagePlan,
  type ApprovedImagePlan,
  type ImageAssetReference,
  type NormalizedImagePlan,
  type PlannedImage,
} from "./manifest";
import type { ImagePlanningPolicy } from "./policy";
import {
  claimImageAsset,
  completeImageAsset,
  failImageAsset,
  findReusableImageAssets,
  finishImagePlan,
  isImageStoreFailure,
  listRunImageAssets,
  syncImagePlan,
  type ClaimedImageAsset,
  type PersistedImageAssetRow,
} from "./store";

export interface PendingImagePlacement {
  assetId: string;
  pagePath: string;
  purpose: string;
  alt: string;
  reason: "deferred" | "failed" | "pending";
}

export type ImageStageStatus =
  | "disabled"
  | "skipped"
  | "invalid"
  | "persist_failed"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface ImageStageResult {
  status: ImageStageStatus;
  reason: string | null;
  plan: ApprovedImagePlan | null;
  /** Persisted assets the coding agent may reference. */
  references: ImageAssetReference[];
  pending: PendingImagePlacement[];
  counts: {
    planned: number;
    approved: number;
    ready: number;
    failed: number;
    deferred: number;
    reused: number;
    pending: number;
  };
  estimatedCostUsd: number;
  /** Sum of provider-reported costs, or null when any attempt was unknown. */
  actualCostUsd: number | null;
  costKnown: boolean;
  /** Approved assets the plan marked REQUIRED that are not persisted yet. */
  requiredMissing: number;
  /** The plan status the database settled from its rows, when it answered. */
  planStatus: string | null;
}

export interface ImageStageDeps {
  generate: (input: {
    prompt: string;
    aspectRatio: string;
    outputFormat: ImageOutputFormat;
  }) => Promise<ImageGenerationResult>;
  upload: (input: {
    projectId: string;
    runId: string;
    assetKey: string;
    mediaType: "image/png" | "image/jpeg";
    format: ImageOutputFormat;
    bytes: Uint8Array;
  }) => Promise<ImageUploadResult>;
  syncPlan: typeof syncImagePlan;
  claim: typeof claimImageAsset;
  complete: typeof completeImageAsset;
  fail: typeof failImageAsset;
  listAssets: typeof listRunImageAssets;
  findReusable: typeof findReusableImageAssets;
  finishPlan: typeof finishImagePlan;
  now: () => number;
}

export interface ImageStageInput {
  client: SupabaseClient | null;
  projectId: string;
  runId: string;
  policy: ImagePlanningPolicy;
  plan: NormalizedImagePlan;
  /** Absolute deadline for the whole stage. */
  deadlineAt: number;
  /**
   * Ownership/cancellation fence, awaited before each claim. Throwing stops the
   * stage without failing anything already persisted.
   */
  assertRunnable?: () => Promise<void>;
  deps?: Partial<ImageStageDeps>;
}

function emptyResult(status: ImageStageStatus, reason: string | null): ImageStageResult {
  return {
    status,
    reason,
    plan: null,
    references: [],
    pending: [],
    counts: { planned: 0, approved: 0, ready: 0, failed: 0, deferred: 0, reused: 0, pending: 0 },
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    costKnown: true,
    requiredMissing: 0,
    planStatus: null,
  };
}

function referenceOf(asset: {
  assetId: string;
  pagePath: string;
  sectionId: string | null;
  purpose: string;
  productId: string | null;
  productImageIndex: number | null;
  alt: string;
  aspectRatio: string;
  url: string;
}): ImageAssetReference {
  return {
    assetId: asset.assetId,
    pagePath: asset.pagePath,
    sectionId: asset.sectionId,
    purpose: asset.purpose as ImageAssetReference["purpose"],
    productId: asset.productId,
    productImageIndex: asset.productImageIndex,
    alt: asset.alt,
    aspectRatio: asset.aspectRatio,
    url: asset.url,
  };
}

/**
 * Which provider failures leave the actual spend UNKNOWN.
 *
 * A timeout, a dropped connection or a 5xx may hide a generation the provider
 * already produced and billed, so those stay uncertain. A configuration, auth,
 * validation, rate-limit or content-filter answer is a definite "no image".
 */
function isUncertainFailure(code: string): boolean {
  return code === "TIMEOUT" || code === "NETWORK" || code === "TRANSIENT" || code === "UNKNOWN";
}

/**
 * Execute the image plan for one run. Returns a truthful account of what was
 * persisted, what failed and what was never started.
 */
export async function runImageStage(input: ImageStageInput): Promise<ImageStageResult> {
  const { policy } = input;
  if (!policy.enabled) {
    return emptyResult("disabled", policy.disabledReason ?? "image_planning_disabled");
  }
  if (input.plan.images.length === 0) {
    return emptyResult("skipped", "no_images_planned");
  }

  const model = resolveImageModel();
  if (model.id !== policy.modelId) {
    // The policy and the provider catalog disagree: refuse rather than swap in
    // a different model behind the operator's back.
    return emptyResult("invalid", "image_model_mismatch");
  }

  const approvedPlan = approveImagePlan(input.plan, policy);
  const deps: ImageStageDeps = {
    generate: async (request) => {
      /**
       * A provider request may not outlive the stage's slice of the run: the
       * per-asset timeout is the SMALLER of its own configured bound and the
       * time actually left before the stage deadline (floored, so a nearly
       * expired slice still gets one real attempt rather than an instant abort).
       */
      const remaining = input.deadlineAt - Date.now();
      const timeoutMs = Math.max(
        5_000,
        Math.min(policy.perAssetTimeoutMs, remaining > 0 ? remaining : policy.perAssetTimeoutMs),
      );
      return generateImage({
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        outputFormat: request.outputFormat,
        timeoutMs,
      });
    },
    upload: async (request) =>
      input.client
        ? uploadImageAsset(input.client, { bucket: policy.bucket, ...request })
        : { ok: false, code: "STORAGE", error: "Storage is not configured for this run." },
    syncPlan: syncImagePlan,
    claim: claimImageAsset,
    complete: completeImageAsset,
    fail: failImageAsset,
    listAssets: listRunImageAssets,
    findReusable: findReusableImageAssets,
    finishPlan: finishImagePlan,
    now: () => Date.now(),
    ...input.deps,
  };

  const allPlanned: Array<PlannedImage & { deferred: boolean }> = [
    ...approvedPlan.approved.map((asset) => ({ ...asset, deferred: false })),
    ...approvedPlan.deferred.map((asset) => ({ ...asset, deferred: true })),
  ];

  const synced = await deps.syncPlan(input.client, {
    projectId: input.projectId,
    runId: input.runId,
    schemaVersion: approvedPlan.schemaVersion,
    model: approvedPlan.modelId,
    siteType: approvedPlan.siteType,
    plannedCount: approvedPlan.counts.planned,
    approvedCount: approvedPlan.counts.approved,
    deferredCount: approvedPlan.counts.deferred,
    requiredCount: approvedPlan.counts.required,
    maxAssets: policy.maxAssets,
    estimatedCostUsd: approvedPlan.estimatedCostUsd,
    maxCostUsd: policy.maxRunCostUsd,
    assets: allPlanned.map((asset) => ({
      ...asset,
      maxAttempts: policy.maxAttempts,
      estimatedCostUsd: policy.usdPerImage,
    })),
  });
  if (isImageStoreFailure(synced)) {
    // No durable approval record means no paid call.
    return { ...emptyResult("persist_failed", synced.code), plan: approvedPlan };
  }

  const saved = await deps.listAssets(input.client, input.projectId, input.runId);
  const savedRows = saved.ok ? saved.data : [];
  const readyByKey = new Map<string, PersistedImageAssetRow>();
  const rowByKey = new Map<string, PersistedImageAssetRow>();
  for (const row of savedRows) {
    rowByKey.set(row.assetKey, row);
    if (row.status === "ready" && row.publicUrl) readyByKey.set(row.assetKey, row);
  }

  const reuseKeys = approvedPlan.approved
    .map((asset) => asset.reuseKey)
    .filter((key): key is string => typeof key === "string" && key.length > 0);
  const reusable = await deps.findReusable(input.client, input.projectId, reuseKeys);
  const reusableByKey = reusable.ok ? reusable.data : new Map<string, PersistedImageAssetRow>();

  const references: ImageAssetReference[] = [];
  const pending: PendingImagePlacement[] = [];
  const queue: PlannedImage[] = [];
  let ready = 0;
  let failed = 0;
  let reused = 0;
  let cancelled = false;
  let costSum = 0;
  let costKnown = true;

  for (const asset of approvedPlan.approved) {
    const existing = readyByKey.get(asset.assetId);
    if (existing && existing.publicUrl) {
      references.push(
        referenceOf({
          assetId: asset.assetId,
          pagePath: existing.pagePath,
          sectionId: existing.sectionId,
          purpose: existing.purpose,
          productId: existing.productId,
          productImageIndex: existing.productImageIndex,
          alt: existing.alt || asset.alt,
          aspectRatio: existing.aspectRatio,
          url: existing.publicUrl,
        }),
      );
      ready += 1;
      continue;
    }
    queue.push(asset);
  }

  for (const asset of approvedPlan.deferred) {
    pending.push({
      assetId: asset.assetId,
      pagePath: asset.pagePath,
      purpose: asset.purpose,
      alt: asset.alt,
      reason: "deferred",
    });
  }

  const recordCost = (costUsd: number | null): void => {
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) {
      costSum = Math.round((costSum + costUsd) * 1_000_000) / 1_000_000;
      return;
    }
    // A missing provider cost is unknown, never zero.
    costKnown = false;
  };

  const attemptOne = async (asset: PlannedImage): Promise<void> => {
    if (deps.now() >= input.deadlineAt) {
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "pending",
      });
      return;
    }
    if (input.assertRunnable) {
      try {
        await input.assertRunnable();
      } catch {
        cancelled = true;
        return;
      }
    }

    const claimed = await deps.claim(input.client, input.projectId, input.runId, asset.assetId);
    if (isImageStoreFailure(claimed)) {
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "pending",
      });
      return;
    }
    const claim: ClaimedImageAsset | null = claimed.data;
    if (!claim) {
      const row = rowByKey.get(asset.assetId);
      if (row?.status === "ready" && row.publicUrl) {
        // Another worker completed it while we were queued: reuse that result.
        references.push(
          referenceOf({
            assetId: asset.assetId,
            pagePath: row.pagePath,
            sectionId: row.sectionId,
            purpose: row.purpose,
            productId: row.productId,
            productImageIndex: row.productImageIndex,
            alt: row.alt || asset.alt,
            aspectRatio: row.aspectRatio,
            url: row.publicUrl,
          }),
        );
        ready += 1;
        return;
      }
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "pending",
      });
      return;
    }

    /**
     * ⚠️ REUSE ACROSS RUNS. A ready asset from an earlier run of THIS project
     * with the same `reuse_key` already satisfies this placement. The claim
     * above keeps the row exclusive, and the completion records a REAL cost of
     * zero for this run because no provider call was made for it.
     */
    const reusableAsset = asset.reuseKey ? reusableByKey.get(asset.reuseKey) : null;
    if (reusableAsset && reusableAsset.publicUrl && reusableAsset.storagePath) {
      const completed = await deps.complete(input.client, {
        assetId: claim.id,
        storagePath: reusableAsset.storagePath,
        publicUrl: reusableAsset.publicUrl,
        mediaType: reusableAsset.mediaType ?? "image/png",
        bytes: 0,
        actualCostUsd: 0,
        costKnown: true,
        providerRequestId: null,
      });
      if (completed.ok && completed.data) {
        references.push(
          referenceOf({
            assetId: asset.assetId,
            pagePath: asset.pagePath,
            sectionId: asset.sectionId,
            purpose: asset.purpose,
            productId: asset.productId,
            productImageIndex: asset.productImageIndex,
            alt: asset.alt,
            aspectRatio: asset.aspectRatio,
            url: reusableAsset.publicUrl,
          }),
        );
        ready += 1;
        reused += 1;
        return;
      }
      // A failed reuse falls through to a real generation for this slot.
    }

    const generated = await deps.generate({
      prompt: claim.prompt || asset.prompt,
      aspectRatio: claim.aspectRatio || asset.aspectRatio,
      outputFormat: model.defaultOutputFormat,
    });

    if (isImageGenerationFailure(generated)) {
      /**
       * A definite refusal (config, auth, validation, rate limit, filter) was
       * never billed, so its cost is a KNOWN zero. A timeout or a 5xx may hide a
       * completed generation, so it stays unknown rather than free.
       */
      const uncertain = isUncertainFailure(generated.code);
      const failureCost = uncertain ? null : 0;
      recordCost(failureCost);
      await deps.fail(input.client, {
        assetId: claim.id,
        errorCode: generated.code,
        errorReason: generated.error,
        uncertain,
        actualCostUsd: failureCost,
      });
      failed += 1;
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "failed",
      });
      return;
    }

    const bytes = Buffer.from(generated.image.base64, "base64");
    const uploaded = await deps.upload({
      projectId: input.projectId,
      runId: input.runId,
      assetKey: asset.assetId,
      mediaType: generated.image.mediaType,
      format: generated.image.format,
      bytes,
    });

    if (!uploaded.ok) {
      /**
       * ⚠️ THE PROVIDER WAS PAID, THE STORAGE WAS NOT WRITTEN. The asset is NOT
       * ready, and its provider cost is recorded (known when the provider
       * reported it) so a failed upload cannot look free.
       */
      recordCost(generated.usage.costUsd);
      await deps.fail(input.client, {
        assetId: claim.id,
        errorCode: `${uploaded.code}_STORAGE_FAILED`,
        errorReason: uploaded.error,
        uncertain: false,
        actualCostUsd: generated.usage.costUsd,
      });
      failed += 1;
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "failed",
      });
      return;
    }

    const completed = await deps.complete(input.client, {
      assetId: claim.id,
      storagePath: uploaded.storagePath,
      publicUrl: uploaded.publicUrl,
      mediaType: generated.image.mediaType,
      bytes: uploaded.bytes,
      actualCostUsd: generated.usage.costUsd,
      costKnown: typeof generated.usage.costUsd === "number",
      providerRequestId: generated.metadata.providerRequestId,
    });

    if (isImageStoreFailure(completed) || !completed.data) {
      /**
       * The bytes are safely stored but the row could not be marked ready, so
       * the placement stays pending. It is NOT reported as generated; the next
       * run claims it again and overwrites the same deterministic path.
       */
      recordCost(generated.usage.costUsd);
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "pending",
      });
      return;
    }

    recordCost(generated.usage.costUsd);
    references.push(
      referenceOf({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        sectionId: asset.sectionId,
        purpose: asset.purpose,
        productId: asset.productId,
        productImageIndex: asset.productImageIndex,
        alt: asset.alt,
        aspectRatio: asset.aspectRatio,
        url: uploaded.publicUrl,
      }),
    );
    ready += 1;
  };

  /**
   * ⚠️ ONE ASSET'S EXCEPTION MUST NOT ABORT THE STAGE. A storage or database
   * error thrown after a paid call would otherwise escape and lose the outcome
   * of every other asset in the plan. The asset is left pending and truthful —
   * its own `fail`/`complete` write decided its row, not this wrapper.
   */
  const handleOne = async (asset: PlannedImage): Promise<void> => {
    try {
      await attemptOne(asset);
    } catch {
      if (!pending.some((entry) => entry.assetId === asset.assetId)) {
        pending.push({
          assetId: asset.assetId,
          pagePath: asset.pagePath,
          purpose: asset.purpose,
          alt: asset.alt,
          reason: "pending",
        });
      }
    }
  };

  const concurrency = Math.max(1, Math.min(policy.concurrency, queue.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled || deps.now() >= input.deadlineAt) return;
      const index = cursor;
      cursor += 1;
      const asset = queue[index];
      if (!asset) return;
      await handleOne(asset);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Anything never attempted is reported as waiting, not as generated.
  const attempted = new Set(pending.map((entry) => entry.assetId));
  for (const asset of queue) {
    if (references.some((reference) => reference.assetId === asset.assetId)) continue;
    if (attempted.has(asset.assetId)) continue;
    pending.push({
      assetId: asset.assetId,
      pagePath: asset.pagePath,
      purpose: asset.purpose,
      alt: asset.alt,
      reason: "pending",
    });
  }

  /**
   * Same-plan reuse: a placement whose `reuse_key` matches an APPROVED asset
   * shares that asset's URL instead of generating (and paying for) a second
   * image. It gets no row of its own — the owner asset is the durable record —
   * but the coding agent still needs the placement, so it is added here with its
   * own page/section/product metadata and the owner's URL.
   */
  const referenceByAssetId = new Map(references.map((reference) => [reference.assetId, reference]));
  for (const asset of approvedPlan.reused) {
    const owner = asset.reuseKey
      ? approvedPlan.approved.find((candidate) => candidate.reuseKey === asset.reuseKey)
      : undefined;
    const ownerReference = owner ? referenceByAssetId.get(owner.assetId) : undefined;
    if (!ownerReference) {
      // The shared asset did not become ready: the placement is still missing.
      pending.push({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        purpose: asset.purpose,
        alt: asset.alt,
        reason: "pending",
      });
      continue;
    }
    references.push(
      referenceOf({
        assetId: asset.assetId,
        pagePath: asset.pagePath,
        sectionId: asset.sectionId,
        purpose: asset.purpose,
        productId: asset.productId,
        productImageIndex: asset.productImageIndex,
        alt: asset.alt,
        aspectRatio: asset.aspectRatio,
        url: ownerReference.url,
      }),
    );
    reused += 1;
  }

  const settled = await deps.finishPlan(input.client, input.projectId, input.runId);

  const readyIds = new Set(references.map((reference) => reference.assetId));
  const requiredMissing = approvedPlan.approved.filter(
    (asset) => asset.required && !readyIds.has(asset.assetId),
  ).length;

  const counts = {
    planned: approvedPlan.counts.planned,
    approved: approvedPlan.counts.approved,
    ready,
    failed,
    deferred: approvedPlan.counts.deferred,
    reused,
    pending: Math.max(0, approvedPlan.counts.approved - ready - failed),
  };

  const status: ImageStageStatus = cancelled
    ? "cancelled"
    : counts.pending > 0
      ? "partial"
      : failed > 0 || counts.deferred > 0
        ? "partial"
        : "completed";

  /** Why an approved asset was never finished — never a guess. */
  const pendingReason = (): string => {
    if (deps.now() >= input.deadlineAt) return "deadline_reached";
    if (failed > 0) return "some_assets_failed";
    return "not_started";
  };

  return {
    status,
    reason: cancelled
      ? "cancelled"
      : counts.pending > 0
        ? pendingReason()
        : failed > 0
          ? "some_assets_failed"
          : counts.deferred > 0
            ? "some_assets_deferred"
            : null,
    plan: approvedPlan,
    references,
    pending,
    counts,
    estimatedCostUsd: approvedPlan.estimatedCostUsd,
    actualCostUsd: costKnown ? Math.round(costSum * 1_000_000) / 1_000_000 : null,
    costKnown,
    requiredMissing,
    planStatus: settled.ok && settled.data ? settled.data.status : null,
  };
}
