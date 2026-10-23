import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEGACY_REDIRECTS, legacyRedirectTarget } from "../src/lib/legacy-routes";
import { DEFAULT_REDIRECT } from "../src/lib/auth/redirect";

/**
 * The route map: the builder lives at `/dashboard`, `/home` is its old address.
 */

// ── The canonical destination ────────────────────────────────────────────────

test("the default destination after a sign-in is the builder", () => {
  assert.equal(DEFAULT_REDIRECT, "/dashboard");
});

// ── The legacy redirect ──────────────────────────────────────────────────────

test("the builder's old address redirects to the new one", () => {
  assert.equal(legacyRedirectTarget("/home"), "/dashboard");
  assert.equal(LEGACY_REDIRECTS["/home"], "/dashboard");
});

test("the query string of a legacy URL survives the redirect", () => {
  assert.equal(legacyRedirectTarget("/home", "tab=chat"), "/dashboard?tab=chat");
  assert.equal(
    legacyRedirectTarget("/home", "tab=chat&mode=code"),
    "/dashboard?tab=chat&mode=code",
  );
});

test("a live route is never a legacy path", () => {
  // `/dashboard` is a real route now — a legacy entry would shadow it.
  assert.equal(LEGACY_REDIRECTS["/dashboard"], undefined);
  assert.equal(legacyRedirectTarget("/dashboard"), null);
  assert.equal(legacyRedirectTarget("/"), null);
  assert.equal(legacyRedirectTarget("/project/my-app"), null);
  assert.equal(legacyRedirectTarget("/login"), null);
  assert.equal(legacyRedirectTarget("/auth/callback"), null);
});

test("the old locale prefixes still point at the marketing page", () => {
  assert.equal(legacyRedirectTarget("/en"), "/");
  assert.equal(legacyRedirectTarget("/es"), "/");
});

// ── The files that decide the route ──────────────────────────────────────────

const proxy = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
const dashboardPage = readFileSync(
  new URL("../src/app/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const hero = readFileSync(
  new URL("../src/components/home/HeroSection.tsx", import.meta.url),
  "utf8",
);

test("the proxy protects /dashboard and only /dashboard", () => {
  assert.equal(
    proxy.includes('pathname === "/dashboard" || pathname.startsWith("/dashboard/")'),
    true,
  );
  assert.equal(proxy.includes('pathname === "/home"'), false);
});

test("the builder page sends a signed-out visitor to the sign-in page", () => {
  assert.equal(dashboardPage.includes('loginUrlFor("/dashboard")'), true);
  assert.equal(dashboardPage.includes('loginUrlFor("/home")'), false);
});

test("the marketing page starts the OAuth flow towards the builder", () => {
  assert.equal(hero.includes('startOAuth(provider, "/dashboard")'), true);
  assert.equal(hero.includes('startOAuth(provider, "/home")'), false);
});
