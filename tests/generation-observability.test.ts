import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isTraceId,
  isUuid,
  newTraceId,
  redactSensitiveText,
} from "../src/lib/observability/correlation";
import { reportedCostOf } from "../src/lib/observability/cost";
import {
  emitGenerationEvent,
  type GenerationEventFields,
  type GenerationEventName,
} from "../src/lib/observability/events";

/**
 * Observability is an allowlist, not a formatter. A log line carries known
 * scalar fields; a prompt, credential, email or provider body cannot reach it.
 */

const TRACE = "a".repeat(32);
const RUN_ID = "22222222-2222-2222-2222-222222222222";

// ── Correlation ────────────────────────────────────────────────────────────

test("trace ids are 32 hex characters, non-secret and unique", () => {
  const first = newTraceId();
  const second = newTraceId();
  assert.equal(isTraceId(first), true);
  assert.equal(isTraceId(second), true);
  assert.notEqual(first, second);
  assert.equal(first.length, 32);
  assert.equal(/^[a-f0-9]+$/.test(first), true);
  assert.equal(isTraceId("ABC"), false);
  assert.equal(isTraceId("z".repeat(32)), false);
  assert.equal(isTraceId(null), false);
});

test("uuid validation is strict", () => {
  assert.equal(isUuid(RUN_ID), true);
  assert.equal(isUuid("22222222-2222-2222-2222-22222222222"), false);
  assert.equal(isUuid("not-a-uuid"), false);
});

// ── Redaction ──────────────────────────────────────────────────────────────

test("credentials, tokens, emails and URLs are removed", () => {
  assert.equal(
    redactSensitiveText("Authorization: Bearer abc.def-123"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(redactSensitiveText("key sk_live_1234567890abcdef"), "key [redacted-key]");
  assert.equal(
    redactSensitiveText(
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ),
    "token [redacted-jwt]",
  );
  assert.equal(redactSensitiveText("user@example.com"), "[redacted-email]");
  assert.equal(redactSensitiveText("see https://example.com/path?q=1"), "see [url]");
  assert.equal(redactSensitiveText("A".repeat(48)), "[redacted-token]");
});

test("redaction collapses whitespace, bounds length and refuses non-strings", () => {
  assert.equal(redactSensitiveText("  a \n\t b  "), "a b");
  assert.equal(redactSensitiveText(42), "");
  assert.equal(redactSensitiveText(null), "");
  const bounded = redactSensitiveText("abcdefghijklmnop", 5);
  assert.equal(bounded.length, 5);
  assert.equal(bounded.endsWith("…"), true);
  assert.equal(redactSensitiveText("abcdefghij", 10), "abcdefghij");
});

// ── Event emission ─────────────────────────────────────────────────────────

function capture(
  event: GenerationEventName,
  fields: GenerationEventFields,
): { channel: "info" | "warn" | "error"; body: Record<string, unknown> }[] {
  const lines: { channel: "info" | "warn" | "error"; body: Record<string, unknown> }[] = [];
  const original = { info: console.info, warn: console.warn, error: console.error };
  const record =
    (channel: "info" | "warn" | "error") =>
    (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      const json = text.startsWith("[generation] ") ? text.slice("[generation] ".length) : text;
      lines.push({ channel, body: JSON.parse(json) as Record<string, unknown> });
    };
  console.info = record("info") as typeof console.info;
  console.warn = record("warn") as typeof console.warn;
  console.error = record("error") as typeof console.error;
  try {
    emitGenerationEvent(event, fields);
  } finally {
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

test("an emitted line carries only allowlisted, validated fields", () => {
  const [line] = capture("generation.accepted", {
    traceId: TRACE,
    runId: RUN_ID,
    projectId: "my-project",
    workerId: "worker-1",
    stage: "queued",
    status: "accepted",
    dispatchMode: "worker",
    attempt: 1,
    maxAttempts: 3,
    queueLagMs: 1200,
    model: "deepseek/deepseek-v4.1-flash",
    prompt: "SECRET PROMPT",
    generatedCode: "<html>secret</html>",
  } as GenerationEventFields);

  assert.equal(line.channel, "info");
  assert.equal(line.body.event, "generation.accepted");
  assert.equal(typeof line.body.at, "string");
  assert.equal(line.body.traceId, TRACE);
  assert.equal(line.body.runId, RUN_ID);
  assert.equal(line.body.projectId, "my-project");
  assert.equal(line.body.dispatchMode, "worker");
  assert.equal(line.body.attempt, 1);
  assert.equal(line.body.queueLagMs, 1200);
  assert.equal(line.body.model, "deepseek/deepseek-v4.1-flash");
  assert.equal("prompt" in line.body, false);
  assert.equal("generatedCode" in line.body, false);
});

test("invalid identifiers and negative counts are dropped rather than logged", () => {
  const [line] = capture("generation.claimed", {
    traceId: "trace",
    runId: "run",
    projectId: "../escape",
    workerId: "has space",
    attempt: -1,
    retryAfterSeconds: Number.POSITIVE_INFINITY,
    costUsd: 0.123456789,
    costKnown: true,
  });

  assert.equal("traceId" in line.body, false);
  assert.equal("runId" in line.body, false);
  assert.equal("projectId" in line.body, false);
  assert.equal("workerId" in line.body, false);
  assert.equal("attempt" in line.body, false);
  assert.equal("retryAfterSeconds" in line.body, false);
  assert.equal(line.body.costUsd, 0.123457);
  assert.equal(line.body.costKnown, true);
});

test("provider-attempt events retain safe run-scoped metadata without prompt content", () => {
  const [line] = capture("generation.provider_attempt", {
    traceId: TRACE,
    runId: RUN_ID,
    projectId: "my-project",
    workerId: "aws-worker-1",
    attempt: 4,
    runAttempt: 4,
    phaseAttempt: 2,
    stage: "batch",
    status: "TIMEOUT",
    model: "anthropic/claude-sonnet-5",
    providerRequestId: "req_123",
    providerAttemptId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-01-02T03:04:05.000Z",
    endedAt: "2026-01-02T03:04:15.000Z",
    latencyMs: 10_000,
    remainingBudgetMs: 50_000,
    httpStatus: 200,
    finishReason: "length",
    timeoutClassification: "idle",
    retryReason: "timeout_scope_reduction",
    promptTokens: 900,
    completionTokens: 12_000,
    totalTokens: 12_900,
    reasoningTokens: 2_000,
    prompt: "must never be emitted",
  } as GenerationEventFields);

  assert.equal(line.body.event, "generation.provider_attempt");
  assert.equal(line.body.runId, RUN_ID);
  assert.equal(line.body.runAttempt, 4);
  assert.equal(line.body.providerRequestId, "req_123");
  assert.equal(line.body.providerAttemptId, "33333333-3333-4333-8333-333333333333");
  assert.equal(line.body.timeoutClassification, "idle");
  assert.equal(line.body.completionTokens, 12_000);
  assert.equal(line.body.totalTokens, 12_900);
  assert.equal(line.body.reasoningTokens, 2_000);
  assert.equal("prompt" in line.body, false);
});

test("failure-level events use the error channel and retry events warn", () => {
  assert.equal(capture("generation.failed", { runId: RUN_ID })[0].channel, "error");
  assert.equal(capture("generation.dead_letter", { runId: RUN_ID })[0].channel, "error");
  assert.equal(capture("generation.worker_error", { reason: "unhandled" })[0].channel, "error");
  assert.equal(
    capture("generation.retry_scheduled", { runId: RUN_ID })[0].channel,
    "warn",
  );
  assert.equal(capture("generation.lease_lost", { runId: RUN_ID })[0].channel, "warn");
  assert.equal(capture("generation.heartbeat_failed", { runId: RUN_ID })[0].channel, "warn");
  assert.equal(capture("generation.completed", { runId: RUN_ID })[0].channel, "info");
});

test("an unknown event name emits nothing and emitting never throws", () => {
  const lines = capture("generation.not_a_real_event" as GenerationEventName, {
    runId: RUN_ID,
  });
  assert.deepEqual(lines, []);
  assert.doesNotThrow(() =>
    emitGenerationEvent("generation.worker_empty", {
      recovered: Number.NaN,
      reason: "https://example.com/?key=secret",
    }),
  );
});

// ── Cost ───────────────────────────────────────────────────────────────────

test("cost is known only when every attempt reported a finite non-negative value", () => {
  assert.deepEqual(reportedCostOf([]), { costUsd: null, known: false });
  assert.deepEqual(reportedCostOf([{ costUsd: 0.1 }, { costUsd: 0.2 }]), {
    costUsd: 0.3,
    known: true,
  });
  assert.deepEqual(reportedCostOf([{ costUsd: 0 }, { costUsd: 2 }]), {
    costUsd: 2,
    known: true,
  });
  assert.deepEqual(reportedCostOf([{ costUsd: 1 }, { costUsd: null }]), {
    costUsd: null,
    known: false,
  });
  assert.deepEqual(reportedCostOf([{ costUsd: 1 }, {}]), {
    costUsd: null,
    known: false,
  });
  assert.deepEqual(reportedCostOf([{ costUsd: -1 }]), { costUsd: null, known: false });
  assert.deepEqual(reportedCostOf([{ costUsd: Number.NaN }]), {
    costUsd: null,
    known: false,
  });
});
