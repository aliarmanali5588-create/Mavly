/**
 * ═══ IMAGE PLANNING POLICY — BACKEND-OWNED LIMITS, NEVER MODEL-OWNED ═════════
 *
 * The Planning Agent decides WHAT imagery a website needs. This module decides
 * what the backend will actually authorize, and nothing in a model response can
 * raise it:
 *
 *   · the effective asset count is capped by configuration and site type;
 *   · the large-catalog ceiling is an operator cohort, not a planner claim;
 *   · the estimated provider spend is capped in USD;
 *   · every value is bounded so a typo cannot disable the guard.
 *
 * ⚠️ USER CREDITS ARE NOT TOUCHED HERE. Mavly's credit foundation prices a
 * generation RUN, and this build has no image price. Charging or reserving
 * credits per image would be a new charging policy, which this feature must not
 * introduce. Provider cost is recorded as provider cost (with `cost_known` /
 * uncertainty), never as a user debit.
 *
 * Pure: the caller passes the environment, so tests never depend on the host.
 */

import {
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_PLAN_ASPECT_RATIOS,
  IMAGE_PROVIDER_USD_PER_IMAGE,
} from "@/lib/ai/image-models";
import type { ImageAspectRatio } from "@/lib/image-generation-options";

/** The image plan schema this build writes and reads. */
export const IMAGE_PLAN_SCHEMA_VERSION = 1;

export type ImageSiteType =
  | "landing"
  | "saas"
  | "content"
  | "local"
  | "ecommerce"
  | "catalog"
  | "other";

/**
 * Planning guidance, not a promise. The planner picks the actual number inside
 * the range the backend authorizes; `max` is what the backend will accept.
 */
export const IMAGE_SITE_TYPE_BUDGETS: Readonly<
  Record<ImageSiteType, { min: number; max: number; label: string }>
> = {
  landing: { min: 3, max: 8, label: "landing page or portfolio" },
  saas: { min: 5, max: 12, label: "SaaS website" },
  content: { min: 5, max: 15, label: "blog or content website" },
  local: { min: 6, max: 15, label: "restaurant or local business" },
  ecommerce: { min: 15, max: 40, label: "e-commerce store" },
  catalog: { min: 40, max: 80, label: "large product catalog" },
  other: { min: 0, max: 8, label: "small website" },
};

/** Default ceiling for one standard generation run. */
export const IMAGE_STANDARD_MAX_ASSETS = 40;
/** Absolute ceiling, reachable only by an authorized large-catalog project. */
export const IMAGE_LARGE_CATALOG_MAX_ASSETS = 80;
/** SQL mirrors this: the durable plan RPC refuses more than this. */
export const IMAGE_MAX_ASSETS_HARD_LIMIT = 80;

/** Default provider-spend ceiling for one run's images. */
export const IMAGE_DEFAULT_MAX_RUN_COST_USD = 0.3;
/** Absolute ceiling for one run's images, regardless of configuration. */
export const IMAGE_MAX_RUN_COST_HARD_LIMIT_USD = 1;

export const IMAGE_MAX_ATTEMPTS = 2;
export const IMAGE_JOB_TIMEOUT_MS = 45_000;
export const IMAGE_DEFAULT_CONCURRENCY = 2;
export const IMAGE_MAX_CONCURRENCY = 4;
/** The stage never takes more than this from the run's remaining budget. */
export const IMAGE_STAGE_MAX_MS = 60_000;
/** The stage leaves this much for the code batches and finalization. */
export const IMAGE_STAGE_MIN_GENERATION_MS = 60_000;
export const IMAGE_DEFAULT_BUCKET = "project-images";

export const IMAGE_MAX_PLAN_ASSETS_FROM_MODEL = IMAGE_LARGE_CATALOG_MAX_ASSETS * 2;
export const IMAGE_MAX_PROMPT_CHARS = 1_000;
export const IMAGE_MAX_ALT_TEXT_CHARS = 200;
export const IMAGE_MAX_PAGE_PATH_CHARS = 200;

export type ImagePlanningDisabledReason =
  | "flag_disabled"
  | "provider_not_configured"
  | "android_project";

export interface ImagePlanningPolicy {
  enabled: boolean;
  disabledReason: ImagePlanningDisabledReason | null;
  modelId: string;
  siteType: ImageSiteType;
  /** The authorized number of NEW assets for this run. */
  maxAssets: number;
  standardMaxAssets: number;
  largeCatalogAuthorized: boolean;
  maxRunCostUsd: number;
  usdPerImage: number;
  concurrency: number;
  perAssetTimeoutMs: number;
  maxAttempts: number;
  bucket: string;
}

function flagEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

function wholeInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw?.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function usdInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw?.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cohortList(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (!value || value === "*") return [];
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** The planner's own category string, normalized. Unrecognised → `other`. */
export function normalizeSiteType(value: unknown): ImageSiteType {
  if (typeof value !== "string") return "other";
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Record<string, ImageSiteType> = {
    landing: "landing",
    landingpage: "landing",
    portfolio: "landing",
    personal: "landing",
    saas: "saas",
    software: "saas",
    dashboard: "saas",
    app: "saas",
    blog: "content",
    content: "content",
    editorial: "content",
    news: "content",
    restaurant: "local",
    local: "local",
    localbusiness: "local",
    agency: "local",
    ecommerce: "ecommerce",
    ecommercestore: "ecommerce",
    shop: "ecommerce",
    store: "ecommerce",
    marketplace: "ecommerce",
    catalog: "catalog",
    largecatalog: "catalog",
    productcatalog: "catalog",
  };
  return aliases[normalized] ?? "other";
}

/**
 * Resolve the effective image policy for one run.
 *
 * `providerConfigured` is passed in rather than read from the process so the
 * caller decides when a missing key is a refusal; a disabled policy never runs
 * the stage and never pretends assets exist.
 */
export function imagePlanningPolicyFor(input: {
  siteType?: unknown;
  projectId?: string | null;
  projectType?: "website" | "android";
  providerConfigured?: boolean;
  env?: NodeJS.ProcessEnv;
}): ImagePlanningPolicy {
  const env = input.env ?? process.env;
  const siteType = normalizeSiteType(input.siteType);

  const standardMaxAssets = wholeInRange(
    env.MAVLY_IMAGE_MAX_ASSETS,
    IMAGE_STANDARD_MAX_ASSETS,
    0,
    IMAGE_STANDARD_MAX_ASSETS,
  );
  const maxRunCostUsd = usdInRange(
    env.MAVLY_IMAGE_MAX_RUN_COST_USD,
    IMAGE_DEFAULT_MAX_RUN_COST_USD,
    0,
    IMAGE_MAX_RUN_COST_HARD_LIMIT_USD,
  );
  const concurrency = wholeInRange(
    env.MAVLY_IMAGE_CONCURRENCY,
    IMAGE_DEFAULT_CONCURRENCY,
    1,
    IMAGE_MAX_CONCURRENCY,
  );
  const perAssetTimeoutMs = wholeInRange(
    env.MAVLY_IMAGE_TIMEOUT_MS,
    IMAGE_JOB_TIMEOUT_MS,
    5_000,
    120_000,
  );
  const maxAttempts = wholeInRange(env.MAVLY_IMAGE_MAX_ATTEMPTS, IMAGE_MAX_ATTEMPTS, 1, 3);
  const bucket = (env.MAVLY_IMAGE_STORAGE_BUCKET ?? "").trim() || IMAGE_DEFAULT_BUCKET;

  const project = (input.projectId ?? "").trim().toLowerCase();
  const largeCatalogAuthorized =
    project.length > 0 && cohortList(env.MAVLY_IMAGE_LARGE_CATALOG_PROJECTS).includes(project);

  /**
   * Only an authorized large-catalog project may exceed the standard ceiling.
   * The planner's own range never raises this; validation trims to it.
   */
  const largeCatalogCeiling =
    siteType === "catalog" && largeCatalogAuthorized
      ? IMAGE_LARGE_CATALOG_MAX_ASSETS
      : standardMaxAssets;
  const maxAssets = Math.max(0, Math.min(IMAGE_MAX_ASSETS_HARD_LIMIT, largeCatalogCeiling));

  let disabledReason: ImagePlanningDisabledReason | null = null;
  if (!flagEnabled(env.MAVLY_IMAGE_PLANNING_ENABLED)) disabledReason = "flag_disabled";
  else if (input.projectType === "android") disabledReason = "android_project";
  else if (input.providerConfigured === false) disabledReason = "provider_not_configured";

  return {
    enabled: disabledReason === null,
    disabledReason,
    modelId: DEFAULT_IMAGE_MODEL_ID,
    siteType,
    maxAssets,
    standardMaxAssets,
    largeCatalogAuthorized,
    maxRunCostUsd,
    usdPerImage: IMAGE_PROVIDER_USD_PER_IMAGE,
    concurrency,
    perAssetTimeoutMs,
    maxAttempts,
    bucket,
  };
}

/**
 * How long the image stage may take from the run's remaining budget. Zero means
 * "do not start": there is not enough time left for the code batches.
 */
export function imageStageBudgetMs(input: {
  remainingMs: number;
  maxMs?: number;
  minGenerationMs?: number;
}): number {
  const maxMs = Math.max(0, Math.floor(input.maxMs ?? IMAGE_STAGE_MAX_MS));
  const minGenerationMs = Math.max(0, Math.floor(input.minGenerationMs ?? IMAGE_STAGE_MIN_GENERATION_MS));
  const remaining = Math.max(0, Math.floor(input.remainingMs));
  return Math.max(0, Math.min(maxMs, remaining - minGenerationMs));
}

/**
 * The aspect ratios an image plan may ask for: the locked model's own enum,
 * imported rather than restated, so the plan validator, the provider request
 * and the SQL check cannot drift apart.
 */
export const IMAGE_PLAN_RATIOS: readonly ImageAspectRatio[] = IMAGE_PLAN_ASPECT_RATIOS;
