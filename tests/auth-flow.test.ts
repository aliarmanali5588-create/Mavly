import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REDIRECT, loginUrlFor, safeRedirectPath } from "../src/lib/auth/redirect";
import {
  AUTH_CALLBACK_PATH,
  buildCallbackUrl,
  isOAuthProvider,
  OAUTH_COOKIE_MAX_AGE,
} from "../src/lib/auth/oauth-url";
import { authErrorMessage } from "../src/lib/auth/error-copy";

// ── safeRedirectPath: what a return destination may be ───────────────────────

test("keeps an internal path untouched", () => {
  assert.equal(safeRedirectPath("/"), "/");
  assert.equal(safeRedirectPath("/dashboard"), "/dashboard");
  assert.equal(safeRedirectPath("/project/my-app"), "/project/my-app");
  assert.equal(safeRedirectPath("/dashboard?tab=chat"), "/dashboard?tab=chat");
  assert.equal(safeRedirectPath("/project/a/b#section"), "/project/a/b#section");
});

test("trims surrounding whitespace", () => {
  assert.equal(safeRedirectPath("  /project/x  "), "/project/x");
});

test("refuses absolute and protocol-relative URLs", () => {
  const fallback = DEFAULT_REDIRECT;
  assert.equal(safeRedirectPath("https://evil.example"), fallback);
  assert.equal(safeRedirectPath("http://evil.example/login"), fallback);
  assert.equal(safeRedirectPath("//evil.example"), fallback);
  assert.equal(safeRedirectPath("//evil.example/dashboard"), fallback);
  assert.equal(safeRedirectPath("javascript:alert(1)"), fallback);
  assert.equal(safeRedirectPath("data:text/html,<h1>x"), fallback);
});

test("refuses backslash spellings and control characters", () => {
  const fallback = DEFAULT_REDIRECT;
  assert.equal(safeRedirectPath("/\\evil.example"), fallback);
  assert.equal(safeRedirectPath("/dashboard\\evil"), fallback);
  assert.equal(safeRedirectPath("/dashboard\nLocation: https://evil.example"), fallback);
  assert.equal(safeRedirectPath("/dashboard\tx"), fallback);
});

test("refuses paths that would loop back into the auth flow", () => {
  const fallback = DEFAULT_REDIRECT;
  assert.equal(safeRedirectPath("/login"), fallback);
  assert.equal(safeRedirectPath("/login?redirect=/dashboard"), fallback);
  assert.equal(safeRedirectPath("/auth/callback"), fallback);
  assert.equal(safeRedirectPath("/auth/callback/anything"), fallback);
});

test("refuses missing or non-path values", () => {
  const fallback = DEFAULT_REDIRECT;
  assert.equal(safeRedirectPath(null), fallback);
  assert.equal(safeRedirectPath(undefined), fallback);
  assert.equal(safeRedirectPath(""), fallback);
  assert.equal(safeRedirectPath("   "), fallback);
  assert.equal(safeRedirectPath("home"), fallback);
  assert.equal(safeRedirectPath("?redirect=/dashboard"), fallback);
});

test("the builder's old address is still a valid internal destination", () => {
  // `/home` is a legacy URL that answers a 308 redirect to `/dashboard`, so a
  // stale bookmark must survive the redirect validation instead of being
  // thrown away.
  assert.equal(safeRedirectPath("/home"), "/home");
  assert.equal(safeRedirectPath("/home?tab=chat"), "/home?tab=chat");
});

test("honours an explicit fallback", () => {
  assert.equal(safeRedirectPath("https://evil.example", "/"), "/");
  assert.equal(safeRedirectPath(null, "/project/x"), "/project/x");
});

// ── loginUrlFor: the link that starts the flow ───────────────────────────────

test("builds a relative sign-in link with an encoded destination", () => {
  // The destination is normalised first (a space becomes %20) and then encoded
  // as one query value, so the `%` itself is escaped — the login page decodes
  // the parameter once and gets the normalised path back.
  assert.equal(loginUrlFor("/project/my app"), "/login?redirect=%2Fproject%2Fmy%2520app");
  assert.equal(loginUrlFor("/dashboard"), "/login?redirect=%2Fdashboard");
});

test("validates the destination before putting it in the URL", () => {
  assert.equal(loginUrlFor("https://evil.example"), "/login?redirect=%2Fdashboard");
  assert.equal(loginUrlFor("/login"), "/login?redirect=%2Fdashboard");
});

test("builds an absolute link when given an origin", () => {
  assert.equal(
    loginUrlFor("/dashboard", "https://app.example.com"),
    "https://app.example.com/login?redirect=%2Fdashboard",
  );
});

// ── oauth-url: pure helpers ──────────────────────────────────────────────────

test("recognises only the supported providers", () => {
  assert.equal(isOAuthProvider("google"), true);
  assert.equal(isOAuthProvider("github"), true);
  assert.equal(isOAuthProvider("apple"), false);
  assert.equal(isOAuthProvider("Google"), false);
  assert.equal(isOAuthProvider(""), false);
  assert.equal(isOAuthProvider(null), false);
  assert.equal(isOAuthProvider(undefined), false);
});

test("builds the callback URL as a bare path on the given origin", () => {
  assert.equal(buildCallbackUrl("http://localhost:3000"), "http://localhost:3000/auth/callback");
  assert.equal(buildCallbackUrl("https://app.example.com/"), "https://app.example.com/auth/callback");
  // A callback URL with a query string would not match Supabase's allow list.
  assert.equal(buildCallbackUrl("https://app.example.com").includes("?"), false);
  assert.equal(AUTH_CALLBACK_PATH, "/auth/callback");
});

test("the one-time cookies are short lived", () => {
  assert.equal(OAUTH_COOKIE_MAX_AGE, 600);
});

// ── error copy ───────────────────────────────────────────────────────────────

test("maps every error code to copy", () => {
  for (const code of [
    "oauth_failed",
    "missing_code",
    "invalid_state",
    "session_expired",
    "exchange_failed",
    "not_configured",
  ]) {
    const message = authErrorMessage(code);
    assert.equal(typeof message, "string");
    assert.equal(message.length > 0, true);
    assert.equal(message.includes(code), false);
  }
});

test("never echoes an unknown code to the user", () => {
  const fallback = authErrorMessage("something_else");
  assert.equal(fallback.includes("something_else"), false);
  assert.equal(authErrorMessage(null), authErrorMessage(undefined));
});
