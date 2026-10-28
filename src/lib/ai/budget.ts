/**
 * ═══ ONE RUN, ONE DEADLINE — TIME THE PIPELINE CAN ACTUALLY HONOUR ═══════════
 *
 * The generation pipeline makes one manifest call and then N batch calls. A
 * deadline alone was not enough: a single batch could spend its whole timeout,
 * retry, and leave the next attempt with a ~1 s window, while the time needed to
 * persist the last batch and write the terminal run state was already gone.
 *
 * The rules encoded here:
 *
 *   · a run has ONE absolute deadline;
 *   · a reserve of that deadline belongs to finalization (persist, checkpoint
 *     validation, terminal write, resumable failure) and is never spent on a
 *     provider call;
 *   · every call is planned against the time that is ACTUALLY left;
 *   · a call is never started with less than the minimum useful attempt, because
 *     a 1 s request can only burn credits and produce another timeout;
 *   · time for batches that have not started yet can be reserved, so a retrying
 *     batch cannot starve the rest of the run.
 *
 * This module is pure: the caller passes `now`, which keeps the policy testable
 * with a fake clock.
 */

/** Time held back from provider calls for persistence and terminal writes. */
export const GENERATION_FINALIZE_RESERVE_MS = 20_000;

/**
 * The smallest attempt worth starting. Below this a provider call is very
 * unlikely to return a usable batch, so failing honestly (and resumably) is
 * better than spending the last seconds on a request that cannot finish.
 */
export const MIN_USEFUL_ATTEMPT_MS = 20_000;

/**
 * How much run budget must be left before an inline `after()` run may start its
 * bounded automatic recovery attempt. The recovery re-executes the pipeline, so
 * it needs a real window rather than the finalize reserve.
 */
export const MIN_INLINE_RECOVERY_WINDOW_MS = 90_000;

/** Automatic inline recovery is bounded to one continuation, never a loop. */
export const MAX_INLINE_RECOVERY_ATTEMPTS = 1;

export interface RunBudget {
  startedAtMs: number;
  /** Total wall-clock budget for planning + batches + provider retries. */
  totalMs: number;
  /** Held back for finalization; provider calls may never use it. */
  finalizeReserveMs: number;
}

export function runBudgetFor(
  startedAtMs: number,
  totalMs: number,
  finalizeReserveMs: number = GENERATION_FINALIZE_RESERVE_MS,
): RunBudget {
  return {
    startedAtMs,
    totalMs: Math.max(1_000, Math.floor(totalMs)),
    finalizeReserveMs: Math.max(0, Math.floor(finalizeReserveMs)),
  };
}

export function runDeadlineAt(budget: RunBudget): number {
  return budget.startedAtMs + budget.totalMs;
}

/** The last instant a provider call may run: the deadline minus the reserve. */
export function workDeadlineAt(budget: RunBudget): number {
  return runDeadlineAt(budget) - budget.finalizeReserveMs;
}

export function remainingWorkMs(budget: RunBudget, now: number): number {
  return workDeadlineAt(budget) - now;
}

export interface CallPlanInput {
  /** Absolute work deadline (already excludes the finalization reserve). */
  deadlineAt: number;
  now: number;
  /** The phase's configured per-attempt ceiling. */
  configuredTimeoutMs: number;
  /**
   * Time that must remain for provider work not yet started (for example, the
   * batches still queued behind this one). Never reduces this call below the
   * minimum useful attempt.
   */
  reserveForOthersMs?: number;
  minAttemptMs?: number;
}

export type CallPlan =
  | {
      ok: true;
      /** The timeout this attempt must use. Always >= `minAttemptMs`. */
      timeoutMs: number;
      /** Absolute deadline for this attempt (never after the run's deadline). */
      callDeadlineAt: number;
      remainingMs: number;
      reservedMs: number;
    }
  | { ok: false; reason: "deadline"; remainingMs: number; minAttemptMs: number };

/**
 * Plan ONE provider attempt. `ok: false` means "do not call the provider at
 * all"; the caller must surface a typed, resumable deadline failure instead.
 */
export function planProviderCall(input: CallPlanInput): CallPlan {
  const minAttemptMs = Math.max(1_000, Math.floor(input.minAttemptMs ?? MIN_USEFUL_ATTEMPT_MS));
  const remainingMs = input.deadlineAt - input.now;

  if (!Number.isFinite(remainingMs) || remainingMs < minAttemptMs) {
    return { ok: false, reason: "deadline", remainingMs, minAttemptMs };
  }

  /**
   * ⚠️ THE RESERVE IS CLAMPED SO THIS CALL STILL GETS ITS MINIMUM. Reserving
   * more than the window can repay would otherwise schedule a zero-length
   * attempt, which is exactly the failure this module exists to prevent.
   */
  const requestedReserve = Math.max(0, Math.floor(input.reserveForOthersMs ?? 0));
  const reservedMs = Math.min(requestedReserve, Math.max(0, remainingMs - minAttemptMs));
  const spendableMs = remainingMs - reservedMs;

  const timeoutMs = Math.max(
    minAttemptMs,
    Math.min(Math.floor(input.configuredTimeoutMs), spendableMs),
  );

  return {
    ok: true,
    timeoutMs,
    callDeadlineAt: Math.min(input.deadlineAt, input.now + timeoutMs),
    remainingMs,
    reservedMs,
  };
}

/**
 * Whether a backoff delay can still be waited out AND leave a useful attempt.
 * Mirrors the check inside `retryWithBackoff`, exposed so callers and tests can
 * reason about the same rule.
 */
export function retryFitsBefore(input: {
  deadlineAt: number;
  now: number;
  delayMs: number;
  minAttemptMs?: number;
}): boolean {
  const minAttemptMs = Math.max(1_000, Math.floor(input.minAttemptMs ?? MIN_USEFUL_ATTEMPT_MS));
  const remaining = input.deadlineAt - input.now;
  return remaining > minAttemptMs && input.delayMs + minAttemptMs <= remaining;
}

/** Remaining total budget, used to decide whether an inline recovery may start. */
export function remainingRunMs(budget: RunBudget, now: number): number {
  return runDeadlineAt(budget) - now;
}
