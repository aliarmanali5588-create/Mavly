import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETRY_POLICY,
  parseRetryAfterMs,
  retryDelayMs,
  retryWithBackoff,
} from "../src/lib/ai/retry";

test("backoff is exponential, jittered and capped", () => {
  assert.equal(retryDelayMs(1, DEFAULT_RETRY_POLICY, null, () => 0), 800);
  assert.equal(retryDelayMs(2, DEFAULT_RETRY_POLICY, null, () => 0), 1_600);
  assert.equal(retryDelayMs(10, DEFAULT_RETRY_POLICY, null, () => 0), 15_000);
  assert.equal(retryDelayMs(1, DEFAULT_RETRY_POLICY, null, () => 0.999), 1_199);
});

test("Retry-After wins when it is longer, and is bounded", () => {
  assert.equal(retryDelayMs(1, DEFAULT_RETRY_POLICY, 5_000, () => 0), 5_000);
  assert.equal(retryDelayMs(1, DEFAULT_RETRY_POLICY, 999_999, () => 0), 60_000);
  assert.equal(retryDelayMs(4, DEFAULT_RETRY_POLICY, 1_000, () => 0), 6_400);
});

test("Retry-After parses seconds and an HTTP date", () => {
  assert.equal(parseRetryAfterMs("7"), 7_000);
  assert.equal(parseRetryAfterMs("0.5"), 500);
  assert.equal(parseRetryAfterMs("-1"), null);
  assert.equal(parseRetryAfterMs("not-a-date"), null);
  assert.equal(parseRetryAfterMs(null), null);

  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", now), 10_000);
});

test("retryWithBackoff stops at the attempt cap", async () => {
  let calls = 0;
  const sleeps: number[] = [];

  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      return false;
    },
    () => ({ retryable: true }),
    {
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    },
  );

  assert.equal(result, false);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("retryWithBackoff stops before sleeping past the deadline", async () => {
  let calls = 0;
  let now = 0;
  const sleeps: number[] = [];

  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      return false;
    },
    () => ({ retryable: true }),
    {
      policy: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 1_000, minRemainingMs: 2_000 },
      deadlineAt: 2_500,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 0,
    },
  );

  assert.equal(result, false);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("retryWithBackoff does not retry a permanent failure", async () => {
  let calls = 0;

  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      return "permanent";
    },
    () => ({ retryable: false }),
    { sleep: async () => {} },
  );

  assert.equal(result, "permanent");
  assert.equal(calls, 1);
});
