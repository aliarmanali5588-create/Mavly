/**
 * Phase 6's per-instance window helper, retained as a pure utility/test seam.
 *
 * ⚠️ THE GATEWAY NO LONGER USES THIS FOR ITS PRODUCTION LIMIT. Phase 7 adds
 * `public.consume_integration_rate_limit()` (migration 23), a durable shared
 * counter keyed by integration and operation. Counters in module memory are not
 * a global production limit: N instances multiply the ceiling and a cold start
 * forgets it. The gateway fails closed if that RPC is missing.
 *
 * The fixed production limits are declared here so documentation/tests and the
 * SQL cannot silently disagree.
 */

export const PAYMENT_ORDER_LIMIT_PER_WINDOW = 30;
export const PAYMENT_VERIFY_LIMIT_PER_WINDOW = 60;
export const PAYMENT_RATE_WINDOW_SECONDS = 60;

export interface WindowLimiterOptions {
  perKeyLimit: number;
  perKeyWindowMs: number;
  globalLimit: number;
  globalWindowMs: number;
  maxKeys?: number;
}

export type LimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

export interface WindowLimiter {
  consume(key: string, now?: number): LimitDecision;
}

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

export function createWindowLimiter(options: WindowLimiterOptions): WindowLimiter {
  const { perKeyLimit, perKeyWindowMs, globalLimit, globalWindowMs } = options;
  const maxKeys = options.maxKeys ?? 5_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let global = { count: 0, resetAt: 0 };

  return {
    consume(key, now = Date.now()) {
      const trimmed = key.trim();
      if (!trimmed) return { ok: false, retryAfterSeconds: 60 };

      if (global.resetAt <= now) global = { count: 0, resetAt: now + globalWindowMs };
      if (global.count >= globalLimit) {
        return { ok: false, retryAfterSeconds: secondsUntil(global.resetAt, now) };
      }

      let window = windows.get(trimmed);
      if (!window || window.resetAt <= now) {
        for (const [entry, value] of windows) {
          if (value.resetAt <= now) windows.delete(entry);
        }
        if (!window && windows.size >= maxKeys) {
          return { ok: false, retryAfterSeconds: secondsUntil(global.resetAt, now) };
        }
        window = { count: 0, resetAt: now + perKeyWindowMs };
        windows.set(trimmed, window);
      }

      if (window.count >= perKeyLimit) {
        return { ok: false, retryAfterSeconds: secondsUntil(window.resetAt, now) };
      }

      window.count += 1;
      global.count += 1;
      return { ok: true, remaining: Math.max(0, perKeyLimit - window.count) };
    },
  };
}

/** Order creation is the costly, non-idempotent call. */
export const paymentOrderLimiter = createWindowLimiter({
  perKeyLimit: 30,
  perKeyWindowMs: 60_000,
  globalLimit: 300,
  globalWindowMs: 60_000,
});

/** Verification and status reads are cheap but still bounded. */
export const paymentVerifyLimiter = createWindowLimiter({
  perKeyLimit: 60,
  perKeyWindowMs: 60_000,
  globalLimit: 600,
  globalWindowMs: 60_000,
});
