import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import type { NextRequest } from "next/server";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  authCookieOptions,
  isSupabaseConfigured,
} from "./config";

/** One cookie the client wants to write, as `@supabase/ssr` hands it over. */
export type CookieToSet = {
  name: string;
  value: string;
  options?: {
    domain?: string;
    path?: string;
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
  };
};

/**
 * ═══ THE SERVER-SIDE SUPABASE CLIENT ════════════════════════════════════════
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT. It reads the request cookies.
 *
 * The session is read from — and written back to — the request cookies, which
 * is the only storage the server and the browser share. A server component
 * cannot write cookies, so `setAll` swallows the write there; the PROXY
 * (`src/proxy.ts`) is what actually refreshes the session and writes the new
 * cookies onto the response. That is the split `@supabase/ssr` is designed for:
 * the proxy refreshes, the page reads.
 *
 * ⚠️ A NEW CLIENT PER REQUEST. The session is per-user state; sharing one
 * client across requests would leak one visitor's session into another's.
 *
 * ⚠️ RETURNS `null` WHEN SUPABASE IS NOT CONFIGURED — callers treat that as
 * "nobody is signed in" and refuse to render anything that needs a user.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  if (!isSupabaseConfigured()) return null;

  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          /**
           * ⭐ SERVER COMPONENTS CANNOT WRITE COOKIES — Next throws here on
           * purpose. The proxy refreshes the session instead, so this is not an
           * error path; it is the expected one when a page reads the session.
           */
        }
      },
    },
  });
}

/**
 * ═══⭐ A REQUEST-SCOPED CLIENT FOR ROUTE HANDLERS ═══════════════════════════
 *
 * A route handler that SIGNS SOMEBODY IN OR OUT (the OAuth callback, sign-out)
 * must write the session cookies onto the response it returns. `cookies()` is
 * the wrong tool there: it is bound to the response Next builds for you, and a
 * handler that returns its own `NextResponse.redirect()` would drop every write.
 *
 * This client reads the request cookies and hands the writes to the caller:
 *
 *   const pending: CookieToSet[] = [];
 *   const supabase = createSupabaseRequestClient(request, (c) => pending.push(...c));
 *   await supabase.auth.exchangeCodeForSession(code);
 *   const response = NextResponse.redirect(destination);
 *   pending.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
 *
 * Returns `null` when Supabase is not configured.
 */
export function createSupabaseRequestClient(
  request: NextRequest,
  onSetCookies: (cookies: CookieToSet[]) => void,
): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        onSetCookies(cookiesToSet as CookieToSet[]);
      },
    },
  });
}

/**
 * ═══⭐ THE AUTHORITATIVE "WHO IS THIS?" ANSWER ══════════════════════════════
 *
 * `getUser()` asks the Supabase Auth server to validate the access token — it
 * does NOT trust the cookie's mere presence. A cookie with an expired, tampered
 * or revoked token answers with an error, and this returns `null`.
 *
 * ⚠️ THIS IS WHAT MAKES "SIGNED IN" A FACT INSTEAD OF A HOPE. Reading
 * `document.cookie` (or the raw session blob) would say "signed in" for a
 * cookie the Auth server has already invalidated.
 *
 * Returns `null` — never throws — when Supabase is not configured, when there
 * is no session, when the session has expired, or when the Auth server cannot
 * be reached. Callers treat `null` as "not authenticated" and redirect.
 */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    // A network failure or an unreadable cookie must not read as "signed in".
    return null;
  }
}

/**
 * ═══⭐ ONE AUTH ROUND-TRIP PER REQUEST ══════════════════════════════════════
 *
 * `getUser()` is a network call to the Supabase Auth server. A single admin
 * page used to make it TWICE — once in `app/adminsh/layout.tsx` and again in
 * `requireAdmin()` — and every extra call is a full round-trip added to the
 * time before anything renders.
 *
 * This memoises the answer for the lifetime of one request. It is keyed by
 * `React.cache`, which is request-scoped by design: two different users' requests
 * never share an entry, so this cannot leak a session between visitors.
 *
 * ⚠️ THE CACHED VALUE IS THE VERIFIED USER OR `null`. A `null` is cached too, so
 * a signed-out request does not retry the Auth server on every call site.
 * ⚠️ NEVER use this for a mutation that must re-verify a session it just
 * changed (sign-in/sign-out routes use `getCurrentUser` directly).
 */
export const getRequestUser = cache(getCurrentUser);
