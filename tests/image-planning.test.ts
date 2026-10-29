import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_PLAN_ASPECT_RATIOS,
  IMAGE_PROVIDER_USD_PER_IMAGE,
} from "../src/lib/ai/image-models";
import type {
  ImageGenerationFailure,
  ImageGenerationResult,
  ImageGenerationSuccess,
} from "../src/lib/ai/openrouter-images";
import { imageStoragePath, IMAGE_STORAGE_MAX_BYTES } from "../src/lib/images/asset-store";
import {
  approveImagePlan,
  sanitizeImagePagePath,
  validateImagePlan,
  type PlannedImage,
} from "../src/lib/images/manifest";
import {
  IMAGE_LARGE_CATALOG_MAX_ASSETS,
  IMAGE_STANDARD_MAX_ASSETS,
  imagePlanningPolicyFor,
  imageStageBudgetMs,
} from "../src/lib/images/policy";
import { batchImageBlock, plannerImageAddendum } from "../src/lib/images/prompt";
import { runImageStage, type ImageStageDeps } from "../src/lib/images/service";
import type { ClaimedImageAsset, PersistedImageAssetRow } from "../src/lib/images/store";

/**
 * ═══ PLANNING-DRIVEN WEBSITE IMAGERY — PURE AND MOCKED ═══════════════════════
 *
 * Nothing here spends a provider call or touches Supabase: the plan validator,
 * the approval/budget rules and the stage are exercised through the same
 * dependency seam the run uses, with every provider/DB interaction stubbed.
 *
 * ⚠️ WHAT IS ASSERTED IS BACKEND BEHAVIOUR, NOT MODEL BEHAVIOUR. The planner is
 * free to propose anything; these tests prove that a bad or oversized plan is
 * refused, that approved count and spend are backend-owned, and that an asset is
 * only ever "ready" after its bytes were validated, stored and the row written.
 */

const RECRAFT = "recraft/recraft-v4.1-flash";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A plan entry as the planner would return it (raw JSON, not trusted yet). */
function rawAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: "hero-home",
    pagePath: "/",
    sectionId: "hero",
    purpose: "hero",
    required: true,
    priority: 1,
    prompt: "Editorial hero photograph of a bright studio workspace, soft daylight",
    aspectRatio: "16:9",
    alt: "Workspace bathed in daylight",
    ...overrides,
  };
}

function planned(overrides: Partial<PlannedImage> = {}): PlannedImage {
  return {
    assetId: "hero-home",
    pagePath: "/",
    sectionId: "hero",
    purpose: "hero",
    required: true,
    priority: 1,
    prompt: "Editorial hero photograph of a bright studio workspace",
    aspectRatio: "16:9",
    productId: null,
    productImageIndex: null,
    reuseKey: null,
    alt: "Workspace bathed in daylight",
    ...overrides,
  };
}

function policyFor(
  input: {
    siteType?: string;
    projectId?: string;
    projectType?: "website" | "android";
    providerConfigured?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  return imagePlanningPolicyFor({
    siteType: input.siteType ?? "landing",
    projectId: input.projectId ?? "demo-site",
    projectType: input.projectType ?? "website",
    providerConfigured: input.providerConfigured ?? true,
    env: input.env ?? {},
  });
}

function approvedPlanOf(raw: unknown) {
  const validated = validateImagePlan(raw);
  assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
  if (!validated.ok) throw new Error("unreachable");
  return validated.plan;
}

// ── planning: the shape and the count the backend will accept ───────────────

test("a landing page plan is validated and approved inside its own small budget", () => {
  const plan = approvedPlanOf({
    siteType: "landing",
    images: [
      rawAsset(),
      rawAsset({ assetId: "feature-grid", sectionId: "features", purpose: "feature", required: false, priority: 2 }),
      rawAsset({ assetId: "about-portrait", pagePath: "/about", sectionId: "team", purpose: "team", required: false, priority: 3 }),
    ],
  });

  assert.equal(plan.siteType, "landing");
  assert.equal(plan.images.length, 3);

  const approved = approveImagePlan(plan, policyFor({ siteType: "landing" }));
  assert.equal(approved.counts.planned, 3);
  assert.equal(approved.counts.approved, 3);
  assert.equal(approved.counts.required, 1);
  assert.equal(approved.counts.optional, 2);
  assert.equal(approved.counts.deferred, 0);
  assert.equal(approved.modelId, DEFAULT_IMAGE_MODEL_ID);
  // 3 × $0.007 — the provider's verified per-image price, not a credit price.
  assert.equal(approved.estimatedCostUsd, 0.021);
  assert.equal(approved.withinBudget, true);
});

test("a SaaS plan keeps every planned asset while it fits the standard budget", () => {
  const images = Array.from({ length: 9 }, (_, index) =>
    rawAsset({
      assetId: `saas-${index}`,
      pagePath: index < 6 ? "/" : "/pricing",
      sectionId: `section-${index}`,
      purpose: index === 0 ? "hero" : "feature",
      required: index === 0,
      priority: index === 0 ? 1 : 3,
    }),
  );

  const approved = approveImagePlan(approvedPlanOf({ siteType: "saas", images }), policyFor({ siteType: "saas" }));
  assert.equal(approved.counts.approved, 9);
  assert.equal(approved.counts.deferred, 0);
  assert.equal(approved.counts.required, 1);
});

test("an e-commerce plan maps product, category and hero imagery to their own ids", () => {
  const images = [
    rawAsset({ assetId: "store-hero", pagePath: "/", sectionId: "hero", purpose: "hero" }),
    rawAsset({ assetId: "cat-lighting", pagePath: "/collections/lighting", sectionId: "header", purpose: "category", required: false }),
    rawAsset({
      assetId: "prod-lamp-primary",
      pagePath: "/products/arc-lamp",
      sectionId: "gallery",
      purpose: "product",
      productId: "arc-lamp",
      productImageIndex: 0,
      required: true,
      priority: 2,
    }),
    rawAsset({
      assetId: "prod-lamp-detail",
      pagePath: "/products/arc-lamp",
      sectionId: "detail",
      purpose: "product",
      productId: "arc-lamp",
      productImageIndex: 1,
      required: false,
      priority: 4,
    }),
  ];

  const approved = approveImagePlan(
    approvedPlanOf({ siteType: "ecommerce", images }),
    policyFor({ siteType: "ecommerce" }),
  );

  assert.equal(approved.counts.approved, 4);
  const lamp = approved.approved.filter((asset) => asset.productId === "arc-lamp");
  assert.equal(lamp.length, 2);
  assert.deepEqual(
    lamp.map((asset) => asset.productImageIndex).sort(),
    [0, 1],
  );
  assert.deepEqual(
    lamp.map((asset) => asset.assetId).sort(),
    ["prod-lamp-detail", "prod-lamp-primary"],
  );
  // Nothing is swapped between placements: each asset keeps its own product id.
  assert.deepEqual(
    approved.approved.map((asset) => `${asset.assetId}:${asset.productId ?? "none"}`),
    [
      "store-hero:none",
      "prod-lamp-primary:arc-lamp",
      "cat-lighting:none",
      "prod-lamp-detail:arc-lamp",
    ],
  );
});

test("a shared reuse key is one generated asset, not a second paid call", () => {
  const images = [
    rawAsset({ assetId: "campaign-a", sectionId: "promo-a", purpose: "editorial", reuseKey: "spring-campaign" }),
    rawAsset({ assetId: "campaign-b", pagePath: "/collections", sectionId: "promo-b", purpose: "editorial", reuseKey: "spring-campaign" }),
  ];

  const approved = approveImagePlan(approvedPlanOf({ images }), policyFor({ siteType: "ecommerce" }));
  assert.equal(approved.counts.approved, 1);
  assert.equal(approved.counts.reused, 1);
  assert.equal(approved.estimatedCostUsd, IMAGE_PROVIDER_USD_PER_IMAGE);
});

test("a plan larger than the standard ceiling is trimmed, and only a cohort lifts it", () => {
  const images = Array.from({ length: 60 }, (_, index) =>
    rawAsset({
      assetId: `catalog-${index}`,
      pagePath: "/",
      sectionId: `slot-${index}`,
      purpose: "product",
      productId: `product-${index}`,
      required: index === 0,
      priority: index === 0 ? 1 : 3,
    }),
  );
  const plan = approvedPlanOf({ siteType: "catalog", images });

  const unauthorized = approveImagePlan(plan, policyFor({ siteType: "catalog" }));
  assert.equal(unauthorized.counts.approved, IMAGE_STANDARD_MAX_ASSETS);
  assert.equal(unauthorized.counts.deferred, 20);
  assert.equal(unauthorized.withinBudget, false);
  assert.match(unauthorized.deferredReason ?? "", /budget allows 40/);

  const authorized = approveImagePlan(
    plan,
    policyFor({
      siteType: "catalog",
      projectId: "big-catalog",
      env: { MAVLY_IMAGE_LARGE_CATALOG_PROJECTS: "some-other-project, big-catalog" },
    }),
  );
  assert.equal(authorized.counts.approved, 60);
  assert.equal(authorized.counts.deferred, 0);
});

test("the large-catalog cohort needs BOTH the cohort entry and a catalog site type", () => {
  const env = { MAVLY_IMAGE_LARGE_CATALOG_PROJECTS: "big-catalog" };
  assert.equal(
    policyFor({ siteType: "catalog", projectId: "big-catalog", env }).maxAssets,
    IMAGE_LARGE_CATALOG_MAX_ASSETS,
  );
  // A cohort entry does not raise a landing page's ceiling…
  assert.equal(policyFor({ siteType: "landing", projectId: "big-catalog", env }).maxAssets, IMAGE_STANDARD_MAX_ASSETS);
  // …and a catalog project outside the cohort keeps the standard ceiling.
  assert.equal(policyFor({ siteType: "catalog", projectId: "other", env }).maxAssets, IMAGE_STANDARD_MAX_ASSETS);
  // `*` is never a cohort.
  assert.equal(
    policyFor({ siteType: "catalog", projectId: "big-catalog", env: { MAVLY_IMAGE_LARGE_CATALOG_PROJECTS: "*" } })
      .maxAssets,
    IMAGE_STANDARD_MAX_ASSETS,
  );
});

test("a planner cannot raise the ceiling through its own output", () => {
  // A count ceiling is clamped by configuration, never by the response.
  const configured = policyFor({ env: { MAVLY_IMAGE_MAX_ASSETS: "6" } });
  assert.equal(configured.maxAssets, 6);

  const images = Array.from({ length: 9 }, (_, index) =>
    rawAsset({ assetId: `shot-${index}`, sectionId: `slot-${index}`, purpose: "feature", required: false }),
  );
  const approved = approveImagePlan(approvedPlanOf({ images }), configured);
  assert.equal(approved.counts.approved, 6);
  assert.equal(approved.counts.deferred, 3);

  // A configured value above the hard limit is clamped, not honoured.
  assert.equal(policyFor({ env: { MAVLY_IMAGE_MAX_ASSETS: "500" } }).maxAssets, IMAGE_STANDARD_MAX_ASSETS);
  // Garbage falls back to the default instead of disabling the guard.
  assert.equal(policyFor({ env: { MAVLY_IMAGE_MAX_ASSETS: "lots" } }).maxAssets, IMAGE_STANDARD_MAX_ASSETS);
});

test("the provider-spend ceiling trims optional assets after the required ones", () => {
  // $0.02 / $0.007 per image = 2 affordable assets.
  const policy = policyFor({ env: { MAVLY_IMAGE_MAX_RUN_COST_USD: "0.02" } });
  assert.equal(policy.maxRunCostUsd, 0.02);

  const images = [
    rawAsset({ assetId: "optional-1", sectionId: "s1", purpose: "feature", required: false, priority: 2 }),
    rawAsset({ assetId: "hero-required", sectionId: "hero", required: true, priority: 1 }),
    rawAsset({ assetId: "optional-2", sectionId: "s2", purpose: "feature", required: false, priority: 2 }),
  ];

  const approved = approveImagePlan(approvedPlanOf({ images }), policy);
  assert.equal(approved.counts.approved, 2);
  assert.deepEqual(
    approved.approved.map((asset) => asset.assetId),
    ["hero-required", "optional-1"],
  );
  assert.deepEqual(
    approved.deferred.map((asset) => asset.assetId),
    ["optional-2"],
  );
  assert.equal(approved.estimatedCostUsd, 0.014);
  assert.match(approved.deferredReason ?? "", /spend limit/);
});

test("a malformed, oversized or duplicated plan is rejected outright", () => {
  assert.equal(validateImagePlan({ images: "hero, about" }).ok, false);
  assert.equal(validateImagePlan("nope").ok, false);

  const duplicateIds = validateImagePlan({
    images: [rawAsset(), rawAsset({ sectionId: "other" })],
  });
  assert.equal(duplicateIds.ok, false);
  if (duplicateIds.ok) return;
  assert.equal(duplicateIds.issues[0].code, "duplicate_asset_id");

  const duplicatePlacement = validateImagePlan({
    images: [rawAsset(), rawAsset({ assetId: "hero-home-2" })],
  });
  assert.equal(duplicatePlacement.ok, false);
  if (duplicatePlacement.ok) return;
  assert.equal(duplicatePlacement.issues[0].code, "duplicate_placement");

  assert.equal(validateImagePlan({ images: [rawAsset({ prompt: "   " })] }).ok, false);
  assert.equal(validateImagePlan({ images: [rawAsset({ aspectRatio: "21:9" })] }).ok, false);
  assert.equal(validateImagePlan({ images: [rawAsset({ pagePath: "https://evil.test/x.png" })] }).ok, false);
  assert.equal(validateImagePlan({ images: [rawAsset({ pagePath: "/../../etc/passwd" })] }).ok, false);
  assert.equal(validateImagePlan({ images: [rawAsset({ assetId: "Hero Home" })] }).ok, false);

  // The planning ceiling itself is bounded before any approval happens.
  const tooMany = validateImagePlan(
    { images: Array.from({ length: 200 }, (_, index) => rawAsset({ assetId: `x-${index}`, sectionId: `s-${index}` })) },
    { maxAssets: 500 },
  );
  assert.equal(tooMany.ok, false);
  if (tooMany.ok) return;
  assert.equal(tooMany.code, "IMAGE_PLAN_TOO_LARGE");
});

test("image planning is off without the flag, a provider key, or on Android", () => {
  assert.equal(policyFor({ env: { MAVLY_IMAGE_PLANNING_ENABLED: "0" } }).enabled, false);
  assert.equal(policyFor({ env: { MAVLY_IMAGE_PLANNING_ENABLED: "false" } }).disabledReason, "flag_disabled");
  assert.equal(policyFor({ providerConfigured: false }).disabledReason, "provider_not_configured");
  assert.equal(policyFor({ projectType: "android" }).disabledReason, "android_project");
  assert.equal(policyFor().enabled, true);
});

test("the page path and storage path sanitizers refuse anything outside the project", () => {
  assert.equal(sanitizeImagePagePath("/pricing"), "/pricing");
  assert.equal(sanitizeImagePagePath("about"), "/about");
  assert.equal(sanitizeImagePagePath("javascript:alert(1)"), null);
  assert.equal(sanitizeImagePagePath("//evil.test/x"), null);
  assert.equal(sanitizeImagePagePath("/a b"), null);

  const runId = "0f3f6f5e-1c2b-4f7a-9d61-5a3f2f9b7c11";
  assert.equal(
    imageStoragePath({ projectId: "demo-site", runId, assetKey: "hero-home", format: "jpeg" }),
    `demo-site/${runId}/hero-home.jpg`,
  );
  assert.equal(imageStoragePath({ projectId: "../etc", runId, assetKey: "hero", format: "png" }), null);
  assert.equal(imageStoragePath({ projectId: "demo-site", runId: "not-a-uuid", assetKey: "hero", format: "png" }), null);
  assert.equal(imageStoragePath({ projectId: "demo-site", runId, assetKey: "../../x", format: "png" }), null);
  assert.ok(IMAGE_STORAGE_MAX_BYTES >= 4_000_000);
});

test("the stage's time slice can never eat the code batches", () => {
  assert.equal(imageStageBudgetMs({ remainingMs: 600_000 }), 60_000);
  assert.equal(imageStageBudgetMs({ remainingMs: 90_000, maxMs: 60_000, minGenerationMs: 60_000 }), 30_000);
  assert.equal(imageStageBudgetMs({ remainingMs: 45_000, maxMs: 60_000, minGenerationMs: 60_000 }), 0);
  assert.equal(imageStageBudgetMs({ remainingMs: 0 }), 0);
});

// ── prompts: the coding agent only ever sees persisted URLs ─────────────────

test("the coding block advertises only supplied URLs and forbids invented ones", () => {
  const block = batchImageBlock({
    assets: [
      {
        assetId: "hero-home",
        pagePath: "/",
        sectionId: "hero",
        purpose: "hero",
        productId: null,
        productImageIndex: null,
        alt: "Workspace bathed in daylight",
        aspectRatio: "16:9",
        url: "https://cdn.test/project-images/demo-site/run/hero-home.png",
      },
    ],
    pending: [{ assetId: "about-portrait", pagePath: "/about", purpose: "team", alt: "Studio portrait", reason: "failed" }],
  });

  assert.match(block, /https:\/\/cdn\.test\/project-images\/demo-site\/run\/hero-home\.png/);
  assert.match(block, /never invent, shorten, hotlink or guess another image URL/);
  assert.match(block, /preview\.html: NEVER reference these URLs or any remote image/);
  // The unavailable placement is named, and never given a URL.
  assert.match(block, /about-portrait on \/about/);
  assert.equal(/about-portrait[^\n]*https?:\/\//.test(block), false);
});

test("the planner addendum states the backend ceiling and the supported ratios", () => {
  const addendum = plannerImageAddendum(policyFor({ env: { MAVLY_IMAGE_MAX_ASSETS: "7", MAVLY_IMAGE_MAX_RUN_COST_USD: "0.05" } }));
  assert.match(addendum, /at most 7 NEW image assets/);
  assert.match(addendum, /image budget is \$0\.05\./);
  assert.match(addendum, /about \$0\.007 each/);
  for (const ratio of IMAGE_PLAN_ASPECT_RATIOS) assert.ok(addendum.includes(ratio), ratio);
  assert.match(addendum, /preview\.html must NOT reference these images/);
});

// ── execution: one bounded, idempotent, truthful stage ─────────────────────

function success(costUsd: number | null = IMAGE_PROVIDER_USD_PER_IMAGE): ImageGenerationSuccess {
  return {
    ok: true,
    image: { base64: PNG_BASE64, mediaType: "image/png", format: "png", bytes: 70 },
    model: RECRAFT,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null, costUsd },
    metadata: {
      status: 200,
      requestedModel: RECRAFT,
      providerRequestId: "req-test",
      retryAfterMs: null,
      errorCode: null,
      errorDetail: null,
    },
  };
}

function failure(code: ImageGenerationFailure["code"]): ImageGenerationFailure {
  return {
    ok: false,
    error: `mock ${code}`,
    code,
    retryable: false,
    retryAfterMs: null,
    metadata: {
      status: null,
      requestedModel: RECRAFT,
      providerRequestId: null,
      retryAfterMs: null,
      errorCode: code,
      errorDetail: `mock ${code}`,
    },
  };
}

function readyRow(overrides: Partial<PersistedImageAssetRow> = {}): PersistedImageAssetRow {
  return {
    id: "asset-1",
    assetKey: "hero-home",
    pagePath: "/",
    sectionId: "hero",
    purpose: "hero",
    productId: null,
    productImageIndex: null,
    alt: "Workspace bathed in daylight",
    aspectRatio: "16:9",
    status: "ready",
    reuseKey: null,
    publicUrl: "https://cdn.test/project-images/demo-site/run/hero-home.png",
    storagePath: "demo-site/0f3f6f5e-1c2b-4f7a-9d61-5a3f2f9b7c11/hero-home.png",
    mediaType: "image/png",
    ...overrides,
  };
}

interface HarnessOptions {
  assets?: PlannedImage[];
  rows?: PersistedImageAssetRow[];
  reusable?: PersistedImageAssetRow[];
  claim?: (asset: PlannedImage) => ClaimedImageAsset | null;
  generate?: (prompt: string) => ImageGenerationResult;
  upload?: (assetKey: string) => { ok: true; storagePath: string; publicUrl: string; bytes: number } | { ok: false; code: "STORAGE"; error: string };
  syncOk?: boolean;
  assertRunnable?: () => Promise<void>;
  clock?: () => number;
}

function harness(options: HarnessOptions = {}) {
  const assets = options.assets ?? [planned()];
  const events: string[] = [];
  const generated: string[] = [];
  const completed: Array<{ assetId: string; actualCostUsd: number | null; publicUrl: string }> = [];
  const failedAssets: Array<{ assetId: string; code: string; uncertain: boolean }> = [];
  let syncedAssets = 0;

  const deps: Partial<ImageStageDeps> = {
    syncPlan: async (_client, input) => {
      events.push("sync");
      if (options.syncOk === false) {
        return { ok: false, code: "BUDGET", error: "The image plan exceeds the backend's approved budget." };
      }
      syncedAssets = input.assets.length;
      return { ok: true, data: { planId: "plan-1", approvedCount: input.approvedCount } };
    },
    claim: async (_client, _projectId, _runId, assetKey) => {
      events.push(`claim:${assetKey}`);
      const asset = assets.find((entry) => entry.assetId === assetKey);
      if (!asset) return { ok: true, data: null };
      if (options.claim) return { ok: true, data: options.claim(asset) };
      return {
        ok: true,
        data: {
          id: `row-${asset.assetId}`,
          assetKey: asset.assetId,
          prompt: asset.prompt,
          aspectRatio: asset.aspectRatio,
          attempt: 1,
          maxAttempts: 2,
          pagePath: asset.pagePath,
          purpose: asset.purpose,
          sectionId: asset.sectionId,
          productId: asset.productId,
          alt: asset.alt,
        },
      };
    },
    complete: async (_client, input) => {
      events.push(`complete:${input.assetId}`);
      completed.push({
        assetId: input.assetId,
        actualCostUsd: input.actualCostUsd,
        publicUrl: input.publicUrl,
      });
      return { ok: true, data: true };
    },
    fail: async (_client, input) => {
      events.push(`fail:${input.assetId}`);
      failedAssets.push({ assetId: input.assetId, code: input.errorCode, uncertain: input.uncertain });
      return { ok: true, data: true };
    },
    listAssets: async () => ({ ok: true, data: options.rows ?? [] }),
    findReusable: async () => {
      const byKey = new Map<string, PersistedImageAssetRow>();
      for (const row of options.reusable ?? []) {
        if (row.reuseKey) byKey.set(row.reuseKey, row);
      }
      return { ok: true, data: byKey };
    },
    finishPlan: async () => ({
      ok: true,
      data: {
        planId: "plan-1",
        status: "completed" as const,
        ready: completed.length,
        failed: failedAssets.length,
        deferred: 0,
        pending: 0,
        requiredMissing: 0,
        approved: assets.length,
      },
    }),
    generate: async (input) => {
      events.push(`generate:${input.prompt}`);
      generated.push(input.prompt);
      return options.generate ? options.generate(input.prompt) : success();
    },
    upload: async (input) => {
      events.push(`upload:${input.assetKey}`);
      if (options.upload) return options.upload(input.assetKey);
      return {
        ok: true,
        storagePath: `demo-site/run/${input.assetKey}.png`,
        publicUrl: `https://cdn.test/project-images/demo-site/run/${input.assetKey}.png`,
        bytes: 70,
      };
    },
    now: options.clock ?? (() => 0),
  };

  return { deps, events, generated, completed, failedAssets, syncedAssets: () => syncedAssets };
}

async function run(
  plan: PlannedImage[],
  options: HarnessOptions & { policy?: ReturnType<typeof policyFor>; deadlineAt?: number } = {},
) {
  const built = harness({ ...options, assets: plan });
  const policy = options.policy ?? policyFor({ env: { MAVLY_IMAGE_CONCURRENCY: "1" } });
  const result = await runImageStage({
    client: null,
    projectId: "demo-site",
    runId: "0f3f6f5e-1c2b-4f7a-9d61-5a3f2f9b7c11",
    policy,
    plan: { schemaVersion: 1, siteType: policy.siteType, images: plan },
    deadlineAt: options.deadlineAt ?? 60_000,
    assertRunnable: options.assertRunnable,
    deps: built.deps,
  });
  return { result, ...built };
}

test("the stage persists the approved plan before any paid provider call", async () => {
  const { result, events, generated } = await run([planned()]);
  assert.equal(result.status, "completed");
  assert.deepEqual(events[0], "sync");
  assert.deepEqual(generated, [planned().prompt]);
  assert.ok(events.indexOf("sync") < events.indexOf(`claim:${planned().assetId}`));
});

test("a plan that cannot be persisted is never executed", async () => {
  const { result, events } = await run([planned()], { syncOk: false });
  assert.equal(result.status, "persist_failed");
  assert.deepEqual(events, ["sync"]);
  assert.equal(result.references.length, 0);
});

test("one asset is generated, stored and marked ready exactly once", async () => {
  const { result, events, completed, failedAssets } = await run([planned()]);

  assert.equal(result.status, "completed");
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.approved, 1);
  assert.equal(result.counts.pending, 0);
  assert.equal(result.costKnown, true);
  assert.equal(result.actualCostUsd, IMAGE_PROVIDER_USD_PER_IMAGE);
  assert.equal(result.requiredMissing, 0);
  assert.equal(result.planStatus, "completed");

  assert.deepEqual(events.filter((event) => event.startsWith("generate:")).length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].actualCostUsd, IMAGE_PROVIDER_USD_PER_IMAGE);
  assert.match(completed[0].publicUrl, /^https:\/\/cdn\.test\/project-images\//);
  assert.equal(failedAssets.length, 0);

  // The coding agent receives the persisted URL and its placement metadata.
  assert.deepEqual(result.references, [
    {
      assetId: "hero-home",
      pagePath: "/",
      sectionId: "hero",
      purpose: "hero",
      productId: null,
      productImageIndex: null,
      alt: "Workspace bathed in daylight",
      aspectRatio: "16:9",
      url: "https://cdn.test/project-images/demo-site/run/hero-home.png",
    },
  ]);
});

test("a resume reuses the finished asset instead of paying for it twice", async () => {
  const { result, events, generated } = await run([planned()], { rows: [readyRow()] });

  assert.deepEqual(generated, []);
  assert.equal(events.some((event) => event.startsWith("claim:")), false);
  assert.equal(result.counts.ready, 1);
  assert.equal(result.references[0].url, readyRow().publicUrl);
  assert.equal(result.status, "completed");
});

test("an asset another worker owns is not generated here", async () => {
  const { result, generated, failedAssets } = await run([planned()], { claim: () => null });

  assert.deepEqual(generated, []);
  assert.equal(failedAssets.length, 0);
  assert.equal(result.counts.ready, 0);
  assert.equal(result.counts.pending, 1);
  assert.deepEqual(result.pending.map((entry) => entry.reason), ["pending"]);
  // A half-finished plan is never reported as completed.
  assert.equal(result.status, "partial");
});

test("a matching asset from an earlier run is reused, recorded at zero cost", async () => {
  const reusable = readyRow({ reuseKey: "spring-campaign", publicUrl: "https://cdn.test/old.png" });
  const plan = [planned({ assetId: "campaign-a", reuseKey: "spring-campaign", purpose: "editorial" })];

  const { result, generated, completed } = await run(plan, { reusable: [reusable] });

  assert.deepEqual(generated, []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].actualCostUsd, 0);
  assert.equal(result.counts.reused, 1);
  assert.equal(result.counts.ready, 1);
  assert.equal(result.references[0].url, "https://cdn.test/old.png");
  assert.equal(result.actualCostUsd, 0);
});

test("a same-plan reuse shares one URL instead of generating a second image", async () => {
  const plan = [
    planned({ assetId: "campaign-a", sectionId: "promo-a", purpose: "editorial", required: false, reuseKey: "shared" }),
    planned({
      assetId: "campaign-b",
      pagePath: "/collections",
      sectionId: "promo-b",
      purpose: "editorial",
      required: false,
      reuseKey: "shared",
    }),
  ];

  const { result, generated } = await run(plan);

  // One paid asset, two placements.
  assert.equal(generated.length, 1);
  assert.equal(result.counts.approved, 1);
  assert.equal(result.counts.reused, 1);
  assert.equal(result.references.length, 2);
  assert.equal(new Set(result.references.map((reference) => reference.url)).size, 1);
  assert.deepEqual(
    result.references.map((reference) => reference.pagePath).sort(),
    ["/", "/collections"],
  );
  assert.equal(result.status, "completed");
});

test("a storage failure never marks the asset ready, but still records the spend", async () => {
  const { result, completed, failedAssets, events } = await run([planned()], {
    upload: () => ({ ok: false, code: "STORAGE", error: "The generated image could not be stored." }),
  });

  assert.equal(completed.length, 0);
  assert.equal(failedAssets.length, 1);
  assert.match(failedAssets[0].code, /STORAGE_FAILED/);
  assert.equal(events.some((event) => event.startsWith("complete:")), false);
  assert.equal(result.counts.ready, 0);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.references.length, 0);
  // The provider was paid even though the upload failed.
  assert.equal(result.actualCostUsd, IMAGE_PROVIDER_USD_PER_IMAGE);
  assert.equal(result.status, "partial");
});

test("a timeout is recorded as uncertain, never as zero cost", async () => {
  const { result, failedAssets } = await run([planned()], { generate: () => failure("TIMEOUT") });

  assert.equal(failedAssets.length, 1);
  assert.equal(failedAssets[0].uncertain, true);
  assert.equal(result.costKnown, false);
  assert.equal(result.actualCostUsd, null);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.references.length, 0);
});

test("a configuration failure costs nothing and is not called uncertain", async () => {
  const { result, failedAssets } = await run([planned()], { generate: () => failure("CONFIGURATION") });
  assert.equal(failedAssets[0].uncertain, false);
  assert.equal(result.costKnown, true);
  assert.equal(result.actualCostUsd, 0);
});

test("an expired deadline starts no new provider call", async () => {
  const { result, generated } = await run([planned(), planned({ assetId: "about-portrait", sectionId: "about", required: false })], {
    deadlineAt: 0,
  });

  assert.deepEqual(generated, []);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "deadline_reached");
  assert.equal(result.counts.pending, 2);
});

test("cancellation stops scheduling and keeps what already finished", async () => {
  let calls = 0;
  const plan = [
    planned(),
    planned({ assetId: "second", sectionId: "second", purpose: "feature", required: false }),
    planned({ assetId: "third", sectionId: "third", purpose: "feature", required: false }),
  ];

  const { result, generated, completed } = await run(plan, {
    assertRunnable: async () => {
      calls += 1;
      if (calls > 1) throw new Error("run cancelled");
    },
  });

  assert.equal(generated.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(result.status, "cancelled");
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.pending, 2);
});

test("partial success keeps the successes and reports the rest honestly", async () => {
  const plan = [
    planned(),
    planned({
      assetId: "second",
      sectionId: "second",
      purpose: "feature",
      required: false,
      prompt: "Close-up of a ceramic mug on a linen surface",
    }),
  ];

  const { result } = await run(plan, {
    generate: (prompt) => (prompt === plan[1].prompt ? failure("RATE_LIMITED") : success()),
  });

  assert.equal(result.counts.approved, 2);
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.failed, 1);
  // The failure was an OPTIONAL placement, so nothing required is missing.
  assert.equal(result.requiredMissing, 0);
  assert.equal(result.status, "partial");
  // One real URL, and the failed placement is named without one.
  assert.equal(result.references.length, 1);
  assert.deepEqual(result.pending.map((entry) => entry.assetId), ["second"]);
  assert.equal(result.pending[0].reason, "failed");
});

test("a failed REQUIRED asset is counted as missing, never as complete", async () => {
  const { result } = await run([planned()], { generate: () => failure("INVALID_REQUEST") });

  assert.equal(result.counts.ready, 0);
  assert.equal(result.requiredMissing, 1);
  assert.equal(result.references.length, 0);
  assert.equal(result.status, "partial");
});

test("a deferred asset is reported as deferred, never as ready", async () => {
  const plan = [
    planned(),
    planned({ assetId: "optional", sectionId: "optional", purpose: "feature", required: false }),
  ];
  const { result, generated } = await run(plan, { policy: policyFor({ env: { MAVLY_IMAGE_MAX_ASSETS: "1", MAVLY_IMAGE_CONCURRENCY: "1" } }) });

  assert.equal(generated.length, 1);
  assert.equal(result.counts.approved, 1);
  assert.equal(result.counts.deferred, 1);
  assert.equal(result.pending[0].reason, "deferred");
  assert.equal(result.status, "partial");
});

test("a disabled policy runs nothing at all", async () => {
  const { result, events } = await run([planned()], {
    policy: policyFor({ env: { MAVLY_IMAGE_PLANNING_ENABLED: "0" } }),
  });
  assert.equal(result.status, "disabled");
  assert.deepEqual(events, []);
  assert.equal(result.references.length, 0);
});

test("a policy naming a different model refuses to run instead of substituting one", async () => {
  const mismatched = { ...policyFor(), modelId: "some-other/image-model" };
  const { result, events } = await run([planned()], { policy: mismatched });

  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "image_model_mismatch");
  assert.deepEqual(events, []);
  assert.equal(result.references.length, 0);
});

test("the approved plan records the locked model id", () => {
  const approved = approveImagePlan(approvedPlanOf({ images: [rawAsset()] }), policyFor());
  assert.equal(approved.modelId, RECRAFT);
  assert.equal(approved.modelId, DEFAULT_IMAGE_MODEL_ID);
});

test("an empty plan is skipped without touching the database", async () => {
  const { result, events } = await run([]);
  assert.equal(result.status, "skipped");
  assert.deepEqual(events, []);
});
