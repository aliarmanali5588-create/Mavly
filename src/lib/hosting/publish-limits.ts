/**
 * ═══ DEPLOYMENT-OPERATION ADMISSION — BEST-EFFORT, PER INSTANCE ═════════════
 *
 * Publishing is the most expensive thing a signed-in user can do: it reads a
 * project, hashes and stores its static output (shared mode) or uploads files
 * to Vercel (legacy mode). Without a ceiling, one client loop can fill the
 * published-version table and hammer the Vercel API.
 *
 * ⚠️ THIS IS NOT A HARD GLOBAL CAP, exactly like `image-limits.ts`. The counters
 * live in module memory: each serverless instance keeps its own, a cold start
 * forgets them, and N instances multiply the effective ceiling by N. It stops a
 * single client loop and ordinary accidental double-clicks; it does not stop a
 * distributed abuser. A durable limit would be a table plus an admission RPC —
 * the shape used by `create_generation_job` — and is deliberately out of scope.
 *
 * The window is fixed, so the ceiling is identical at the start and end of it.
 */

export const DEPLOYMENT_OPERATION_USER_LIMIT = 6;
export const DEPLOYMENT_OPERATION_USER_WINDOW_MS = 5 * 60_000;
export const DEPLOYMENT_OPERATION_GLOBAL_LIMIT = 60;
export const DEPLOYMENT_OPERATION_GLOBAL_WINDOW_MS = 5 * 60_000;

const MAX_TRACKED_USERS = 5_000;

export interface DeploymentOperationLimitOptions {
  userLimit?: number;
  userWindowMs?: number;
  globalLimit?: number;
  globalWindowMs?: number;
  maxTrackedUsers?: number;
}

export type DeploymentOperationDecision =
  | { ok: true; remaining: number }
  | { ok: false; scope: "user" | "global"; retryAfterSeconds: number };

export interface DeploymentOperationLimiter {
  /** `now` is injectable for deterministic tests; callers omit it. */
  consume(userId: string, now?: number): DeploymentOperationDecision;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function createDeploymentOperationLimiter(
  options: DeploymentOperationLimitOptions = {},
): DeploymentOperationLimiter {
  const userLimit = positive(options.userLimit, DEPLOYMENT_OPERATION_USER_LIMIT);
  const userWindowMs = positive(options.userWindowMs, DEPLOYMENT_OPERATION_USER_WINDOW_MS);
  const globalLimit = positive(options.globalLimit, DEPLOYMENT_OPERATION_GLOBAL_LIMIT);
  const globalWindowMs = positive(options.globalWindowMs, DEPLOYMENT_OPERATION_GLOBAL_WINDOW_MS);
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
      if (!userId) {
        return { ok: false, scope: "user", retryAfterSeconds: Math.ceil(userWindowMs / 1000) };
      }

      prune(now);
      if (windows.size >= maxTrackedUsers && !windows.has(userId)) {
        // A flood of distinct ids must not grow the map without bound. Refusing
        // the overflow is safer than evicting a real caller's window.
        return { ok: false, scope: "global", retryAfterSeconds: 60 };
      }

      const existing = windows.get(userId);
      const window = existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + userWindowMs };

      if (window.count >= userLimit) {
        windows.set(userId, window);
        return {
          ok: false,
          scope: "user",
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        };
      }

      if (global.resetAt <= now) global = { count: 0, resetAt: now + globalWindowMs };
      if (global.count >= globalLimit) {
        return {
          ok: false,
          scope: "global",
          retryAfterSeconds: Math.max(1, Math.ceil((global.resetAt - now) / 1000)),
        };
      }

      window.count += 1;
      windows.set(userId, window);
      global.count += 1;

      return { ok: true, remaining: Math.max(0, userLimit - window.count) };
    },
  };
}

/** One process-wide limiter for deploy/unpublish requests. */
export const deploymentOperationLimiter = createDeploymentOperationLimiter();
