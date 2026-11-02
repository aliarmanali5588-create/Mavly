/**
 * ═══ SERVICE-ROLE FETCH HEADER RULES — TESTS ════════════════════════════════
 *
 * These exercise the REAL header builder used by `createAuthCompatibleFetch`,
 * and assert on the headers that actually go out. They never touch the network
 * and never contain a real key: the values below are fakes with the right shape.
 *
 * ⚠️ WHY THIS FILE EXISTS. The previous attempt at this coverage called
 * `require()` inside an ESM module, threw `require is not defined`, and asserted
 * nothing about headers at all. The wrapper's real failure mode — a `Request`
 * input losing its own headers — went unnoticed because no test ever looked at
 * an outgoing request.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildServiceRoleHeaders,
  isLegacyJwtKey,
} from "../src/lib/supabase/service-role-headers";

const NEW_KEY = "sb_secret_FAKEKEYFORTESTINGONLY000000000000";
const LEGACY_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWYiOiJhYmNkZWZnaGlqa2xtbm9wcXJzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.c2lnbmF0dXJl";

// ── 1. Key format detection ────────────────────────────────────────────────

test("a three-part JWT is legacy; an opaque sb_secret_ key is not", () => {
  assert.equal(isLegacyJwtKey(LEGACY_KEY), true);
  assert.equal(isLegacyJwtKey(NEW_KEY), false);
  assert.equal(isLegacyJwtKey("sb_publishable_abc"), false);
  assert.equal(isLegacyJwtKey(`  ${LEGACY_KEY}  `), true, "surrounding whitespace is ignored");
});

// ── 2. New-format opaque key: apikey kept, Bearer stripped ──────────────────

test("a new-format key keeps apikey and loses the Bearer Authorization header", () => {
  const headers = buildServiceRoleHeaders(
    "https://example.supabase.co/auth/v1/admin/users/x",
    {
      method: "GET",
      headers: {
        apikey: NEW_KEY,
        authorization: `Bearer ${NEW_KEY}`,
        "x-mavly-actor": "account-administration",
      },
    },
    NEW_KEY,
  );

  assert.equal(headers.get("apikey"), NEW_KEY, "apikey must survive");
  assert.equal(headers.has("authorization"), false, "opaque key must not be a Bearer token");
  assert.equal(headers.get("x-mavly-actor"), "account-administration", "unrelated headers survive");
});

// ── 3. Legacy JWT key: Bearer preserved ────────────────────────────────────

test("a legacy JWT key keeps its Bearer Authorization header", () => {
  const headers = buildServiceRoleHeaders(
    "https://example.supabase.co/auth/v1/admin/users/x",
    {
      method: "GET",
      headers: { apikey: LEGACY_KEY, authorization: `Bearer ${LEGACY_KEY}` },
    },
    LEGACY_KEY,
  );

  assert.equal(headers.get("apikey"), LEGACY_KEY);
  assert.equal(headers.get("authorization"), `Bearer ${LEGACY_KEY}`, "GoTrue validates legacy JWTs");
});

// ── 4. Request input: its own headers must not be dropped ──────────────────

test("a Request input keeps its own headers instead of being sent headerless", () => {
  const request = new Request("https://example.supabase.co/auth/v1/admin/users/x", {
    method: "GET",
    headers: {
      apikey: NEW_KEY,
      authorization: `Bearer ${NEW_KEY}`,
      "x-from-request": "kept",
    },
  });

  const headers = buildServiceRoleHeaders(request, undefined, NEW_KEY);

  assert.equal(headers.get("apikey"), NEW_KEY, "apikey must not be lost");
  assert.equal(headers.get("x-from-request"), "kept", "Request headers must be preserved");
  assert.equal(headers.has("authorization"), false, "opaque key still strips Bearer");
});

// ── 5. Request input plus init: init wins, Request headers still present ───

test("init headers override a Request's headers without erasing the rest", () => {
  const request = new Request("https://example.supabase.co/auth/v1/admin/users/x", {
    method: "GET",
    headers: { apikey: NEW_KEY, "x-from-request": "kept" },
  });

  const headers = buildServiceRoleHeaders(
    request,
    { method: "GET", headers: { "x-from-init": "wins" } },
    NEW_KEY,
  );

  assert.equal(headers.get("apikey"), NEW_KEY, "Request apikey survives an unrelated init");
  assert.equal(headers.get("x-from-request"), "kept");
  assert.equal(headers.get("x-from-init"), "wins");
});

// ── 6. A different key's Bearer is not touched ─────────────────────────────

test("a Bearer token that is not the service-role key is left alone", () => {
  const userToken = "Bearer some-user-session-jwt";
  const headers = buildServiceRoleHeaders(
    "https://example.supabase.co/rest/v1/x",
    { method: "GET", headers: { apikey: NEW_KEY, authorization: userToken } },
    NEW_KEY,
  );

  assert.equal(headers.get("authorization"), userToken, "a caller's own token is not stripped");
});

// ── 7. A plain URL input with no init does not throw ───────────────────────

test("a URL input with no init produces an empty header set, not a crash", () => {
  const headers = buildServiceRoleHeaders(new URL("https://example.supabase.co/x"), undefined, NEW_KEY);
  assert.equal(headers.has("apikey"), false);
  assert.equal(headers.has("authorization"), false);
});
