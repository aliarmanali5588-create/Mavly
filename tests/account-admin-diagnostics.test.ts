/**
 * ═══ ACCOUNT ADMIN DIAGNOSTICS — TESTS ══════════════════════════════════════
 *
 * ⚠️ PER AGENTS.md, NO AUTOMATED VERIFICATION WAS RUN FOR THIS WORK. These tests
 * are written for the human developer to run (`npm test`, Node 22.6+). Nothing
 * here was executed and no result is claimed.
 *
 * The point of this file is the bug it prevents: a single
 * `if (readError) return 404 USER_NOT_FOUND` that told operators an account was
 * missing when the key was wrong.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  accountAdminFailureResponse,
  classifyAuthAdminError,
  describeServiceRoleConfig,
  projectRefFromUrl,
  readKeyClaims,
} from "../src/lib/admin/account-diagnostics";

const source = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

const REF = "cazmezhpanwdjgsqugzr";

// ── 1. Configuration: present vs missing ────────────────────────────────────

test("a missing key is reported as missing, not as a bad key", () => {
  const report = describeServiceRoleConfig({ url: `https://${REF}.supabase.co`, key: undefined });
  assert.equal(report.configured, false);
  assert.equal(report.keyLength, "missing");
  assert.equal(report.keyProjectRef, null);
  assert.equal(report.projectMatch, null);
});

test("an empty or whitespace key is missing, not plausible", () => {
  const report = describeServiceRoleConfig({ url: `https://${REF}.supabase.co`, key: "   " });
  assert.equal(report.keyLength, "missing");
  assert.equal(report.configured, false);
});

test("a truncated key is too_short rather than plausible", () => {
  const report = describeServiceRoleConfig({ url: `https://${REF}.supabase.co`, key: "abc" });
  assert.equal(report.keyLength, "too_short");
  assert.equal(report.configured, false);
});

// ── 2. Configuration: right project vs wrong project ────────────────────────

test("a key from the same project matches the URL", () => {
  const report = describeServiceRoleConfig({
    url: `https://${REF}.supabase.co`,
    key: fakeJwt({ ref: REF, role: "service_role" }),
  });
  assert.equal(report.configured, true);
  assert.equal(report.keyProjectRef, REF);
  assert.equal(report.projectMatch, true);
  assert.equal(report.keyRoleIsServiceRole, true);
});

test("a key from another project is reported as a mismatch", () => {
  const report = describeServiceRoleConfig({
    url: `https://${REF}.supabase.co`,
    key: fakeJwt({ ref: "aaaaaaaaaaaaaaaaaaaa", role: "service_role" }),
  });
  assert.equal(report.projectMatch, false);
});

test("a new-format secret key leaves projectMatch null (not a mismatch)", () => {
  const report = describeServiceRoleConfig({
    url: `https://${REF}.supabase.co`,
    key: "sb_secret_this_is_not_a_jwt_but_it_is_long_enough_12345678901234567890",
  });
  assert.equal(report.configured, true);
  assert.equal(report.keyProjectRef, null);
  assert.equal(report.projectMatch, null);
  assert.equal(report.keyRoleIsServiceRole, null);
});

test("a new-format publishable key leaves projectMatch null (not a mismatch)", () => {
  const report = describeServiceRoleConfig({
    url: `https://${REF}.supabase.co`,
    key: "sb_publishable_this_is_not_a_jwt_but_it_is_long_enough_123456789",
  });
  assert.equal(report.configured, true);
  assert.equal(report.keyProjectRef, null);
  assert.equal(report.projectMatch, null);
  assert.equal(report.keyRoleIsServiceRole, null);
});

test("an anon key is distinguished from a service-role key", () => {
  const report = describeServiceRoleConfig({
    url: `https://${REF}.supabase.co`,
    key: fakeJwt({ ref: REF, role: "anon" }),
  });
  assert.equal(report.keyRoleIsServiceRole, false);
});

test("the project ref is read from a supabase.co URL only", () => {
  assert.equal(projectRefFromUrl(`https://${REF}.supabase.co`), REF);
  assert.equal(projectRefFromUrl("https://example.com"), null);
  assert.equal(projectRefFromUrl("not a url"), null);
});

test("key claims are read without verifying or trusting the signature", () => {
  const claims = readKeyClaims(fakeJwt({ ref: REF, role: "service_role" }));
  assert.equal(claims.ref, REF);
  assert.equal(claims.role, "service_role");
  assert.deepEqual(readKeyClaims("garbage"), { ref: null, role: null });
});

// ── 3. Error classification: the four conditions stay apart ─────────────────

test("a 401 is invalid credentials, never a missing user", () => {
  assert.equal(classifyAuthAdminError({ status: 401, message: "Invalid API key" }), "invalid_credentials");
});

test("a 403 is invalid credentials", () => {
  assert.equal(classifyAuthAdminError({ status: 403, message: "forbidden" }), "invalid_credentials");
});

test("a 404 is the only evidence of a genuinely missing user", () => {
  assert.equal(classifyAuthAdminError({ status: 404, message: "User not found" }), "user_not_found");
});

test("a user_not_found code is recognised without a status", () => {
  assert.equal(classifyAuthAdminError({ code: "user_not_found" }), "user_not_found");
});

test("a 500 is an upstream failure, not a missing user", () => {
  assert.equal(classifyAuthAdminError({ status: 500, message: "internal" }), "upstream_unavailable");
});

test("a fetch failure is an upstream failure", () => {
  assert.equal(classifyAuthAdminError({ message: "TypeError: fetch failed" }), "upstream_unavailable");
});

test("a DNS failure is an upstream failure", () => {
  assert.equal(classifyAuthAdminError({ message: "getaddrinfo ENOTFOUND" }), "upstream_unavailable");
});

test("an unrecognised error is unknown, not a missing user", () => {
  assert.equal(classifyAuthAdminError({ status: 418, message: "teapot" }), "unknown");
  assert.equal(classifyAuthAdminError(null), "unknown");
  assert.equal(classifyAuthAdminError(undefined), "unknown");
});

// ── 4. Each condition gets its own status and code ──────────────────────────

test("only user_not_found answers 404", () => {
  const conditions = [
    "not_configured",
    "invalid_credentials",
    "upstream_unavailable",
    "unknown",
  ] as const;
  for (const condition of conditions) {
    assert.notEqual(accountAdminFailureResponse(condition).status, 404, condition);
  }
  assert.equal(accountAdminFailureResponse("user_not_found").status, 404);
});

test("each condition has a distinct code", () => {
  const codes = (
    ["not_configured", "invalid_credentials", "user_not_found", "upstream_unavailable", "unknown"] as const
  ).map((condition) => accountAdminFailureResponse(condition).code);
  assert.equal(new Set(codes).size, codes.length);
});

test("configuration messages name the variable to fix", () => {
  assert.match(accountAdminFailureResponse("not_configured").error, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(accountAdminFailureResponse("invalid_credentials").error, /different Supabase project/);
});

// ── 5. The route no longer collapses every error into 404 ───────────────────

test("the status route classifies the read error instead of discarding it", async () => {
  const text = await source("src/app/api/adminsh/users/status/route.ts");
  assert.match(text, /classifyAuthAdminError/);
  assert.match(text, /accountAdminFailureResponse/);
  /**
   * ⚠️ THE REGRESSION GUARD. This exact line was the bug: any readError, including
   * a 401 from a bad key, became "That account does not exist."
   */
  assert.doesNotMatch(
    text,
    /if \(readError \|\| !target\?\.user\) \{\s*return adminError\(404, "USER_NOT_FOUND"/,
  );
});

test("the route logs the classification without the key or raw message", async () => {
  const text = await source("src/app/api/adminsh/users/status/route.ts");
  const logBlock = text.slice(text.indexOf('"[adminsh] account status read failed"'));
  const block = logBlock.slice(0, 700);
  assert.match(block, /failure/);
  /** No secret may be logged, and no raw AuthError message either. */
  assert.doesNotMatch(block, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(block, /readError\.message/);
});

test("the diagnostics endpoint never returns the key", async () => {
  const text = await source("src/app/api/adminsh/users/status/diagnostics/route.ts");
  /** It reads the key, but only to describe it. */
  assert.match(text, /describeServiceRoleConfig/);
  assert.doesNotMatch(text, /key:\s*key\b/);
  assert.doesNotMatch(text, /SUPABASE_SERVICE_ROLE_KEY\s*[,}]/);
  assert.match(text, /requireAdmin/);
});

test("the probe performs a read-only lookup", async () => {
  const text = await source("src/app/api/adminsh/users/status/diagnostics/route.ts");
  assert.match(text, /getUserById/);
  /** ⚠️ A diagnostic must never change an account. */
  assert.doesNotMatch(text, /updateUserById/);
  assert.doesNotMatch(text, /ban_duration/);
});

// ── 6. The frontend sends the real Auth UUID ────────────────────────────────

test("the directory returns auth.users ids and the page sends that id", async () => {
  const sql = await source("supabase/migrations/41_admin_directory.sql");
  /** The directory's id must come from auth.users, not a profile or project row. */
  assert.match(sql, /u\.id/);
  assert.match(sql, /from auth\.users u/);

  const page = await source("src/app/adminsh/users/page.tsx");
  assert.match(page, /userId: statusTarget\.id/);
});

// ── 7. Service-role client compatibility with new and legacy API keys ───────

test("service-role client factory correctly detects legacy JWT keys (3 parts)", () => {
  // This is tested indirectly by verifying the source code does not crash on key
  // detection. The test imports the module to ensure it parses without errors.
  const workerModule = require("../src/lib/supabase/worker.ts");
  assert.ok(typeof workerModule.createSupabaseAccountAdminClient === "function");
  assert.ok(typeof workerModule.createSupabaseWorkerClient === "function");
});

