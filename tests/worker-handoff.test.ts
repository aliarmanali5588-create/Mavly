import { test } from "node:test";
import assert from "node:assert/strict";

import { handoffDecision } from "../src/lib/generation/dispatch";
import { reserveForPendingWork } from "../src/lib/ai/budget";

/**
 * ═══ INLINE → WORKER HAND-OFF (pure decision) ═══════════════════════════════
 *
 * These tests pin the four conditions that make a hand-off safe. The database
 * side (ownership, the `claimed_at` fence, manifest + checkpoint presence, and
 * the once-only transition) is enforced by
 * `supabase/migrations/36_generation_worker_handoff.sql` and is NOT exercised
 * here.
 */

const eligible = {
  leaseToken: null as string | null,
  claimedAt: "2026-01-01T00:00:00.000Z" as string | null,
  retryable: true,
  workerDispatchSelected: true,
};

test("an eligible inline run is handed off", () => {
  assert.deepEqual(handoffDecision(eligible), { handoff: true });
});

test("a worker attempt never hands its own run back to the queue", () => {
  const decision = handoffDecision({ ...eligible, leaseToken: "lease-token" });
  assert.equal(decision.handoff, false);
  assert.equal(decision.handoff === false && decision.reason, "worker_attempt_owns_run");
});

test("an invocation without its inline claim cannot hand the run over", () => {
  const decision = handoffDecision({ ...eligible, claimedAt: null });
  assert.equal(decision.handoff === false && decision.reason, "no_inline_claim");
});

test("a non-retryable failure is not a scheduling problem", () => {
  const decision = handoffDecision({ ...eligible, retryable: false });
  assert.equal(decision.handoff === false && decision.reason, "not_retryable");
});

/**
 * ⚠️ THE LOAD-BEARING REFUSAL. A hand-off is allowed only when the production
 * dispatch path assigns this run to the platform worker; otherwise it would
 * park a live run on a queue no worker reads.
 */
test("a run not assigned to the platform worker stays on the inline path", () => {
  const decision = handoffDecision({ ...eligible, workerDispatchSelected: false });
  assert.equal(decision.handoff === false && decision.reason, "worker_not_selected_for_runtime");
});

/**
 * ═══ PENDING-WORK RESERVE ═══════════════════════════════════════════════════
 *
 * The batch loop used to reserve `pending × minAttemptMs`, which for four queued
 * batches exceeded the whole window and handed the batch being sent its bare
 * minimum (60 s) — a timeout by construction. The reserve is now capped at a
 * fraction of what is left.
 */

test("the reserve is capped so the current call keeps a usable window", () => {
  // 4 queued batches × 60 s would be 240 s of a 150 s window.
  const reserve = reserveForPendingWork({
    pendingCount: 4,
    minAttemptMs: 60_000,
    remainingMs: 150_000,
  });
  assert.equal(reserve, 60_000);
  assert.ok(150_000 - reserve >= 60_000, "the current call keeps at least its minimum");
});

test("the reserve never asks for more than the queued calls need", () => {
  const reserve = reserveForPendingWork({
    pendingCount: 2,
    minAttemptMs: 20_000,
    remainingMs: 400_000,
  });
  assert.equal(reserve, 40_000);
});

test("no queued work means no reserve", () => {
  assert.equal(
    reserveForPendingWork({ pendingCount: 0, minAttemptMs: 60_000, remainingMs: 120_000 }),
    0,
  );
});

test("a spent deadline reserves nothing", () => {
  assert.equal(
    reserveForPendingWork({ pendingCount: 3, minAttemptMs: 60_000, remainingMs: -5_000 }),
    0,
  );
});

test("the fraction is bounded", () => {
  const half = reserveForPendingWork({
    pendingCount: 10,
    minAttemptMs: 60_000,
    remainingMs: 100_000,
    maxFraction: 0.5,
  });
  assert.equal(half, 50_000);
  const over = reserveForPendingWork({
    pendingCount: 10,
    minAttemptMs: 60_000,
    remainingMs: 100_000,
    maxFraction: 4,
  });
  assert.equal(over, 100_000);
});
