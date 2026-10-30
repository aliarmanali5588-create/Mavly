import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiSessionDecision } from "@/lib/api-access";
import { crossOriginMutationReason, isAllowedAppOrigin } from "@/lib/api-origin";
import { isSharedHostingRuntimeEnabled } from "@/lib/hosting/config";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { loginUrlFor } from "@/lib/auth/redirect";
import { authenticatedRootTarget } from "@/lib/auth/route-policy";
import { AUTH_CALLBACK_PATH } from "@/lib/auth/oauth-url";
import { refreshSession } from "@/lib/supabase/proxy";
import { isNextInternalPath, parseTenantHost } from "@/lib/tenant-host";

const isProduction = process.env.NODE_ENV === "production";

/**
 * ⚠️ NO ORIGIN IS DERIVED FROM THE REQUEST HERE. `src/lib/api-origin.ts` owns
 * the allowlist; this file only applies it. Deriving trust from `Host` made
 * every hostname the edge routes to the app — including every tenant site once
 * `*.mavly.xyz` points here — an authorized credentialed origin.
 */
function isAllowedOrigin(origin: string): boolean {
  if (!isProduction) return true;
  return isAllowedAppOrigin(origin);
}

// Add CORS headers if the origin is allowed
function addCorsHeaders(response: NextResponse, request: NextRequest) {
  const origin = request.headers.get("origin");

  if (origin && isAllowedOrigin(origin)) {
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
 * Tenant dispatch — BEFORE every app concern.
 *
 * A validated tenant host never reaches the session refresh, the API gate, the
 * workspace redirects or the app's CORS/CSP. Its whole request is rewritten to
 * the tenant route, so the app's APIs are not merely protected there — they are
 * unreachable. `/_next/*` is passed through because those are the app's build
 * assets, not tenant content.
 */
function tenantResponse(request: NextRequest): NextResponse | null {
  const tenant = parseTenantHost(request.headers.get("host"));
  if (!tenant) return null;

  if (!isSharedHostingRuntimeEnabled()) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // The app's build chunks are not tenant content; let Next serve them.
  if (isNextInternalPath(request.nextUrl.pathname)) return NextResponse.next();

  const target = request.nextUrl.clone();
  const suffix = request.nextUrl.pathname === "/" ? "" : request.nextUrl.pathname;
  target.pathname = `/api/tenant${suffix}`;
  return NextResponse.rewrite(target);
}

/**
 * Requests for static files are not app navigations. They used to be excluded by
 * the matcher; the matcher must now also see TENANT asset requests, so this
 * short-circuit keeps the app's own assets from paying for a session refresh.
 */
const STATIC_ASSET_PATH =
  /\.(?:svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|cjs|map|txt|xml|webmanifest|woff2?|ttf|otf|eot|mp4|webm|pdf|wasm)$/i;

function isStaticAssetPath(pathname: string): boolean {
  return isNextInternalPath(pathname) || STATIC_ASSET_PATH.test(pathname);
}

/**
 * Pages that require a signed-in user.
 *
 * The builder (`/dashboard`), the workspace (`/project/…`), the legal pages
 * (`/terms`, `/privacy`), the marketing page (`/`), the sign-in page
 * (`/login`) and the auth routes themselves stay public.
 *
 * ⚠️ `/` IS PUBLIC, BUT NOT AUTH-BLIND. A signed-out visitor gets the marketing
 * page; a visitor whose session this request verified is redirected to
 * `/dashboard` before render (`authenticatedRootTarget`). Keeping the
 * marketing page reachable is why `/` is not in this list.
 *
 * ⚠️ `/home` IS NOT IN THIS LIST ON PURPOSE. It is the builder's old address
 * and it answers a 308 redirect to `/dashboard`; a signed-out visitor who
 * follows an old link is sent to the sign-in page *through* the new address,
 * so the `redirect` parameter they come back with is the current one.
 *
 * ⚠️ API ROUTES ARE NOT IN THIS LIST because they do NOT get this function's
 * redirect — a `fetch()` cannot read a 303 to an HTML login page as an error.
 * They have their own gate right below: same verified session, answered as a
 * JSON 401 (`apiSessionDecision`).
 */
function requiresSession(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return true;
  if (pathname.startsWith("/project/")) return true;
  /**
   * ⚠️ THE ADMIN CONSOLE IS NOT PUBLIC. `/adminsh/auth` used to be a client
   * side `setTimeout`, and every `/adminsh/*` page was reachable signed-out.
   * This is the coarse session gate; `app/adminsh/layout.tsx` performs the
   * real, database-backed `current_user_is_admin()` check and returns 404 to a
   * signed-in non-admin. Keeping both means a future page under `/adminsh`
   * cannot accidentally bypass the session layer.
   */
  if (pathname === "/adminsh" || pathname.startsWith("/adminsh/")) return true;
  return false;
}

/**
 * An OAuth answer that landed somewhere other than `/auth/callback`.
 *
 * Supabase sends the provider's response to the project's **Site URL** when the
 * callback URL is missing from its allow list. The exchange can still succeed —
 * the PKCE verifier travels in a cookie — so the one-time code is forwarded to
 * the route that knows what to do with it.
 */
function oauthFallbackTarget(url: URL): URL | null {
  if (url.pathname === AUTH_CALLBACK_PATH) return null;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return null;
  if (!url.searchParams.get("code")) return null;

  const target = new URL(AUTH_CALLBACK_PATH, url.origin);
  url.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });
  return target;
}

/**
 * ═══ THE REFRESHED COOKIES MUST RIDE ON WHATEVER RESPONSE WINS ══════════════
 *
 * `refreshSession()` builds a `NextResponse.next()` that carries the cookies
 * the Supabase client just wrote: a rotated access/refresh token pair, or the
 * removal of a session the Auth server rejected.
 *
 * ⚠️ WHEN THIS PROXY REPLACES THAT RESPONSE — a login redirect, a JSON 401, or
 * the landing-page redirect below — the replacements start empty. Dropping the
 * cookies is how a valid sign-in turns into "please log in again":
 *
 *   · a rotated refresh token that never reaches the browser is replaced on the
 *     next request by the previous one, which the Auth server may treat as
 *     reuse and answer by revoking the session family;
 *   · a rejected session cookie that is never cleared keeps failing on every
 *     request.
 *
 * Copy them onto every response this file returns in place of `response`.
 */
function carrySessionCookies(target: NextResponse, session: NextResponse): NextResponse {
  for (const cookie of session.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}

/**
 * ═══ THE REQUEST BOUNDARY ════════════════════════════════════════════════════
 *
 * 1. A tenant host is served by the tenant runtime and nothing else.
 * 2. Static assets short-circuit (no session work for an image).
 * 3. A credentialed mutation from an unapproved origin is refused, so a
 *    generated website (same-site with the app) cannot publish or unpublish for
 *    a signed-in visitor.
 * 4. The Supabase session is refreshed and verified on the app's own hosts.
 * 5. An authenticated visit to `/` is sent to the builder; signed-out visitors
 *    keep the public marketing page.
 * 6. Unauthenticated API calls get a JSON 401; app pages get a login redirect.
 *
 * ⚠️ IT FAILS CLOSED. Without a Supabase configuration the builder pages are
 * not served at all — the visitor is sent to `/login`, which explains that
 * sign-in is not configured.
 */
export async function proxy(request: NextRequest) {
  /**
   * ⚠️ THE GENERATED-APP DATA GATEWAY OWNS ITS OWN ORIGIN RULE.
   *
   * `https://<project>.mavly.xyz/api/...` is a tenant origin, which is
   * deliberately never in the app-origin allowlist. The data gateway at
   * `/api/app/v1/apps/` is called BY that tenant origin, so the generic
   * preflight short-circuit and the generic cross-origin mutation refusal would
   * both break it. Those routes enforce their own rule: the allowed origin is
   * derived from the public project id, mutations from any other origin are
   * refused, and every request still needs a project-scoped end-user session.
   * The proxy must let the preflight reach the route so the correct
   * `Access-Control-Allow-Origin` is returned.
   */
  const appDataGateway = request.nextUrl.pathname.startsWith("/api/app/v1/apps/");

  // 1. Tenant hosting (public, static, no session).
  const tenant = tenantResponse(request);
  if (tenant) return tenant;

  // 2. App assets: no session refresh, no API gate.
  if (isStaticAssetPath(request.nextUrl.pathname)) {
    const response = NextResponse.next({ request });
    addCspHeaders(response, request);
    return response;
  }

  // 3. CORS preflight.
  if (request.method === "OPTIONS" && !appDataGateway) {
    const response = new NextResponse(null, { status: 204 });
    addCorsHeaders(response, request);
    addCspHeaders(response, request);
    return response;
  }

  /**
   * 4. ✋ A CROSS-ORIGIN MUTATION IS REFUSED BEFORE ANY STATE CHANGES.
   *
   * The published-site runtime lives on `<project>.mavly.xyz`, the same
   * registrable domain as the app, so a signed-in visitor viewing a generated
   * page would otherwise send their session cookie on a `POST` to
   * `https://mavly.xyz/api/...`. Origin/Sec-Fetch checks are the boundary; the
   * API routes keep their own session and ownership checks behind it.
   */
  if (request.nextUrl.pathname.startsWith("/api/") && !appDataGateway) {
    const reason = crossOriginMutationReason({
      method: request.method,
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      isProduction,
    });
    if (reason) {
      console.warn(`[proxy] refused cross-origin API mutation: ${reason}`);
      return NextResponse.json(
        { ok: false, error: "This request did not come from the Mavly app.", code: "FORBIDDEN" },
        { status: 403, headers: { "cache-control": "private, no-store, max-age=0", Vary: "Origin" } },
      );
    }
  }

  // 5. Forward a stray OAuth code to the callback before anything else touches it.
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
   * ── THE FRONT DOOR (authenticated visitors) ──────────────────────────────
   *
   * `/` stays the public marketing page for signed-out visitors. A visitor the
   * Auth server JUST VERIFIED belongs in the builder, and the decision is made
   * here, before anything renders — no marketing-page flash, no client-side
   * guess while the session is still initialising.
   *
   * Only an exact `/` GET/HEAD is redirected. A stray OAuth `?code=` was
   * already forwarded to `/auth/callback` above, API routes are excluded by the
   * policy, and `/dashboard` is not redirected again, so this cannot loop.
   */
  if (request.method === "GET" || request.method === "HEAD") {
    const rootTarget = authenticatedRootTarget(request.nextUrl.pathname, user !== null);
    if (rootTarget) {
      const redirectResponse = carrySessionCookies(
        NextResponse.redirect(new URL(rootTarget, request.nextUrl.origin), 307),
        response,
      );
      redirectResponse.headers.set(
        "Cache-Control",
        "private, no-store, no-cache, must-revalidate, max-age=0",
      );
      addCorsHeaders(redirectResponse, request);
      addCspHeaders(redirectResponse, request);
      // The answer depends on the session cookie: a shared cache must not
      // replay the redirect for a signed-out visitor (or vice versa).
      redirectResponse.headers.append("Vary", "Cookie");
      return redirectResponse;
    }
  }

  /**
   * ── THE API GATE (F-1) ────────────────────────────────────────────────────
   *
   * Everything under `/api/` except the exact public paths (`/api/config` and
   * the worker's `/api/generation/worker`, which authenticates itself with a
   * bearer secret) must present a session the Auth server just verified
   * (`refreshSession`'s `getUser()` — a cookie's mere presence is not a
   * session). Without one the request is answered HERE, with JSON, before any
   * route handler runs.
   */
  if (apiSessionDecision(request.nextUrl.pathname, user !== null) === "unauthenticated") {
    const unauthorized = carrySessionCookies(
      NextResponse.json(
        { ok: false, error: "You must be signed in to do that.", code: "UNAUTHENTICATED" },
        { status: 401, headers: { "cache-control": "private, no-store, max-age=0" } },
      ),
      response,
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

    // Carry the Auth server's removals: a session it has rejected must be
    // cleared in the browser, not retried on every visit to `/login`.
    const redirectResponse = carrySessionCookies(
      NextResponse.redirect(loginUrl, 303),
      response,
    );
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
     * Match all request paths except the Next.js build internals.
     *
     * ⚠️ ASSET EXTENSIONS ARE NO LONGER EXCLUDED. A published site's images and
     * stylesheets live at the tenant root and must reach the tenant rewrite;
     * excluding `*.png` here sent them straight to the app's 404. App asset
     * requests are short-circuited inside `proxy` instead, before any session
     * work, which preserves the old cost profile.
     */
    "/((?!_next/static|_next/image).*)",
  ],
};
