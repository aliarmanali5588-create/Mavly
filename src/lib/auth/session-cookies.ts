/**
 * ═══ WHAT A SUPABASE AUTH COOKIE LOOKS LIKE ═════════════════════════════════
 *
 * Pure name/shape helpers used by the OAuth callback (did the exchange really
 * persist a session?) and by sign-out (clear every session cookie, even when
 * the Auth server call fails). No Supabase client, no Next.js, no env.
 *
 * `@supabase/ssr` names its cookies after the project reference:
 *
 *   sb-<ref>-auth-token                    the session (or its first chunk)
 *   sb-<ref>-auth-token.0, .1, …           additional chunks of a large session
 *   sb-<ref>-auth-token-code-verifier      PKCE verifier (fixed slot)
 *   sb-<ref>-auth-token-flow-…-code-verifier, -flows-code-verifier
 *   sb-<ref>-auth-token-user               separate user storage (unused here)
 *
 * ⚠️ `sb_secret_…` / `sb_publishable_…` API keys are NOT cookies and must never
 * match; the `-auth-token` segment in the middle is what keeps this narrow.
 */
const SUPABASE_AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+|-.*)?$/;

export function isSupabaseAuthCookieName(name: string): boolean {
  return SUPABASE_AUTH_COOKIE.test(name);
}

export type AuthCookieSnapshot = { name: string; value: string };

/**
 * True when this set of `Set-Cookie` writes actually established a session.
 *
 * A cookie with an empty value is a DELETION (the PKCE verifier is removed as
 * part of a successful exchange, for example), so it does not count. A real
 * session always leaves at least one non-empty chunk — even when the library
 * chunks a large token across `…-auth-token`, `….0`, `….1`.
 */
export function hasEstablishedSessionCookie(
  cookies: ReadonlyArray<AuthCookieSnapshot>,
): boolean {
  return cookies.some(
    ({ name, value }) =>
      value !== "" &&
      isSupabaseAuthCookieName(name) &&
      !name.includes("-code-verifier"),
  );
}
