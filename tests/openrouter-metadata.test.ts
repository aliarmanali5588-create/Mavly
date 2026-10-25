import { test } from "node:test";
import assert from "node:assert/strict";

import { chatCompletion, completionUsage } from "../src/lib/ai/openrouter";
import { resolveOpenRouterModel } from "../src/lib/ai/models";

const model = resolveOpenRouterModel();
const originalFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("finish_reason length is a failure, not an empty success", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  stubFetch(200, {
    id: "gen-123",
    model: "deepseek/deepseek-v4.1-flash",
    choices: [{ message: { content: "{\"files\":[" }, finish_reason: "length" }],
    usage: { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100 },
  });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }], {
      timeoutMs: 1_000,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "OUTPUT_LIMIT");
    assert.equal(result.retryable, false);
    assert.equal(result.metadata.finishReason, "length");
    assert.equal(result.metadata.providerRequestId, "gen-123");
    assert.equal(result.metadata.usage.totalTokens, 1100);
  } finally {
    restoreFetch();
  }
});

test("a 429 carries Retry-After and is retryable", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  stubFetch(
    429,
    { error: { message: "slow down" } },
    { "retry-after": "7", "x-request-id": "req-429" },
  );

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.retryable, true);
    assert.equal(result.retryAfterMs, 7_000);
    assert.equal(result.status, 429);
    assert.equal(result.metadata.providerRequestId, "req-429");
  } finally {
    restoreFetch();
  }
});

test("a 200 error envelope is not treated as a completion", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  stubFetch(200, { error: { message: "provider exploded" } });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.match(result.error, /provider exploded/);
  } finally {
    restoreFetch();
  }
});

test("empty content is reported as EMPTY_COMPLETION", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  stubFetch(200, {
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  });

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "EMPTY_COMPLETION");
  } finally {
    restoreFetch();
  }
});

test("a missing API key fails closed without a network call", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run");
  }) as typeof fetch;

  try {
    const result = await chatCompletion(model, [{ role: "user", content: "x" }]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "CONFIGURATION");
    assert.equal(result.retryable, false);
  } finally {
    restoreFetch();
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
  }
});

test("usage reads reasoning tokens and provider cost safely", () => {
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
