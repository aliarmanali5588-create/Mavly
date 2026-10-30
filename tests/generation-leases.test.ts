import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEASE_RENEW_INTERVAL_MS,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  WORKER_LEASE_SECONDS,
  clampLeaseSeconds,
  isLeaseExpired,
  leaseExpiresAt,
  retryDelaySeconds,
  sanitizeWorkerId,
} from "../src/lib/generation/leases";

/**
 * Lease timing and retry backoff are pure. The SQL clamps the same 60–900 s
 * range and mirrors the 15 s-doubling/300 s-cap schedule, so these assertions
 * describe the contract the worker and migration share.
 */

// ── Lease bounds ───────────────────────────────────────────────────────────

test("the default lease outlives the generation budget and a worker tick", () => {
  assert.equal(WORKER_LEASE_SECONDS, 420);
  assert.equal(WORKER_LEASE_SECONDS > 300, true);
  assert.equal(LEASE_RENEW_INTERVAL_MS, 120_000);
  assert.equal(LEASE_RENEW_INTERVAL_MS < WORKER_LEASE_SECONDS * 1_000, true);
});

test("a lease is clamped to the range the RPC accepts", () => {
  assert.equal(MIN_LEASE_SECONDS, 60);
  assert.equal(MAX_LEASE_SECONDS, 900);
  assert.equal(clampLeaseSeconds(null), 420);
  assert.equal(clampLeaseSeconds(undefined), 420);
  assert.equal(clampLeaseSeconds(Number.NaN), 420);
  assert.equal(clampLeaseSeconds(10), 60);
  assert.equal(clampLeaseSeconds(60), 60);
  assert.equal(clampLeaseSeconds(420.9), 420);
  assert.equal(clampLeaseSeconds(10_000), 900);
});

test("a lease expiry is an absolute instant", () => {
  assert.equal(leaseExpiresAt(1_000, 60), 61_000);
  assert.equal(isLeaseExpired(null), true);
  assert.equal(isLeaseExpired(undefined), true);
  assert.equal(isLeaseExpired("not-a-date"), true);
  assert.equal(isLeaseExpired("2026-10-26T00:00:10.000Z", Date.parse("2026-10-26T00:00:00.000Z")), false);
  assert.equal(isLeaseExpired("2026-10-26T00:00:00.000Z", Date.parse("2026-10-26T00:00:00.000Z")), true);
  assert.equal(isLeaseExpired("2026-10-25T23:59:59.000Z", Date.parse("2026-10-26T00:00:00.000Z")), true);
});

// ── Retry backoff ──────────────────────────────────────────────────────────

test("retry backoff doubles from 15 seconds and is capped at 300", () => {
  assert.equal(RETRY_BASE_SECONDS, 15);
  assert.equal(RETRY_MAX_SECONDS, 300);
  assert.equal(retryDelaySeconds(1, () => 0), 15);
  assert.equal(retryDelaySeconds(2, () => 0), 30);
  assert.equal(retryDelaySeconds(3, () => 0), 60);
  assert.equal(retryDelaySeconds(4, () => 0), 120);
  assert.equal(retryDelaySeconds(5, () => 0), 240);
  assert.equal(retryDelaySeconds(6, () => 0), 300);
  assert.equal(retryDelaySeconds(60, () => 0), 300);
});

test("jitter is bounded to 25 % and never exceeds the cap", () => {
  assert.equal(retryDelaySeconds(1, () => 0.99), 18);
  assert.equal(retryDelaySeconds(1, () => 1), 18);
  assert.equal(retryDelaySeconds(1, () => -1), 15);
  assert.equal(retryDelaySeconds(1, () => 4), 18);
  assert.equal(retryDelaySeconds(20, () => 1), 300);
});

// ── Worker identity ────────────────────────────────────────────────────────

test("a worker id is bounded, printable and falls back instead of becoming empty", () => {
  assert.equal(sanitizeWorkerId("  worker-1  "), "worker-1");
  assert.equal(sanitizeWorkerId("my worker!!"), "my-worker");
  assert.equal(sanitizeWorkerId("a"), "generation-worker");
  assert.equal(sanitizeWorkerId(""), "generation-worker");
  assert.equal(sanitizeWorkerId(null), "generation-worker");
  assert.equal(sanitizeWorkerId("x".repeat(200)).length, 120);
  assert.equal(sanitizeWorkerId("---"), "generation-worker");
  assert.equal(sanitizeWorkerId("us:west.1_2", "fallback"), "us:west.1_2");
});
