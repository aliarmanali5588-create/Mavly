import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  authCookieOptions,
  isSupabaseConfigured,
} from "./config";

/**
 * ═══ SESSION REFRESH FOR THE PROXY ═════════════════════════════════════════
 *
 * ⚠️ THIS RUNS BEFORE EVERY PROTECTED RENDER. It is the only place in the app
 * that can WRITE the session cookies, because the proxy runs before the
 * response is committed.
 *
 * Two jobs, in this order:
 *
 *  1. **REFRESH.** If the access token has expired but the refresh token is
 *     still good, Supabase renews it and writes the new cookies here. Without
 *     this, a long-lived session would fall apart exactly when the user comes
 *     back to the builder.
 *
 *  2. **VERIFY.** `getUser()` asks the Auth server whether the token is real.
 *     A cookie that merely EXISTS is not a session; an expired, tampered or
 *     revoked token answers with an error and the visitor is not
 *     authenticated.
 *
 * ⚠️ THE RESPONSE IS REBUILT AFTER THE COOKIE WRITE. `NextResponse.next({ request })`
 * snapshots the request, so the response has to be created *after* the request
 * cookies are updated, or the refreshed session never reaches the browser.
 */
export async function updateSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Without keys there is nothing to refresh and nobody to verify. The caller
  // gets `configured: false` and knows that the deployment has no auth at all.
  if (!isSupabaseConfigured()) {
    return { response, user: null, configured: false };
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // The mutated request is what the page below will read.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        // …and the response is what carries them back to the browser.
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();

  return {
    response,
    user: error ? null : data?.user ?? null,
    configured: true,
  };
}

/**
 * The same call without the `configured` flag, for callers that ask
 * `isSupabaseConfigured()` themselves.
 */
export async function refreshSession(request: NextRequest) {
  const { response, user } = await updateSupabaseSession(request);
  return { response, user };
}
