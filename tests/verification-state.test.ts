import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_EXEC_OUTPUT_BYTES,
  boundOutput,
  sandboxError,
  sandboxIdSafe,
  withTimeout,
} from "../src/lib/sandbox/adapter";
import {
  MAX_ACTIVE_GLOBAL,
  MAX_ACTIVE_PER_PROJECT,
  MAX_ACTIVE_PER_USER,
  TERMINAL_STAGES,
  VERIFICATION_BUILD_TIMEOUT_MS,
  VERIFICATION_DEADLINE_MS,
  VERIFICATION_INSTALL_TIMEOUT_MS,
  VERIFICATION_SESSION_TIMEOUT_MS,
  isTerminalStage,
  notStartedVerification,
  publicVerificationStatus,
} from "../src/lib/sandbox/state";

/**
 * The adapter's timeout and bounding helpers are the only part of the contract
 * that can be proven without a provider. The state mapping is what keeps a
 * public status from claiming more than the database recorded.
 */

test("internal stages map to the three public non-terminal statuses", () => {
  assert.equal(publicVerificationStatus("queued"), "pending");
  assert.equal(publicVerificationStatus("preparing"), "running");
  assert.equal(publicVerificationStatus("installing"), "running");
  assert.equal(publicVerificationStatus("building"), "running");
  for (const stage of TERMINAL_STAGES) {
    assert.equal(publicVerificationStatus(stage), stage);
    assert.equal(isTerminalStage(stage), true);
  }
  assert.equal(isTerminalStage("building"), false);
});

test("a run with no verification is not_started, never fabricated as running", () => {
  const result = notStartedVerification("11111111-1111-4111-8111-111111111111", "demo-app");
  assert.equal(result.status, "not_started");
  assert.equal(result.stage, "queued");
  assert.equal(result.provider, null);
  assert.equal(result.exitCode, null);
  assert.deepEqual(result.diagnostics, []);
});

test("timeouts fit inside the verification deadline", () => {
  assert.equal(
    VERIFICATION_INSTALL_TIMEOUT_MS + VERIFICATION_BUILD_TIMEOUT_MS <
      VERIFICATION_SESSION_TIMEOUT_MS,
    true,
  );
  assert.equal(VERIFICATION_SESSION_TIMEOUT_MS < VERIFICATION_DEADLINE_MS, true);
});

test("admission caps stay explicit and finite", () => {
  assert.equal(MAX_ACTIVE_PER_PROJECT, 1);
  assert.equal(MAX_ACTIVE_PER_USER, 2);
  assert.equal(MAX_ACTIVE_GLOBAL, 8);
});

test("sandbox references are restricted to an opaque safe charset", () => {
  assert.equal(sandboxIdSafe("mavly-verify-abc123"), true);
  assert.equal(sandboxIdSafe("sbx_01.ABC-xyz"), true);
  for (const value of ["", "has space", "a/b", "a:b", "../escape", "x".repeat(129)]) {
    assert.equal(sandboxIdSafe(value), false, value);
  }
});

test("provider output is bounded before it can reach diagnostics", () => {
  assert.equal(boundOutput("short"), "short");
  const bounded = boundOutput("x".repeat(MAX_EXEC_OUTPUT_BYTES + 100));
  assert.equal(bounded.length, MAX_EXEC_OUTPUT_BYTES);
});

test("withTimeout returns a typed timeout instead of hanging forever", async () => {
  const never = withTimeout(() => new Promise<string>(() => {}), 10);
  const result = await never;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "timeout");
});

test("withTimeout maps a rejected provider promise to a sanitized error", async () => {
  const result = await withTimeout(
    async () => {
      throw new Error("provider body with a token sk-live-abcdefghijklmnop");
    },
    1_000,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_error");
    assert.equal(result.error.message.includes("sk-live"), false);
  }
});

test("withTimeout passes a successful value through", async () => {
  const result = await withTimeout(async () => 42, 1_000);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 42);
});

test("sandboxError carries only an allowlisted code and message", () => {
  const error = sandboxError("not_found", "The sandbox no longer exists.");
  assert.deepEqual(error, { code: "not_found", message: "The sandbox no longer exists." });
});
