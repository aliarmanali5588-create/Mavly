import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GENERATION_FINALIZE_RESERVE_MS,
  MIN_USEFUL_ATTEMPT_MS,
  planProviderCall,
  remainingRunMs,
  remainingWorkMs,
  retryFitsBefore,
  runBudgetFor,
  runDeadlineAt,
  workDeadlineAt,
} from "../src/lib/ai/budget";
import { retryWithBackoff } from "../src/lib/ai/retry";

/**
 * Phase 0 timeout policy:
 *
 *   · one absolute run deadline;
 *   · a finalization reserve that provider calls may never spend;
 *   · every attempt planned against the time actually left;
 *   · no attempt below the minimum useful window;
 *   · backoff that cannot push past the deadline.
 */

const START = 1_000_000;

test("the work deadline excludes the finalization reserve", () => {
  const budget = runBudgetFor(START, 240_000);
  assert.equal(runDeadlineAt(budget), START + 240_000);
  assert.equal(workDeadlineAt(budget), START + 240_000 - GENERATION_FINALIZE_RESERVE_MS);
  assert.equal(remainingWorkMs(budget, START), 220_000);
  assert.equal(remainingRunMs(budget, START), 240_000);
});

test("a call never receives less than the minimum useful attempt", () => {
  const plan = planProviderCall({
    deadlineAt: START + 100_000,
    now: START,
    configuredTimeoutMs: 90_000,
    // Absurd reservation: it must be clamped, not turn the call into 1 ms.
    reserveForOthersMs: 500_000,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timeoutMs, MIN_USEFUL_ATTEMPT_MS);
  assert.equal(plan.reservedMs, 100_000 - MIN_USEFUL_ATTEMPT_MS);
  assert.ok(plan.callDeadlineAt <= START + 100_000);
});

test("no call is started below the minimum useful attempt", () => {
  const plan = planProviderCall({
    deadlineAt: START + 100_000,
    now: START + 100_000 - (MIN_USEFUL_ATTEMPT_MS - 1),
    configuredTimeoutMs: 90_000,
  });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.equal(plan.reason, "deadline");
  assert.equal(plan.minAttemptMs, MIN_USEFUL_ATTEMPT_MS);
});

test("two long attempts cannot starve the next one into an unusable timeout", () => {
  const deadlineAt = workDeadlineAt(runBudgetFor(START, 240_000));

  const first = planProviderCall({
    deadlineAt,
    now: START,
    configuredTimeoutMs: 90_000,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.timeoutMs, 90_000);
  assert.ok(first.timeoutMs >= MIN_USEFUL_ATTEMPT_MS);

  const afterFirst = planProviderCall({
    deadlineAt,
    now: START + first.timeoutMs,
    configuredTimeoutMs: 90_000,
  });
  assert.equal(afterFirst.ok, true);
  if (!afterFirst.ok) return;
  assert.equal(afterFirst.timeoutMs, 90_000);

  const afterSecond = planProviderCall({
    deadlineAt,
    now: START + first.timeoutMs + afterFirst.timeoutMs,
    configuredTimeoutMs: 90_000,
  });
  assert.equal(afterSecond.ok, true);
  if (!afterSecond.ok) return;
  assert.ok(afterSecond.timeoutMs >= MIN_USEFUL_ATTEMPT_MS);
  assert.ok(afterSecond.timeoutMs <= deadlineAt - (START + first.timeoutMs + afterFirst.timeoutMs));

  // Only once the usable window is gone does the policy refuse the call.
  const refused = planProviderCall({
    deadlineAt,
    now: deadlineAt - (MIN_USEFUL_ATTEMPT_MS - 1),
    configuredTimeoutMs: 90_000,
  });
  assert.equal(refused.ok, false);
});

test("a queue of pending batches reserves a minimum window for each", () => {
  const plan = planProviderCall({
    deadlineAt: START + 220_000,
    now: START,
    configuredTimeoutMs: 90_000,
    // Three batches still queued behind this one.
    reserveForOthersMs: 3 * MIN_USEFUL_ATTEMPT_MS,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.reservedMs, 3 * MIN_USEFUL_ATTEMPT_MS);
  assert.equal(plan.timeoutMs, 90_000);
});

test("the configured ceiling still wins when there is plenty of time", () => {
  const plan = planProviderCall({
    deadlineAt: START + 220_000,
    now: START,
    configuredTimeoutMs: 45_000,
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.timeoutMs, 45_000);
});

test("retryFitsBefore refuses a backoff that would leave no useful attempt", () => {
  assert.equal(
    retryFitsBefore({ deadlineAt: START + 30_000, now: START, delayMs: 10_000 }),
    true,
  );
  assert.equal(
    retryFitsBefore({ deadlineAt: START + 25_000, now: START, delayMs: 10_000 }),
    false,
  );
  assert.equal(
    retryFitsBefore({
      deadlineAt: START + 20_000,
      now: START,
      delayMs: 0,
      minAttemptMs: MIN_USEFUL_ATTEMPT_MS,
    }),
    false,
  );
});

test("backoff cannot sleep past the deadline", async () => {
  let clock = START;
  const sleeps: number[] = [];
  let attempts = 0;

  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      return { kind: "failed" as const };
    },
    () => ({ retryable: true }),
    {
      policy: {
        maxAttempts: 5,
        baseDelayMs: 10_000,
        maxDelayMs: 10_000,
        minRemainingMs: MIN_USEFUL_ATTEMPT_MS,
        maxRetryAfterMs: 60_000,
      },
      deadlineAt: START + 25_000,
      now: () => clock,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  );

  assert.deepEqual(result, { kind: "failed" });
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("a permanent decision is never retried even with time left", async () => {
  let attempts = 0;
  await retryWithBackoff(
    async () => {
      attempts += 1;
      return { kind: "permanent" as const };
    },
    () => ({ retryable: false }),
    {
      policy: { maxAttempts: 5 },
      deadlineAt: START + 200_000,
      now: () => START,
      sleep: async () => {},
    },
  );
  assert.equal(attempts, 1);
});
