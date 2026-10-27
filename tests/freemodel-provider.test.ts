import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chatCompletion,
  completionUsage,
  isAiConfigured,
  type ChatMessage,
} from "../src/lib/ai/freemodel";
import { AI_MODEL_CATALOG, resolveModel, type AiModel } from "../src/lib/ai/models";

const model = resolveModel();
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.FREEMODEL_API_KEY;
const TEST_API_KEY = "fm_test_secret";

function useApiKey(value = TEST_API_KEY) {
  process.env.FREEMODEL_API_KEY = value;
}

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://freemodel.in/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_API_KEY}`)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as typeof fetch;
}

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.FREEMODEL_API_KEY;
  else process.env.FREEMODEL_API_KEY = originalApiKey;
  if (process.env.FREEMODEL_BASE_URL === undefined) delete process.env.FREEMODEL_BASE_URL;

}

test("a successful request uses FreeModel auth, the catalog model, and supported chat parameters", async () => {
  useApiKey();
  let sent: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://freemodel.in/v1/chat/completions");
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_API_KEY}`);
    return new Response(JSON.stringify({
      id: "req-freemodel-1",
      model: model.id,
      choices: [{ message: { content: '{"files":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req-freemodel-1" },
    });
  }) as typeof fetch;

  try {
    const messages: ChatMessage[] = [{ role: "system", content: "Return JSON." }, { role: "user", content: "x" }];
    const result = await chatCompletion(model, messages, { maxTokens: 400, temperature: 0.2 });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.model, "claude-opus-4.7");
    assert.deepEqual(sent, {
      model: model.id,
      messages,
      temperature: 0.2,
      max_completion_tokens: 400,
      stream: false,
    });
    assert.equal(result.metadata.providerRequestId, "req-freemodel-1");
    assert.equal(result.metadata.usage.totalTokens, 21);
    assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  } finally {
    restoreEnvironment();
  }
});

test("a missing FREEMODEL_API_KEY fails closed without a network call", async () => {
  delete process.env.FREEMODEL_API_KEY;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;

  try {
    assert.equal(isAiConfigured(), false);
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "CONFIGURATION");
    assert.equal(result.retryable, false);
    assert.match(result.error, /FREEMODEL_API_KEY/);
  } finally {
    restoreEnvironment();
  }
});

test("an invalid FreeModel key is classified as a non-retryable authentication failure", async () => {
  useApiKey();
  stubFetch(401, { error: { message: `invalid API key: ${TEST_API_KEY}` } });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "AUTHENTICATION");
    assert.equal(result.retryable, false);
    assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  } finally {
    restoreEnvironment();
  }
});

test("an unsupported model is rejected before making a provider request", async () => {
  useApiKey();
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;
  const unsupported: AiModel = {
    ...model,
    id: "provider/unsupported-model",
  };

  try {
    const result = await chatCompletion(unsupported, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(result.retryable, false);
  } finally {
    restoreEnvironment();
  }
});

test("a 429 carries Retry-After and remains retryable", async () => {
  useApiKey();
  stubFetch(429, { error: { message: "rate limit" } }, { "retry-after": "7" });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
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
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TRANSIENT");
    assert.equal(result.retryable, true);
  } finally {
    restoreEnvironment();
  }
});

test("an aborted FreeModel request is classified as a timeout without swallowing cancellation", async () => {
  useApiKey();
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("request aborted", "AbortError");
  }) as typeof fetch;

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }], {
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TIMEOUT");
    assert.equal(result.retryable, true);
  } finally {
    restoreEnvironment();
  }
});

test("a 200 provider error envelope is not treated as a completion", async () => {
  useApiKey();
  stubFetch(200, { error: { message: "provider error" } });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
  } finally {
    restoreEnvironment();
  }
});

test("empty and truncated completions are failures, not successes", async () => {
  useApiKey();
  stubFetch(200, { choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  try {
    const empty = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "EMPTY_COMPLETION");

    stubFetch(200, {
      choices: [{ message: { content: '{"files":[' }, finish_reason: "length" }],
      usage: { prompt_tokens: 100, completion_tokens: 24_000, total_tokens: 24_100 },
    });
    const truncated = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(truncated.ok, false);
    if (truncated.ok) return;
    assert.equal(truncated.code, "OUTPUT_LIMIT");
    assert.equal(truncated.retryable, false);
  } finally {
    restoreEnvironment();
  }
});

test("the website-generation model catalog contains only the supported FreeModel model", () => {
  assert.deepEqual(AI_MODEL_CATALOG.map((entry) => entry.id), ["claude-opus-4.7"]);
});

test("MAVLY_DEFAULT_MODEL selects the catalog model and an unknown value stays on the catalog default", () => {
  const previousDefault = process.env.MAVLY_DEFAULT_MODEL;
  try {
    process.env.MAVLY_DEFAULT_MODEL = "claude-opus-4.7";
    assert.equal(resolveModel(null, "app-generation").id, "claude-opus-4.7");

    // An unrecognized value must never reach the provider; it falls back to the
    // catalog default rather than being forwarded on the wire.
    process.env.MAVLY_DEFAULT_MODEL = "claude-fable-5-1";
    assert.equal(resolveModel(null, "app-generation").id, "claude-opus-4.7");
  } finally {
    if (previousDefault === undefined) delete process.env.MAVLY_DEFAULT_MODEL;
    else process.env.MAVLY_DEFAULT_MODEL = previousDefault;
  }
});

test("the base URL defaults to FreeModel and trailing slashes are stripped", async () => {
  useApiKey();
  const previousBaseUrl = process.env.FREEMODEL_BASE_URL;
  const seen: string[] = [];
  globalThis.fetch = (async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({
      model: model.id,
      choices: [{ message: { content: '{"files":[]}' }, finish_reason: "stop" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    delete process.env.FREEMODEL_BASE_URL;
    const byDefault = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(byDefault.ok, true);

    process.env.FREEMODEL_BASE_URL = "https://freemodel.example/v1///";
    const overridden = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(overridden.ok, true);

    assert.deepEqual(seen, [
      "https://freemodel.in/v1/chat/completions",
      "https://freemodel.example/v1/chat/completions",
    ]);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.FREEMODEL_BASE_URL;
    else process.env.FREEMODEL_BASE_URL = previousBaseUrl;
    restoreEnvironment();
  }
});

test("FreeModel usage safely extracts token and reasoning counts", () => {
  assert.deepEqual(completionUsage({
    usage: {
      prompt_tokens: "10",
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 8 },
    },
  }), {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    reasoningTokens: 8,
    costUsd: null,
  });
});
