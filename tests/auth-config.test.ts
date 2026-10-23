import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  configProblem,
  isValidSupabaseUrl,
  supabaseConfigProblem,
} from "../src/lib/supabase/config";
import {
  authErrorMessage,
  notConfiguredMessage,
  signInErrorMessage,
} from "../src/lib/auth/error-copy";

/**
 * The configuration detection and the simplified sign-in screen.
 *
 * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE IS THE FIRST ONE: a deployment that
 * sets `SUPABASE_URL` / `SUPABASE_ANON_KEY` (no `NEXT_PUBLIC_` prefix) reads
 * empty in the browser bundle, because only `NEXT_PUBLIC_*` is inlined into a
 * client build. That is the difference between "the variables are set" and
 * "the app can sign anybody in".
 */

// ── Which problem does a given configuration have? ───────────────────────────

test("an empty URL is a missing URL", () => {
  assert.equal(configProblem("", ""), "missing_url");
  assert.equal(configProblem("   ", ""), "missing_url");
});

test("a URL without a key is a missing key", () => {
  assert.equal(configProblem("https://abc.supabase.co", ""), "missing_key");
  assert.equal(configProblem("https://abc.supabase.co", "   "), "missing_key");
});

test("a URL that is not an http(s) URL is an invalid URL", () => {
  assert.equal(configProblem("abc.supabase.co", "sb_publishable_x"), "invalid_url");
  assert.equal(configProblem("not a url", "sb_publishable_x"), "invalid_url");
  assert.equal(configProblem("ftp://abc.supabase.co", "sb_publishable_x"), "invalid_url");
});

test("a key with whitespace in it is malformed", () => {
  assert.equal(configProblem("https://abc.supabase.co", "sb_publishable x"), "invalid_key");
});

test("a complete public configuration has no problem", () => {
  assert.equal(configProblem("https://abc.supabase.co", "sb_publishable_abc"), null);
  assert.equal(configProblem("https://abc.supabase.co", "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig"), null);
  // Surrounding whitespace from a pasted value is not a problem.
  assert.equal(configProblem("  https://abc.supabase.co  ", "  sb_publishable_abc  "), null);
});

test("a local Supabase URL is accepted", () => {
  assert.equal(isValidSupabaseUrl("http://127.0.0.1:54321"), true);
  assert.equal(isValidSupabaseUrl("https://abc.supabase.co"), true);
  assert.equal(isValidSupabaseUrl("abc.supabase.co"), false);
  assert.equal(isValidSupabaseUrl(""), false);
});

// ── The deployment this test run happens in ──────────────────────────────────

test("the test environment itself has no Supabase configuration", () => {
  // `npm test` does not load `.env.local`, so this is the "nothing configured"
  // state — the same state a Vercel deployment with the wrong variable names
  // ends up in.
  assert.equal(supabaseConfigProblem(), "missing_url");
});

// ── The copy shown for a configuration problem ───────────────────────────────

test("the message names the missing variable and how to fix it", () => {
  const url = notConfiguredMessage("missing_url");
  assert.equal(url.includes("NEXT_PUBLIC_SUPABASE_URL"), true);
  assert.equal(url.includes("redeploy"), true);

  const key = notConfiguredMessage("missing_key");
  assert.equal(key.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"), true);
});

test("the message never contains a value, only names", () => {
  for (const problem of ["missing_url", "missing_key", "invalid_url", "invalid_key"] as const) {
    const message = notConfiguredMessage(problem);
    assert.equal(message.includes("supabase.co/"), false);
    assert.equal(message.includes("sb_publishable_"), false);
    assert.equal(message.includes("eyJ"), false);
  }
});

test("a configured deployment falls back to the neutral message", () => {
  assert.equal(notConfiguredMessage(null), authErrorMessage("not_configured"));
});

test("the sign-in message spells out a configuration problem", () => {
  assert.equal(signInErrorMessage("not_configured"), notConfiguredMessage("missing_url"));
  // Every other code keeps its own copy.
  assert.equal(signInErrorMessage("oauth_failed"), authErrorMessage("oauth_failed"));
});

// ── The sign-in screen ───────────────────────────────────────────────────────

const loginScreen = readFileSync(
  new URL("../src/app/login/login-screen.tsx", import.meta.url),
  "utf8",
);

test("the sign-in screen has no sign up / sign in selector", () => {
  assert.equal(loginScreen.includes('role="tablist"'), false);
  assert.equal(loginScreen.includes('role="tab"'), false);
  assert.equal(loginScreen.includes("setMode"), false);
  assert.equal(loginScreen.includes("mode ==="), false);
  assert.equal(loginScreen.includes(">Sign up<"), false);
  assert.equal(loginScreen.includes(">Sign in<"), false);
});

test("the sign-in screen keeps both OAuth providers", () => {
  assert.equal(loginScreen.includes("Continue with Google"), true);
  assert.equal(loginScreen.includes("Continue with GitHub"), true);
  assert.equal(loginScreen.includes('beginOAuth("google")'), true);
  assert.equal(loginScreen.includes('beginOAuth("github")'), true);
  // The real implementation — no simulated provider response.
  assert.equal(loginScreen.includes("startOAuth(provider, redirectPath)"), true);
});

test("the sign-in screen keeps the legal links and the error region", () => {
  assert.equal(loginScreen.includes("Terms of Service"), true);
  assert.equal(loginScreen.includes("Privacy Policy"), true);
  assert.equal(loginScreen.includes('role="alert"'), true);
  // A second click while the provider is loading must not start a second flow.
  assert.equal(loginScreen.includes("disabled={!!loadingProvider}"), true);
});
