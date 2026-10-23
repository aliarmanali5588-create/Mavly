"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  buildCallbackUrl,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  type OAuthProvider,
} from "./oauth-url";
import { DEFAULT_REDIRECT, safeRedirectPath } from "./redirect";

/**
 * ═══ STARTING THE REAL OAUTH FLOW ═══════════════════════════════════════════
 *
 * ⚠️ THE PREVIOUS BEHAVIOUR WAS A SIMULATION: the button showed a toast, waited
 * 700 ms and navigated. No identity was created, no cookie was set, and the
 * next page load had forgotten everything. This is the actual provider flow —
 * the browser is handed to Supabase, which hands it to Google or GitHub, and
 * the provider comes back to `/auth/callback` with a code the server exchanges
 * for a session.
 *
 * ⚠️ THE RETURN DESTINATION RIDES ALONG IN A COOKIE and is validated first
 * (`safeRedirectPath`), so it can only ever be a path on this site. The provider
 * never sees it and cannot change it.
 *
 * ⚠️ NO CUSTOM `state` IS SENT TO THE PROVIDER. Supabase's PKCE flow owns the
 * `state` parameter: it generates one, checks it on the way back and may
 * forward it to the callback URL. Adding a second `state` of our own would
 * either be overwritten by Supabase or make the provider echo a value the
 * Auth server does not recognise — and the sign-in would fail for everybody.
 * The CSRF guarantee comes from the PKCE code verifier (a cookie only this
 * browser has) plus the short-lived state cookie written below.
 */

export type { OAuthProvider };

/** Why a sign-in could not be started. The UI maps these to copy. */
export type OAuthStartError = "not_configured" | "oauth_failed";

/**
 * ⚠️ THE `never` OPTIONAL IS LOAD-BEARING IN THIS CODEBASE. `tsconfig.json` has
 * `strict: false`, so TypeScript does not narrow a union by a boolean
 * discriminant — `if (!result.ok) { result.error }` would not compile.
 * Declaring the other branch's property as `?: never` keeps `error` readable
 * on the union without a type guard.
 */
export type OAuthStartResult = { ok: true; error?: never } | { ok: false; error: OAuthStartError };

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function writeCookie(name: string, value: string, maxAge: number): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

/** Removes the one-time cookies of a finished (or abandoned) flow. */
export function clearOAuthCookies(): void {
  writeCookie(OAUTH_STATE_COOKIE, "", 0);
  writeCookie(OAUTH_NEXT_COOKIE, "", 0);
}

/**
 * Hand the browser to the identity provider.
 *
 * On success the browser leaves the page (Supabase performs the redirect), so
 * the caller only has to handle the failure case.
 *
 * @param provider google | github
 * @param target   where to come back to; validated, defaults to the builder
 */
export async function startOAuth(
  provider: OAuthProvider,
  target: string = DEFAULT_REDIRECT,
): Promise<OAuthStartResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    return { ok: false, error: "not_configured" };
  }

  const destination = safeRedirectPath(target, DEFAULT_REDIRECT);

  try {
    // The marker and the destination are kept for ten minutes: long enough for
    // a login, short enough that a stale cookie cannot be reused later.
    writeCookie(OAUTH_STATE_COOKIE, randomState(), OAUTH_COOKIE_MAX_AGE);
    writeCookie(OAUTH_NEXT_COOKIE, destination, OAUTH_COOKIE_MAX_AGE);

    const redirectTo = buildCallbackUrl(window.location.origin);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });

    if (error) {
      clearOAuthCookies();
      return { ok: false, error: "oauth_failed" };
    }

    return { ok: true };
  } catch {
    clearOAuthCookies();
    return { ok: false, error: "oauth_failed" };
  }
}
