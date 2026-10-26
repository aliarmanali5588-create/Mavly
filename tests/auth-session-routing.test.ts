import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { authenticatedRootTarget, DASHBOARD_PATH } from "../src/lib/auth/route-policy";
import {
  hasEstablishedSessionCookie,
  isSupabaseAuthCookieName,
} from "../src/lib/auth/session-cookies";
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  resolveAuthCookieOptions,
} from "../src/lib/supabase/config";

/**
 * ═══ SESSION PERSISTENCE + ROOT ROUTING REGRESSIONS ════════════════════════
 *
 * Two independent behaviours are pinned here:
 *
 *   1. `/` is the public marketing page for a signed-out visitor and the way
 *      into the builder for a visitor whose session this request verified.
 *      The decision is the proxy's, made before render — not a client guess.
 *
 *   2. A session that survives a refresh, a new tab and a browser restart.
 *      That depends on (a) every Supabase client writing the SAME cookie
 *      attributes, (b) a refreshed/cleared cookie travelling on whatever
 *      response the proxy actually returns, and (c) sign-out being able to
 *      clear a session even when the Auth server cannot be reached.
 *
 * The proxy integration tests below run with NO Supabase configuration (the
 * test environment has none), which is the real signed-out path. The
 * authenticated path is covered by the pure policy and by structural checks on
 * the exact wiring — there is no Auth server and no cookie jar in this suite.
 */

function req(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

const proxySource = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
const signoutSource = readFileSync(
  new URL("../src/app/auth/signout/route.ts", import.meta.url),
  "utf8",
);
const callbackSource = readFileSync(
  new URL("../src/app/auth/callback/route.ts", import.meta.url),
  "utf8",
);
const loginPage = readFileSync(
  new URL("../src/app/login/page.tsx", import.meta.url),
  "utf8",
);
const dashboardPage = readFileSync(
  new URL("../src/app/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const rootPage = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const browserClient = readFileSync(
  new URL("../src/lib/supabase/client.ts", import.meta.url),
  "utf8",
);
const serverClient = readFileSync(
  new URL("../src/lib/supabase/server.ts", import.meta.url),
  "utf8",
);
const proxyClient = readFileSync(
  new URL("../src/lib/supabase/proxy.ts", import.meta.url),
  "utf8",
);
const publicClient = readFileSync(
  new URL("../src/lib/supabase/public.ts", import.meta.url),
  "utf8",
);

// ═══ 1–4, 6 — the root / dashboard policy ═══════════════════════════════════

test("a signed-out visitor to / gets the public landing page", () => {
  assert.equal(authenticatedRootTarget("/", false), null);
});

test("a verified visitor to / is sent to the builder", () => {
  assert.equal(authenticatedRootTarget("/", true), DASHBOARD_PATH);
  assert.equal(DASHBOARD_PATH, "/dashboard");
});

test("only the exact landing page redirects; every other public route is untouched", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/anything",
    "/project/my-app",
    "/pricing",
    "/docs",
    "/login",
    "/auth/callback",
    "/api/vcaas/projects",
  ]) {
    assert.equal(authenticatedRootTarget(path, true), null, path);
  }
});

test("the root rule cannot create a redirect loop", () => {
  const target = authenticatedRootTarget("/", true);
  assert.notEqual(target, "/");
  assert.notEqual(target, "/login");
  assert.equal(authenticatedRootTarget(target as string, true), null);
});

test("the signed-out landing page still renders through the real proxy", async () => {
  // No Supabase configuration in the test environment = no verified session.
  const home = await proxy(req("/"));
  assert.equal(home.status, 200, "the marketing page must stay public");
  assert.equal(home.headers.get("location"), null);
});

test("the proxy only sends a visitor to /login when the session is NOT verified", () => {
  assert.equal(
    proxySource.includes("requiresSession(request.nextUrl.pathname) && !user"),
    true,
  );
});

test("the root decision happens after the session is refreshed and before any render", () => {
  const refreshAt = proxySource.indexOf("await refreshSession(request)");
  const rootAt = proxySource.indexOf("const rootTarget = authenticatedRootTarget(");
  assert.equal(refreshAt >= 0, true);
  assert.equal(rootAt > refreshAt, true);
});

test("a stray OAuth code is forwarded to the callback before the root redirect", () => {
  const fallbackAt = proxySource.indexOf("const fallback = oauthFallbackTarget(");
  const rootAt = proxySource.indexOf("const rootTarget = authenticatedRootTarget(");
  assert.equal(fallbackAt >= 0, true);
  assert.equal(fallbackAt < rootAt, true);
});

test("the root redirect is temporary, uncacheable and cookie-aware", () => {
  assert.match(
    proxySource,
    /NextResponse\.redirect\(new URL\(rootTarget, request\.nextUrl\.origin\), 307\)/,
  );
  assert.equal(proxySource.includes('headers.append("Vary", "Cookie")'), true);
});

// ═══ 3, 10, 11 — the session survives refresh/redirect ═════════════════════

test("every response that replaces the refreshed session carries its cookies", () => {
  // The helper is used for the root redirect, the JSON 401 and the login
  // redirect. Dropping any of them loses a rotated refresh token or leaves a
  // rejected session cookie in the browser.
  const uses = proxySource.match(/carrySessionCookies\(/g) ?? [];
  assert.equal(uses.length >= 4, true, "definition + three replacement responses");
  assert.equal(proxySource.includes("for (const cookie of session.cookies.getAll())"), true);
  assert.equal(proxySource.includes("target.cookies.set(cookie)"), true);
});

test("a rejected session is cleared on the way to /login", () => {
  assert.match(
    proxySource,
    /carrySessionCookies\(\s*NextResponse\.redirect\(loginUrl, 303\),\s*response,?\s*\)/,
  );
});

test("the proxy refreshes the session before deciding anything about the visitor", () => {
  assert.equal(proxySource.includes("refreshSession(request)"), true);
  assert.equal(proxySource.includes("getSession()"), false, "verification uses getUser(), not a cookie read");
});

// ═══ 5 — persistence across a browser restart ══════════════════════════════

test("auth cookies are persistent (400 days), not tab-session cookies", () => {
  assert.equal(AUTH_COOKIE_MAX_AGE_SECONDS, 400 * 24 * 60 * 60);
  const options = resolveAuthCookieOptions({ appUrl: "https://mavly.xyz" });
  assert.equal(options.maxAge, AUTH_COOKIE_MAX_AGE_SECONDS);
  assert.equal(options.maxAge > 0, true);
  assert.equal(options.path, "/");
  assert.equal(options.sameSite, "lax");
});

test("Secure follows an explicit HTTPS app origin and is never forced over http", () => {
  assert.equal(resolveAuthCookieOptions({ appUrl: "https://mavly.xyz" }).secure, true);
  assert.equal(
    resolveAuthCookieOptions({ appUrl: "http://localhost:3000" }).secure,
    false,
    "the documented `next build && next start` smoke test runs over http",
  );
  assert.equal(resolveAuthCookieOptions({ appUrl: "" }).secure, false);
  assert.equal(
    resolveAuthCookieOptions({ appUrl: "not a url" }).secure,
    false,
    "an unreadable origin must not silently enable or disable Secure",
  );
});

test("the browser, server and proxy clients share one cookie policy", () => {
  for (const [name, source] of [
    ["browser", browserClient],
    ["server", serverClient],
    ["proxy", proxyClient],
  ] as const) {
    assert.equal(source.includes("authCookieOptions()"), true, name);
  }
  assert.equal((serverClient.match(/cookieOptions: authCookieOptions\(\)/g) ?? []).length, 2);
});

test("the browser client never disables session persistence", () => {
  assert.equal(browserClient.includes("persistSession: false"), false);
  assert.equal(browserClient.includes("persistSession:false"), false);
  assert.equal(browserClient.includes("createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {"), true);
});

test("only the anonymous tenant runtime keeps a stateless client", () => {
  // `public.ts` is the tenant runtime: no user, no cookie jar. This is the one
  // place `persistSession: false` is correct.
  assert.equal(publicClient.includes("persistSession: false"), true);
});

// ═══ 7–9 — login, callback and sign-out ════════════════════════════════════

test("a signed-out visitor to /dashboard is sent to the login flow with a destination", async () => {
  const dashboard = await proxy(req("/dashboard"));
  assert.equal(dashboard.status, 303);
  assert.match(dashboard.headers.get("location") ?? "", /\/login\?redirect=%2Fdashboard/);
});

test("the login page sends an already-signed-in visitor on to their destination", () => {
  assert.equal(loginPage.includes("getCurrentUser()"), true);
  assert.equal(loginPage.includes("redirect(redirectPath)"), true);
});

test("the dashboard keeps its own server-side guard", () => {
  assert.equal(dashboardPage.includes('loginUrlFor("/dashboard")'), true);
});

test("the OAuth callback proves a session cookie was persisted", () => {
  assert.equal(callbackSource.includes("hasEstablishedSessionCookie(sessionCookies)"), true);
  // Success without a cookie would bounce off /dashboard and loop back to
  // /login; the callback reports it once instead.
  assert.equal(callbackSource.includes('searchParams.set("error", "exchange_failed")'), true);
  assert.equal(callbackSource.includes("for (const { name, value, options } of sessionCookies)"), true);
});

test("sign-out clears the session and the one-time OAuth cookies", () => {
  assert.equal(signoutSource.includes("await supabase.auth.signOut()"), true);
  assert.equal(signoutSource.includes('signOut({ scope: "local" })'), true);
  assert.equal(signoutSource.includes("isSupabaseAuthCookieName"), true);
  assert.equal(signoutSource.includes("OAUTH_STATE_COOKIE"), true);
  assert.equal(signoutSource.includes("OAUTH_NEXT_COOKIE"), true);
  assert.equal(signoutSource.includes('new URL("/", origin)'), true);
});

test("sign-out is a POST, so a third-party page cannot trigger it", () => {
  assert.equal(signoutSource.includes("export async function POST"), true);
  assert.equal(signoutSource.includes("export async function GET"), false);
});

// ═══ 8, 12 — after sign-out, the public page (and no loop/flash) ═══════════

test("the root page is still the marketing page, not an unconditional redirect", () => {
  assert.equal(rootPage.includes("MarketingHome"), true);
  assert.equal(/from ["']next\/navigation["']/.test(rootPage), false);
  assert.equal(rootPage.includes("redirect("), false);
});

test("the proxy's protected-route list is unchanged", () => {
  assert.equal(
    proxySource.includes('pathname === "/dashboard" || pathname.startsWith("/dashboard/")'),
    true,
  );
  assert.equal(proxySource.includes('pathname.startsWith("/project/")'), true);

  // The landing page is public: it must not appear in `requiresSession`.
  const policyStart = proxySource.indexOf("function requiresSession");
  const policyEnd = proxySource.indexOf("/**", policyStart);
  const requiresSessionSource = proxySource.slice(policyStart, policyEnd);
  assert.equal(policyStart >= 0 && policyEnd > policyStart, true);
  assert.equal(requiresSessionSource.includes('pathname === "/"'), false);
});

// ═══ cookie shape helpers ══════════════════════════════════════════════════

test("recognises the session cookies the SSR library writes", () => {
  for (const name of [
    "sb-cazmezhpanwdjgsqugzr-auth-token",
    "sb-cazmezhpanwdjgsqugzr-auth-token.0",
    "sb-cazmezhpanwdjgsqugzr-auth-token.1",
    "sb-cazmezhpanwdjgsqugzr-auth-token-code-verifier",
    "sb-cazmezhpanwdjgsqugzr-auth-token-flow-abcd1234-code-verifier",
    "sb-cazmezhpanwdjgsqugzr-auth-token-flows-code-verifier",
  ]) {
    assert.equal(isSupabaseAuthCookieName(name), true, name);
  }
});

test("never mistakes API keys or unrelated cookies for a session", () => {
  for (const name of [
    "sb_publishable_abc",
    "sb_secret_abc",
    "mavly_oauth_state",
    "mavly_oauth_next",
    "sb-cazmezhpanwdjgsqugzr-auth-tokenx",
    "SB-cazmezhpanwdjgsqugzr-auth-token",
    "",
  ]) {
    assert.equal(isSupabaseAuthCookieName(name), false, name);
  }
});

test("a deletion or a PKCE verifier is not an established session", () => {
  assert.equal(
    hasEstablishedSessionCookie([
      { name: "sb-x-auth-token", value: "" },
      { name: "sb-x-auth-token-code-verifier", value: "verifier" },
    ]),
    false,
  );
  assert.equal(
    hasEstablishedSessionCookie([{ name: "sb-x-auth-token.0", value: "base64-eyJ" }]),
    true,
  );
});
