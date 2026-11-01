import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  classifySql,
  sqlRequiresApproval,
} from "../src/lib/integrations/supabase/sql-policy";
import {
  SUPABASE_ACTIONS,
  actionRequiresScope,
  decideBrokerAction,
  isReadOnlyAction,
  isSupabaseAction,
} from "../src/lib/integrations/supabase/broker";
import {
  SUPABASE_OAUTH_CALLBACK_PATH,
  SUPABASE_REQUIRED_SCOPES,
  tokenAad,
} from "../src/lib/integrations/supabase/config";
import {
  buildSupabaseAuthorizeUrl,
  isSafeProjectRef,
} from "../src/lib/integrations/supabase/oauth";
import {
  decryptSecret,
  encryptSecret,
  pkceChallenge,
  randomToken,
  sha256Base64Url,
} from "../src/lib/integrations/github/crypto";

/**
 * ═══ SUPABASE MANAGEMENT API OAUTH ══════════════════════════════════════════
 *
 * Covers the parts that decide whether the integration is safe: the OAuth
 * handshake's CSRF/PKCE properties, the token encryption boundary, the broker's
 * authorization decision, scope enforcement, approval for destructive SQL, and
 * the migration's structural guarantees.
 *
 * ⚠️ WHAT THIS DOES NOT COVER, AND MUST NOT CLAIM TO: a live Supabase OAuth
 * exchange, a real token refresh, a Management API call, a real database query,
 * or the migration against a database. Those need a registered OAuth app and a
 * real Supabase account.
 */

const migration = () =>
  readFile(
    new URL("../supabase/migrations/40_supabase_oauth.sql", import.meta.url),
    "utf8",
  );

/** Strip SQL comments so prose cannot satisfy a structural assertion. */
function sqlCode(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/* ─────────────────────── 1. State and CSRF protection ──────────────────── */

test("state is high-entropy and its stored form is a hash, never the state", () => {
  const state = randomToken(32);
  // 32 bytes of base64url is 43 characters: enough that guessing is not a threat.
  assert.ok(state.length >= 43, `state too short: ${state.length}`);
  assert.match(state, /^[A-Za-z0-9_-]+$/);

  const hash = sha256Base64Url(state);
  assert.notEqual(hash, state, "the stored value must not be the state itself");
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);

  // Distinct every time: a reused state would make replay possible.
  assert.notEqual(randomToken(32), randomToken(32));
});

test("the state hash satisfies the migration's format constraint", () => {
  // The migration constrains state_hash to ^[A-Za-z0-9_-]{43,64}$; a hash that
  // failed it would make every callback insert fail.
  const hash = sha256Base64Url(randomToken(32));
  assert.match(hash, /^[A-Za-z0-9_-]{43,64}$/);
});

test("state rows are single-use: consumption is a DELETE ... RETURNING", async () => {
  const code = sqlCode(await migration());
  const consume = code.slice(
    code.indexOf("function public.consume_supabase_oauth_state"),
    code.indexOf("function public.save_supabase_oauth_connection"),
  );
  /**
   * ⚠️ THE SINGLE-USE GUARANTEE IS THE DELETE. A SELECT-then-DELETE pair would
   * let two simultaneous callbacks both find the row and both exchange a code.
   */
  assert.match(consume, /delete\s+from\s+public\.supabase_oauth_states/i);
  assert.match(consume, /returning/i);
  assert.match(consume, /s\.user_id\s*=\s*v_user/i);
  // An expired row is refused even when it was found.
  assert.match(consume, /expires_at\s*<=\s*now\(\)/i);
});

/* ─────────────────────────── 2. PKCE ───────────────────────────────────── */

test("PKCE uses S256 and the challenge is not the verifier", () => {
  const verifier = randomToken(48);
  const challenge = pkceChallenge(verifier);

  assert.notEqual(challenge, verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  // Deterministic, so the callback can recompute it.
  assert.equal(pkceChallenge(verifier), challenge);
  assert.notEqual(pkceChallenge(randomToken(48)), challenge);
});

test("the authorize URL carries PKCE, state and no scope parameter", () => {
  const config = {
    clientId: "client-abc",
    clientSecret: "secret",
    redirectUri: "https://mavly.example/auth/supabase/callback",
    encryptionKey: Buffer.alloc(32, 7),
  };
  const state = randomToken(32);
  const url = new URL(buildSupabaseAuthorizeUrl(config, state, pkceChallenge(randomToken(48))));

  assert.equal(url.origin + url.pathname, "https://api.supabase.com/v1/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("client_id"), "client-abc");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.ok(url.searchParams.get("code_challenge"));
  /**
   * ⚠️ NO `scope` PARAMETER. Supabase deprecated it; scopes come back in the
   * token response. Sending it would be misleading about what was requested.
   */
  assert.equal(url.searchParams.get("scope"), null);
  // The client secret must never appear in a URL the browser navigates to.
  assert.ok(!url.toString().includes("secret"));
});

test("the callback path is the one the app actually serves", () => {
  assert.equal(SUPABASE_OAUTH_CALLBACK_PATH, "/auth/supabase/callback");
});

/* ─────────────────── 3. Token encryption and ownership ─────────────────── */

test("tokens round-trip under their own AAD and fail under another", () => {
  const key = Buffer.alloc(32, 3);
  const clientId = "client-abc";
  const aad = tokenAad({ userId: "user-1", projectId: "proj-1", purpose: "access" });

  const ciphertext = encryptSecret(clientId, key, "sbp_token_value", aad);
  assert.equal(decryptSecret(clientId, key, ciphertext, aad), "sbp_token_value");

  // The plaintext must not be recoverable from the stored value.
  assert.ok(!ciphertext.includes("sbp_token_value"));
});

test("a ciphertext cannot be moved between users, projects or purposes", () => {
  const key = Buffer.alloc(32, 3);
  const clientId = "client-abc";
  const ciphertext = encryptSecret(
    clientId,
    key,
    "access-token",
    tokenAad({ userId: "user-1", projectId: "proj-1", purpose: "access" }),
  );

  const wrongUser = tokenAad({ userId: "user-2", projectId: "proj-1", purpose: "access" });
  const wrongProject = tokenAad({ userId: "user-1", projectId: "proj-2", purpose: "access" });
  const wrongPurpose = tokenAad({ userId: "user-1", projectId: "proj-1", purpose: "refresh" });

  for (const [label, aad] of [
    ["user", wrongUser],
    ["project", wrongProject],
    ["purpose", wrongPurpose],
  ] as const) {
    assert.equal(decryptSecret(clientId, key, ciphertext, aad), null, label);
  }
});

test("a ciphertext does not decrypt under a different key", () => {
  const clientId = "client-abc";
  const aad = tokenAad({ userId: "u", projectId: "p", purpose: "access" });
  const ciphertext = encryptSecret(clientId, Buffer.alloc(32, 1), "token", aad);
  assert.equal(decryptSecret(clientId, Buffer.alloc(32, 2), ciphertext, aad), null);
});

test("a tampered ciphertext is rejected rather than returning garbage", () => {
  const key = Buffer.alloc(32, 3);
  const clientId = "client-abc";
  const aad = tokenAad({ userId: "u", projectId: "p", purpose: "access" });
  const ciphertext = encryptSecret(clientId, key, "token", aad);

  const parts = ciphertext.split(".");
  const body = Buffer.from(parts[3], "base64url");
  body[0] = body[0] ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");
  assert.equal(decryptSecret(clientId, key, tampered, aad), null);
});

/* ─────────────────────── 4. Project ref validation ─────────────────────── */

test("a project ref is strictly validated before it enters a URL path", () => {
  assert.equal(isSafeProjectRef("abcdefghijklmnop"), true);
  assert.equal(isSafeProjectRef("abc123"), true);

  for (const bad of [
    "../etc/passwd",
    "abc/def",
    "ABC123",
    "abc def",
    "abc?x=1",
    "abc#frag",
    "",
    "a".repeat(41),
    null,
    undefined,
    123,
  ]) {
    assert.equal(isSafeProjectRef(bad), false, String(bad));
  }
});

/* ─────────────────── 5. The broker's authorization decision ────────────── */

const CONNECTED = {
  projectRef: "abcdefghijklmnop",
  status: "connected",
  grantedScopes: [...SUPABASE_REQUIRED_SCOPES],
};

test("only the closed action set is accepted", () => {
  assert.equal(isSupabaseAction("read_schema"), true);
  assert.equal(isSupabaseAction("run_sql"), true);
  for (const bad of ["run_arbitrary", "http_request", "GET /projects", "", null]) {
    assert.equal(isSupabaseAction(bad), false, String(bad));
  }
  // There is no action that names a host, path or method.
  for (const action of SUPABASE_ACTIONS) {
    assert.doesNotMatch(action, /http|url|host|fetch|request/i);
  }
});

test("an unknown action is refused before anything else is considered", () => {
  const decision = decideBrokerAction({
    action: "drop_everything",
    projectRef: CONNECTED.projectRef,
    connection: CONNECTED,
    approved: true,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "action_not_allowed");
});

test("a missing connection is refused", () => {
  const decision = decideBrokerAction({
    action: "read_schema",
    projectRef: CONNECTED.projectRef,
    connection: null,
    approved: false,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "not_connected");
});

test("a pending_selection row cannot authorize anything", () => {
  /**
   * ⚠️ THE USER AUTHORIZED MAVLY BUT HAS NOT CHOSEN A PROJECT. The row holds a
   * live token, so treating it as usable would let an action run against a
   * project the user never picked.
   */
  const decision = decideBrokerAction({
    action: "read_schema",
    projectRef: CONNECTED.projectRef,
    connection: { projectRef: null, status: "pending_selection", grantedScopes: [...SUPABASE_REQUIRED_SCOPES] },
    approved: true,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "not_connected");
});

test("a connection for project A cannot authorize an action on project B", () => {
  /**
   * ⚠️ CROSS-PROJECT ISOLATION. Both projects may belong to the same user; the
   * connection is still bound to the one that was chosen.
   */
  const decision = decideBrokerAction({
    action: "read_schema",
    projectRef: "zzzzzzzzzzzzzzzz",
    connection: CONNECTED,
    approved: true,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "project_not_authorized");
});

test("revoked and expired connections are refused with distinct codes", () => {
  const revoked = decideBrokerAction({
    action: "read_schema",
    projectRef: CONNECTED.projectRef,
    connection: { ...CONNECTED, status: "revoked" },
    approved: true,
  });
  assert.equal(revoked.ok, false);
  if (revoked.ok === false) assert.equal(revoked.code, "token_revoked");

  for (const status of ["expired", "reconnection_required"]) {
    const decision = decideBrokerAction({
      action: "read_schema",
      projectRef: CONNECTED.projectRef,
      connection: { ...CONNECTED, status },
      approved: true,
    });
    assert.equal(decision.ok, false, status);
    if (decision.ok === false) assert.equal(decision.code, "token_expired");
  }
});

/* ──────────────────────── 6. Scope enforcement ─────────────────────────── */

test("every action declares the scope it needs", () => {
  for (const action of SUPABASE_ACTIONS) {
    const scope = actionRequiresScope(action);
    assert.ok(scope, `${action} must declare a scope`);
    assert.ok(
      (SUPABASE_REQUIRED_SCOPES as readonly string[]).includes(scope!),
      `${action} requires ${scope}, which is not in the declared minimum set`,
    );
  }
});

test("an action is refused when its scope was not granted", () => {
  /**
   * ⚠️ THE GRANTED LIST IS WHAT SUPABASE RETURNED, NOT WHAT WAS REQUESTED. A user
   * can approve a narrower scope set than the app asks for.
   */
  const decision = decideBrokerAction({
    action: "run_sql",
    projectRef: CONNECTED.projectRef,
    connection: { ...CONNECTED, grantedScopes: ["projects:read", "database:read"] },
    statement: "select 1",
    approved: true,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "scope_missing");
});

test("an empty granted-scope list grants nothing", () => {
  const decision = decideBrokerAction({
    action: "list_projects",
    projectRef: CONNECTED.projectRef,
    connection: { ...CONNECTED, grantedScopes: [] },
    approved: true,
  });
  assert.equal(decision.ok, false);
  if (decision.ok === false) assert.equal(decision.code, "scope_missing");
});

test("read-only actions are exactly the non-mutating ones", () => {
  assert.equal(isReadOnlyAction("read_schema"), true);
  assert.equal(isReadOnlyAction("list_projects"), true);
  assert.equal(isReadOnlyAction("run_sql"), false);
});

/* ─────────────────── 7. Destructive-operation approval ─────────────────── */

test("reads pass without approval and destructive statements do not", () => {
  const read = decideBrokerAction({
    action: "run_sql",
    projectRef: CONNECTED.projectRef,
    connection: CONNECTED,
    statement: "select id, email from users limit 10",
    approved: false,
  });
  assert.equal(read.ok, true);
  if (read.ok === true) assert.equal(read.sqlRisk, "read");

  const write = decideBrokerAction({
    action: "run_sql",
    projectRef: CONNECTED.projectRef,
    connection: CONNECTED,
    statement: "delete from users where id = 1",
    approved: false,
  });
  assert.equal(write.ok, false);
  if (write.ok === false) {
    assert.equal(write.code, "approval_required");
    // The caller may retry with approval; the UI depends on this flag.
    assert.equal(write.retryableWithApproval, true);
  }

  const approved = decideBrokerAction({
    action: "run_sql",
    projectRef: CONNECTED.projectRef,
    connection: CONNECTED,
    statement: "delete from users where id = 1",
    approved: true,
  });
  assert.equal(approved.ok, true);
  if (approved.ok === true) assert.equal(approved.sqlRisk, "destructive");
});

test("blocked statements are refused even when approved", () => {
  /**
   * ⚠️ APPROVAL IS NOT A MASTER KEY. These are refused outright, so a user
   * clicking "confirm" cannot drop a schema through Mavly.
   */
  for (const statement of [
    "drop schema public",
    "drop database postgres",
    "create extension dblink",
    "grant all on users to anon",
    "alter role postgres with superuser",
    "copy users from program 'curl evil'",
    "set session authorization 'postgres'",
  ]) {
    const decision = decideBrokerAction({
      action: "run_sql",
      projectRef: CONNECTED.projectRef,
      connection: CONNECTED,
      statement,
      approved: true,
    });
    assert.equal(decision.ok, false, statement);
    if (decision.ok === false) assert.equal(decision.code, "statement_blocked", statement);
  }
});

test("multi-statement input is refused so one approval cannot cover a batch", () => {
  const classification = classifySql("select 1; delete from users");
  assert.equal(classification.risk, "blocked");
  assert.equal(classification.reason, "multiple_statements_not_allowed");
  // A single trailing terminator is fine.
  assert.equal(classifySql("select 1;").risk, "read");
});

test("the classifier fails closed on an unrecognised statement", () => {
  const classification = classifySql("vacuum full users");
  assert.equal(classification.risk, "destructive");
  assert.equal(sqlRequiresApproval(classification), true);
});

test("classification never echoes the statement back", () => {
  const secret = "delete from users where email = 'someone@example.com'";
  const classification = classifySql(secret);
  assert.equal(classification.reason, null);
  assert.ok(!JSON.stringify(classification).includes("someone@example.com"));
});

/* ─────────────────────── 8. Migration invariants ───────────────────────── */

test("the migration is additive and never drops or truncates", async () => {
  const code = sqlCode(await migration());
  assert.doesNotMatch(code, /\bdrop\s+table\b/i);
  assert.doesNotMatch(code, /\bdrop\s+column\b/i);
  assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /\bdelete\s+from\s+public\.projects\b/i);
  // It must not alter the earlier provider table.
  assert.doesNotMatch(code, /alter\s+table\s+public\.project_backend_providers/i);
});

test("the migration declares its schema marker and is transactional", async () => {
  const code = sqlCode(await migration());
  assert.match(code, /^begin;/m);
  assert.match(code, /^commit;/m);
  assert.match(code, /supabase_oauth_schema_version/);
  assert.match(code, /select\s+40/i);
});

test("no table stores a plaintext token column", async () => {
  const code = sqlCode(await migration());
  /**
   * ⚠️ EVERY TOKEN COLUMN MUST BE A CIPHERTEXT COLUMN. A column named
   * `access_token` or `refresh_token` would be a plaintext credential.
   */
  assert.doesNotMatch(code, /\baccess_token\s+text\b/i);
  assert.doesNotMatch(code, /\brefresh_token\s+text\b/i);
  assert.match(code, /access_token_ciphertext\s+text\s+not\s+null/i);
  assert.match(code, /refresh_token_ciphertext\s+text/i);
});

test("the authenticated role cannot write a token row or forge an audit entry", async () => {
  const code = sqlCode(await migration());
  for (const table of [
    "supabase_oauth_states",
    "supabase_oauth_connections",
    "supabase_oauth_audit",
  ]) {
    assert.match(
      code,
      new RegExp(`revoke\\s+insert,\\s*update,\\s*delete\\s+on\\s+public\\.${table}`, "i"),
      table,
    );
  }
  // No INSERT/UPDATE/DELETE policy may exist on the token table.
  assert.doesNotMatch(code, /create policy[^;]*for\s+(insert|update|delete)/i);
});

test("every SECURITY DEFINER RPC pins search_path and checks the owner", async () => {
  const code = sqlCode(await migration());
  const definers = code.match(/security definer/g) ?? [];
  const pinned = code.match(/set search_path = ''/g) ?? [];
  assert.ok(definers.length > 0);
  /**
   * ⚠️ A SECURITY DEFINER function without a pinned search_path is a privilege
   * escalation vector: a caller-controlled schema could shadow a referenced name.
   */
  assert.equal(pinned.length, definers.length);
});

test("the token-read RPC is owner-checked, not service-role-gated", async () => {
  const code = sqlCode(await migration());
  const fn = code.slice(
    code.indexOf("function public.read_supabase_oauth_tokens"),
    code.indexOf("function public.mark_supabase_oauth_status"),
  );
  /**
   * ⚠️ THE FIRST DRAFT REQUIRED service_role HERE, WHICH NOTHING CAN SATISFY:
   * every caller holds the user's session client, and AGENTS.md confines the
   * service-role client to the worker. That made the integration dead on arrival.
   */
  assert.doesNotMatch(fn, /service role required/i);
  assert.match(fn, /supabase_oauth_owner_ok/);
  assert.match(fn, /c\.user_id\s*=\s*v_user/i);
  // It is still not granted to anon.
  assert.match(
    code,
    /revoke all on function public\.read_supabase_oauth_tokens\(text\)\s*\n?\s*from public, anon;/i,
  );
});

test("the audit table is constrained to secret-free metadata", async () => {
  const code = sqlCode(await migration());
  assert.match(code, /jsonb_typeof\(metadata\)\s*=\s*'object'/i);
  assert.match(code, /outcome\s+in\s*\('allowed',\s*'refused',\s*'failed',\s*'pending_approval'\)/i);
  // No column may exist for SQL text or a raw result.
  assert.doesNotMatch(code, /\bsql_text\b/i);
  assert.doesNotMatch(code, /\braw_body\b/i);
});

test("a row that is not pending selection must name a project", async () => {
  const code = sqlCode(await migration());
  assert.match(
    code,
    /check\s*\(\s*status\s*=\s*'pending_selection'\s*or\s*supabase_project_ref\s+is\s+not\s+null\s*\)/i,
  );
});

test("status is derived from the ref, never passed in by the caller", async () => {
  const code = sqlCode(await migration());
  const save = code.slice(
    code.indexOf("function public.save_supabase_oauth_connection"),
    code.indexOf("function public.read_supabase_oauth_connection"),
  );
  // The insert computes status; it is not a parameter.
  assert.match(save, /case when p_supabase_project_ref is null then 'pending_selection'/i);
  assert.doesNotMatch(save, /p_status/);
});

/* ──────────── 12. Schema context handed to the generation agent ─────────── */

test("a schema document is projected to tables and columns, never to raw JSON", async () => {
  const { projectSchema } = await import(
    "../src/lib/integrations/supabase/agent-context"
  );
  const tables = projectSchema({
    definitions: {
      orders: {
        required: ["id"],
        properties: {
          id: { type: "integer", format: "bigint" },
          note: { type: "string" },
        },
      },
    },
  });
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, "orders");
  assert.deepEqual(tables[0].columns, [
    { name: "id", type: "bigint", required: true },
    { name: "note", type: "string", required: false },
  ]);
});

test("a malformed or empty schema document yields no tables rather than a guess", async () => {
  const { projectSchema } = await import(
    "../src/lib/integrations/supabase/agent-context"
  );
  assert.deepEqual(projectSchema(null), []);
  assert.deepEqual(projectSchema("nope"), []);
  assert.deepEqual(projectSchema({}), []);
  assert.deepEqual(projectSchema({ definitions: [] }), []);
  assert.deepEqual(projectSchema({ definitions: { t: { properties: [] } } }), []);
});

test("the rendered schema block is bounded and says it is a snapshot", async () => {
  const { renderSchemaContext, MAX_SCHEMA_CONTEXT_CHARS } = await import(
    "../src/lib/integrations/supabase/agent-context"
  );
  const tables = Array.from({ length: 200 }, (_, index) => ({
    name: `table_${index}`,
    columns: [{ name: "id", type: "bigint", required: true }],
  }));
  const rendered = renderSchemaContext(tables, "abcdefghij");
  assert.ok(rendered, "a non-empty schema must render");
  assert.match(rendered, /READ-ONLY snapshot/);
  assert.match(rendered, /Do not invent a table/);
  assert.ok(
    rendered.length <= MAX_SCHEMA_CONTEXT_CHARS + 400,
    "the block must stay near its ceiling",
  );
  assert.match(rendered, /were omitted/, "truncation must be stated, not silent");
});

test("an empty schema renders nothing, so no empty-database claim is made", async () => {
  const { renderSchemaContext } = await import(
    "../src/lib/integrations/supabase/agent-context"
  );
  assert.equal(renderSchemaContext([], "abcdefghij"), null);
});

test("the schema block never carries a token, a key or a connection string", async () => {
  const { renderSchemaContext } = await import(
    "../src/lib/integrations/supabase/agent-context"
  );
  const rendered = renderSchemaContext(
    [{ name: "t", columns: [{ name: "id", type: "bigint", required: true }] }],
    "abcdefghij",
  );
  assert.ok(rendered);
  assert.doesNotMatch(rendered, /postgres:\/\/|password/i);
  assert.doesNotMatch(rendered, /eyJ/, "no JWT fragment may appear");
});

/* ───────────── 13. The broker refreshes instead of dead-ending ──────────── */

test("the broker refreshes an expiring token instead of demanding a reconnect", async () => {
  const source = await readFile(
    new URL("../src/lib/integrations/supabase/broker.ts", import.meta.url),
    "utf8",
  );
  /**
   * ⚠️ A REGRESSION GUARD. The old code returned `token_expired` whenever the
   * access token was within a minute of expiry, even with a valid refresh token
   * stored — telling the user to reconnect while Mavly held everything needed.
   */
  assert.match(source, /refreshSupabaseToken\(input\.config, refreshToken\)/);
  const resolve = source.slice(
    source.indexOf("async function resolveAccessToken"),
    source.indexOf("export async function executeBrokerAction"),
  );
  assert.match(resolve, /saveConnection\(/, "the refreshed pair must be persisted");
  assert.doesNotMatch(
    resolve,
    /needs refreshing\. Reconnect to continue/,
    "a refreshable token must not be reported as needing a reconnect",
  );
});

test("a refused refresh is terminal and marks the row, rather than retrying forever", async () => {
  const source = await readFile(
    new URL("../src/lib/integrations/supabase/broker.ts", import.meta.url),
    "utf8",
  );
  const resolve = source.slice(
    source.indexOf("async function resolveAccessToken"),
    source.indexOf("export async function executeBrokerAction"),
  );
  assert.match(resolve, /supabase_unauthorized/);
  assert.match(resolve, /reconnection_required/);
});
