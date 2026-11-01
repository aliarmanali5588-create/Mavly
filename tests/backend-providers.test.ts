import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BACKEND_CONNECTION_STATES,
  BACKEND_PROVIDERS,
  buildBackendCenterView,
  decideBackendSwitch,
  isActivatableState,
  isBackendConnectionState,
  isBackendProvider,
  isServingState,
  type BackendProviderView,
} from "../src/lib/backend-providers/types";
import {
  jwtProjectRef,
  jwtRole,
  parseSupabaseProjectUrl,
  preflightSupabaseCredentials,
  supabaseProviderConfig,
  verifySupabaseCredentials,
} from "../src/lib/backend-providers/supabase";

const migration = () =>
  readFile(
    new URL("../supabase/migrations/39_backend_providers.sql", import.meta.url),
    "utf8",
  );

/** Strip SQL comments so prose cannot satisfy a structural assertion. */
function sqlCode(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

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

// ── 1. Provider vocabulary ───────────────────────────────────────────────────

test("exactly two backend providers are supported", () => {
  assert.deepEqual([...BACKEND_PROVIDERS].sort(), [
    "external_supabase",
    "mavly_managed_neon",
  ]);
  assert.equal(isBackendProvider("mavly_managed_neon"), true);
  assert.equal(isBackendProvider("external_supabase"), true);
  // GitHub is source control, never a backend provider.
  assert.equal(isBackendProvider("github"), false);
  assert.equal(isBackendProvider("vercel"), false);
});

test("the eight required UI states exist and are the only accepted values", () => {
  assert.deepEqual(
    [...BACKEND_CONNECTION_STATES].sort(),
    [
      "connecting",
      "disconnecting",
      "failed",
      "not_connected",
      "provisioning",
      "ready",
      "reconnection_required",
      "suspended",
    ],
  );
  assert.equal(isBackendConnectionState("ready"), true);
  assert.equal(isBackendConnectionState("bogus"), false);
});

test("only ready serves, and only ready or provisioning may be activated", () => {
  assert.equal(isServingState("ready"), true);
  for (const state of BACKEND_CONNECTION_STATES) {
    if (state !== "ready") assert.equal(isServingState(state), false, state);
  }
  assert.equal(isActivatableState("ready"), true);
  assert.equal(isActivatableState("provisioning"), true);
  assert.equal(isActivatableState("failed"), false);
  assert.equal(isActivatableState("suspended"), false);
  assert.equal(isActivatableState("not_connected"), false);
  assert.equal(isActivatableState("reconnection_required"), false);
});

// ── 2. Switch rules ─────────────────────────────────────────────────────────

test("a first choice needs no confirmation", () => {
  const decision = decideBackendSwitch({
    currentActive: null,
    target: "external_supabase",
    targetStatus: "ready",
    confirmed: false,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresConfirmation, false);
});

test("switching away from a live backend requires explicit confirmation", () => {
  const unconfirmed = decideBackendSwitch({
    currentActive: "mavly_managed_neon",
    target: "external_supabase",
    targetStatus: "ready",
    confirmed: false,
  });
  assert.equal(unconfirmed.allowed, false);
  assert.equal(unconfirmed.refusal, "confirmation_required");
  assert.equal(unconfirmed.requiresConfirmation, true);
  assert.match(unconfirmed.confirmationMessage ?? "", /not deleted/i);

  const confirmed = decideBackendSwitch({
    currentActive: "mavly_managed_neon",
    target: "external_supabase",
    targetStatus: "ready",
    confirmed: true,
  });
  assert.equal(confirmed.allowed, true);
});

test("a switch is refused when the target is not connected or not ready", () => {
  assert.equal(
    decideBackendSwitch({
      currentActive: null,
      target: "external_supabase",
      targetStatus: null,
      confirmed: true,
    }).refusal,
    "target_not_connected",
  );
  assert.equal(
    decideBackendSwitch({
      currentActive: null,
      target: "external_supabase",
      targetStatus: "failed",
      confirmed: true,
    }).refusal,
    "target_not_ready",
  );
  assert.equal(
    decideBackendSwitch({
      currentActive: null,
      target: "external_supabase",
      targetStatus: "reconnection_required",
      confirmed: true,
    }).refusal,
    "target_not_ready",
  );
});

test("switching to the already-active provider is refused, not silently accepted", () => {
  const decision = decideBackendSwitch({
    currentActive: "external_supabase",
    target: "external_supabase",
    targetStatus: "ready",
    confirmed: true,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal, "already_active");
});

// ── 3. The page projection ──────────────────────────────────────────────────

function row(overrides: Partial<BackendProviderView>): BackendProviderView {
  return {
    provider: "external_supabase",
    status: "ready",
    active: false,
    config: {},
    hasServiceRoleKey: true,
    lastError: null,
    verifiedAt: null,
    connectedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test("the active provider is the one flagged active, and it sorts first", () => {
  const view = buildBackendCenterView({
    providers: [
      row({ provider: "mavly_managed_neon", active: false, status: "not_connected" }),
      row({ provider: "external_supabase", active: true }),
    ],
    managedBackendState: null,
  });
  assert.equal(view.activeProvider, "external_supabase");
  assert.equal(view.providers[0].provider, "external_supabase");
  assert.equal(view.needsChoice, false);
});

test("no provider at all means the page must ask for a choice", () => {
  const view = buildBackendCenterView({ providers: [], managedBackendState: null });
  assert.equal(view.activeProvider, null);
  assert.equal(view.needsChoice, true);
  assert.equal(view.legacyManagedBackend, false);
});

test("a ready managed backend with no provider row is reported as active, not absent", () => {
  /**
   * Pre-migration-39 projects have a working database and no provider row.
   * Telling that owner "no backend" would be false, so the projection keeps it.
   */
  const view = buildBackendCenterView({
    providers: [],
    managedBackendState: "ready",
  });
  assert.equal(view.activeProvider, "mavly_managed_neon");
  assert.equal(view.legacyManagedBackend, true);
  assert.equal(view.needsChoice, false);
});

test("a failed managed backend is not reported as an active backend", () => {
  const view = buildBackendCenterView({
    providers: [],
    managedBackendState: "failed",
  });
  assert.equal(view.activeProvider, null);
  assert.equal(view.needsChoice, true);
});

// ── 4. Supabase URL validation ──────────────────────────────────────────────

test("a Supabase project URL must be https and a real supabase host", () => {
  const good = parseSupabaseProjectUrl("https://abcdefghijkl.supabase.co");
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.projectRef, "abcdefghijkl");
    assert.equal(good.host, "abcdefghijkl.supabase.co");
  }

  assert.equal(parseSupabaseProjectUrl("http://abcdefghijkl.supabase.co").ok, false);
  assert.equal(parseSupabaseProjectUrl("not a url").ok, false);
  assert.equal(parseSupabaseProjectUrl("").ok, false);
  assert.equal(parseSupabaseProjectUrl(undefined).ok, false);
});

test("a lookalike host is rejected, not accepted by suffix", () => {
  /**
   * `evil-supabase.co` ends with "supabase.co" and would pass a naive suffix
   * check. The service-role key is sent to this origin, so the label before the
   * suffix is what must match.
   */
  const lookalike = parseSupabaseProjectUrl("https://evil-supabase.co");
  assert.equal(lookalike.ok, false);
  if (!lookalike.ok) assert.equal(lookalike.code, "url_not_supabase");

  const subdomain = parseSupabaseProjectUrl("https://abc.supabase.co.evil.com");
  assert.equal(subdomain.ok, false);

  // The regional .in domain is legitimate.
  assert.equal(parseSupabaseProjectUrl("https://abcdefghijkl.supabase.in").ok, true);
});

// ── 5. Credential preflight ─────────────────────────────────────────────────

test("JWT helpers read the project ref and the role", () => {
  const token = fakeJwt({ ref: "abcdefghijkl", role: "service_role" });
  assert.equal(jwtProjectRef(token), "abcdefghijkl");
  assert.equal(jwtRole(token), "service_role");
  assert.equal(jwtProjectRef("not-a-jwt"), null);
  assert.equal(jwtProjectRef(undefined), null);
});

test("matching credentials pass preflight", () => {
  const result = preflightSupabaseCredentials({
    projectUrl: "https://abcdefghijkl.supabase.co",
    anonKey: fakeJwt({ ref: "abcdefghijkl", role: "anon" }),
    serviceRoleKey: fakeJwt({ ref: "abcdefghijkl", role: "service_role" }),
  });
  assert.equal(result.ok, true);
});

test("keys from different projects are refused before any network call", () => {
  const result = preflightSupabaseCredentials({
    projectUrl: "https://abcdefghijkl.supabase.co",
    anonKey: fakeJwt({ ref: "abcdefghijkl", role: "anon" }),
    serviceRoleKey: fakeJwt({ ref: "zzzzzzzzzzzz", role: "service_role" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "keys_from_different_projects");
});

test("a key that is not actually a service-role key is refused", () => {
  /**
   * The dangerous case: an anon key pasted into the service-role field. The
   * connection would appear to work while every request silently ran with RLS
   * applied, and the user would debug their app instead of their key.
   */
  const result = preflightSupabaseCredentials({
    projectUrl: "https://abcdefghijkl.supabase.co",
    anonKey: fakeJwt({ ref: "abcdefghijkl", role: "anon" }),
    serviceRoleKey: fakeJwt({ ref: "abcdefghijkl", role: "anon" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "service_role_key_not_elevated");
});

test("keys that do not match the URL's project are refused", () => {
  const result = preflightSupabaseCredentials({
    projectUrl: "https://abcdefghijkl.supabase.co",
    anonKey: fakeJwt({ ref: "zzzzzzzzzzzz", role: "anon" }),
    serviceRoleKey: fakeJwt({ ref: "zzzzzzzzzzzz", role: "service_role" }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "keys_from_different_projects");
});

// ── 6. Live verification ────────────────────────────────────────────────────

const credentials = () => ({
  projectUrl: "https://abcdefghijkl.supabase.co",
  anonKey: fakeJwt({ ref: "abcdefghijkl", role: "anon" }),
  serviceRoleKey: fakeJwt({ ref: "abcdefghijkl", role: "service_role" }),
});

test("a reachable project with accepted keys verifies", async () => {
  const calls: string[] = [];
  const result = await verifySupabaseCredentials(credentials(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.projectRef, "abcdefghijkl");
  // Both keys are exercised: anon proves the project is up, service proves the
  // elevated key works.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith("https://abcdefghijkl.supabase.co/rest/v1/")));
});

test("a rejected anon key fails verification", async () => {
  let call = 0;
  const result = await verifySupabaseCredentials(credentials(), {
    fetchImpl: (async () => {
      call += 1;
      return new Response("{}", { status: call === 1 ? 401 : 200 });
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "anon_key_rejected");
});

test("a rejected service-role key fails verification", async () => {
  let call = 0;
  const result = await verifySupabaseCredentials(credentials(), {
    fetchImpl: (async () => {
      call += 1;
      return new Response("{}", { status: call === 2 ? 403 : 200 });
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "service_role_key_rejected");
});

test("an unreachable project is a failure, never a pass", async () => {
  const result = await verifySupabaseCredentials(credentials(), {
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "project_unreachable");
});

test("verification never echoes a credential in its messages", async () => {
  const creds = credentials();
  const result = await verifySupabaseCredentials(creds, {
    fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!result.message.includes(creds.anonKey));
    assert.ok(!result.message.includes(creds.serviceRoleKey));
  }
});

test("stored provider config carries no credential", () => {
  const config = supabaseProviderConfig({ projectRef: "abcdefghijkl", host: "abcdefghijkl.supabase.co" });
  const serialized = JSON.stringify(config);
  assert.match(serialized, /abcdefghijkl/);
  assert.ok(!/eyJ/.test(serialized), "no JWT may appear in stored config");
  assert.ok(!/service_role/i.test(serialized));
});

// ── 7. Migration 39 structure ───────────────────────────────────────────────

test("migration 39 enforces one active provider per project in the database", async () => {
  const sql = sqlCode(await migration());
  assert.match(
    sql,
    /create unique index if not exists project_backend_providers_one_active_idx\s+on public\.project_backend_providers \(project_id\)\s+where active/,
    "the one-active rule must be a partial unique index, not a convention",
  );
  assert.match(sql, /create unique index if not exists project_backend_providers_project_provider_key/);
});

test("migration 39 is additive and deletes no customer data", async () => {
  const sql = sqlCode(await migration());
  assert.ok(!/drop table/i.test(sql), "no table may be dropped");
  assert.ok(!/drop column/i.test(sql), "no column may be dropped");
  assert.ok(!/truncate/i.test(sql), "nothing may be truncated");
  assert.ok(!/delete from/i.test(sql), "nothing may be deleted");
  // It must not alter the tables it depends on.
  assert.ok(!/alter table public\.project_managed_backends/i.test(sql));
  assert.ok(!/alter table public\.project_secrets/i.test(sql));
  assert.ok(!/alter table public\.projects\b/i.test(sql));
});

test("migration 39 never stores the service-role key in project_secrets", async () => {
  const sql = sqlCode(await migration());
  /**
   * `project_secrets` syncs into a deployed app's environment, so a service-role
   * key there would hand RLS-bypass to generated code and every end user.
   */
  assert.ok(
    !/insert into public\.project_secrets/i.test(sql),
    "the service-role key must not become a project secret",
  );
  assert.match(sql, /service_role_ciphertext/);
  assert.match(
    sql,
    /service_role_ciphertext is null or provider = 'external_supabase'/,
    "only the Supabase provider may carry a service-role key",
  );
});

test("migration 39 grants no direct write to the authenticated role", async () => {
  const sql = sqlCode(await migration());
  assert.match(
    sql,
    /revoke insert, update, delete on public\.project_backend_providers\s+from authenticated, anon/,
  );
  assert.match(sql, /grant select on public\.project_backend_providers to authenticated/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /using \(user_id = auth\.uid\(\)\)/);
});

test("every provider RPC verifies project ownership itself", async () => {
  const sql = sqlCode(await migration());
  const ownerChecks = sql.match(/backend_provider_owner_ok\(p_project_id, v_user\)/g) ?? [];
  // read, connect, activate, disconnect.
  assert.ok(ownerChecks.length >= 4, `expected >= 4 owner checks, found ${ownerChecks.length}`);
  assert.match(sql, /message = 'project owner mismatch'/);
});

test("the service-role ciphertext is readable only by the service role", async () => {
  const sql = sqlCode(await migration());
  assert.match(sql, /read_backend_provider_secret/);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/);
  assert.match(
    sql,
    /revoke all on function public\.read_backend_provider_secret\(text\)\s+from public, anon, authenticated/,
  );
});

test("activation swaps providers under a per-project lock", async () => {
  const sql = sqlCode(await migration());
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('backend_provider:' \|\| p_project_id\)\)/);
  // The previous active row is deactivated before the target is activated.
  const deactivate = sql.indexOf("set active = false");
  const activate = sql.indexOf("set active = true");
  assert.ok(deactivate >= 0 && activate > deactivate, "deactivate must precede activate");
});

test("disconnecting the active backend is refused, not silently allowed", async () => {
  const sql = sqlCode(await migration());
  assert.match(sql, /if v_active then/);
  assert.match(sql, /switch to another backend before disconnecting this one/);
});

test("connecting does not activate", async () => {
  const sql = sqlCode(await migration());
  const connectBody = sql.slice(
    sql.indexOf("create or replace function public.connect_external_supabase"),
    sql.indexOf("create or replace function public.activate_backend_provider"),
  );
  assert.ok(connectBody.length > 500, "the connect body must be found");
  /**
   * The insert may name `active` only to pin it false. It must never set it true:
   * an unverified connection becoming authoritative is exactly the failure the
   * brief forbids.
   */
  assert.ok(
    !/set[^;]*active = true/i.test(connectBody),
    "connect must never activate a provider",
  );
  assert.match(connectBody, /'external_supabase', v_status, false/);
});

test("migration 39 records its schema marker as a version function", async () => {
  const sql = sqlCode(await migration());
  /**
   * The house convention (35, 37) is a `*_schema_version()` function. A marker
   * table would be a second, competing answer to "what is applied?".
   */
  assert.match(sql, /create or replace function public\.backend_providers_schema_version\(\)/);
  assert.match(sql, /as \$\$ select 39 \$\$/);
  assert.ok(!/insert into public\.schema_markers/.test(sql));
});

// ── 8. The route and service wiring ─────────────────────────────────────────

test("the backend route authorizes before it reads or writes", async () => {
  const route = await readFile(
    new URL("../src/app/api/projects/[projectId]/backend-providers/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /authorizeProjectRequest\(projectId\)/);
  /**
   * Authorization must precede every provider call. The CALL is matched, not the
   * identifier: `readBackendCenter` also appears in the import block at the top
   * of the file, which would make a naive index comparison meaningless.
   */
  const authIndex = route.indexOf("await authorizeProjectRequest(projectId)");
  const readIndex = route.indexOf("await readBackendCenter(");
  assert.ok(authIndex >= 0, "the route must authorize");
  assert.ok(readIndex >= 0, "the route must read the center");
  assert.ok(readIndex > authIndex, "authorization must run before the provider read");
  /**
   * The verified user id still reaches the service layer: `authorize()` derives it
   * from the ownership-checked session, and the switch/disconnect paths use that
   * same `auth` object. The manual `connect_supabase` branch that previously
   * carried `userId: auth.userId` is gone — it accepted a pasted service-role key,
   * which the Management API OAuth flow replaces — so the assertion now targets
   * the helper that every method goes through.
   */
  assert.match(route, /userId: authorized\.team\.userId/);
  assert.ok(!/userId: ""/.test(route), "an empty user id would make the key undecryptable");
});

test("the route exposes no credential in any response", async () => {
  const route = await readFile(
    new URL("../src/app/api/projects/[projectId]/backend-providers/route.ts", import.meta.url),
    "utf8",
  );
  /**
   * `serviceRoleKey` legitimately appears when the route READS the request body.
   * What matters is that it never appears in a response, so the assertion is
   * scoped to the response payloads rather than the whole file.
   */
  const responses = route.match(/apiData\([\s\S]*?\);/g) ?? [];
  assert.ok(responses.length > 0, "the route must return data");
  for (const response of responses) {
    assert.ok(!/serviceRoleKey/.test(response), "no response may carry a service-role key");
    assert.ok(!/ciphertext/i.test(response), "no response may carry a ciphertext");
    assert.ok(!/anonKey/.test(response), "no response may carry an anon key");
  }
});

test("the service encrypts the service-role key with the project-secrets key", async () => {
  const service = await readFile(
    new URL("../src/lib/backend-providers/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /encryptProjectSecretValue/);
  assert.match(service, /decryptProjectSecretValue/);
  assert.match(service, /projectSecretsCryptoConfig/);
  // The AAD must be provider-specific so a ciphertext cannot move between stores.
  assert.match(service, /backend-provider:/);
});

test("the service refuses to store credentials when encryption is unavailable", async () => {
  const service = await readFile(
    new URL("../src/lib/backend-providers/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /BACKEND_PROVIDERS_ENCRYPTION_UNAVAILABLE/);
  assert.match(service, /no credentials were saved/);
});

test("a switch refusal is reported as a confirmation request, not an error", async () => {
  const service = await readFile(
    new URL("../src/lib/backend-providers/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /BACKEND_SWITCH_CONFIRMATION_REQUIRED/);
  assert.match(service, /409/);
});

test("the UI renders the official assets and never lifts on hover", async () => {
  const component = await readFile(
    new URL("../src/components/workspace/v2/BackendCenter.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /\/svg\/supabase\.svg/);
  assert.match(component, /\/svg\/github\.svg/);
  // The clay contract: no positional movement on hover.
  assert.ok(!/hover:-translate/.test(component));
  assert.ok(!/hover:scale/.test(component));
  assert.ok(!/hover:translate/.test(component));
  // Press-in is allowed on :active only.
  assert.match(component, /active:shadow-\[var\(--clay-well-2\)\]/);
});

test("the UI keeps GitHub independent of backend selection", async () => {
  const component = await readFile(
    new URL("../src/components/workspace/v2/BackendCenter.tsx", import.meta.url),
    "utf8",
  );
  // GitHub is opened through the workspace's own dialog, not reimplemented.
  assert.match(component, /onOpenGithub/);
  assert.ok(
    !/switch.*github/i.test(component),
    "GitHub must never participate in provider switching",
  );
});

test("the old empty placeholder is gone from every workspace, not just the website one", async () => {
  const more = await readFile(
    new URL("../src/components/workspace/v2/WorkspaceMore.tsx", import.meta.url),
    "utf8",
  );
  assert.match(more, /BackendCenter/);
  assert.ok(
    !/DatabasePlaceholder/.test(more),
    "the empty placeholder must be replaced by the real center",
  );

  /**
   * ⚠️ THE ANDROID WORKSPACE HAD ITS OWN COPY OF THE DEAD TAB. Replacing only the
   * website one would leave an Android project with a Database tab that renders
   * an empty box, which is exactly the state this integration removes.
   */
  const android = await readFile(
    new URL("../src/components/workspace/AndroidWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(android, /BackendCenter/);
  assert.ok(
    !/DatabasePlaceholder/.test(android),
    "the Android Database tab must render the real center too",
  );

  /**
   * The placeholder component itself must be deleted, not merely unreferenced: a
   * leftover file is an invitation to wire it back in.
   */
  await assert.rejects(
    readFile(
      new URL("../src/components/workspace/DatabasePlaceholder.tsx", import.meta.url),
      "utf8",
    ),
    "the placeholder component must be deleted",
  );
});
