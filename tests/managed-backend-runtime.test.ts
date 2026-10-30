import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  detectBackendRequirement,
} from "../src/lib/managed-backend/requirement";
import {
  appDataModelFingerprint,
  parseAppDataModel,
  type AppDataModel,
} from "../src/lib/managed-backend/model";
import {
  AUTH_SESSIONS_TABLE,
  AUTH_USERS_TABLE,
  buildSchemaPlan,
  schemaLedgerSql,
} from "../src/lib/managed-backend/migrations";
import {
  canTransitionManagedBackend,
  managedBackendCapabilities,
  managedBackendNextAction,
} from "../src/lib/managed-backend/lifecycle";
import {
  dataApiContractBlock,
  dataApiBase,
} from "../src/lib/managed-backend/prompt";
import {
  appOriginFor,
  originAllowed,
} from "../src/lib/app-data/cors";
import {
  buildCreateQuery,
  buildDeleteQuery,
  buildListQuery,
  buildReadQuery,
  buildUpdateQuery,
  escapeLike,
  type DataColumn,
} from "../src/lib/app-data/query";
import {
  clearedSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  passwordProblem,
  sessionCookieName,
  sessionCookie,
  sessionTokenFromCookie,
  SESSION_TOKEN_PATTERN,
  verifyPassword,
} from "../src/lib/app-data/auth";

/**
 * ═══ MANAGED BACKEND RUNTIME — PURE AND STATIC ══════════════════════════════
 *
 * Nothing here provisions Neon, connects to a database, calls the gateway or
 * runs a migration. These tests pin the decisions that make the feature safe:
 * which requests may provision, which models compile, what the compiler may
 * emit, when `ready` is allowed, and how a row is scoped to a user.
 *
 * The repository's AGENTS.md forbids agents from running tests; this file was
 * authored but not executed.
 */

const BASE_PROMPT = "A colorful hero section for a cafe";

function validModel(): AppDataModel {
  const parsed = parseAppDataModel({
    version: 1,
    auth: { required: false, allowSignup: false },
    tables: [
      {
        name: "notes",
        userOwned: false,
        columns: [
          { name: "title", type: "text", required: true, maxLength: 200 },
  { name: "pinned", type: "boolean", required: false, maxLength: null },
        ],
      },
    ],
    resources: [
      {
        name: "notes",
        table: "notes",
        ownership: "public",
        operations: ["list", "read"],
        filterable: ["title"],
        orderBy: { column: "created_at", direction: "desc" },
      },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? "" : (parsed as { ok: false; error: string }).error);
  return (parsed as { ok: true; model: AppDataModel }).model;
}

function authenticatedModel(): AppDataModel {
  const parsed = parseAppDataModel({
    version: 1,
    auth: { required: true, allowSignup: true },
    tables: [
      {
        name: "tasks",
        userOwned: true,
        columns: [{ name: "title", type: "text", required: true }],
      },
    ],
    resources: [
      {
        name: "tasks",
        table: "tasks",
        ownership: "user",
        operations: ["list", "create", "read", "update", "delete"],
        filterable: ["title"],
        orderBy: { column: "created_at", direction: "desc" },
      },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? "" : (parsed as { ok: false; error: string }).error);
  return (parsed as { ok: true; model: AppDataModel }).model;
}

const COLUMNS: DataColumn[] = [
  { name: "title", type: "text", required: true, maxLength: 200 },
  { name: "pinned", type: "boolean", required: false, maxLength: null },
];

// ── Requirement detection ───────────────────────────────────────────────────

test("a static landing page never provisions, even if the planner asks", () => {
  const decision = detectBackendRequirement({
    prompt: "A one page landing page for my bakery",
    planner: { requiresDatabase: true, reason: "maybe" },
    projectType: "website",
  });
  assert.equal(decision.required, false);
  assert.equal(decision.overridden, true);
});

test("a clearly persistent request overrides a static planner signal without provisioning", () => {
  const decision = detectBackendRequirement({
    prompt: "A notes app where notes are saved and survive a reload",
    planner: { requiresDatabase: false },
    projectType: "website",
  });
  assert.equal(decision.required, true);
  assert.equal(decision.overridden, true);
  // No validated model exists, so the stage must not create an empty database.
  assert.equal(decision.modelMissing, true);
});

test("a planner-required backend enables auth only when the product asks for accounts", () => {
  const withAuth = detectBackendRequirement({
    prompt: "A private dashboard with login for each member",
    planner: { requiresDatabase: true, authentication: true },
    projectType: "website",
  });
  assert.equal(withAuth.required, true);
  assert.equal(withAuth.authentication, true);

  const withoutAuth = detectBackendRequirement({
    prompt: "A saved list of books",
    planner: { requiresDatabase: true, authentication: false },
    projectType: "website",
  });
  assert.equal(withoutAuth.required, true);
  assert.equal(withoutAuth.authentication, false);
});

test("Android projects never get a managed backend", () => {
  const decision = detectBackendRequirement({
    prompt: "A notes app with saved notes",
    planner: { requiresDatabase: true },
    projectType: "android",
  });
  assert.equal(decision.required, false);
});

test("a read-only request with no signal is not provisioned", () => {
  const decision = detectBackendRequirement({
    prompt: BASE_PROMPT,
    planner: null,
    projectType: "website",
  });
  assert.equal(decision.required, false);
  assert.equal(decision.overridden, false);
});

// ── Data model validation ───────────────────────────────────────────────────

test("a valid model is accepted and fingerprinted deterministically", () => {
  const model = validModel();
  assert.equal(model.tables.length, 1);
  assert.equal(model.resources[0].orderBy.column, "created_at");
  const reordered = parseAppDataModel({
    ...model,
    tables: [...model.tables],
    resources: [...model.resources],
  });
  assert.equal(reordered.ok, true);
  assert.equal(
    appDataModelFingerprint(model),
    appDataModelFingerprint((reordered as { ok: true; model: AppDataModel }).model),
  );
});

test("reserved tables, reserved columns and unknown types are refused", () => {
  for (const [label, payload] of [
    [
      "reserved table",
      {
        tables: [{ name: "_mavly_auth_users", columns: [{ name: "email", type: "text" }] }],
        resources: [],
      },
    ],
    [
      "reserved column",
      {
        tables: [{ name: "notes", columns: [{ name: "owner_id", type: "uuid" }] }],
        resources: [],
      },
    ],
    [
      "unknown type",
      {
        tables: [{ name: "notes", columns: [{ name: "body", type: "bytea" }] }],
        resources: [],
      },
    ],
  ] as const) {
    const parsed = parseAppDataModel(payload);
    assert.equal(parsed.ok, false, label);
  }
});

test("a public resource cannot declare writes", () => {
  const parsed = parseAppDataModel({
    auth: { required: false },
    tables: [{ name: "notes", columns: [{ name: "title", type: "text" }] }],
    resources: [
      {
        name: "notes",
        table: "notes",
        ownership: "public",
        operations: ["list", "create"],
      },
    ],
  });
  assert.equal(parsed.ok, false);
});

test("an owner-scoped table requires end-user authentication", () => {
  const parsed = parseAppDataModel({
    auth: { required: false },
    tables: [{ name: "tasks", userOwned: true, columns: [{ name: "title", type: "text" }] }],
    resources: [],
  });
  assert.equal(parsed.ok, false);
});

test("a table cannot be used with mixed ownership", () => {
  const parsed = parseAppDataModel({
    auth: { required: true },
    tables: [{ name: "tasks", userOwned: true, columns: [{ name: "title", type: "text" }] }],
    resources: [
      { name: "tasks", table: "tasks", ownership: "user", operations: ["list"] },
      { name: "public-tasks", table: "tasks", ownership: "public", operations: ["list"] },
    ],
  });
  assert.equal(parsed.ok, false);
});

// ── Schema compiler ────────────────────────────────────────────────────────

const DESTRUCTIVE = /\b(?:drop|truncate|delete\s+from|alter\s+table\s+\S+\s+alter|grant|revoke|create\s+extension|create\s+function|do\s+\$)\b/i;

test("the compiler emits additive, idempotent steps and no destructive statement", () => {
  const plan = buildSchemaPlan(authenticatedModel());
  assert.equal(plan.steps.length, 2, "auth step + one table step");
  assert.equal(plan.steps[0].name, "auth:init");
  assert.equal(plan.steps[1].name, "table:tasks");
  for (const step of plan.steps) {
    assert.equal(step.checksum.length, 64);
    assert.match(step.sql, /if not exists/);
    assert.equal(DESTRUCTIVE.test(step.sql), false, step.sql);
    assert.equal(step.sql.includes("DATABASE_URL"), false);
  }
  assert.match(plan.steps[0].sql, new RegExp(AUTH_USERS_TABLE));
  assert.match(plan.steps[0].sql, new RegExp(AUTH_SESSIONS_TABLE));
  assert.match(plan.steps[1].sql, /owner_id/);
  assert.match(schemaLedgerSql(), /mavly_schema_migrations/);
});

test("the compiler is deterministic and expected columns cover the model", () => {
  const first = buildSchemaPlan(authenticatedModel());
  const second = buildSchemaPlan(authenticatedModel());
  assert.deepEqual(
    first.steps.map((step) => step.checksum),
    second.steps.map((step) => step.checksum),
  );
  assert.equal(first.tableCount, 3);
  const expected = new Set(first.expected.map((entry) => `${entry.table}.${entry.column}`));
  assert.equal(expected.has("tasks.title"), true);
  assert.equal(expected.has("tasks.owner_id"), true);
  assert.equal(expected.has("_mavly_auth_users.password_hash"), true);
});

test("a public model does not create auth tables", () => {
  const plan = buildSchemaPlan(validModel());
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.expected.some((entry) => entry.table === AUTH_USERS_TABLE), false);
});

// ── Lifecycle and capabilities ─────────────────────────────────────────────

test("the transition table refuses a jump from provisioning to ready", () => {
  assert.equal(canTransitionManagedBackend("provisioning", "provisioned"), true);
  assert.equal(canTransitionManagedBackend("provisioned", "configuring"), true);
  assert.equal(canTransitionManagedBackend("configuring", "ready"), true);
  assert.equal(canTransitionManagedBackend("provisioning", "ready"), false);
  assert.equal(canTransitionManagedBackend("failed", "ready"), false);
  assert.equal(canTransitionManagedBackend("cleanup_pending", "ready"), false);
});

test("capabilities separate a database from a working backend", () => {
  const provisionedOnly = managedBackendCapabilities({
    state: "provisioned",
    connectionVerified: true,
    schemaVerified: false,
    modelRegistered: false,
    gatewayConfigured: false,
    authenticationRequired: false,
    tableCount: 0,
  });
  assert.equal(provisionedOnly.database, true);
  assert.equal(provisionedOnly.schema, false);
  assert.equal(provisionedOnly.dataApi, false);
  assert.equal(provisionedOnly.persistentCrud, false);

  const ready = managedBackendCapabilities({
    state: "ready",
    connectionVerified: true,
    schemaVerified: true,
    modelRegistered: true,
    gatewayConfigured: true,
    authenticationRequired: true,
    tableCount: 2,
  });
  assert.equal(ready.persistentCrud, true);
  assert.equal(ready.authentication, true);

  const readyWithoutGateway = managedBackendCapabilities({
    state: "ready",
    connectionVerified: true,
    schemaVerified: true,
    modelRegistered: true,
    gatewayConfigured: false,
    authenticationRequired: true,
    tableCount: 2,
  });
  assert.equal(readyWithoutGateway.dataApi, false);
  assert.equal(readyWithoutGateway.persistentCrud, false);
});

test("a non-ready state always names a next action", () => {
  const next = managedBackendNextAction({
    state: "provisioned",
    connectionVerified: true,
    schemaVerified: false,
    modelRegistered: true,
    gatewayConfigured: false,
    authenticationRequired: false,
    tableCount: 1,
  });
  assert.equal(typeof next, "string");
  assert.equal(
    managedBackendNextAction({
      state: "ready",
      connectionVerified: true,
      schemaVerified: true,
      modelRegistered: true,
      gatewayConfigured: true,
      authenticationRequired: false,
      tableCount: 1,
    }),
    null,
  );
});

// ── Data gateway query builder ─────────────────────────────────────────────

const LIST_BASE = {
  table: "tasks",
  columns: COLUMNS,
  orderBy: { column: "created_at" as const, direction: "desc" as const },
  filterable: ["title"],
  filters: {},
  search: null,
  limit: 20,
  offset: 0,
};

test("a user-owned list binds the owner and only declared filter columns", () => {
  const query = buildListQuery({
    ...LIST_BASE,
    userOwned: true,
    userId: "11111111-1111-1111-1111-111111111111",
    filters: { title: "hello" },
  });
  assert.match(query.text, /"owner_id" = \$1/);
  assert.match(query.text, /"title" = \$2/);
  assert.equal(query.values[0], "11111111-1111-1111-1111-111111111111");
  assert.equal(query.values[1], "hello");
  assert.match(query.text, /limit \$3 offset \$4/);
});

test("an undeclared filter key is ignored rather than interpolated", () => {
  const query = buildListQuery({
    ...LIST_BASE,
    userOwned: false,
    userId: null,
    filters: { 'title"; drop table tasks; --': "x" },
  });
  assert.equal(query.text.includes("drop table"), false);
  assert.equal(query.values.length, 2);
});

test("a user-owned query without a session fails closed", () => {
  assert.throws(() =>
    buildListQuery({ ...LIST_BASE, userOwned: true, userId: null }),
  );
  assert.throws(() =>
    buildCreateQuery({
      table: "tasks",
      columns: COLUMNS,
      userOwned: true,
      userId: null,
      values: { title: "x" },
    }),
  );
  assert.throws(() =>
    buildDeleteQuery({
      table: "tasks",
      columns: COLUMNS,
      userOwned: true,
      userId: null,
      id: "11111111-1111-1111-1111-111111111111",
    }),
  );
});

test("create, update and delete bind values and validate the id", () => {
  const create = buildCreateQuery({
    table: "tasks",
    columns: COLUMNS,
    userOwned: true,
    userId: "11111111-1111-1111-1111-111111111111",
    values: { title: "hello", pinned: true },
  });
  assert.match(create.text, /insert into "tasks"/);
  assert.equal(create.values.length, 3);

  const read = buildReadQuery({
    table: "tasks",
    columns: COLUMNS,
    userOwned: true,
    userId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
  });
  assert.match(read.text, /"id" = \$1/);
  assert.match(read.text, /"owner_id" = \$2/);

  const update = buildUpdateQuery({
    table: "tasks",
    columns: COLUMNS,
    userOwned: true,
    userId: "11111111-1111-1111-1111-111111111111",
    values: { title: "changed" },
    id: "22222222-2222-2222-2222-222222222222",
  });
  assert.match(update.text, /"title" = \$1/);
  assert.match(update.text, /"updated_at" = now\(\)/);

  const remove = buildDeleteQuery({
    table: "tasks",
    columns: COLUMNS,
    userOwned: true,
    userId: "11111111-1111-1111-1111-111111111111",
    id: "22222222-2222-2222-2222-222222222222",
  });
  assert.match(remove.text, /delete from "tasks"/);

  assert.throws(() =>
    buildReadQuery({
      table: "tasks",
      columns: COLUMNS,
      userOwned: false,
      userId: null,
      id: "not-a-uuid",
    }),
  );
});

test("pagination is clamped and ILIKE wildcards are escaped", () => {
  const query = buildListQuery({
    ...LIST_BASE,
    userOwned: false,
    userId: null,
    limit: 5_000,
    offset: -10,
    search: "100%_complete",
  });
  assert.match(query.text, /limit \$1 offset \$2/);
  assert.deepEqual(query.values.slice(-2), [100, 0]);
  assert.equal(escapeLike("a_b%c"), "a\\_b\\%c");
});

// ── Auth primitives ────────────────────────────────────────────────────────

test("an email is normalized and a weak password is refused", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(passwordProblem("short"), "The password must be at least 10 characters.");
  assert.equal(
    passwordProblem("correct horse battery staple", "user@example.com"),
    null,
  );
});

test("a password hashes to a salted scrypt string and verifies", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(stored.includes("correct horse"), false);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong password value", stored), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("session tokens are opaque, hashed and cookie-scoped per project", () => {
  const token = createSessionToken();
  assert.match(token, SESSION_TOKEN_PATTERN);
  assert.equal(hashSessionToken(token).length, 64);
  assert.equal(hashSessionToken(token).includes(token), false);

  const cookie = sessionCookie("demo-site", token);
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/app\/v1\/apps\/demo-site/);
  assert.equal(sessionCookieName("Demo Site"), null);

  assert.equal(
    sessionTokenFromCookie(`a=1; ${sessionCookieName("demo-site")}=${token}; b=2`, "demo-site"),
    token,
  );
  assert.equal(
    sessionTokenFromCookie(`${sessionCookieName("demo-site")}=${token}`, "other-site"),
    null,
  );
  assert.match(clearedSessionCookie("demo-site") ?? "", /Max-Age=0/);
});

// ── Origin policy ──────────────────────────────────────────────────────────

test("the allowed origin is derived from the project, not supplied by a client", () => {
  assert.equal(appOriginFor("demo-site"), "https://demo-site.mavly.xyz");
  assert.equal(
    originAllowed("demo-site", "https://demo-site.mavly.xyz", "production"),
    true,
  );
  assert.equal(
    originAllowed("demo-site", "https://other-site.mavly.xyz", "production"),
    false,
  );
  assert.equal(
    originAllowed("demo-site", "https://evil.example.com", "production"),
    false,
  );
  assert.equal(originAllowed("demo-site", null, "production"), false);
  assert.equal(originAllowed("demo-site", "http://localhost:3000", "production"), false);
  assert.equal(originAllowed("demo-site", "http://localhost:3000", "development"), true);
});

// ── Contract text ──────────────────────────────────────────────────────────

test("the prompt contract names only the validated resources and forbids credentials", () => {
  const model = authenticatedModel();
  const block = dataApiContractBlock({
    origin: "https://app.example.com",
    projectId: "demo-site",
    model,
  });
  assert.equal(
    dataApiBase("https://app.example.com", "demo-site"),
    "https://app.example.com/api/app/v1/apps/demo-site",
  );
  assert.match(block, /\/data\/tasks/);
  assert.match(block, /\/auth\/signup/);
  assert.match(block, /do NOT read DATABASE_URL/);
  assert.match(block, /title \(text, required\)/);
  assert.equal(block.includes("password_hash"), false);
  assert.equal(block.includes("postgres://"), false);
});

// ── Static migration/route invariants ──────────────────────────────────────

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("migration 35 gates ready on schema + runtime + gateway and grants only what is needed", async () => {
  const migration = await source("supabase/migrations/35_managed_backend_runtime.sql");
  assert.match(migration, /project_managed_backends_ready_requires_schema/);
  assert.match(migration, /schema_verified_at is not null/);
  assert.match(migration, /runtime_verified_at is not null/);
  assert.match(migration, /gateway_secret_hash is not null/);
  assert.match(migration, /create or replace function public\.data_gateway_context/);
  assert.match(migration, /create or replace function public\.consume_app_gateway_rate/);
  assert.match(migration, /grant execute on function public\.managed_backend_status\(text\)\s+to authenticated, service_role;/);
  assert.match(migration, /revoke all on function public\.data_gateway_context\(text, text\)\s+from public;/);
  assert.match(migration, /select 35/);
  assert.equal(migration.includes("delete from public.projects"), false);
});

test("the public data routes resolve their own session and never read a DB credential", async () => {
  const list = await source(
    "src/app/api/app/v1/apps/[projectId]/data/[resource]/route.ts",
  );
  const item = await source(
    "src/app/api/app/v1/apps/[projectId]/data/[resource]/[id]/route.ts",
  );
  for (const route of [list, item]) {
    assert.match(route, /sessionTokenFromRequest/);
    assert.equal(route.includes("DATABASE_URL"), false);
    assert.equal(route.includes("createClient"), false);
  }
  assert.match(item, /handleDataUpdate/);
  assert.match(item, /handleDataDelete/);
});

test("the orchestrator never provisions without a validated model and worker dispatch", async () => {
  const runAgent = await source("src/lib/mavly/run-agent.ts");
  assert.match(runAgent, /detectBackendRequirement/);
  assert.match(runAgent, /if \(!model\)/);
  assert.match(runAgent, /configureManagedBackend/);
  assert.equal(runAgent.includes("createNeonProject"), false);
});
