/**
 * ═══ BACKEND SELECTION AUTHORITY — TESTS ════════════════════════════════════
 *
 * Covers the product invariant: one project = one active backend = one
 * authoritative agent context.
 *
 * ⚠️ PER AGENTS.md, NO AUTOMATED VERIFICATION WAS RUN FOR THIS WORK. These tests
 * are written to be run by the human developer (`npm test`, Node 22.6+). Nothing
 * here was executed, and no result is claimed.
 *
 * The tests are split the way the risk is:
 *   · pure rules (context, staleness, role permissions) — no I/O;
 *   · migration 48 structure — read as text, because the invariant is SQL;
 *   · wiring — read as text, because "every agent gets it" is a structural fact.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BACKEND_CONTEXT_PROVIDERS,
  BACKEND_INSTRUCTIONS,
  ROLE_BACKEND_CONSTRAINTS,
  ROLE_BACKEND_PERMISSIONS,
  buildBackendAgentContext,
  detectStaleBackendContext,
  isBackendContextProvider,
  renderBackendContextBlock,
  type BackendContextRow,
} from "../src/lib/backend-providers/context";

const source = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const migration48 = () => source("supabase/migrations/48_backend_selection_authority.sql");

/** Strip SQL comments so prose cannot satisfy a structural assertion. */
function sqlCode(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

function row(overrides: Partial<BackendContextRow> = {}): BackendContextRow {
  return {
    backend_provider: "none",
    backend_status: "not_selected",
    backend_active: false,
    selection_epoch: 0,
    managed_ready: false,
    supabase_ready: false,
    supabase_project_ref: null,
    data_model: null,
    gateway_origin: null,
    ...overrides,
  };
}

// ── 1. No backend selected ──────────────────────────────────────────────────

test("no backend: the agent is told none exists and must not assume one", () => {
  const context = buildBackendAgentContext(row());
  assert.equal(context.backend_provider, "none");
  assert.equal(context.backend_active, false);
  assert.equal(context.database_owner, "none");
  assert.equal(context.schema_access, false);
  assert.match(context.backend_instructions, /No backend has been selected/);
  assert.match(context.backend_instructions, /Do not assume Neon or Supabase/);
});

test("no backend: the rendered block names both providers as unavailable", () => {
  const block = renderBackendContextBlock(buildBackendAgentContext(row()));
  assert.match(block, /Provider: none/);
  assert.match(block, /Active: no/);
  assert.match(block, /Schema access: not available/);
});

// ── 2. Managed Neon active ──────────────────────────────────────────────────

test("managed neon active: owner is mavly and schema access is granted", () => {
  const context = buildBackendAgentContext(
    row({
      backend_provider: "mavly_managed_neon",
      backend_status: "ready",
      backend_active: true,
      managed_ready: true,
      selection_epoch: 3,
    }),
  );
  assert.equal(context.database_owner, "mavly");
  assert.equal(context.schema_access, true);
  assert.equal(context.selection_epoch, 3);
  assert.match(context.backend_instructions, /Never attempt to use customer Supabase/);
  assert.match(context.backend_instructions, /never create a competing backend/i);
});

// ── 3. Customer Supabase active ─────────────────────────────────────────────

test("supabase active: owner is customer and the competing Neon backend is forbidden", () => {
  const context = buildBackendAgentContext(
    row({
      backend_provider: "external_supabase",
      backend_status: "ready",
      backend_active: true,
      supabase_ready: true,
      supabase_project_ref: "abcdefghijklmnop",
    }),
  );
  assert.equal(context.database_owner, "customer");
  assert.equal(context.schema_access, true);
  assert.match(context.backend_instructions, /Never provision a competing Neon backend/);
});

// ── 4. Selected but not ready ───────────────────────────────────────────────

test("a selected but unready backend keeps its provider and denies schema access", () => {
  const context = buildBackendAgentContext(
    row({
      backend_provider: "mavly_managed_neon",
      backend_status: "provisioning",
      backend_active: true,
      managed_ready: false,
    }),
  );
  /**
   * ⚠️ THE PROVIDER IS NOT COLLAPSED TO `none`. Reporting "no backend" here would
   * invite the agent to propose a different provider, which is the silent switch
   * the product forbids.
   */
  assert.equal(context.backend_provider, "mavly_managed_neon");
  assert.equal(context.schema_access, false);
});

test("an unready backend's block forbids claiming working persistence", () => {
  const block = renderBackendContextBlock(
    buildBackendAgentContext(
      row({
        backend_provider: "external_supabase",
        backend_status: "reconnection_required",
        backend_active: true,
        supabase_ready: false,
      }),
    ),
  );
  assert.match(block, /not currently usable/);
  assert.match(block, /do not switch to another provider/);
});

test("an inactive provider never grants schema access even when ready", () => {
  const context = buildBackendAgentContext(
    row({
      backend_provider: "external_supabase",
      backend_status: "ready",
      backend_active: false,
      supabase_ready: true,
    }),
  );
  assert.equal(context.schema_access, false);
});

// ── 5. Stale context during a generation ────────────────────────────────────

test("a provider change mid-run is detected as stale", () => {
  const result = detectStaleBackendContext({
    startedEpoch: 1,
    currentEpoch: 2,
    startedProvider: "mavly_managed_neon",
    currentProvider: "external_supabase",
  });
  assert.equal(result.stale, true);
  assert.equal(result.stale && result.reason, "provider_changed");
});

test("an epoch bump alone is stale even when the provider name matches", () => {
  const result = detectStaleBackendContext({
    startedEpoch: 4,
    currentEpoch: 5,
    startedProvider: "mavly_managed_neon",
    currentProvider: "mavly_managed_neon",
  });
  assert.equal(result.stale, true);
  assert.equal(result.stale && result.reason, "epoch_changed");
});

test("an unchanged selection is not stale", () => {
  const result = detectStaleBackendContext({
    startedEpoch: 7,
    currentEpoch: 7,
    startedProvider: "external_supabase",
    currentProvider: "external_supabase",
  });
  assert.equal(result.stale, false);
});

// ── 6. Every role is constrained ────────────────────────────────────────────

test("all seven roles have a backend permission and a constraint", () => {
  const roles = Object.keys(ROLE_BACKEND_PERMISSIONS).sort();
  assert.deepEqual(roles, [
    "coding",
    "deployment",
    "planner",
    "qa",
    "repair",
    "security",
    "ui_ux",
  ]);
  for (const role of roles) {
    const constraint = ROLE_BACKEND_CONSTRAINTS[role as keyof typeof ROLE_BACKEND_CONSTRAINTS];
    assert.equal(typeof constraint, "string");
    assert.ok(constraint.length > 20, `${role} constraint is too thin`);
  }
});

test("the repair role may never change the provider", () => {
  assert.equal(ROLE_BACKEND_PERMISSIONS.repair, "never_change_provider");
  assert.match(ROLE_BACKEND_CONSTRAINTS.repair, /Never change, replace or switch/);
});

test("the ui_ux role may not invent backend infrastructure", () => {
  assert.equal(ROLE_BACKEND_PERMISSIONS.ui_ux, "no_backend_infrastructure");
  assert.match(ROLE_BACKEND_CONSTRAINTS.ui_ux, /Do not invent backend infrastructure/);
});

test("every provider has an instruction block", () => {
  for (const provider of BACKEND_CONTEXT_PROVIDERS) {
    assert.ok(BACKEND_INSTRUCTIONS[provider].length > 40, provider);
  }
});

test("the context provider vocabulary is closed", () => {
  assert.equal(isBackendContextProvider("managed_neon"), false);
  assert.equal(isBackendContextProvider("mavly_managed_neon"), true);
  assert.equal(isBackendContextProvider("none"), true);
  assert.equal(isBackendContextProvider("supabase"), false);
});

// ── 7. Migration 48: the database invariant ─────────────────────────────────

test("migration 48 registers managed neon as a provider row", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /register_managed_backend_provider/);
  assert.match(sql, /'mavly_managed_neon'/);
});

test("migration 48 keeps the one-active-provider index authoritative", async () => {
  const sql = sqlCode(await migration48());
  /**
   * The index itself lives in migration 39; 48 must not drop or weaken it.
   */
  assert.doesNotMatch(sql, /drop\s+index[^;]*project_backend_providers_one_active_idx/i);
  assert.doesNotMatch(sql, /drop\s+constraint[^;]*one_active/i);
});

test("migration 48 proves readiness per provider before activating", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /managed_backend_is_ready/);
  assert.match(sql, /supabase connection is not verified/);
  assert.match(sql, /supabase connection is not active/);
});

test("migration 48 serializes activation under a per-project advisory lock", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('backend_provider:' \|\| p_project_id\)\)/);
});

test("migration 48 bumps the selection epoch only on a real change", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /backend_selection_epoch = p\.backend_selection_epoch \+ 1/);
  assert.match(sql, /if v_current is distinct from p_provider then/);
});

test("migration 48 refuses to guess when two providers are active", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /multiple active backends for project/);
});

test("the backend context RPC is service-role only", async () => {
  const sql = sqlCode(await migration48());
  const contextFn = sql.slice(sql.indexOf("function public.read_backend_context"));
  assert.match(contextFn, /auth\.role\(\) <> 'service_role'/);
  assert.match(contextFn, /revoke all on function public\.read_backend_context\(text\)/);
  assert.match(
    contextFn,
    /grant execute on function public\.read_backend_context\(text\) to service_role/,
  );
});

test("migration 48 deletes no customer data and drops no database", async () => {
  const sql = sqlCode(await migration48()).toLowerCase();
  assert.doesNotMatch(sql, /delete\s+from/);
  assert.doesNotMatch(sql, /truncate/);
  assert.doesNotMatch(sql, /drop\s+table/);
  assert.doesNotMatch(sql, /drop\s+database/);
});

test("migration 48 backfills an existing ready managed backend", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /backfilled/);
  assert.match(sql, /on conflict \(project_id, provider\) do nothing/);
});

test("migration 48 repairs the ambiguous provider reference in connect", async () => {
  const sql = sqlCode(await migration48());
  /**
   * ⚠️ REGRESSION GUARD. `connect_external_supabase` declares an OUT parameter
   * named `provider` and writes `on conflict (project_id, provider)`, which raised
   * "column reference provider is ambiguous" on every call. Without the directive
   * the customer Supabase connection path silently never worked.
   */
  assert.match(sql, /#variable_conflict use_column/);
  assert.match(sql, /create or replace function public\.connect_external_supabase\(/);
});

test("migration 48 does not edit migration 39 in place", async () => {
  const text = await source("supabase/migrations/39_backend_providers.sql");
  /**
   * The repair must live in 48. An applied migration is never rewritten, because
   * environments that already ran it would keep the old function body.
   */
  assert.doesNotMatch(text, /#variable_conflict use_column/);
});

test("migration 48 records its schema marker as a version function", async () => {
  const sql = sqlCode(await migration48());
  assert.match(sql, /backend_selection_schema_version/);
  assert.match(sql, /select 48/);
});

// ── 8. Agent wiring: every path receives the context ────────────────────────

test("the coding engine emits the backend block for every profile", async () => {
  const text = await source("src/lib/ai/agent.ts");
  assert.match(text, /renderBackendContextBlock/);
  assert.match(text, /backendAgentContext/);
  /**
   * ⚠️ THE OLD EARLY RETURN IS THE BUG. `!managedBackendContext || profile ===
   * "android"` returned before any backend was described, which is why a Supabase
   * project and an Android project were both told nothing.
   */
  assert.doesNotMatch(text, /if \(!managedBackendContext \|\| profile === "android"\)/);
});

test("every orchestration role receives the same context through one funnel", async () => {
  const text = await source("src/lib/orchestration/engine.ts");
  assert.match(text, /function roleSystemPrompt/);
  assert.match(text, /renderBackendContextBlock/);
  assert.match(text, /ROLE_BACKEND_CONSTRAINTS/);
  /** The system message must go through the funnel, not the raw prompt. */
  assert.match(text, /content: roleSystemPrompt\(handle, input\.role, input\.system\)/);
  assert.doesNotMatch(text, /content: input\.system/);
});

test("an unresolved selection is stated as unresolved, not as none", async () => {
  const text = await source("src/lib/orchestration/engine.ts");
  assert.match(text, /could not be resolved/);
  assert.match(text, /Do not assume Neon or Supabase is available/);
});

test("the run resolves the backend from the database before agents run", async () => {
  const text = await source("src/lib/mavly/run-agent.ts");
  assert.match(text, /resolveBackendContext/);
  assert.match(text, /backendAgentContext: backendContext/);
});

test("a backend switch mid-generation stops the run", async () => {
  const text = await source("src/lib/mavly/run-agent.ts");
  assert.match(text, /verifyBackendContextUnchanged/);
  assert.match(text, /code === "stale"/);
});

test("provisioning registers the managed provider row", async () => {
  const text = await source("src/lib/mavly/run-agent.ts");
  assert.match(text, /register_managed_backend_provider/);
});

// ── 9. Gateway: exactly one provider, no fallback ───────────────────────────

test("the gateway checks the selected provider before opening a connection", async () => {
  const text = await source("src/lib/app-data/context.ts");
  assert.match(text, /readActiveProvider/);
  assert.match(text, /read_backend_context/);
});

test("the gateway refuses a supabase-selected project instead of falling back", async () => {
  const text = await source("src/lib/app-data/context.ts");
  assert.match(text, /backend_not_served_here/);
  /**
   * ⚠️ NO SILENT FALLBACK. The refusal must return before the managed connection
   * is decrypted, so a Supabase project can never be served from Neon.
   */
  const refusal = text.indexOf("backend_not_served_here");
  const decrypt = text.indexOf("decryptManagedBackendConnection(");
  assert.ok(refusal > 0 && decrypt > 0);
  assert.ok(refusal < decrypt, "the provider refusal must precede the managed connection");
});

// ── 10. The enable action is not a switch ───────────────────────────────────

test("enabling the managed backend refuses a supabase-active project", async () => {
  const text = await source("src/lib/backend-providers/enable-managed.ts");
  assert.match(text, /Switch your backend before enabling Mavly's/);
  assert.match(text, /outcome: "blocked"/);
});

test("enabling never provisions without a validated data model", async () => {
  const text = await source("src/lib/backend-providers/enable-managed.ts");
  assert.match(text, /hasDataModel: false/);
  /** It must not call the provisioning service. */
  assert.doesNotMatch(text, /ensureManagedBackend/);
  assert.doesNotMatch(text, /configureManagedBackend/);
});

test("the enable action is exposed by the route and documented", async () => {
  const text = await source("src/app/api/projects/[projectId]/backend-providers/route.ts");
  assert.match(text, /action === "enable_managed"/);
  assert.match(text, /enableManagedBackend/);
});

// ── 11. UI lock states ──────────────────────────────────────────────────────

test("the managed card is actionable and locks against an active Supabase", async () => {
  const text = await source("src/components/workspace/v2/BackendCenter.tsx");
  assert.match(text, /Enable Backend/);
  assert.match(text, /enable_managed/);
  assert.match(text, /LockIcon/);
  assert.match(
    text.replace(/\s+/g, " "),
    /To use Mavly&apos;s backend, switch your backend/,
  );
});

test("the supabase card locks against an active managed backend", async () => {
  const text = await source("src/components/workspace/v2/BackendCenter.tsx");
  /** The sentence wraps across JSX lines, so match it whitespace-tolerantly. */
  assert.match(
    text.replace(/\s+/g, " "),
    /To use your own Supabase project, switch your active backend first/,
  );
});

test("a locked card is not styled as an error", async () => {
  const text = await source("src/components/workspace/v2/BackendCenter.tsx");
  const locked = text.slice(text.indexOf("backend-supabase-locked"));
  const block = locked.slice(0, 600);
  /** Muted text, never the destructive palette. */
  assert.match(block, /text-muted-foreground/);
  assert.doesNotMatch(block, /destructive/);
});
