/**
 * ═══ SERVICE-ROLE FETCH HEADER RULES ════════════════════════════════════════
 *
 * Pure, dependency-free helpers behind `createAuthCompatibleFetch` in
 * `worker.ts`. They live here so the header behaviour can be tested directly,
 * without importing a module that pulls in the Supabase client and the Next.js
 * server environment.
 *
 * ⚠️ NOTHING HERE READS THE ENVIRONMENT OR TOUCHES THE NETWORK. Every function
 * takes its inputs and returns a value.
 */

/**
 * Determines whether a key is in the legacy JWT format (3 dot-separated parts).
 * Legacy keys: `eyJ...` (3-part JWT)
 * New opaque keys: `sb_secret_...` / `sb_publishable_...` (no dots, or not 3 parts)
 */
export function isLegacyJwtKey(key: string): boolean {
  return key.trim().split(".").length === 3;
}

/**
 * Build the outgoing header set for one request.
 *
 * ⚠️ A `Request` INPUT CARRIES ITS OWN HEADERS. Building the header set from
 * `init?.headers` alone silently DROPS them: `new Headers(undefined)` is empty,
 * and passing that as `init.headers` overrides the Request's own headers, so
 * the outgoing call loses `apikey` entirely and the API answers
 * "No API key found in request". The Request's headers are therefore merged in
 * first, and `init` — when present — wins on collision.
 *
 * ⚠️ THE BEARER IS STRIPPED ONLY FOR NEW-FORMAT KEYS, AND ONLY WHEN IT IS THAT
 * KEY. GoTrue cannot validate an opaque key as a JWT, so sending it as a Bearer
 * token produces a 401. A caller's own session token is never touched.
 */
export function buildServiceRoleHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  serviceRoleKey: string,
): Headers {
  const key = serviceRoleKey.trim();

  const headers = new Headers(
    typeof input === "string" || input instanceof URL ? undefined : input.headers,
  );
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

  if (!isLegacyJwtKey(key) && headers.get("authorization") === `Bearer ${key}`) {
    headers.delete("authorization");
  }

  return headers;
}
