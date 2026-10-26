import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_STAGES,
  GENERATION_STAGES,
  READY_STAGES,
  TERMINAL_STAGES,
  canResumeStage,
  canTransition,
  classifyGenerationFailure,
  isExecutionStage,
  isReadyStage,
  isTerminalStage,
  isUnfinishedStage,
  publicStageOf,
} from "../src/lib/generation/state-machine";

/**
 * These tests exercise the pure state machine and failure policy. The SQL RPCs
 * enforce the same rules, but a database is not required to prove an edge is
 * refused or a retry is conservative.
 */

// ── Stage vocabulary ───────────────────────────────────────────────────────

test("retry_wait is a ready stage, not a running or terminal one", () => {
  assert.deepEqual(READY_STAGES, ["queued", "retry_wait"]);
  assert.equal(isReadyStage("retry_wait"), true);
  assert.equal(isReadyStage("queued"), true);
  assert.equal(isReadyStage("validating"), false);
  assert.equal(isExecutionStage("retry_wait"), false);
  assert.equal(isExecutionStage("validating"), true);
  assert.equal(isTerminalStage("retry_wait"), false);
  assert.equal(isUnfinishedStage("retry_wait"), true);
  assert.equal(isUnfinishedStage("completed"), false);
  assert.equal(isUnfinishedStage(null), false);
  assert.equal(GENERATION_STAGES.includes("retry_wait"), true);
});

test("the public stage maps retry_wait to retrying instead of inventing a new UI state", () => {
  assert.equal(publicStageOf("retry_wait"), "retrying");
  for (const stage of GENERATION_STAGES) {
    if (stage === "retry_wait") continue;
    assert.equal(publicStageOf(stage), stage);
  }
});

test("the stage sets do not overlap or omit a known stage", () => {
  assert.equal(EXECUTION_STAGES.includes("validating"), true);
  assert.equal(TERMINAL_STAGES.includes("interrupted"), true);
  for (const stage of READY_STAGES) {
    assert.equal(isExecutionStage(stage), false);
    assert.equal(isTerminalStage(stage), false);
  }
});

// ── Transitions ────────────────────────────────────────────────────────────

test("a job can only leave a ready state towards execution, failure or cancellation", () => {
  assert.equal(canTransition("queued", "validating"), true);
  assert.equal(canTransition("queued", "completed"), false);
  assert.equal(canTransition("queued", "generating"), false);
  assert.equal(canTransition("queued", "cancelled"), true);
  assert.equal(canTransition("queued", "failed"), true);

  assert.equal(canTransition("retry_wait", "validating"), true);
  assert.equal(canTransition("retry_wait", "completed"), false);
  assert.equal(canTransition("retry_wait", "cancelled"), true);
});

test("terminal states cannot be re-entered without the explicit resume transition", () => {
  assert.equal(canTransition("completed", "queued"), false);
  assert.equal(canTransition("completed", "validating"), false);
  assert.equal(canTransition("cancelled", "queued"), false);
  assert.equal(canTransition("interrupted", "queued"), true);
  assert.equal(canTransition("failed", "queued"), true);
  assert.equal(canResumeStage("failed"), true);
  assert.equal(canResumeStage("interrupted"), true);
  assert.equal(canResumeStage("completed"), false);
  assert.equal(canResumeStage("cancelled"), false);
});

test("a running job may retry, complete, fail or be cancelled", () => {
  assert.equal(canTransition("validating", "generating"), true);
  assert.equal(canTransition("validating", "retry_wait"), true);
  assert.equal(canTransition("generating", "completed"), true);
  assert.equal(canTransition("generating", "retry_wait"), true);
  assert.equal(canTransition("retrying", "validating"), true);
  assert.equal(canTransition("retrying", "generating"), true);
  assert.equal(canTransition("retrying", "cancelled"), true);
});

// ── Failure classification ─────────────────────────────────────────────────

test("timeouts, rate limits, transient provider errors and persistence failures retry", () => {
  assert.deepEqual(
    classifyGenerationFailure({ code: "GENERATION_TIMEOUT" }),
    { retryable: true, errorClass: "provider_timeout", summary: "" },
  );
  assert.equal(
    classifyGenerationFailure({ code: "GENERATION_PERSIST_FAILED" }).retryable,
    true,
  );
  assert.equal(
    classifyGenerationFailure({
      code: "GENERATION_PROVIDER_FAILED",
      attemptErrorCode: "RATE_LIMITED",
    }).errorClass,
    "provider_rate_limited",
  );
  assert.equal(
    classifyGenerationFailure({
      code: "GENERATION_PROVIDER_FAILED",
      attemptErrorCode: "NETWORK",
    }).errorClass,
    "provider_transient",
  );
  assert.equal(
    classifyGenerationFailure({
      code: "GENERATION_PROVIDER_FAILED",
      attemptErrorCode: "TIMEOUT",
    }).retryable,
    true,
  );
});

test("permanent failures are never retried", () => {
  const permanentCodes: Array<[string, string]> = [
    ["GENERATION_CONTENT_FILTER", "content_filter"],
    ["GENERATION_TRUNCATED", "generation_truncated"],
    ["GENERATION_MALFORMED", "generation_malformed"],
    ["GENERATION_INCOMPLETE", "generation_incomplete"],
    ["GENERATION_UNSAFE_PATH", "unsafe_path"],
    ["GENERATION_TOO_LARGE", "too_large"],
    ["GENERATION_TOO_MANY_FILES", "too_many_files"],
    ["GENERATION_NO_FILES", "no_files"],
  ];
  for (const [code, errorClass] of permanentCodes) {
    const result = classifyGenerationFailure({ code });
    assert.equal(result.retryable, false, code);
    assert.equal(result.errorClass, errorClass, code);
  }

  assert.equal(
    classifyGenerationFailure({
      code: "GENERATION_PROVIDER_FAILED",
      attemptErrorCode: "AUTHENTICATION",
    }).errorClass,
    "provider_auth",
  );
  assert.equal(
    classifyGenerationFailure({
      code: "GENERATION_PROVIDER_FAILED",
      attemptErrorCode: "INVALID_REQUEST",
    }).retryable,
    false,
  );
  assert.equal(
    classifyGenerationFailure({ message: "insufficient quota" }).errorClass,
    "provider_rejected",
  );
});

test("an unrecognised failure is not retried", () => {
  const result = classifyGenerationFailure({ message: "something unexpected happened" });
  assert.equal(result.retryable, false);
  assert.equal(result.errorClass, "unknown");
});

test("cancellation and a lost lease are classified apart from provider failures", () => {
  assert.deepEqual(classifyGenerationFailure({ code: "RUN_CANCELLED" }), {
    retryable: false,
    errorClass: "cancelled",
    summary: "",
  });
  assert.equal(
    classifyGenerationFailure({ message: "lease lost to another worker" }).errorClass,
    "lease_lost",
  );
});

test("a persisted summary is redacted and bounded", () => {
  const result = classifyGenerationFailure({
    message: "request failed: Authorization: Bearer sk_live_1234567890abcdef for user@example.com",
  });
  assert.equal(result.summary.includes("sk_live_1234567890abcdef"), false);
  assert.equal(result.summary.includes("user@example.com"), false);
  assert.equal(result.summary.length <= 500, true);
});
