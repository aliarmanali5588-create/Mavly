import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_PROVIDER_IDS,
  AI_MODEL_CATALOG,
  OPENROUTER_MODEL_CATALOG,
  resolveModel,
  resolveOpenRouterModel,
} from "../src/lib/ai/models";
import { chatCompletion, completionUsage, type ChatMessage } from "../src/lib/ai/openrouter";
import { isAiConfigured } from "../src/lib/ai/provider";

/**
 * ═══ THE ACTIVE TEXT-GENERATION PROVIDER CONTRACT ═══════════════════════════
 *
 * OpenRouter is the only provider for website and native Android source
 * generation. These tests pin the wire contract, the catalog gate and the
 * failure classification the durable run depends on. Every response is mocked:
 * no live quota is used.
 */

const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const model = resolveModel();
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENROUTER_API_KEY;
const originalDefaultModel = process.env.MAVLY_DEFAULT_MODEL;
const TEST_API_KEY = "or_test_secret";

function useApiKey(value = TEST_API_KEY) {
  process.env.OPENROUTER_API_KEY = value;
}

function stubFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  onRequest?: (init: RequestInit | undefined) => void,
) {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_API_KEY}`);
    onRequest?.(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof fetch;
}

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKey;
  if (originalDefaultModel === undefined) delete process.env.MAVLY_DEFAULT_MODEL;
  else process.env.MAVLY_DEFAULT_MODEL = originalDefaultModel;
}

const USER: ChatMessage[] = [{ role: "user", content: "build a landing page" }];

// ── catalog and selection ───────────────────────────────────────────────────

test("the catalog contains exactly the verified OpenRouter model", () => {
  assert.deepEqual(AI_PROVIDER_IDS, ["openrouter"]);
  assert.deepEqual(
    AI_MODEL_CATALOG.map((entry) => entry.id),
    [MODEL_ID],
    "only a verified OpenRouter ID may reach the wire",
  );
  assert.deepEqual(OPENROUTER_MODEL_CATALOG.map((entry) => entry.id), [MODEL_ID]);
  assert.equal(resolveModel().id, MODEL_ID);
  assert.equal(resolveOpenRouterModel().id, MODEL_ID);
  assert.equal(model.label, "DeepSeek V4.1 Flash (OpenRouter)");
  assert.equal(model.maxOutputTokens, 24_000);
});

test("retired FreeModel model IDs never resolve to themselves", () => {
  for (const retired of ["claude-opus-4.7", "claude-opus-4.8", "claude-fable-5-1"]) {
    assert.equal(resolveModel(retired).id, MODEL_ID, `${retired} must not reach the wire`);
  }
});

test("MAVLY_DEFAULT_MODEL selects a catalog entry and an unknown value stays on the default", () => {
  try {
    process.env.MAVLY_DEFAULT_MODEL = MODEL_ID;
    assert.equal(resolveModel(null, "app-generation").id, MODEL_ID);

    process.env.MAVLY_DEFAULT_MODEL = "claude-opus-4.7";
    assert.equal(resolveModel(null, "app-generation").id, MODEL_ID);
  } finally {
    restoreEnvironment();
  }
});

// ── configuration ───────────────────────────────────────────────────────────

test("isAiConfigured reflects OPENROUTER_API_KEY", () => {
  try {
    useApiKey();
    assert.equal(isAiConfigured(), true);
    delete process.env.OPENROUTER_API_KEY;
    assert.equal(isAiConfigured(), false);
  } finally {
    restoreEnvironment();
  }
});

test("a missing OPENROUTER_API_KEY fails closed without a network call", async () => {
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "CONFIGURATION");
    assert.equal(result.retryable, false);
    assert.match(result.error, /OPENROUTER_API_KEY/);
  } finally {
    restoreEnvironment();
  }
});

test("an unsupported model is rejected before any provider request", async () => {
  useApiKey();
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;

  try {
    const unsupported = { ...model, id: "freemodel/claude-opus-4.7" };
    const result = await chatCompletion(unsupported, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(result.retryable, false);
    assert.match(result.error, /not in Mavly's supported model catalog/);
  } finally {
    restoreEnvironment();
  }
});

// ── the request ─────────────────────────────────────────────────────────────

test("a generation uses OpenRouter auth, the catalog model and supported parameters", async () => {
  useApiKey();
  let body: Record<string, unknown> | null = null;
  stubFetch(
    200,
    {
      id: "gen-or-1",
      model: MODEL_ID,
      choices: [{ message: { content: '{"files":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.0012 },
    },
    { "x-request-id": "gen-or-1" },
    (init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    },
  );

  try {
    const result = await chatCompletion(model, USER, { maxTokens: 12_000, temperature: 0.1 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(body, {
      model: MODEL_ID,
      messages: USER,
      temperature: 0.1,
      max_tokens: 12_000,
    });
    assert.equal(result.content, '{"files":[]}');
    assert.equal(result.model, MODEL_ID);
    assert.equal(result.finishReason, "stop");
    assert.equal(result.metadata.providerRequestId, "gen-or-1");
    assert.equal(result.metadata.usage.totalTokens, 18);
    assert.equal(result.metadata.usage.costUsd, 0.0012);
  } finally {
    restoreEnvironment();
  }
});

test("the adapter sends max_tokens, the field OpenRouter documents for chat completions", async () => {
  useApiKey();
  let body: Record<string, unknown> | null = null;
  stubFetch(
    200,
    { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    {},
    (init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    },
  );

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, true);
    assert.equal(body !== null && "max_tokens" in body, true);
    assert.equal(body !== null && "stream" in body, false, "the pipeline is non-streaming");
  } finally {
    restoreEnvironment();
  }
});

// ── failures ────────────────────────────────────────────────────────────────

test("an invalid key is a non-retryable authentication failure", async () => {
  useApiKey();
  stubFetch(401, { error: { message: "invalid api key" } });

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "AUTHENTICATION");
    assert.equal(result.retryable, false);
  } finally {
    restoreEnvironment();
  }
});

test("a 429 carries Retry-After and remains retryable", async () => {
  useApiKey();
  stubFetch(429, { error: { message: "rate limit" } }, { "retry-after": "7" });

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.retryable, true);
    assert.equal(result.retryAfterMs, 7_000);
  } finally {
    restoreEnvironment();
  }
});

test("a transient provider failure is classified for the existing retry policy", async () => {
  useApiKey();
  stubFetch(503, { error: { message: "temporarily unavailable" } });

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TRANSIENT");
    assert.equal(result.retryable, true);
  } finally {
    restoreEnvironment();
  }
});

test("a 200 error envelope is not treated as a completion", async () => {
  useApiKey();
  stubFetch(200, { error: { message: "provider error" } });

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.equal(result.retryable, false);
  } finally {
    restoreEnvironment();
  }
});

test("empty and truncated completions are failures, not successes", async () => {
  useApiKey();
  stubFetch(200, { choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  try {
    const empty = await chatCompletion(model, USER);
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "EMPTY_COMPLETION");

    stubFetch(200, {
      choices: [{ message: { content: '{"files":[' }, finish_reason: "length" }],
      usage: { prompt_tokens: 100, completion_tokens: 24_000, total_tokens: 24_100 },
    });
    const truncated = await chatCompletion(model, USER);
    assert.equal(truncated.ok, false);
    if (truncated.ok) return;
    assert.equal(truncated.code, "OUTPUT_LIMIT");
    assert.equal(truncated.retryable, false);
  } finally {
    restoreEnvironment();
  }
});

test("an aborted request is a timeout and cancellation is not swallowed", async () => {
  useApiKey();
  globalThis.fetch = (async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }) as typeof fetch;

  try {
    const result = await chatCompletion(model, USER, { timeoutMs: 1 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TIMEOUT");
    assert.equal(result.retryable, true);
  } finally {
    restoreEnvironment();
  }
});

test("provider error text never echoes the API key", async () => {
  useApiKey();
  stubFetch(502, { error: { message: `upstream rejected Bearer ${TEST_API_KEY}` } });

  try {
    const result = await chatCompletion(model, USER);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.includes(TEST_API_KEY), false, "the key must be redacted");
    assert.match(result.error, /\[redacted\]/);
  } finally {
    restoreEnvironment();
  }
});

// ── metadata ────────────────────────────────────────────────────────────────

test("usage safely extracts token, reasoning and cost figures", () => {
  const usage = completionUsage({
    usage: {
      prompt_tokens: "10",
      completion_tokens: 20,
      total_tokens: 30,
      cost: 0.0042,
      completion_tokens_details: { reasoning_tokens: 8 },
    },
  });

  assert.deepEqual(usage, {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    reasoningTokens: 8,
    costUsd: 0.0042,
  });
});
