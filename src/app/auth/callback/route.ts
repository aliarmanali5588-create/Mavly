import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveCallbackOutcome } from "@/lib/auth/callback";
import { OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE } from "@/lib/auth/oauth-url";
import {
  createSupabaseRequestClient,
  type CookieToSet,
} from "@/lib/supabase/server";

/**
 * OAuth callback for the Mavly application.
 *
 * The provider (Google/GitHub) redirects here with `?code=…` after the user
 * approved the sign-in. We exchange the code for a session, let the Supabase
 * client queue the session cookies and attach them to the redirect we return,
 * then send the user to their validated destination.
 *
 * ⚠️ THE SESSION COOKIES ARE WRITTEN BY THIS RESPONSE, NOT BY `cookies()`.
 * The exchange happens inside a route handler that returns its own redirect, so
 * the writes are collected here and applied to that response explicitly. A
 * handler that returned a fresh `NextResponse.redirect()` after trusting
 * `cookies().set()` would drop the session and sign the user out instantly.
 *
 * Nothing about the code, the session or the provider's tokens is ever logged
 * or put into the URL we redirect to — only a stable error code is.
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;
  const nextCookie = request.cookies.get(OAUTH_NEXT_COOKIE)?.value ?? null;

  // Session cookies queued by the Supabase client, applied to the response
  // below. Empty when the deployment is not configured.
  const sessionCookies: CookieToSet[] = [];

  const supabase = createSupabaseRequestClient(request, (cookies) => {
    sessionCookies.push(...cookies);
  });

  let destination: URL;

  if (!supabase) {
    destination = new URL("/login", origin);
    destination.searchParams.set("error", "not_configured");
  } else {
    const outcome = await resolveCallbackOutcome({
      searchParams: request.nextUrl.searchParams,
      stateCookie,
      nextCookie,
      exchangeCode: async (code) => {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        return { error };
      },
    });

    // NOTE: `in` instead of `outcome.ok` — this repo compiles with
    // `strict: false`, and TypeScript only narrows a boolean discriminant when
    // strict null checks are on.
    if ("error" in outcome) {
      destination = new URL("/login", origin);
      destination.searchParams.set("error", outcome.error);
    } else {
      destination = new URL(outcome.redirectTo, origin);
    }
  }

  const response = NextResponse.redirect(destination, 303);

  // The freshly minted session.
  for (const { name, value, options } of sessionCookies) {
    response.cookies.set(name, value, options);
  }

  // The state/destination cookies are single-use.
  response.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  response.cookies.set(OAUTH_NEXT_COOKIE, "", { path: "/", maxAge: 0 });

  // A response that carries session cookies must never be cached.
  response.headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");

  return response;
}
