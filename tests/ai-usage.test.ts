import { test } from "node:test";
import assert from "node:assert/strict";

import { addUsage, EMPTY_USAGE, seededUsage } from "../src/lib/ai/usage";
import { reportedCostOf } from "../src/lib/observability/cost";

test("inline continuation extends persisted usage and cost exactly once", () => {
  const initial = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    reasoningTokens: 2,
    costUsd: 0.03,
    attempts: 1,
    retries: 0,
  };
  const continuation = {
    promptTokens: 7,
    completionTokens: 4,
    totalTokens: 11,
    reasoningTokens: 1,
    costUsd: 0.05,
    attempts: 1,
    retries: 1,
  };
  const afterInitial = addUsage(EMPTY_USAGE, initial);
  const resumed = seededUsage({
    promptTokens: afterInitial.promptTokens,
    completionTokens: afterInitial.completionTokens,
    totalTokens: afterInitial.totalTokens,
    reasoningTokens: afterInitial.reasoningTokens,
    attemptCount: afterInitial.attempts,
  });
  const afterContinuation = addUsage(resumed, continuation);

  assert.deepEqual(
    {
      promptTokens: afterContinuation.promptTokens,
      completionTokens: afterContinuation.completionTokens,
      totalTokens: afterContinuation.totalTokens,
      reasoningTokens: afterContinuation.reasoningTokens,
      attempts: afterContinuation.attempts,
    },
    {
      promptTokens: 17,
      completionTokens: 9,
      totalTokens: 26,
      reasoningTokens: 3,
      attempts: 2,
    },
  );
  assert.equal(
    reportedCostOf([{ costUsd: 0.03 }, { costUsd: 0.05 }]).costUsd,
    0.08,
  );

  const persistedAgain = seededUsage({
    promptTokens: afterContinuation.promptTokens,
    completionTokens: afterContinuation.completionTokens,
    totalTokens: afterContinuation.totalTokens,
    reasoningTokens: afterContinuation.reasoningTokens,
    attemptCount: afterContinuation.attempts,
  });
  assert.equal(addUsage(persistedAgain, EMPTY_USAGE).attempts, 2);
  assert.equal(addUsage(persistedAgain, EMPTY_USAGE).totalTokens, 26);
});

test("a failed continuation still contributes its actual usage without inventing cost", () => {
  const prior = seededUsage({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    reasoningTokens: 2,
    attemptCount: 1,
  });
  const failedContinuation = {
    promptTokens: 7,
    completionTokens: 0,
    totalTokens: 7,
    reasoningTokens: 0,
    costUsd: 0,
    attempts: 1,
    retries: 0,
  };
  const cumulative = addUsage(prior, failedContinuation);

  assert.equal(cumulative.promptTokens, 17);
  assert.equal(cumulative.totalTokens, 22);
  assert.equal(cumulative.attempts, 2);
  assert.deepEqual(
    reportedCostOf([{ costUsd: 0.03 }, { costUsd: null }]),
    { costUsd: null, known: false },
  );
});
