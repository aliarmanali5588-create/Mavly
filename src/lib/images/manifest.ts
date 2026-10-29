/**
 * ═══ IMAGE PLAN — WHAT THE PLANNER PROPOSES, WHAT THE BACKEND APPROVES ═══════
 *
 * Two separate steps, on purpose:
 *
 *   1. `validateImagePlan` accepts or rejects the Planning Agent's structured
 *      `images` array. Model output is untrusted data: every field is bounded,
 *      every id is unique, every aspect ratio is one the locked image model
 *      actually accepts.
 *
 *   2. `approveImagePlan` decides, deterministically, how many of those assets
 *      the backend will pay for. Ordering is required-first, then priority,
 *      then id; anything past the count or USD ceiling is DEFERRED, not
 *      silently dropped, so the manifest can tell the truth about what is
 *      missing.
 *
 * ⚠️ A MODEL RESPONSE CAN NEVER RAISE THESE LIMITS. `approveImagePlan` only
 * reads `policy` for the ceiling; nothing in the plan can widen it. There is no
 * code path here that executes agent-supplied URLs, SQL or tool instructions —
 * a prompt is text, an id is matched against a strict pattern, and a route is a
 * sanitized path.
 *
 * Pure: no clock, no environment, no I/O.
 */

import { IMAGE_PROVIDER_USD_PER_IMAGE } from "@/lib/ai/image-models";
import type { ImageAspectRatio } from "@/lib/image-generation-options";
import {
  IMAGE_MAX_ALT_TEXT_CHARS,
  IMAGE_MAX_PAGE_PATH_CHARS,
  IMAGE_MAX_PLAN_ASSETS_FROM_MODEL,
  IMAGE_MAX_PROMPT_CHARS,
  IMAGE_PLAN_RATIOS,
  IMAGE_PLAN_SCHEMA_VERSION,
  normalizeSiteType,
  type ImagePlanningPolicy,
  type ImageSiteType,
} from "./policy";

export const IMAGE_PURPOSES = [
  "hero",
  "product",
  "category",
  "editorial",
  "feature",
  "background",
  "team",
  "testimonial",
  "logo",
  "other",
] as const;

export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export interface PlannedImage {
  /** Stable within the project, so retries and resumes address the same row. */
  assetId: string;
  pagePath: string;
  sectionId: string | null;
  purpose: ImagePurpose;
  required: boolean;
  /** 1 = highest. */
  priority: number;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  productId: string | null;
  productImageIndex: number | null;
  /**
   * Deterministic reuse hint: two placements with the same key share ONE
   * generated asset. Never a prompt-similarity guess.
   */
  reuseKey: string | null;
  alt: string;
}

export interface ImagePlanIssue {
  code: string;
  message: string;
  assetId?: string;
}

export interface NormalizedImagePlan {
  schemaVersion: number;
  siteType: ImageSiteType;
  images: PlannedImage[];
}

export type ImagePlanValidation =
  | { ok: true; plan: NormalizedImagePlan }
  | { ok: false; code: string; error: string; issues: ImagePlanIssue[] };

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const SECTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const REUSE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A page path must stay inside the generated site: a leading slash, no scheme,
 * no host, no traversal, no query or fragment that would let a planner smuggle
 * a URL into a prompt or a storage key.
 */
export function sanitizeImagePagePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IMAGE_MAX_PAGE_PATH_CHARS) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  if (trimmed.includes("\\") || trimmed.includes("?") || trimmed.includes("#")) return null;
  if (trimmed.includes("..") || /\s/.test(trimmed)) return null;
  // `//host/path` is protocol-relative: it points at another origin.
  if (trimmed.startsWith("//")) return null;
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return /^\/[A-Za-z0-9._~\-/]*$/.test(withSlash) ? withSlash : null;
}

function isRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && (IMAGE_PLAN_RATIOS as readonly string[]).includes(value);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalisePurpose(value: unknown): ImagePurpose {
  if (typeof value === "string") {
    const purpose = value.trim().toLowerCase();
    if ((IMAGE_PURPOSES as readonly string[]).includes(purpose)) return purpose as ImagePurpose;
  }
  return "other";
}

/**
 * Validate the planner's `images` output. Any structural defect rejects the
 * WHOLE plan: generating a partial image set from a half-read manifest would
 * put the wrong picture on a page and hide the fact that the plan was broken.
 */
export function validateImagePlan(
  raw: unknown,
  options: { maxAssets?: number } = {},
): ImagePlanValidation {
  const maxAssets = Math.max(
    0,
    Math.min(IMAGE_MAX_PLAN_ASSETS_FROM_MODEL, Math.floor(options.maxAssets ?? IMAGE_MAX_PLAN_ASSETS_FROM_MODEL)),
  );

  let siteType: ImageSiteType = "other";
  let entries: unknown[] = [];
  let schemaVersion = IMAGE_PLAN_SCHEMA_VERSION;

  if (Array.isArray(raw)) {
    entries = raw;
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    siteType = normalizeSiteType(record.siteType ?? record.site_type ?? record.category);
    const rawEntries = record.images ?? record.assets;
    if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
      // A present-but-unreadable list is a broken plan, not an empty one.
      return {
        ok: false,
        code: "IMAGE_PLAN_INVALID",
        error: "The image plan's `images` field must be an array of assets.",
        issues: [{ code: "invalid_container", message: "`images` must be an array." }],
      };
    }
    entries = (rawEntries ?? []) as unknown[];
    const version = record.schemaVersion ?? record.schema_version;
    if (typeof version === "number" && Number.isInteger(version) && version > 0) {
      schemaVersion = Math.min(version, IMAGE_PLAN_SCHEMA_VERSION);
    }
  } else {
    return {
      ok: false,
      code: "IMAGE_PLAN_INVALID",
      error: "The image plan must be an array of assets or an object with an `images` array.",
      issues: [{ code: "not_an_object", message: "Invalid image plan container." }],
    };
  }

  if (entries.length > maxAssets) {
    return {
      ok: false,
      code: "IMAGE_PLAN_TOO_LARGE",
      error: `The planner proposed ${entries.length} images, which exceeds the ${maxAssets}-asset planning ceiling.`,
      issues: [
        { code: "too_many_assets", message: `At most ${maxAssets} images may be planned.` },
      ],
    };
  }

  const images: PlannedImage[] = [];
  const issues: ImagePlanIssue[] = [];
  const seenIds = new Set<string>();
  const seenPlacements = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ code: "invalid_entry", message: `Asset ${index + 1} is not an object.` });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const assetId = boundedText(record.assetId ?? record.asset_id ?? record.id, 64).toLowerCase();
    if (!ASSET_ID_PATTERN.test(assetId)) {
      issues.push({
        code: "invalid_asset_id",
        message: `Asset ${index + 1} has an invalid id. Use lowercase letters, digits, "-" or "_" (max 64).`,
      });
      continue;
    }
    if (seenIds.has(assetId)) {
      issues.push({
        code: "duplicate_asset_id",
        message: `Asset id "${assetId}" is used more than once.`,
        assetId,
      });
      continue;
    }
    seenIds.add(assetId);

    const prompt = boundedText(record.prompt, IMAGE_MAX_PROMPT_CHARS);
    if (!prompt) {
      issues.push({
        code: "missing_prompt",
        message: `Asset "${assetId}" has no generation prompt.`,
        assetId,
      });
      continue;
    }

    const pagePath = sanitizeImagePagePath(
      record.pagePath ?? record.page_path ?? record.page ?? record.route ?? "/",
    );
    if (!pagePath) {
      issues.push({
        code: "invalid_page_path",
        message: `Asset "${assetId}" has an invalid page path. Use a site-relative path such as "/" or "/pricing".`,
        assetId,
      });
      continue;
    }

    const rawRatio = record.aspectRatio ?? record.aspect_ratio;
    const aspectRatio = isRatio(rawRatio) ? rawRatio : "16:9";
    if (rawRatio !== undefined && !isRatio(rawRatio)) {
      issues.push({
        code: "unsupported_aspect_ratio",
        message: `Asset "${assetId}" asks for an aspect ratio the image model does not support.`,
        assetId,
      });
      continue;
    }

    const sectionId = boundedText(record.sectionId ?? record.section_id ?? record.section, 64);
    if (sectionId && !SECTION_ID_PATTERN.test(sectionId)) {
      issues.push({
        code: "invalid_section_id",
        message: `Asset "${assetId}" has an invalid section id.`,
        assetId,
      });
      continue;
    }

    const productId = boundedText(record.productId ?? record.product_id, 64);
    if (productId && !PRODUCT_ID_PATTERN.test(productId)) {
      issues.push({
        code: "invalid_product_id",
        message: `Asset "${assetId}" has an invalid product id.`,
        assetId,
      });
      continue;
    }

    const reuseKey = boundedText(record.reuseKey ?? record.reuse_key, 64).toLowerCase();
    if (reuseKey && !REUSE_KEY_PATTERN.test(reuseKey)) {
      issues.push({
        code: "invalid_reuse_key",
        message: `Asset "${assetId}" has an invalid reuse key.`,
        assetId,
      });
      continue;
    }

    /**
     * The same placement twice is a planning mistake, not two images: the page,
     * section and purpose together identify where the asset is shown.
     */
    const placement = `${pagePath}|${sectionId}|${normalisePurpose(record.purpose)}|${productId}`;
    if (seenPlacements.has(placement)) {
      issues.push({
        code: "duplicate_placement",
        message: `Asset "${assetId}" repeats the same page, section and purpose as another asset.`,
        assetId,
      });
      continue;
    }
    seenPlacements.add(placement);

    const rawPriority = record.priority;
    const priority =
      typeof rawPriority === "number" && Number.isFinite(rawPriority)
        ? Math.max(1, Math.min(5, Math.round(rawPriority)))
        : 3;

    const rawProductIndex = record.productImageIndex ?? record.product_image_index;
    const productImageIndex =
      typeof rawProductIndex === "number" &&
      Number.isInteger(rawProductIndex) &&
      rawProductIndex >= 0 &&
      rawProductIndex <= 20
        ? rawProductIndex
        : null;

    const alt =
      boundedText(record.alt ?? record.altText ?? record.alt_text, IMAGE_MAX_ALT_TEXT_CHARS) ||
      boundedText(`${normalisePurpose(record.purpose)} image`, IMAGE_MAX_ALT_TEXT_CHARS);

    images.push({
      assetId,
      pagePath,
      sectionId: sectionId || null,
      purpose: normalisePurpose(record.purpose),
      required: record.required === true,
      priority,
      prompt,
      aspectRatio,
      productId: productId || null,
      productImageIndex,
      reuseKey: reuseKey || null,
      alt,
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "IMAGE_PLAN_INVALID",
      error: `The image plan was rejected: ${issues[0].message}`,
      issues,
    };
  }

  return { ok: true, plan: { schemaVersion, siteType, images } };
}

export interface ApprovedImagePlan {
  schemaVersion: number;
  siteType: ImageSiteType;
  modelId: string;
  /** Assets the backend will generate, in execution order. */
  approved: PlannedImage[];
  /** Placements satisfied by another approved asset's `reuseKey`. */
  reused: PlannedImage[];
  /** Assets the backend refused to pay for in this run. */
  deferred: PlannedImage[];
  counts: {
    planned: number;
    required: number;
    optional: number;
    approved: number;
    reused: number;
    deferred: number;
  };
  estimatedCostUsd: number;
  withinBudget: boolean;
  deferredReason: string | null;
}

function orderImages(images: readonly PlannedImage[]): PlannedImage[] {
  return [...images].sort((left, right) => {
    if (left.required !== right.required) return left.required ? -1 : 1;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.assetId.localeCompare(right.assetId);
  });
}

/**
 * Deterministic approval. Required assets are considered first; the cost and
 * count ceilings then decide which optional assets survive. Nothing here can be
 * influenced by the model beyond the order the plan already describes.
 */
export function approveImagePlan(
  plan: NormalizedImagePlan,
  policy: Pick<ImagePlanningPolicy, "maxAssets" | "maxRunCostUsd" | "usdPerImage" | "modelId" | "siteType">,
): ApprovedImagePlan {
  const usdPerImage = policy.usdPerImage > 0 ? policy.usdPerImage : IMAGE_PROVIDER_USD_PER_IMAGE;
  const maxAssets = Math.max(0, Math.floor(policy.maxAssets));
  const maxCost = Math.max(0, policy.maxRunCostUsd);

  const required = plan.images.filter((image) => image.required).length;
  const ordered = orderImages(plan.images);

  const approved: PlannedImage[] = [];
  const reused: PlannedImage[] = [];
  const deferred: PlannedImage[] = [];
  const reuseKeys = new Map<string, string>();

  let deferredReason: string | null = null;

  for (const image of ordered) {
    if (image.reuseKey && reuseKeys.has(image.reuseKey)) {
      reused.push(image);
      continue;
    }
    if (approved.length >= maxAssets) {
      deferred.push(image);
      deferredReason ??= `The run's image budget allows ${maxAssets} new asset(s).`;
      continue;
    }
    const nextCost = Math.round((approved.length + 1) * usdPerImage * 1_000_000) / 1_000_000;
    if (nextCost > maxCost + 1e-9) {
      deferred.push(image);
      deferredReason ??= `The run's image spend limit is $${maxCost.toFixed(2)}.`;
      continue;
    }
    approved.push(image);
    if (image.reuseKey) reuseKeys.set(image.reuseKey, image.assetId);
  }

  const estimatedCostUsd =
    Math.round(approved.length * usdPerImage * 1_000_000) / 1_000_000;

  return {
    schemaVersion: plan.schemaVersion,
    siteType: plan.siteType || policy.siteType,
    modelId: policy.modelId,
    approved,
    reused,
    deferred,
    counts: {
      planned: plan.images.length,
      required,
      optional: plan.images.length - required,
      approved: approved.length,
      reused: reused.length,
      deferred: deferred.length,
    },
    estimatedCostUsd,
    withinBudget: deferred.length === 0,
    deferredReason,
  };
}

export interface ImageAssetReference {
  assetId: string;
  pagePath: string;
  sectionId: string | null;
  purpose: ImagePurpose;
  productId: string | null;
  productImageIndex: number | null;
  alt: string;
  aspectRatio: string;
  /** Absolute, publicly readable URL of the persisted asset. */
  url: string;
}
