import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  AI_PROVIDER_IDS,
  DEFAULT_AI_PROVIDER,
  OPENROUTER_MODEL_CATALOG,
  TEXT_MODEL_CATALOGS,
  TOKEN_HARBOR_MODEL_CATALOG,
  activeAiProvider,
  activeModelCatalog,
  modelCatalogFor,
  resolveModel,
  resolveOpenRouterModel,
  resolveTokenHarborModel,
} from "../src/lib/ai/models";
import {
  TOKEN_HARBOR_DEFAULT_BASE_URL,
  chatCompletion as tokenHarborChatCompletion,
  isAiConfigured as tokenHarborConfigured,
  looksLikeUnsupportedModel,
  resolveTokenHarborBaseUrl,
} from "../src/lib/ai/tokenharbor";
import { chatCompletion as openRouterChatCompletion } from "../src/lib/ai/openrouter";
import {
  activeTextProvider,
  chatCompletion as dispatchChatCompletion,
  generationConfigurationError,
  isAiConfigured as providerConfigured,
  textProviderApiKeyName,
  textProviderLabel,
} from "../src/lib/ai/provider";
import {
  isChatCompletionFailure,
  completionUsage,
  type ChatCompletionFailure,
  type ChatCompletionResult,
  type ChatCompletionSuccess,
  type ChatMessage,
} from "../src/lib/ai/chat-contract";
import {
  AI_IMAGE_MODEL_CATALOG,
  DEFAULT_IMAGE_MODEL_ID,
  resolveImageModel,
} from "../src/lib/ai/image-models";
import { RESERVED_ENV_KEYS, secretEnvKeyRejectionReason } from "../src/lib/hosting/deployment-env";
import { reportedCostOf } from "../src/lib/observability/cost";

/**
 * ═══ THE TOKEN HARBOR PROVIDER CONTRACT ═════════════════════════════════════
 *
 * Token Harbor is an ADDITIONAL text provider for website/Android source
 * generation. These tests pin, with mocked HTTP only:
 *
 *  · the exact endpoint, credential and request shape;
 *  · the provider-local model id and the catalog gate around it;
 *  · response parsing, usage extraction and every failure classification;
 *  · that the default provider is still OpenRouter and that nothing falls back
 *    between providers;
 *  · that the credential is server-only and reserved;
 *  · that image generation is untouched.
 *
 * No live provider call is made and no quota is spent.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const TH_MODEL_ID = "deepseek-v4.1-flash:free";
const OR_MODEL_ID = "deepseek/deepseek-v4.1-flash";
const TH_URL = "https://tokenharbor.ai/v1/chat/completions";
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_KEY = "th_test_secret";
const USER: ChatMessage[] = [{ role: "user", content: "build a landing page" }];

const TOUCHED_ENV = [
  "MAVLY_AI_PROVIDER",
  "MAVLY_DEFAULT_MODEL",
  "TOKEN_HARBOR_API_KEY",
  "TOKEN_HARBOR_BASE_URL",
  "OPENROUTER_API_KEY",
] as const;
type EnvKey = (typeof TOUCHED_ENV)[number];

const originalFetch = globalThis.fetch;
const originalEnv: Record<EnvKey, string | undefined> = TOUCHED_ENV.reduce(
  (acc, key) => {
    acc[key] = process.env[key];
    return acc;
  },
  {} as Record<EnvKey, string | undefined>,
);

/** Touches ONLY the keys named here; an explicit `undefined` deletes one. */
function setEnv(values: Partial<Record<EnvKey, string | undefined>>) {
  for (const key of Object.keys(values) as EnvKey[]) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * A stand-in environment, passed explicitly to the pure selection functions and
 * never merged into `process.env`: a value set on the machine running the tests
 * must not be able to change an assertion. `ProcessEnv` requires `NODE_ENV` in
 * this project, so the literal needs one cast.
 */
const env = (values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  values as unknown as NodeJS.ProcessEnv;

function restore() {
  globalThis.fetch = originalFetch;
  for (const key of TOUCHED_ENV) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * ⚠️ `strict` is off in this repository, so truthiness narrowing on `result.ok`
 * is not reliable — `src/lib/mavly/store.ts` documents the same constraint and
 * answers it with a predicate. These helpers do the same, and the success case
 * states the cast it needs rather than relying on the negative branch.
 */
function expectSuccess(result: ChatCompletionResult): ChatCompletionSuccess {
  if (isChatCompletionFailure(result)) {
    throw new Error(`expected a success, got ${result.code}: ${result.error}`);
  }
  return result as ChatCompletionSuccess;
}

function expectFailure(result: ChatCompletionResult): ChatCompletionFailure {
  if (isChatCompletionFailure(result)) return result;
  throw new Error("expected a failure, got a success");
}

function stubFetch(
  status: number,
  body: unknown,
  options: {
    url?: string;
    headers?: Record<string, string>;
    raw?: string;
    inspect?: (init: RequestInit | undefined) => void;
  } = {},
) {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), options.url ?? TH_URL);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_KEY}`);
    options.inspect?.(init);
    return new Response(options.raw ?? JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...options.headers },
    });
  }) as typeof fetch;
}

function failFetch() {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;
}

/** A Token Harbor-shaped success payload. */
function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "th-req-1",
    model: TH_MODEL_ID,
    choices: [{ message: { content: '{"files":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...overrides,
  };
}

// ── the provider and its model allowlist ────────────────────────────────────

test("Token Harbor uses the exact provider-local model id, never the OpenRouter id", () => {
  assert.deepEqual(TOKEN_HARBOR_MODEL_CATALOG.map((entry) => entry.id), [TH_MODEL_ID]);
  assert.deepEqual(OPENROUTER_MODEL_CATALOG.map((entry) => entry.id), [OR_MODEL_ID]);
  assert.equal(resolveTokenHarborModel().id, TH_MODEL_ID);
  assert.equal(resolveTokenHarborModel().provider, "tokenharbor");

  // An OpenRouter-style id can never resolve to itself for Token Harbor.
  assert.equal(resolveTokenHarborModel(OR_MODEL_ID).id, TH_MODEL_ID);
  // …and vice versa.
  assert.equal(resolveOpenRouterModel(TH_MODEL_ID).id, OR_MODEL_ID);

  assert.equal(TOKEN_HARBOR_MODEL_CATALOG[0].maxOutputTokens, 24_000);
  assert.equal(modelCatalogFor("tokenharbor"), TOKEN_HARBOR_MODEL_CATALOG);
  assert.equal(TEXT_MODEL_CATALOGS.tokenharbor, TOKEN_HARBOR_MODEL_CATALOG);
});

test("the default provider stays OpenRouter for every unset or unrecognized value", () => {
  assert.equal(DEFAULT_AI_PROVIDER, "openrouter");
  assert.deepEqual(AI_PROVIDER_IDS, ["openrouter", "tokenharbor"]);

  for (const value of [undefined, "", "   ", "anthropic", "token-harbor-2", "groq", "1"]) {
    assert.equal(
      activeAiProvider(env({ MAVLY_AI_PROVIDER: value })),
      "openrouter",
      `${String(value)} must not select another provider`,
    );
  }
  assert.equal(activeAiProvider(env()), "openrouter");

  // Accepted spellings select Token Harbor, case-insensitively.
  for (const value of ["tokenharbor", "TokenHarbor", "TOKEN_HARBOR", "token-harbor", " Token Harbor "]) {
    assert.equal(
      activeAiProvider(env({ MAVLY_AI_PROVIDER: value })),
      "tokenharbor",
      `${value} should select Token Harbor`,
    );
  }
  assert.equal(activeAiProvider(env({ MAVLY_AI_PROVIDER: "openrouter" })), "openrouter");
});

test("the active catalog and model follow the selected provider", () => {
  const thEnv = env({ MAVLY_AI_PROVIDER: "tokenharbor" });
  const orEnv = env();

  assert.deepEqual(activeModelCatalog(thEnv).map((m) => m.id), [TH_MODEL_ID]);
  assert.deepEqual(activeModelCatalog(orEnv).map((m) => m.id), [OR_MODEL_ID]);
  assert.equal(resolveModel(null, "app-generation", thEnv).id, TH_MODEL_ID);
  assert.equal(resolveModel(null, "app-generation", orEnv).id, OR_MODEL_ID);

  // MAVLY_DEFAULT_MODEL may only name a model in the SELECTED provider catalog.
  const crossProvider = env({
    MAVLY_AI_PROVIDER: "tokenharbor",
    MAVLY_DEFAULT_MODEL: OR_MODEL_ID,
  });
  assert.equal(resolveModel(null, "app-generation", crossProvider).id, TH_MODEL_ID);

  const thOverride = env({
    MAVLY_AI_PROVIDER: "tokenharbor",
    MAVLY_DEFAULT_MODEL: TH_MODEL_ID,
  });
  assert.equal(resolveModel(null, "app-generation", thOverride).id, TH_MODEL_ID);
});

test("selection and credentials are reported by id and variable name only", () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    assert.equal(activeTextProvider(), "tokenharbor");
    assert.equal(textProviderLabel(), "Token Harbor");
    assert.equal(textProviderApiKeyName(), "TOKEN_HARBOR_API_KEY");
    assert.equal(providerConfigured(), true);
    assert.equal(
      generationConfigurationError(),
      "Token Harbor is not configured. Add TOKEN_HARBOR_API_KEY to the server runtime.",
    );

    delete process.env.TOKEN_HARBOR_API_KEY;
    assert.equal(providerConfigured(), false, "the selected provider must control readiness");
    assert.equal(tokenHarborConfigured(), false);

    setEnv({ MAVLY_AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or_key" });
    assert.equal(activeTextProvider(), "openrouter");
    assert.equal(textProviderApiKeyName(), "OPENROUTER_API_KEY");
    assert.equal(providerConfigured(), true);
    assert.equal(generationConfigurationError().includes("OPENROUTER_API_KEY"), true);
  } finally {
    restore();
  }
});

// ── the request ─────────────────────────────────────────────────────────────

test("a Token Harbor generation hits the documented endpoint with the allowlisted model", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    const captured: { body: Record<string, unknown> | null; headers: Headers | null } = {
      body: null,
      headers: null,
    };
    stubFetch(200, successPayload(), {
      inspect: (init) => {
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        captured.headers = new Headers(init?.headers);
      },
    });

    const result = expectSuccess(
      await tokenHarborChatCompletion(resolveTokenHarborModel(), USER, {
        maxTokens: 12_000,
        temperature: 0.1,
      }),
    );

    assert.deepEqual(captured.body, {
      model: TH_MODEL_ID,
      messages: USER,
      temperature: 0.1,
      max_tokens: 12_000,
    });
    // OpenAI-compatible chat completions: no streaming, and no OpenRouter
    // attribution header claimed on a provider that does not document one.
    assert.equal(captured.body !== null && "stream" in captured.body, false);
    assert.equal(captured.headers?.get("x-title"), null);
    assert.equal(captured.headers?.get("http-referer"), null);
    assert.equal(result.content, '{"files":[]}');
    assert.equal(result.model, TH_MODEL_ID);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.metadata.providerRequestId, "th-req-1");
    assert.equal(result.metadata.usage.totalTokens, 18);
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
  } finally {
    restore();
  }
});

test("the default base URL is used and only a valid override is accepted", async () => {
  const fallback = resolveTokenHarborBaseUrl(undefined);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.baseUrl, TOKEN_HARBOR_DEFAULT_BASE_URL);
  assert.equal(fallback.reason, null);

  assert.equal(resolveTokenHarborBaseUrl("   ").baseUrl, TOKEN_HARBOR_DEFAULT_BASE_URL);

  const trailingSlashes = resolveTokenHarborBaseUrl("https://th.example/v1///");
  assert.equal(trailingSlashes.ok, true);
  assert.equal(trailingSlashes.baseUrl, "https://th.example/v1");

  for (const invalid of [
    "not a url",
    "http://th.example/v1",
    "https://user:pass@th.example/v1",
    "https://th.example/v1?key=1",
    "https://th.example/v1#frag",
  ]) {
    const refusedUrl = resolveTokenHarborBaseUrl(invalid);
    assert.equal(refusedUrl.ok, false, `${invalid} must be refused`);
    assert.equal(refusedUrl.baseUrl, "", `${invalid} must not yield a callable base URL`);
    assert.match(String(refusedUrl.reason), /TOKEN_HARBOR_BASE_URL/);
  }

  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    stubFetch(200, successPayload(), { url: "https://th.example/v1/chat/completions" });
    process.env.TOKEN_HARBOR_BASE_URL = "https://th.example/v1/";
    expectSuccess(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));

    failFetch();
    process.env.TOKEN_HARBOR_BASE_URL = "http://th.example/v1";
    const refused = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(refused.code, "CONFIGURATION");
    assert.equal(refused.retryable, false);
  } finally {
    restore();
  }
});

test("the provider dispatcher routes to the selected provider and never falls back", async () => {
  try {
    setEnv({
      MAVLY_AI_PROVIDER: undefined,
      MAVLY_DEFAULT_MODEL: undefined,
      TOKEN_HARBOR_API_KEY: TEST_KEY,
      OPENROUTER_API_KEY: TEST_KEY,
    });

    // Default (no selector): OpenRouter, exactly as before this change.
    stubFetch(200, successPayload({ model: OR_MODEL_ID }), { url: OR_URL });
    const viaDefault = expectSuccess(await dispatchChatCompletion(resolveModel(), USER));
    assert.equal(viaDefault.model, OR_MODEL_ID);

    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor" });
    stubFetch(200, successPayload(), { url: TH_URL });
    const viaTokenHarbor = expectSuccess(await dispatchChatCompletion(resolveModel(), USER));
    assert.equal(viaTokenHarbor.model, TH_MODEL_ID);

    // A failing Token Harbor request is a Token Harbor failure: it must not be
    // re-sent to OpenRouter.
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503 });
    }) as typeof fetch;
    expectFailure(await dispatchChatCompletion(resolveModel(), USER));
    assert.deepEqual(seen, [TH_URL]);
  } finally {
    restore();
  }
});

// ── configuration failures ──────────────────────────────────────────────────

test("a missing TOKEN_HARBOR_API_KEY fails closed without a network call", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: undefined });
    failFetch();

    const result = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(result.code, "CONFIGURATION");
    assert.equal(result.retryable, false);
    assert.match(result.error, /TOKEN_HARBOR_API_KEY/);
  } finally {
    restore();
  }
});

test("an id from another provider is refused before any provider request", async () => {
  try {
    // Both credentials present, so each adapter reaches its catalog gate rather
    // than failing earlier on configuration.
    setEnv({
      MAVLY_AI_PROVIDER: "tokenharbor",
      TOKEN_HARBOR_API_KEY: TEST_KEY,
      OPENROUTER_API_KEY: TEST_KEY,
    });
    failFetch();

    const foreign = { ...resolveTokenHarborModel(), id: OR_MODEL_ID };
    const result = expectFailure(await tokenHarborChatCompletion(foreign, USER));
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(result.retryable, false);
    assert.match(result.error, /not in Mavly's supported model catalog/);

    // The OpenRouter adapter refuses a Token Harbor id just as firmly.
    const reverse = expectFailure(
      await openRouterChatCompletion({ ...resolveOpenRouterModel(), id: TH_MODEL_ID }, USER),
    );
    assert.equal(reverse.code, "INVALID_REQUEST");
  } finally {
    restore();
  }
});

// ── responses ───────────────────────────────────────────────────────────────

test("usage is extracted when present and never fabricated when absent", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    stubFetch(200, successPayload({
      usage: {
        prompt_tokens: "10",
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 8 },
        cost: 0.0042,
      },
    }));
    const withUsage = expectSuccess(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.deepEqual(withUsage.metadata.usage, {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 8,
      costUsd: 0.0042,
    });

    stubFetch(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const withoutUsage = expectSuccess(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.deepEqual(withoutUsage.metadata.usage, {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      costUsd: null,
    });

    // A free route that reports no cost must not become a fabricated number.
    assert.deepEqual(reportedCostOf([{ costUsd: withUsage.metadata.usage.costUsd }]), {
      costUsd: 0.0042,
      known: true,
    });
    assert.deepEqual(reportedCostOf([{ costUsd: withoutUsage.metadata.usage.costUsd }]), {
      costUsd: null,
      known: false,
    });
  } finally {
    restore();
  }
});

test("empty, malformed and wrongly shaped 200 responses are failures", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    stubFetch(200, { choices: [{ message: { content: "" }, finish_reason: "stop" }] });
    assert.equal(expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER)).code, "EMPTY_COMPLETION");

    stubFetch(200, {}, { raw: "<html>gateway error</html>" });
    assert.equal(expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER)).code, "EMPTY_COMPLETION");

    stubFetch(200, { choices: "nope" });
    assert.equal(expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER)).code, "EMPTY_COMPLETION");
  } finally {
    restore();
  }
});

test("a truncated completion is discarded, never returned as success", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    stubFetch(200, {
      choices: [{ message: { content: '{"files":[' }, finish_reason: "length" }],
      usage: { prompt_tokens: 100, completion_tokens: 24_000, total_tokens: 24_100 },
    });

    const result = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(result.code, "OUTPUT_LIMIT");
    assert.equal(result.retryable, false);
    assert.equal(result.metadata.finishReason, "length");
  } finally {
    restore();
  }
});

test("a provider content filter is a failure for this provider too", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    stubFetch(200, { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] });
    const result = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(result.code, "CONTENT_FILTER");
    assert.equal(result.retryable, false);
  } finally {
    restore();
  }
});

// ── failure classification ──────────────────────────────────────────────────

test("authentication, quota, unsupported-model and transport failures are classified", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    stubFetch(401, { error: { message: "invalid token" } });
    const unauthorized = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(unauthorized.code, "AUTHENTICATION");
    assert.equal(unauthorized.retryable, false);

    stubFetch(402, { error: { message: "insufficient credits" } });
    const quota = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(quota.code, "PROVIDER_ERROR");
    assert.equal(quota.retryable, false);
    assert.match(quota.error, /no remaining credit or quota/);

    stubFetch(404, { error: { message: "model not found" } });
    const missing = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(missing.code, "INVALID_REQUEST");
    assert.match(missing.error, /does not serve the requested model/);

    // A bare 404 (for example a wrong base path) keeps the code but must NOT
    // claim the model is unserved. The copy asserts only what the body showed.
    stubFetch(404, {}, { raw: "Not Found" });
    const bareNotFound = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(bareNotFound.code, "INVALID_REQUEST");
    assert.equal(bareNotFound.error.includes("does not serve the requested model"), false);
    assert.match(bareNotFound.error, /rejected the request \(404\)/);

    stubFetch(200, { error: { message: `model ${TH_MODEL_ID} is not available` } });
    const envelopeModel = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(envelopeModel.code, "INVALID_REQUEST");

    stubFetch(200, { error: { message: "internal routing problem" } });
    const envelope = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(envelope.code, "PROVIDER_ERROR");
    assert.equal(envelope.retryable, false);

    stubFetch(503, { error: { message: "temporarily unavailable" } });
    const transient = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(transient.code, "TRANSIENT");
    assert.equal(transient.retryable, true);

    stubFetch(500, {}, { raw: "boom" });
    const serverError = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(serverError.code, "TRANSIENT");
  } finally {
    restore();
  }
});

test("a rate limit carries Retry-After and the adapter itself never retries", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "7" },
      });
    }) as typeof fetch;

    const result = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.retryable, true);
    assert.equal(result.retryAfterMs, 7_000);
    assert.equal(calls, 1, "one call, one classification — retry is the caller's policy");

    stubFetch(429, { error: { message: "slow down" } }, { headers: { "retry-after": "9007199254740993" } });
    const absurd = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(absurd.retryAfterMs, 86_400_000, "an absurd Retry-After is capped");
  } finally {
    restore();
  }
});

test("a timeout or abort is retryable and never swallowed", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    globalThis.fetch = (async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    const aborted = expectFailure(
      await tokenHarborChatCompletion(resolveTokenHarborModel(), USER, { timeoutMs: 1 }),
    );
    assert.equal(aborted.code, "TIMEOUT");
    assert.equal(aborted.retryable, true);

    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const network = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(network.code, "NETWORK");
    assert.equal(network.retryable, true);
  } finally {
    restore();
  }
});

test("provider and network errors are redacted and bounded", async () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });

    stubFetch(502, { error: { message: `upstream rejected Bearer ${TEST_KEY}` } });
    const result = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(result.error.includes(TEST_KEY), false);
    assert.match(result.error, /\[redacted\]/);
    assert.equal((result.metadata.errorDetail ?? "").includes(TEST_KEY), false);
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);

    globalThis.fetch = (async () => {
      throw new Error(`connect failed for ${TEST_KEY}`);
    }) as typeof fetch;
    const network = expectFailure(await tokenHarborChatCompletion(resolveTokenHarborModel(), USER));
    assert.equal(network.error.includes(TEST_KEY), false);
  } finally {
    restore();
  }
});

test("unsupported-model detection only trusts what the provider said", () => {
  assert.equal(looksLikeUnsupportedModel("model not found"), true);
  assert.equal(looksLikeUnsupportedModel("unknown model"), true);
  assert.equal(looksLikeUnsupportedModel("the model is not available for your plan"), true);
  assert.equal(looksLikeUnsupportedModel("internal routing problem"), false);
  assert.equal(looksLikeUnsupportedModel("rate limit exceeded"), false);
  assert.equal(looksLikeUnsupportedModel(null), false);
  assert.equal(looksLikeUnsupportedModel(""), false);
});

test("usage parsing stays provider-neutral", () => {
  assert.deepEqual(completionUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    reasoningTokens: null,
    costUsd: null,
  });
  assert.deepEqual(completionUsage(null), {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    costUsd: null,
  });
});

// ── secrets, boundaries and untouched integrations ──────────────────────────

test("TOKEN_HARBOR_API_KEY is reserved and can never reach a generated application", () => {
  assert.equal(RESERVED_ENV_KEYS.has("TOKEN_HARBOR_API_KEY"), true);
  assert.notEqual(secretEnvKeyRejectionReason("TOKEN_HARBOR_API_KEY"), null);
  assert.notEqual(secretEnvKeyRejectionReason("NEXT_PUBLIC_TOKEN_HARBOR_API_KEY"), null);
  assert.notEqual(secretEnvKeyRejectionReason("MAVLY_AI_PROVIDER"), null);
});

test("the credential stays server-side and the adapter never logs", () => {
  const files = (readdirSync(new URL("src", root), { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => `src/${entry.replaceAll("\\", "/")}`);

  for (const file of files) {
    const source = read(file);
    if (file.endsWith(".tsx")) {
      assert.equal(
        source.includes("TOKEN_HARBOR_API_KEY"),
        false,
        `${file} is a component and must not read the Token Harbor key`,
      );
    }
    assert.equal(
      source.includes("NEXT_PUBLIC_TOKEN_HARBOR"),
      false,
      `${file} must not expose the Token Harbor key to the browser`,
    );
  }

  const adapter = read("src/lib/ai/tokenharbor.ts");
  assert.equal(adapter.includes("console."), false, "the adapter must not log");
  assert.equal(adapter.includes("process.env.TOKEN_HARBOR_API_KEY?.trim()"), true);
  assert.equal(adapter.includes("tokenharbor.ai/v1"), true);
});

test("the generation pipeline is provider-neutral and the provider is server-selected", () => {
  const runAgent = read("src/lib/mavly/run-agent.ts");
  assert.equal(runAgent.includes("@/lib/ai/provider"), true);
  assert.equal(runAgent.includes("@/lib/ai/tokenharbor"), false);
  assert.equal(runAgent.includes("@/lib/ai/openrouter"), false);

  assert.equal(read("src/lib/ai/agent.ts").includes('from "./provider"'), true);

  const provider = read("src/lib/ai/provider.ts");
  assert.equal(provider.includes('from "./openrouter"'), true);
  assert.equal(provider.includes('from "./tokenharbor"'), true);
  assert.equal(provider.includes("activeAiProvider()"), true);

  // No route accepts a provider from the request: selection is env-only.
  const api = read("src/lib/mavly/api.ts");
  assert.equal(api.includes("MAVLY_AI_PROVIDER"), false);
  assert.equal(api.includes("TOKEN_HARBOR_API_KEY"), false);
  assert.equal(api.includes("generationConfigurationError()"), true);
});

test("image generation is unchanged and never routed to Token Harbor", () => {
  try {
    setEnv({ MAVLY_AI_PROVIDER: "tokenharbor", TOKEN_HARBOR_API_KEY: TEST_KEY });
    assert.deepEqual(AI_IMAGE_MODEL_CATALOG.map((entry) => entry.id), [DEFAULT_IMAGE_MODEL_ID]);
    assert.equal(resolveImageModel().id, DEFAULT_IMAGE_MODEL_ID);

    const imageClient = read("src/lib/ai/openrouter-images.ts");
    assert.equal(imageClient.includes("OPENROUTER_API_KEY"), true);
    assert.equal(imageClient.includes("TOKEN_HARBOR"), false);
    assert.equal(imageClient.includes("tokenharbor"), false);
  } finally {
    restore();
  }
});
