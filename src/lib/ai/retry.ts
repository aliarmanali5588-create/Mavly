/**
 * ═══ PROVIDER RETRY POLICY — ONE PLACE, BOUNDED ═════════════════════════════
 *
 * The generation pipeline makes several provider calls per run (a manifest and
 * several file batches). A retry loop around each one is only safe when it is
 * bounded in BOTH attempts and wall-clock time: the route has a maximum
 * duration, and a second full-size request after a timeout is how one slow run
 * becomes two charged runs.
 *
 * Rules this module encodes:
 *
 *   · transient network/timeout/429/5xx failures may be retried;
 *   · authentication, invalid-request and content-filter failures may not;
 *   · `Retry-After` wins over our own backoff when it is a sane number;
 *   · exponential backoff + jitter, a strict attempt cap and a deadline;
 *   · an output-limit failure is NOT retried here — it is handled by shrinking
 *     the generation batch (see `agent.ts`), because repeating the same
 *     oversized request with the same token cap only burns time and credits.
 *
 * This module is pure: time, sleeping and randomness are injectable so tests
 * can be deterministic.
 */

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** First backoff delay. */
  baseDelayMs: number;
  /** Upper bound for one backoff delay. */
  maxDelayMs: number;
  /** Never wait longer than this for a provider's Retry-After. */
  maxRetryAfterMs: number;
  /** Do not start a retry when less than this remains before the deadline. */
  minRemainingMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 800,
  maxDelayMs: 15_000,
  maxRetryAfterMs: 60_000,
  minRemainingMs: 2_000,
};

export interface RetryDecision {
  retryable: boolean;
  retryAfterMs?: number | null;
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  /** Absolute epoch-ms deadline for the whole operation, including delays. */
  deadlineAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called after every attempt, including the last one. */
  onAttempt?: (attempt: number, result: unknown) => void | Promise<void>;
  /** Called before a retry is attempted. */
  onRetry?: (retry: { attempt: number; nextAttempt: number; delayMs: number; retryAfterMs: number | null }) => void;
}

function policyWith(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...(overrides ?? {}) };
}

/**
 * Backoff for a failed attempt (`attempt` is 1-based). The jitter is additive
 * and bounded by half the exponential delay, so the cap still holds.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (safeAttempt - 1),
  );
  const jitter = Math.floor(random() * exponential * 0.5);
  const backoff = Math.min(policy.maxDelayMs, exponential + jitter);

  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return backoff;
  }
  const boundedRetryAfter = Math.min(policy.maxRetryAfterMs, retryAfterMs);
  return Math.max(backoff, boundedRetryAfter);
}

/**
 * Run `operation` until it succeeds, fails permanently, exhausts attempts, or
 * the deadline leaves no room for another attempt. Returns the LAST result;
 * the caller decides whether it is a success or a failure.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  classify: (result: T) => RetryDecision,
  options: RetryOptions = {},
): Promise<T> {
  const policy = policyWith(options.policy);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  let last: T;
  for (let attempt = 1; ; attempt += 1) {
    last = await operation(attempt);
    await options.onAttempt?.(attempt, last);

    const decision = classify(last);
    if (!decision.retryable || attempt >= policy.maxAttempts) return last;

    const retryAfterMs =
      typeof decision.retryAfterMs === "number" && Number.isFinite(decision.retryAfterMs)
        ? decision.retryAfterMs
        : null;
    const delayMs = retryDelayMs(attempt, policy, retryAfterMs, random);

    if (options.deadlineAt !== undefined) {
      const remaining = options.deadlineAt - now();
      if (remaining <= policy.minRemainingMs || delayMs + policy.minRemainingMs > remaining) {
        return last;
      }
    }

    options.onRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      retryAfterMs,
    });
    await sleep(delayMs);
  }
}

/** Parse Retry-After seconds (or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds, 24 * 60 * 60) * 1_000;
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.min(timestamp - now, 24 * 60 * 60_000));
}
