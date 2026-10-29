import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GENERATION_FINALIZE_RESERVE_MS,
  MAX_PROVIDER_IDLE_TIMEOUT_MS,
  MIN_USEFUL_ATTEMPT_MS,
  MIN_PROVIDER_IDLE_TIMEOUT_MS,
  WORKER_FUNCTION_LIMIT_MS,
  idleTimeoutFor,
  minUsefulAttemptFor,
  planProviderCall,
  remainingRunMs,
  remainingWorkMs,
  retryFitsBefore,
  runBudgetFor,
  runDeadlineAt,
  workDeadlineAt,
  workerGenerationBudgetMs,
} from "../src/lib/ai/budget";
import {
  BATCH_OUTPUT_TOKENS,
  MANIFEST_OUTPUT_TOKENS,
  PREVIEW_OUTPUT_TOKENS,
  providerAttemptCeiling,
  providerCallPolicyFor,
} from "../src/lib/ai/agent";
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

// ── Streaming call policy ──────────────────────────────────────────────────

test("the idle window stays well below the absolute cap and is bounded", () => {
  assert.equal(idleTimeoutFor(150_000), MAX_PROVIDER_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutFor(30_000), MIN_PROVIDER_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutFor(60_000), 20_000);
  // A productive stream is bounded by the absolute cap, never by its duration;
  // a stalled one is stopped by the far shorter idle window.
  assert.ok(idleTimeoutFor(180_000) < 180_000);
  assert.ok(idleTimeoutFor(1_000) >= MIN_PROVIDER_IDLE_TIMEOUT_MS - 1);
});

test("the minimum useful attempt scales with the call class, not a fixed 20 s", () => {
  // A 150 s batch needs more than a 20 s window to produce anything, so an
  // attempt planned at 20 s would be a guaranteed charge with no result.
  assert.ok(minUsefulAttemptFor(150_000) > MIN_USEFUL_ATTEMPT_MS);
  assert.equal(minUsefulAttemptFor(150_000), 60_000);
  assert.equal(minUsefulAttemptFor(4_000), 12_000);
  for (const timeout of [1_000, 20_000, 90_000, 150_000, 600_000]) {
    const min = minUsefulAttemptFor(timeout);
    assert.ok(min <= Math.max(20_000, timeout), `floor ${min} exceeds ${timeout}`);
  }
});

test("each call class keeps its own output ceiling and timeout", () => {
  const manifest = providerCallPolicyFor("manifest", { modelMaxTokens: 24_000 });
  assert.equal(manifest.maxTokens, MANIFEST_OUTPUT_TOKENS);
  assert.equal(manifest.retryTimeoutAsIs, true);

  const batch = providerCallPolicyFor("batch", { modelMaxTokens: 24_000 });
  assert.equal(batch.maxTokens, BATCH_OUTPUT_TOKENS);
  // A timeout on a large batch is answered by reducing scope, not by repeating it.
  assert.equal(batch.retryTimeoutAsIs, false);
  assert.equal(batch.maxAttempts, 2);

  const preview = providerCallPolicyFor("batch", {
    previewBatch: true,
    modelMaxTokens: 24_000,
  });
  assert.equal(preview.maxTokens, PREVIEW_OUTPUT_TOKENS);
  assert.ok(preview.timeoutMs >= batch.timeoutMs);

  // A repair keeps the preview ceiling only for a preview batch.
  const previewRepair = providerCallPolicyFor("repair", {
    previewBatch: true,
    modelMaxTokens: 24_000,
  });
  const smallRepair = providerCallPolicyFor("repair", { modelMaxTokens: 24_000 });
  assert.equal(previewRepair.maxTokens, PREVIEW_OUTPUT_TOKENS);
  assert.equal(smallRepair.maxTokens, BATCH_OUTPUT_TOKENS);

  // The model's own cap always wins over a larger class ceiling.
  const tiny = providerCallPolicyFor("batch", { modelMaxTokens: 500 });
  assert.equal(tiny.maxTokens, 500);
});

test("the provider-attempt ceiling is bounded and configurable", () => {
  assert.equal(providerAttemptCeiling({} as NodeJS.ProcessEnv), 12);
  assert.equal(
    providerAttemptCeiling({ MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN: "6" } as unknown as NodeJS.ProcessEnv),
    6,
  );
  // A typo can neither disable the guard nor make it useless.
  assert.equal(
    providerAttemptCeiling({ MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN: "0" } as unknown as NodeJS.ProcessEnv),
    4,
  );
  assert.equal(
    providerAttemptCeiling({ MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN: "1000" } as unknown as NodeJS.ProcessEnv),
    40,
  );
  assert.equal(
    providerAttemptCeiling({ MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN: "nonsense" } as unknown as NodeJS.ProcessEnv),
    12,
  );
});

test("a worker tick budget fits inside the serverless function limit", () => {
  const reserve = 50_000;
  const budget = workerGenerationBudgetMs(reserve);
  assert.ok(budget > 0);
  assert.ok(
    budget + reserve + 20_000 + 10_000 <= WORKER_FUNCTION_LIMIT_MS,
    "generation + reviews + finalization must fit the function limit",
  );
  // The lease is a backstop and is allowed to be longer; the WORK budget is not.
  assert.ok(budget < WORKER_FUNCTION_LIMIT_MS);
  assert.ok(workerGenerationBudgetMs(0) <= WORKER_FUNCTION_LIMIT_MS);
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
