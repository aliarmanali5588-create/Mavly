/**
 * ═══ WHICH API PATHS MAY A SIGNED-OUT CALLER REACH? (F-1) ═══════════════════
 *
 * Pure module — no Next, no env, no fetch — so `tests/api-access.test.ts` can
 * exercise every branch of the gate's policy without a server, and
 * `src/proxy.ts` stays a thin wrapper around one decision.
 *
 * ⚠️ THE GATE ANSWERS "IS ANYBODY HOME?", NOT "MAY THEY TOUCH THIS PROJECT?".
 * Session (here) and ownership (`enforceProjectScope` in
 * `src/app/api/vcaas/_shared.ts`) are two independent layers; closing F-1 never
 * implies F-2. A request must pass this classification *and* the per-route
 * guards that later phases wire in.
 *
 * ⚠️ 401, NEVER A REDIRECT. A browser navigation can be sent to `/login`; a
 * `fetch()` cannot read a 303 to an HTML page as an error — it follows the
 * redirect and comes back holding markup. So the proxy answers API requests
 * with a JSON 401 the client layer can actually switch on.
 */

/**
 * The approved public exceptions — paths under `/api/` that stay reachable
 * without a session. Matched EXACTLY (no prefix semantics): `/api/configx` or
 * `/api/config/anything` are not on the list, so they are protected like every
 * other API path.
 *
 * `/api/config` answers one boolean with no key, env value, or other secret in
 * the payload (`src/app/api/config/route.ts`). The dashboard no longer calls it,
 * but the public compatibility contract is retained.
 *
 * `/api/generation/worker` has no user session by design: it is the durable
 * generation worker's internal invocation endpoint. Exempting it here does not
 * make it public — the route performs its own constant-time bearer-secret check
 * and answers 404 when disabled (`src/app/api/generation/worker/route.ts`).
 * Both exceptions are exact-path matches; a near-miss under either is gated.
 */
export const PUBLIC_API_PATHS: readonly string[] = [
  "/api/config",
  "/api/generation/worker",
];

/** True for the exact paths in `PUBLIC_API_PATHS`. */
export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.includes(pathname);
}

/**
 * The whole gate decision, as one pure function:
 *
 *   · not an `/api/` path → "allow" (the page gate in the proxy owns those)
 *   · an approved public API path → "allow"
 *   · any other `/api/` path → "unauthenticated" without a verified session
 *
 * `hasSession` must be `true` only for a session the Auth server verified
 * (`getUser()`), never for a cookie that merely exists — see the proxy.
 */
export function apiSessionDecision(
  pathname: string,
  hasSession: boolean,
): "allow" | "unauthenticated" {
  if (!pathname.startsWith("/api/")) return "allow";
  if (isPublicApiPath(pathname)) return "allow";
  return hasSession ? "allow" : "unauthenticated";
}
