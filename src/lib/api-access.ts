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
 * without a session. Exact paths have no prefix semantics (`/api/configx` and
 * `/api/config/anything` stay protected). Phase 6 adds two deliberate prefixes,
 * listed separately below; each route under them authenticates itself.
 *
 * `/api/config` answers one boolean with no key, env value, or other secret in
 * the payload (`src/app/api/config/route.ts`). The public announcement route
 * exposes only the currently enabled plain-text banner message and is safe for
 * signed-out visitors (`src/app/api/public/announcement/route.ts`).
 *
 * The generation worker is invoked directly by its Cloudflare Cron handler and
 * does not have a public application route.
 */
export const PUBLIC_API_PATHS: readonly string[] = [
  "/api/config",
  "/api/public/announcement",
  "/api/billing/catalog",
];

/**
 * Phase 6 public prefixes. Both are server-to-server only and authenticate
 * themselves OUTSIDE a Supabase session:
 *
 *   · `/api/app/v1/` — the generated application's own server-facing API:
 *     `payments/*` requires a hashed project API key with the `integrations:*`
 *     scope, and `apps/{projectId}/data|auth/*` resolves one READY managed
 *     backend through the server-only RPC proof and authorizes user rows by
 *     the END USER's own app session token (never a Mavly session);
 *   · `/api/integrations/webhooks/` — provider webhooks, which resolve an
 *     unguessable per-integration token and verify the provider signature over
 *     the exact raw body before parsing anything.
 *
 * ⚠️ A PREFIX IS A WIDER GRANT THAN AN EXACT PATH. Every route added under
 * either prefix must perform its own authentication before doing any work; the
 * proxy cannot. The trailing slash is part of the match (`/api/app/v1x` is not
 * exempt), and the prefix tests below pin that boundary.
 */
export const PUBLIC_API_PREFIXES: readonly string[] = [
  "/api/app/v1/",
  "/api/integrations/webhooks/",
  "/api/billing/webhooks/",
];

/** True for an exact public path or a documented public prefix. */
export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.includes(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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
