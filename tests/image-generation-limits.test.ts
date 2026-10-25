import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_GENERATION_GLOBAL_LIMIT,
  IMAGE_GENERATION_USER_LIMIT,
  createImageGenerationLimiter,
} from "../src/lib/mavly/image-limits";

/**
 * ═══ THE IMAGE ADMISSION WINDOWS ════════════════════════════════════════════
 *
 * These are the ceilings that stand between an authenticated user and an
 * unbilled paid provider call. The limiter is pure (time is injected), so the
 * window behaviour is verified without a server.
 *
 * ⚠️ WHAT THESE TESTS DO NOT PROVE: that the cap is global across serverless
 * instances. The counters are module memory, so they are per instance by
 * construction — see `src/lib/mavly/image-limits.ts` for the persisted design
 * that a hard cap would require.
 */

const T0 = 1_000_000;

test("the defaults are conservative and non-zero", () => {
  assert.equal(IMAGE_GENERATION_USER_LIMIT, 5);
  assert.equal(IMAGE_GENERATION_GLOBAL_LIMIT, 40);
});

test("a user gets the configured requests, then a retry-after", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 2,
    userWindowMs: 60_000,
    globalLimit: 100,
    globalWindowMs: 60_000,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true);
  assert.equal(limiter.consume("user-a", T0).ok, true);

  const denied = limiter.consume("user-a", T0);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.scope, "user");
  assert.equal(denied.retryAfterSeconds, 60);
});

test("the per-user window resets after it expires", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 1,
    userWindowMs: 10_000,
    globalLimit: 100,
    globalWindowMs: 60_000,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true);
  assert.equal(limiter.consume("user-a", T0 + 9_999).ok, false);
  assert.equal(limiter.consume("user-a", T0 + 10_000).ok, true);
});

test("one user's usage does not spend another user's budget", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 1,
    userWindowMs: 60_000,
    globalLimit: 100,
    globalWindowMs: 60_000,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true);
  assert.equal(limiter.consume("user-a", T0).ok, false);
  assert.equal(limiter.consume("user-b", T0).ok, true);
});

test("a user refusal does not consume the global budget", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 1,
    userWindowMs: 60_000,
    globalLimit: 2,
    globalWindowMs: 60_000,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true); // global 1
  assert.equal(limiter.consume("user-a", T0).ok, false); // user refusal, no global spend
  assert.equal(limiter.consume("user-b", T0).ok, true); // global 2

  const denied = limiter.consume("user-c", T0);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.scope, "global");
});

test("the global window resets independently of a user window", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 1,
    userWindowMs: 5_000,
    globalLimit: 1,
    globalWindowMs: 10_000,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true);
  assert.equal(limiter.consume("user-b", T0).ok, false); // global full

  // The user window has reset, but the global one has not.
  assert.equal(limiter.consume("user-b", T0 + 6_000).ok, false);
  assert.equal(limiter.consume("user-b", T0 + 10_000).ok, true);
});

test("limiters do not share state", () => {
  const first = createImageGenerationLimiter({ userLimit: 1, globalLimit: 10 });
  const second = createImageGenerationLimiter({ userLimit: 1, globalLimit: 10 });

  assert.equal(first.consume("user-a", T0).ok, true);
  assert.equal(first.consume("user-a", T0).ok, false);
  assert.equal(second.consume("user-a", T0).ok, true);
});

test("the tracked-user ceiling refuses newcomers instead of growing", () => {
  const limiter = createImageGenerationLimiter({
    userLimit: 5,
    userWindowMs: 10_000,
    globalLimit: 100,
    globalWindowMs: 60_000,
    maxTrackedUsers: 1,
  });

  assert.equal(limiter.consume("user-a", T0).ok, true);

  const denied = limiter.consume("user-b", T0);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.scope, "global");

  // Once the tracked window expires it is pruned, and a new user can enter.
  assert.equal(limiter.consume("user-b", T0 + 10_001).ok, true);
});

test("a blank identity is refused rather than sharing a bucket", () => {
  const limiter = createImageGenerationLimiter({ userLimit: 5, globalLimit: 100 });
  const denied = limiter.consume("   ", T0);
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.scope, "user");
});
