/**
 * ═══ ACCOUNT RESTRICTION — THE ENFORCEMENT DECISION ═════════════════════════
 *
 * Pure module: no Next, no fetch, no env. `src/proxy.ts` supplies the two facts
 * and gets one answer, so the policy can be reasoned about (and tested) without
 * a running server.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * Supabase bans an account by setting `auth.users.banned_until`, which stops
 * FUTURE sign-ins. It does NOT invalidate an access token that was already
 * issued: that JWT stays cryptographically valid until it expires. So a user
 * who is blocked while signed in would keep reaching protected pages and APIs
 * for the rest of the token's lifetime.
 *
 * The fix is a server-side check on every protected request that asks the
 * database whether the CALLER is currently restricted. That is
 * `public.current_user_is_restricted()` (migration 45), which reads the same
 * `banned_until` the Auth server enforces — one source of truth, no cached
 * client flag to bypass.
 */

/** Where a restricted user is sent. Not a protected route, not the dashboard. */
export const RESTRICTED_PATH = "/account-restricted";
export const RESTRICTION_STATUS_API_PATH = "/api/account/restriction";

/**
 * Paths a restricted user may still reach.
 *
 * They must be able to SEE why they are blocked, sign out, and contact support —
 * otherwise the restriction is a dead end with no recovery path. Everything
 * else is refused.
 */
const RESTRICTED_ALLOWED_PATHS: readonly string[] = [
  RESTRICTED_PATH,
  "/support",
  "/login",
  "/auth/signout",
];

/** Exact API paths a restricted user may still call, so the screen can work. */
const RESTRICTED_ALLOWED_API_PATHS: readonly string[] = [
  "/auth/signout",
  RESTRICTION_STATUS_API_PATH,
];

function isAllowedWhileRestricted(pathname: string): boolean {
  if (RESTRICTED_ALLOWED_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/support/")) return true;
  if (pathname.startsWith("/auth/")) return true;
  return RESTRICTED_ALLOWED_API_PATHS.includes(pathname);
}

export type RestrictionDecision =
  /** Not restricted, or nothing to enforce. Continue normally. */
  | "allow"
  /** A restricted user asking for an API route: answer JSON 403. */
  | "deny_api"
  /** A restricted user asking for a page: send them to the restriction screen. */
  | "redirect_page"
  /** The status check failed for an API request: fail closed with 503. */
  | "unavailable_api"
  /** The status check failed for a page: fail closed with a readable 503. */
  | "unavailable_page";

/**
 * The whole enforcement decision.
 *
 * `isRestricted` must come from the database for THIS caller, never from a
 * cookie, header or client flag.
 */
export function restrictionDecision(
  pathname: string,
  isRestricted: boolean
): RestrictionDecision {
  if (!isRestricted) return "allow";
  if (isAllowedWhileRestricted(pathname)) return "allow";
  if (pathname.startsWith("/api/")) return "deny_api";
  return "redirect_page";
}

/**
 * Keep the suspension explanation, sign-out, login and support reachable if
 * the status database is unavailable. Protected routes fail closed rather than
 * assuming the account is unrestricted.
 */
export function restrictionUnavailableDecision(pathname: string): RestrictionDecision {
  if (isAllowedWhileRestricted(pathname)) return "allow";
  return pathname.startsWith("/api/") ? "unavailable_api" : "unavailable_page";
}
