import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiSessionDecision } from "@/lib/api-access";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { loginUrlFor } from "@/lib/auth/redirect";
import { AUTH_CALLBACK_PATH } from "@/lib/auth/oauth-url";
import { refreshSession } from "@/lib/supabase/proxy";

const isProduction = process.env.NODE_ENV === "production";
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
// Extract origin from app URL (e.g. "https://my-app.com" from "https://my-app.com/")
const appOrigin = appUrl ? new URL(appUrl).origin : "";

/**
 * Check if an origin is allowed for CORS
 * - Development: any origin
 * - Production: NEXT_PUBLIC_APP_URL, or same-host (custom domains)
 *
 * ⚠️ Totalum's generated-app host was removed from this allowlist when the
 * upstream integration was disconnected. This app no longer serves Totalum
 * previews or custom domains, so no Totalum origin may call it with credentials.
 */
function isAllowedOrigin(origin: string, request: NextRequest): boolean {
  if (!isProduction) return true;
  if (appOrigin && origin === appOrigin) return true;

  // Trust same-host requests — custom domains served by this same server
  const host = request.headers.get("host");
  if (host && origin === `https://${host}`) return true;

  return false;
}

// Add CORS headers if the origin is allowed
function addCorsHeaders(response: NextResponse, request: NextRequest) {
  const origin = request.headers.get("origin");

  if (origin && isAllowedOrigin(origin, request)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Max-Age", "86400");
    response.headers.set("Vary", "Origin");
  }

  return response;
}

// Set CSP to allow iframe embedding from any domain and remove X-Frame-Options.
// The generated preview sets its own, stricter CSP (including `sandbox`), so
// never overwrite it here.
function addCspHeaders(response: NextResponse, request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/preview/")) return response;
  response.headers.set("Content-Security-Policy", "frame-ancestors *");
  response.headers.delete("X-Frame-Options");
  return response;
}

/**
 * Pages that require a signed-in user.
 *
 * The builder (`/dashboard`), the workspace (`/project/…`), the legal pages
 * (`/terms`, `/privacy`), the marketing page (`/`), the sign-in page
 * (`/login`) and the auth routes themselves stay public.
 *
 * ⚠️ `/home` IS NOT IN THIS LIST ON PURPOSE. It is the builder's old address
 * and it answers a 308 redirect to `/dashboard`; a signed-out visitor who
 * follows an old link is sent to the sign-in page *through* the new address,
 * so the `redirect` parameter they come back with is the current one.
 *
 * ⚠️ API ROUTES ARE NOT IN THIS LIST because they do NOT get this function's
 * redirect — a `fetch()` cannot read a 303 to an HTML login page as an error.
 * They have their own gate right below: same verified session, answered as a
 * JSON 401 (`apiSessionDecision`). This function keeps skipping `/api/` so the
 * two policies never fight over one path.
 */
function requiresSession(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return true;
  if (pathname.startsWith("/project/")) return true;
  return false;
}

/**
 * An OAuth answer that landed somewhere other than `/auth/callback`.
 *
 * Supabase sends the provider's response to the project's **Site URL** when the
 * callback URL is missing from its allow list. The exchange can still succeed —
 * the PKCE verifier travels in a cookie — so the one-time code is forwarded to
 * the route that knows what to do with it.
 *
 * Without this, a missing allow-list entry is a silent no-op: the visitor lands
 * on the page they asked for, still signed out, with no error anywhere.
 *
 * Only `code` triggers the forward. An app page that happens to carry an
 * `error=` query parameter of its own must not be hijacked.
 */
function oauthFallbackTarget(url: URL): URL | null {
  if (url.pathname === AUTH_CALLBACK_PATH) return null;
  // API and auth routes are never an OAuth landing page.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return null;
  if (!url.searchParams.get("code")) return null;

  const target = new URL(AUTH_CALLBACK_PATH, url.origin);
  url.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });
  return target;
}

/**
 * The proxy does three things:
 *
 * 1. It refreshes the Supabase session on every request, so the access token
 *    (and the session cookie) stays valid for the pages below.
 * 2. It sends signed-out visitors away from the app pages that need a user.
 * 3. It keeps the CORS and CSP headers the preview iframe and the custom
 *    domains rely on.
 *
 * ⚠️ IT FAILS CLOSED. Without a Supabase configuration there is no way to
 * prove who the visitor is, so the builder pages are not served at all — the
 * visitor is sent to `/login`, which explains that sign-in is not configured.
 */
export async function proxy(request: NextRequest) {
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    addCorsHeaders(response, request);
    addCspHeaders(response, request);
    return response;
  }

  // Forward a stray OAuth code to the callback before anything else touches it.
  if (request.method === "GET") {
    const fallback = oauthFallbackTarget(request.nextUrl);
    if (fallback) {
      const redirectResponse = NextResponse.redirect(fallback, 303);
      redirectResponse.headers.set("Cache-Control", "private, no-store, max-age=0");
      return redirectResponse;
    }
  }

  const configured = isSupabaseConfigured();
  const { response, user } = configured
    ? await refreshSession(request)
    : { response: NextResponse.next({ request }), user: null };

  /**
   * ── THE API GATE (F-1) ────────────────────────────────────────────────────
   *
   * Everything under `/api/` except the approved public `/api/config` must
   * present a session the Auth server just verified (`refreshSession`'s
   * `getUser()` — a cookie's mere presence is not a session). Without one the
   * request is answered HERE, with JSON, before any route handler runs: the
   * API routes themselves are unchanged for authenticated callers, and this
   * one branch is what closes the unauthenticated door the audit called F-1.
   *
   * ⚠️ 401 AS JSON, NEVER A REDIRECT — see `src/lib/api-access.ts`.
   * The session refresh above still ran first, so an authenticated request
   * keeps today's cookie-refresh behaviour exactly.
   */
  if (apiSessionDecision(request.nextUrl.pathname, user !== null) === "unauthenticated") {
    const unauthorized = NextResponse.json(
      { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" },
      { status: 401, headers: { "cache-control": "private, no-store, max-age=0" } },
    );
    addCorsHeaders(unauthorized, request);
    addCspHeaders(unauthorized, request);
    return unauthorized;
  }

  if (requiresSession(request.nextUrl.pathname) && !user) {
    const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    const loginUrl = new URL(loginUrlFor(target, request.nextUrl.origin));

    // Without a Supabase configuration nobody can sign in, so the sign-in page
    // is told why instead of showing buttons that cannot work.
    if (!configured) {
      loginUrl.searchParams.set("error", "not_configured");
    }

    const redirectResponse = NextResponse.redirect(loginUrl, 303);
    redirectResponse.headers.set(
      "Cache-Control",
      "private, no-store, no-cache, must-revalidate, max-age=0",
    );
    addCorsHeaders(redirectResponse, request);
    addCspHeaders(redirectResponse, request);
    return redirectResponse;
  }

  addCorsHeaders(response, request);
  addCspHeaders(response, request);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
