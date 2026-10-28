/**
 * ═══ CUMULATIVE PROVIDER USAGE FOR ONE RUN ══════════════════════════════════
 *
 * `project_runs` keeps provider usage CUMULATIVE for the run. Migration 16 says
 * so explicitly: a manual resume resets the job-attempt budget, never the
 * provider counters. An invocation, however, only knows what IT spent — the
 * inline path can re-enter the pipeline once, and a user resume is a brand new
 * invocation with a new claim.
 *
 * ⚠️ THE ROW IS THE SOURCE OF TRUTH AT CLAIM TIME. Every invocation seeds from
 * the counters already persisted and adds its own attempts, so a continuation
 * and a resume extend the run instead of replacing it. The seed is read ONCE
 * per invocation: adding it again would double-count the same calls.
 *
 * ⚠️ NOTHING IS ESTIMATED. A token field the provider did not report stays 0,
 * and an attempt with a null `costUsd` still makes `reportedCostOf` report the
 * run's cost as unknown. This module only adds and validates.
 *
 * Pure: no Supabase, no provider, no clock.
 */

import type { AgentProviderAttempt, AgentUsageTotals } from "./agent";

export const EMPTY_USAGE: AgentUsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  attempts: 0,
  retries: 0,
};

/** The persisted counters an invocation starts from. */
export interface PersistedUsageCounters {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  /** Provider calls already counted for this run (`project_runs.attempt_count`). */
  attemptCount: number | null;
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Add one invocation's usage to the cumulative total.
 *
 * The cost is rounded to the same precision as `reportedCostOf`, so repeated
 * additions cannot drift into a value that a false `costKnown` would hide.
 */
export function addUsage(
  base: AgentUsageTotals,
  next: AgentUsageTotals,
): AgentUsageTotals {
  return {
    promptTokens: base.promptTokens + next.promptTokens,
    completionTokens: base.completionTokens + next.completionTokens,
    totalTokens: base.totalTokens + next.totalTokens,
    reasoningTokens: base.reasoningTokens + next.reasoningTokens,
    costUsd: Math.round((base.costUsd + next.costUsd) * 1_000_000) / 1_000_000,
    attempts: base.attempts + next.attempts,
    retries: base.retries + next.retries,
  };
}

/**
 * Seed an invocation from the run row it just claimed.
 *
 * ⚠️ `attemptCount` IS THE PROVIDER-CALL COUNTER, not the job-attempt counter
 * (migration 16: "Durable job attempts (claims), separate from attempt_count,
 * which counts provider calls"). `costUsd` is deliberately 0 here: the cost is
 * derived from the attempt records, so an earlier attempt with an unreported
 * cost can never be fabricated into a known total.
 */
export function seededUsage(counters: PersistedUsageCounters): AgentUsageTotals {
  return {
    promptTokens: nonNegative(counters.promptTokens),
    completionTokens: nonNegative(counters.completionTokens),
    totalTokens: nonNegative(counters.totalTokens),
    reasoningTokens: nonNegative(counters.reasoningTokens),
    costUsd: 0,
    attempts: nonNegative(counters.attemptCount),
    retries: 0,
  };
}

function isProviderAttempt(value: unknown): value is AgentProviderAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.phase === "manifest" || record.phase === "batch" || record.phase === "repair") &&
    typeof record.attempt === "number" &&
    Number.isFinite(record.attempt) &&
    typeof record.at === "string" &&
    (record.providerAttemptId === undefined ||
      record.providerAttemptId === null ||
      typeof record.providerAttemptId === "string")
  );
}

/**
 * The attempt records already persisted on the run row.
 *
 * `provider_attempts` is a JSON column the owner can technically write, so it is
 * re-validated rather than trusted. An entry that does not carry the fields this
 * code reads is dropped instead of crashing the accounting or poisoning the
 * persisted provider request id.
 */
export function persistedAttempts(value: unknown): AgentProviderAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isProviderAttempt).map((attempt) => ({
    ...attempt,
    providerAttemptId:
      typeof attempt.providerAttemptId === "string" ? attempt.providerAttemptId : null,
  }));
}
