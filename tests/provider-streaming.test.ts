import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStreamAccumulator,
  parseSseEvent,
  streamCompletionVerdict,
} from "../src/lib/ai/stream-contract";
import { chatCompletion } from "../src/lib/ai/openrouter";
import { resolveModel } from "../src/lib/ai/models";
import type { ChatMessage } from "../src/lib/ai/chat-contract";

/**
 * ═══ THE STREAMED PROVIDER CONTRACT ══════════════════════════════════════════
 *
 * The generation transport used to await one complete non-streaming body under a
 * single total-response timeout, so a large healthy answer was aborted for being
 * slow and then retried identically. These tests pin the replacement:
 *
 *   · deltas accumulate in order, across chunk and multi-byte UTF-8 boundaries;
 *   · only a recognised completion is a success — a cancelled, unknown-reason or
 *     prematurely closed stream fails even when text arrived;
 *   · a stalled stream is aborted by the idle window, not by total duration;
 *   · the provider request id survives an aborted or failed body;
 *   · absent usage stays absent (never invented).
 *
 * They use an injected `fetch`; no network call and no paid request is made.
 */

const MODEL = resolveModel();
const USER: ChatMessage[] = [{ role: "user", content: "build a landing page" }];

const originalKey = process.env.OPENROUTER_API_KEY;
const originalFetch = globalThis.fetch;

function restore(): void {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
}

// ── Pure accumulation ───────────────────────────────────────────────────────

test("SSE events are parsed with multi-line data joined and comments ignored", () => {
  assert.equal(parseSseEvent(": keep-alive\ndata: {\"a\":1}\n"), "{\"a\":1}");
  assert.equal(parseSseEvent("data: line one\ndata: line two"), "line one\nline two");
  assert.equal(parseSseEvent("event: ping\n"), null);
  assert.equal(parseSseEvent("\n\n"), null);
});

test("deltas accumulate in order across chunk boundaries", () => {
  const accumulator = createStreamAccumulator();
  accumulator.feed('data: {"choices":[{"delta":{"content":"{\\"files\\":"}}]}\n\ndata: {"cho');
  accumulator.feed('ices":[{"delta":{"content":"[]}"}}]}\n\n');
  accumulator.feed("data: [DONE]\n\n");

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.content, '{"files":[]}');
  assert.equal(snapshot.sawDone, true);
  assert.deepEqual(streamCompletionVerdict(snapshot), { ok: true, reason: null, detail: null });
});

test("a finish reason and final usage are captured from a stream", () => {
  const accumulator = createStreamAccumulator();
  accumulator.feed(
    'data: {"id":"gen-1","model":"deepseek/deepseek-v4.1-flash","choices":[{"delta":{"content":"hi"}}]}\n\n',
  );
  accumulator.feed(
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12,"cost":0.0004}}\n\n',
  );
  accumulator.flush();

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.finishReason, "stop");
  assert.equal(snapshot.content, "hi");
  assert.equal(snapshot.responseId, "gen-1");
  assert.equal(snapshot.usage.promptTokens, 9);
  assert.equal(snapshot.usage.completionTokens, 3);
  assert.equal(snapshot.usage.totalTokens, 12);
  assert.equal(snapshot.usage.costUsd, 0.0004);
});

test("a provider error event is a failure even when text was received", () => {
  const accumulator = createStreamAccumulator();
  accumulator.feed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  accumulator.feed('data: {"error":{"message":"upstream overloaded"}}\n\n');

  const verdict = streamCompletionVerdict(accumulator.snapshot());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "provider_error");
  assert.match(String(verdict.detail), /overloaded/);
});

test("cancelled, unknown and tool-call finish reasons are never success", () => {
  const cases: [string, string][] = [
    ["cancelled", "cancelled"],
    ["some_new_reason", "unknown_finish_reason"],
    ["tool_calls", "tool_calls"],
  ];
  for (const [finishReason, expected] of cases) {
    const accumulator = createStreamAccumulator();
    accumulator.feed(
      `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"${finishReason}"}]}\n\n`,
    );
    const verdict = streamCompletionVerdict(accumulator.snapshot());
    assert.equal(verdict.ok, false, `${finishReason} must not be a success`);
    assert.equal(verdict.reason, expected);
  }
});

test("a stream that closes without completion is a premature EOF", () => {
  const accumulator = createStreamAccumulator();
  accumulator.feed('data: {"choices":[{"delta":{"content":"half a file"}}]}\n\n');
  accumulator.flush();

  const verdict = streamCompletionVerdict(accumulator.snapshot());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "premature_eof");
});

// ── Transport ───────────────────────────────────────────────────────────────

function streamResponse(
  parts: (string | Uint8Array)[],
  init: { status?: number; headers?: Record<string, string>; close?: boolean } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      if (init.close !== false) controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": "gen-test-request",
      ...(init.headers ?? {}),
    },
  });
}

function stubFetch(response: Response | (() => Response)): { calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { calls };
}

test("a streamed completion is joined and the request asks for a stream", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const fetchStub = stubFetch(
    streamResponse([
      'data: {"id":"gen-a","model":"deepseek/deepseek-v4.1-flash","choices":[{"delta":{"content":"{\\"files\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"cost":0.0002}}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000, maxTokens: 1_000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, '{"files":[]}');
    assert.equal(result.finishReason, "stop");
    assert.equal(result.metadata.usage.totalTokens, 6);
    assert.equal(result.metadata.usage.costUsd, 0.0002);
    assert.equal(result.metadata.providerRequestId, "gen-test-request");

    const body = JSON.parse(fetchStub.calls[0].body) as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.equal(body.model, MODEL.id);
    assert.equal(body.max_tokens, 1_000);
    assert.equal(fetchStub.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    // The credential is a header, never part of the payload.
    assert.equal(fetchStub.calls[0].body.includes("test-key-not-real"), false);
  } finally {
    restore();
  }
});

test("a multi-byte character split across chunks is not corrupted", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const full =
    'data: {"choices":[{"delta":{"content":"héllo ✓ 🎉"},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(full);
  // Split inside the emoji's 4-byte sequence.
  const splitAt = bytes.indexOf(0xf0) + 2;
  assert.ok(splitAt > 2, "the fixture must contain a multi-byte character");
  stubFetch(streamResponse([bytes.slice(0, splitAt), bytes.slice(splitAt)]));

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, "héllo ✓ 🎉");
  } finally {
    restore();
  }
});

test("a mid-stream provider error fails with the request id preserved", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  stubFetch(
    streamResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"stream failed"}}\n\n',
    ]),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.equal(result.metadata.providerRequestId, "gen-test-request");
    assert.equal(result.metadata.status, 200);
  } finally {
    restore();
  }
});

test("a finish_reason of length is an output limit, never a success", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  stubFetch(
    streamResponse([
      'data: {"choices":[{"delta":{"content":"{\\"files\\":["},"finish_reason":"length"}]}\n\n',
    ]),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "OUTPUT_LIMIT");
    assert.equal(result.retryable, false);
  } finally {
    restore();
  }
});

test("a cancelled finish reason is a failure, not partial output", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  stubFetch(
    streamResponse([
      'data: {"choices":[{"delta":{"content":"half"},"finish_reason":"cancelled"}]}\n\n',
    ]),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.match(result.error, /cancelled/i);
  } finally {
    restore();
  }
});

test("missing usage metadata stays absent instead of becoming zero", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  stubFetch(
    streamResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.metadata.usage.promptTokens, null);
    assert.equal(result.metadata.usage.completionTokens, null);
    assert.equal(result.metadata.usage.costUsd, null);
  } finally {
    restore();
  }
});

test("an idle stream is aborted by the progress timeout, keeping the request id", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  // One delta, then the provider never finishes: only the idle window can stop it.
  stubFetch(
    streamResponse(['data: {"choices":[{"delta":{"content":"starting"}}]}\n\n'], { close: false }),
  );

  try {
    const started = Date.now();
    const result = await chatCompletion(MODEL, USER, {
      timeoutMs: 10_000,
      idleTimeoutMs: 1_000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "TIMEOUT");
    assert.match(result.error, /stopped sending tokens/i);
    assert.equal(result.metadata.providerRequestId, "gen-test-request");
    // Bounded by the idle window, not by the absolute cap.
    assert.ok(elapsed < 5_000, `idle abort took ${elapsed} ms`);
  } finally {
    restore();
  }
});

test("a non-streaming JSON answer is still accepted", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  stubFetch(
    new Response(
      JSON.stringify({
        id: "gen-json",
        model: MODEL.id,
        choices: [{ message: { content: "{\"files\":[]}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "gen-json" } },
    ),
  );

  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, "{\"files\":[]}");
    assert.equal(result.metadata.providerRequestId, "gen-json");
  } finally {
    restore();
  }
});

test("an unconfigured provider fails closed without a network call", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const fetchStub = stubFetch(streamResponse([]));
  try {
    const result = await chatCompletion(MODEL, USER, { timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "PROVIDER_ERROR");
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    restore();
  }
});

test("a model outside the catalog never reaches the wire", async () => {
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  const fetchStub = stubFetch(streamResponse([]));
  try {
    const result = await chatCompletion(
      { ...MODEL, id: "vendor/not-registered" },
      USER,
      { timeoutMs: 5_000 },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    restore();
  }
});
