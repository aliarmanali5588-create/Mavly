import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  AI_IMAGE_MODEL_CATALOG,
  DEFAULT_IMAGE_MODEL_ID,
  parseImageGenerationRequest,
  resolveImageModel,
} from "../src/lib/ai/image-models";
import {
  MAX_IMAGE_BYTES,
  generateImage,
  parseImageResponse,
  sniffImageFormat,
} from "../src/lib/ai/openrouter-images";
import { AI_MODEL_CATALOG, resolveModel } from "../src/lib/ai/models";
import { classifyVcaasRequest } from "../src/lib/vcaas-scope";
import { POST as catchAllPost } from "../src/app/api/vcaas/[...path]/route";

/**
 * ═══ FLUX IMAGE GENERATION — THE CONTRACT, NOT A LIVE CALL ═════════════════
 *
 * Every provider response here is mocked: the suite never spends a real
 * generation. What is asserted is what the integration itself owns — the exact
 * model slug, the dedicated `/api/v1/images` request shape, response validation,
 * failure classification, retry safety and the anonymous refusal at the route.
 *
 * ⚠️ There is no credit test because there is no credit engine in this build.
 * The feature is unbilled by construction; see `MAVLY_CLEAN_BASELINE.md`.
 */

const FLUX = "black-forest-labs/flux.2-klein-4b";

/** A real 1×1 PNG — the signature is what `sniffImageFormat` checks. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function stubFetch(
  status: number,
  body: unknown,
  options: { headers?: Record<string, string>; calls?: FetchCall[] } = {},
): void {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    options.calls?.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
  }) as typeof fetch;
}

function stubFetchError(error: unknown, calls?: FetchCall[]): void {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    calls?.push({ url: String(input), init });
    throw error;
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function withApiKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  return run().finally(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
}

const model = resolveImageModel();

const request = {
  model,
  prompt: "a red fox in fresh snow",
  aspectRatio: "16:9",
  outputFormat: "png" as const,
  seed: null,
};

// ── the catalog ─────────────────────────────────────────────────────────────

test("the image catalog uses the exact FLUX slug", () => {
  assert.equal(DEFAULT_IMAGE_MODEL_ID, FLUX);
  assert.equal(model.id, FLUX);
  assert.deepEqual(
    AI_IMAGE_MODEL_CATALOG.map((entry) => entry.id),
    [FLUX],
  );
  // The options are the model's own accepted values, never a superset.
  assert.deepEqual(
    [...model.aspectRatios].sort(),
    ["1:1", "16:9", "2:3", "21:9", "3:2", "3:4", "4:3", "9:16", "auto"].sort(),
  );
  assert.deepEqual([...model.outputFormats], ["png", "jpeg"]);
  assert.equal(model.maxImages, 1);
});

test("the image model is not selectable as the website-generation model", () => {
  assert.equal(
    AI_MODEL_CATALOG.some((entry) => entry.id === FLUX),
    false,
  );
  // An explicit request naming FLUX still resolves to a text model.
  assert.notEqual(resolveModel(FLUX, "app-generation").id, FLUX);
});

test("MAVLY_IMAGE_MODEL selects a catalog entry, and only a catalog entry", () => {
  const previousImage = process.env.MAVLY_IMAGE_MODEL;
  const previousDefault = process.env.MAVLY_DEFAULT_MODEL;
  try {
    // Unset → the built-in default, so an existing deployment is unchanged.
    delete process.env.MAVLY_IMAGE_MODEL;
    assert.equal(resolveImageModel().id, FLUX);

    // A registered entry is honoured (today the only entry is the default).
    process.env.MAVLY_IMAGE_MODEL = FLUX;
    assert.equal(resolveImageModel().id, FLUX);

    // An unregistered slug is never forwarded to the provider…
    process.env.MAVLY_IMAGE_MODEL = "deepseek/deepseek-v4.1-flash";
    assert.equal(resolveImageModel().id, FLUX);
    // …so the resolved model is always an entry in the image catalog.
    assert.ok(
      AI_IMAGE_MODEL_CATALOG.some((entry) => entry.id === resolveImageModel().id),
      "the resolved image model is always a catalog entry",
    );

    // MAVLY_DEFAULT_MODEL stays the website/code-generation selector.
    process.env.MAVLY_DEFAULT_MODEL = "qwen/qwen3-coder";
    assert.equal(resolveImageModel().id, FLUX);
    assert.equal(resolveModel(null, "app-generation").id, "qwen/qwen3-coder");
  } finally {
    if (previousImage === undefined) delete process.env.MAVLY_IMAGE_MODEL;
    else process.env.MAVLY_IMAGE_MODEL = previousImage;
    if (previousDefault === undefined) delete process.env.MAVLY_DEFAULT_MODEL;
    else process.env.MAVLY_DEFAULT_MODEL = previousDefault;
  }
});

// ── the request ─────────────────────────────────────────────────────────────

test("a generation calls the images endpoint with only supported parameters", async () => {
  const calls: FetchCall[] = [];
  stubFetch(
    200,
    {
      created: 1_748_372_400,
      data: [{ b64_json: PNG_BASE64, media_type: "image/png" }],
      usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 },
    },
    { calls },
  );

  try {
    await withApiKey(async () => {
      const result = await generateImage({ ...request, retry: { maxAttempts: 1 } });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
      assert.equal(calls[0].init?.method, "POST");

      const headers = calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer test-key");
      assert.equal(headers["Content-Type"], "application/json");

      const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assert.equal(body.model, FLUX);
      assert.equal(body.prompt, request.prompt);
      assert.equal(body.aspect_ratio, "16:9");
      assert.equal(body.output_format, "png");
      assert.equal(body.n, 1);
      // Chat-shaped or unsupported fields must never be sent.
      assert.equal("messages" in body, false);
      assert.equal("resolution" in body, false);
      assert.equal("max_tokens" in body, false);

      assert.equal(result.image.base64, PNG_BASE64);
      assert.equal(result.image.mediaType, "image/png");
      assert.equal(result.image.format, "png");
      assert.ok(result.image.bytes > 0);
      assert.equal(result.model, FLUX);
      assert.equal(result.usage.totalTokens, 4175);
      assert.equal(result.usage.costUsd, 0.04);

      // The key never appears in anything a caller could echo.
      assert.equal(JSON.stringify(result).includes("test-key"), false);
    });
  } finally {
    restoreFetch();
  }
});

test("a seed is forwarded only when given, and omitted otherwise", async () => {
  const calls: FetchCall[] = [];
  stubFetch(200, { data: [{ b64_json: PNG_BASE64 }] }, { calls });

  try {
    await withApiKey(async () => {
      await generateImage({ ...request, seed: 42, retry: { maxAttempts: 1 } });
      const withSeed = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      assert.equal(withSeed.seed, 42);

      await generateImage({ ...request, retry: { maxAttempts: 1 } });
      const withoutSeed = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
      assert.equal("seed" in withoutSeed, false);
    });
  } finally {
    restoreFetch();
  }
});

// ── the response ────────────────────────────────────────────────────────────

test("a malformed or non-image response fails instead of returning bytes", () => {
  assert.equal(parseImageResponse({ data: [] }).ok, false);
  assert.equal(parseImageResponse({}).ok, false);
  assert.equal(parseImageResponse(null).ok, false);

  const empty = parseImageResponse({ data: [{ b64_json: "" }] });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "EMPTY_RESPONSE");

  const notAnImage = parseImageResponse({
    data: [{ b64_json: Buffer.from("this is not an image at all").toString("base64") }],
  });
  assert.equal(notAnImage.ok, false);
  if (!notAnImage.ok) assert.equal(notAnImage.code, "INVALID_RESPONSE");

  const notBase64 = parseImageResponse({ data: [{ b64_json: "!!!! not base64 !!!!" }] });
  assert.equal(notBase64.ok, false);

  assert.equal(sniffImageFormat(new Uint8Array([1, 2, 3])), null);
});

test("a URL-only response is refused, never fetched", async () => {
  const calls: FetchCall[] = [];
  stubFetch(200, { data: [{ url: "https://example.com/private.png" }] }, { calls });

  try {
    await withApiKey(async () => {
      const result = await generateImage({ ...request, retry: { maxAttempts: 1 } });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "INVALID_RESPONSE");
      // Exactly one call: the API request. The URL was not followed.
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/images");
    });
  } finally {
    restoreFetch();
  }
});

test("the accepted image size fits the deployment platform's response limit", () => {
  // Mavly's own app is built for Vercel, where a Function's response body is
  // capped at 4.5 MB. Base64 expands by 4/3; the envelope needs headroom.
  const base64Chars = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  assert.ok(base64Chars + 2_000 < 4_500_000);
});

test("an image over the accepted size fails as IMAGE_TOO_LARGE", () => {
  const parsed = parseImageResponse({ data: [{ b64_json: PNG_BASE64 }] }, { maxBytes: 10 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.code, "IMAGE_TOO_LARGE");
});

test("a data-URL prefix is stripped before the bytes are validated", () => {
  const parsed = parseImageResponse({
    data: [{ b64_json: `data:image/png;base64,${PNG_BASE64}` }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.image.base64, PNG_BASE64);
  assert.equal(parsed.image.mediaType, "image/png");
});

// ── failures ────────────────────────────────────────────────────────────────

test("a 429 is reported with its Retry-After", async () => {
  const calls: FetchCall[] = [];
  stubFetch(
    429,
    { error: { message: "slow down" } },
    { headers: { "retry-after": "7", "x-request-id": "req-429" }, calls },
  );

  try {
    await withApiKey(async () => {
      const result = await generateImage({ ...request, retry: { maxAttempts: 1 } });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "RATE_LIMITED");
      assert.equal(result.retryable, true);
      assert.equal(result.retryAfterMs, 7_000);
      assert.equal(result.status, 429);
      assert.equal(result.metadata.providerRequestId, "req-429");
      assert.equal(calls.length, 1);
    });
  } finally {
    restoreFetch();
  }
});

test("a 502 is retried once, and a 400 is never retried", async () => {
  const retried: FetchCall[] = [];
  stubFetch(502, { error: { message: "generation failed" } }, { calls: retried });

  try {
    await withApiKey(async () => {
      const result = await generateImage({
        ...request,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, minRemainingMs: 1 },
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "TRANSIENT");
      assert.equal(retried.length, 2);
    });
  } finally {
    restoreFetch();
  }

  const rejected: FetchCall[] = [];
  stubFetch(400, { error: { message: "bad aspect ratio" } }, { calls: rejected });

  try {
    await withApiKey(async () => {
      const result = await generateImage({
        ...request,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, minRemainingMs: 1 },
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "INVALID_REQUEST");
      assert.equal(result.retryable, false);
      assert.equal(rejected.length, 1);
    });
  } finally {
    restoreFetch();
  }
});

test("a timeout fails as TIMEOUT and is not retried", async () => {
  const calls: FetchCall[] = [];
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  stubFetchError(timeout, calls);

  try {
    await withApiKey(async () => {
      const result = await generateImage({ ...request, retry: { maxAttempts: 2 } });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "TIMEOUT");
      assert.equal(result.retryable, false);
      assert.equal(calls.length, 1);
      assert.match(result.error, /deadline/);
    });
  } finally {
    restoreFetch();
  }
});

test("a missing API key fails closed without a network call", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  stubFetchError(new Error("fetch must not run"));

  try {
    const result = await generateImage({ ...request, retry: { maxAttempts: 1 } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "CONFIGURATION");
    assert.equal(result.retryable, false);
    assert.equal(JSON.stringify(result).includes("test-key"), false);
  } finally {
    restoreFetch();
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
  }
});

test("an authentication failure never exposes the key or the provider body", async () => {
  stubFetch(401, { error: { message: "invalid api key sk-or-v1-secret" } });

  try {
    await withApiKey(async () => {
      const result = await generateImage({ ...request, retry: { maxAttempts: 1 } });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "AUTHENTICATION");
      assert.equal(result.retryable, false);
    });
  } finally {
    restoreFetch();
  }
});

// ── request validation ──────────────────────────────────────────────────────

test("only parameters the model accepts are validated in", () => {
  const empty = parseImageGenerationRequest({ prompt: "   " }, model);
  assert.equal(empty.ok, false);

  const ratio = parseImageGenerationRequest({ prompt: "x", aspectRatio: "5:4" }, model);
  assert.equal(ratio.ok, false);

  const format = parseImageGenerationRequest({ prompt: "x", outputFormat: "svg" }, model);
  assert.equal(format.ok, false);

  const many = parseImageGenerationRequest({ prompt: "x", n: 2 }, model);
  assert.equal(many.ok, false);

  const resolution = parseImageGenerationRequest({ prompt: "x", resolution: "4K" }, model);
  assert.equal(resolution.ok, false);

  const references = parseImageGenerationRequest(
    { prompt: "x", input_references: [{ type: "image_url" }] },
    model,
  );
  assert.equal(references.ok, false);

  const fractionalSeed = parseImageGenerationRequest({ prompt: "x", seed: 1.5 }, model);
  assert.equal(fractionalSeed.ok, false);

  const valid = parseImageGenerationRequest({ prompt: "  a fox  " }, model);
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.request.prompt, "a fox");
  assert.equal(valid.request.aspectRatio, "1:1");
  assert.equal(valid.request.outputFormat, "png");
  assert.equal(valid.request.seed, null);
});

// ── the route boundary ──────────────────────────────────────────────────────

test("an anonymous caller cannot reach image generation", async () => {
  const res = await catchAllPost(
    new NextRequest("http://localhost:3000/api/vcaas/projects/my-app/images/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a fox" }),
    }),
    { params: Promise.resolve({ path: ["projects", "my-app", "images", "generate"] }) },
  );

  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { ok: boolean; code: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "UNAUTHENTICATED");
});

test("the image path stays inside the project scope, and nothing else is opened", () => {
  assert.deepEqual(
    classifyVcaasRequest("POST", ["projects", "my-app", "images", "generate"]),
    { kind: "project", projectId: "my-app" },
  );
  // A malformed project id is refused by the same classifier the route uses.
  assert.equal(classifyVcaasRequest("POST", ["projects", "Bad_Slug", "images", "generate"]).kind, "deny");
  // No new account-level root was introduced.
  assert.equal(classifyVcaasRequest("POST", ["images"]).kind, "deny");
});
