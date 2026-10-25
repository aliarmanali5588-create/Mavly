/**
 * ═══ IMAGE-GENERATION ADMISSION — BEST-EFFORT, PER INSTANCE ═════════════════
 *
 * Image generation is an unbilled call to a paid provider. Without a ceiling,
 * any signed-in project owner could spend the operator's OpenRouter balance
 * without limit, so this module enforces a per-user window and a global window
 * before the provider request.
 *
 * ⚠️ THIS IS NOT A HARD GLOBAL CAP. Like the Figma validation allowance
 * (`src/lib/integrations/figma/service.ts`), the counters live in module memory:
 * every serverless instance keeps its own, a cold start forgets them, and N
 * instances multiply the effective ceiling by N. It stops a single client loop
 * and ordinary overuse; it does not stop a distributed abuser.
 *
 * ⚠️ A HARD CAP NEEDS PERSISTENCE, AND THAT NEEDS APPROVAL. The durable design
 * is a small table plus a SECURITY DEFINER admission RPC serialized by a
 * Postgres advisory lock — the same shape as `create_generation_job` in
 * `supabase/migrations/10_generation_jobs.sql` — counting requests per user and
 * globally in a time window before the route may call OpenRouter. That is a
 * migration and a security review, so it is deliberately NOT part of this
 * change. Until it exists, treat these numbers as a guardrail, not a budget.
 *
 * The window is fixed (not sliding): it is one small object per user, and the
 * ceiling is the same at the start and the end of the window.
 */

export const IMAGE_GENERATION_USER_LIMIT = 5;
export const IMAGE_GENERATION_USER_WINDOW_MS = 10 * 60_000;

/**
 * Per-instance. With several instances the real ceiling is this times the
 * instance count; keep it low enough that a mistake is cheap.
 */
export const IMAGE_GENERATION_GLOBAL_LIMIT = 40;
export const IMAGE_GENERATION_GLOBAL_WINDOW_MS = 10 * 60_000;

/** Bound on the per-user map, so a flood of ids cannot grow it without limit. */
const MAX_TRACKED_USERS = 5_000;

export interface ImageGenerationLimitOptions {
  userLimit?: number;
  userWindowMs?: number;
  globalLimit?: number;
  globalWindowMs?: number;
  maxTrackedUsers?: number;
}

export type ImageGenerationLimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; scope: "user" | "global"; retryAfterSeconds: number };

export interface ImageGenerationLimiter {
  /** `now` is injectable for deterministic tests; callers omit it. */
  consume(userId: string, now?: number): ImageGenerationLimitDecision;
}

export function createImageGenerationLimiter(
  options: ImageGenerationLimitOptions = {},
): ImageGenerationLimiter {
  const userLimit = positive(options.userLimit, IMAGE_GENERATION_USER_LIMIT);
  const userWindowMs = positive(options.userWindowMs, IMAGE_GENERATION_USER_WINDOW_MS);
  const globalLimit = positive(options.globalLimit, IMAGE_GENERATION_GLOBAL_LIMIT);
  const globalWindowMs = positive(options.globalWindowMs, IMAGE_GENERATION_GLOBAL_WINDOW_MS);
  const maxTrackedUsers = positive(options.maxTrackedUsers, MAX_TRACKED_USERS);

  const windows = new Map<string, { count: number; resetAt: number }>();
  let global = { count: 0, resetAt: 0 };

  function prune(now: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }

  return {
    consume(userId, now = Date.now()) {
      /**
       * A blank id cannot be rate-limited per user; refusing it is better than
       * putting every such caller into one shared bucket. The route always
       * passes a verified session id, so this is defensive only.
       */
      const key = userId.trim();
      if (!key) return { ok: false, scope: "user", retryAfterSeconds: 60 };

      if (global.resetAt <= now) global = { count: 0, resetAt: now + globalWindowMs };
      if (global.count >= globalLimit) {
        return { ok: false, scope: "global", retryAfterSeconds: secondsUntil(global.resetAt, now) };
      }

      let window = windows.get(key);
      if (!window || window.resetAt <= now) {
        if (!window && windows.size >= maxTrackedUsers) {
          prune(now);
          if (windows.size >= maxTrackedUsers) {
            // Capacity is spent on active users; a new one waits for the window.
            return {
              ok: false,
              scope: "global",
              retryAfterSeconds: secondsUntil(global.resetAt, now),
            };
          }
        }
        window = { count: 0, resetAt: now + userWindowMs };
        windows.set(key, window);
      }

      if (window.count >= userLimit) {
        return { ok: false, scope: "user", retryAfterSeconds: secondsUntil(window.resetAt, now) };
      }

      window.count += 1;
      global.count += 1;
      return { ok: true, remaining: Math.max(0, userLimit - window.count) };
    },
  };
}

/** The process-wide limiter the image route consults. */
export const imageGenerationLimiter = createImageGenerationLimiter();

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}
