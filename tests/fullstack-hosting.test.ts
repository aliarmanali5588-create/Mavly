import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import {
  FULLSTACK_HOSTING_ENABLED_ENV,
  FULLSTACK_HOSTING_PROJECTS_ENV,
  fullstackConfigRefusal,
  isFullstackHostingProject,
  isFullstackHostingRequested,
  parseFullstackCohort,
  readFullstackHostingConfig,
} from "../src/lib/hosting/fullstack-config";
import {
  DATABASE_URL_SECRET_NAME,
  databaseConfigMatchesEnv,
  databaseConnectionFingerprint,
  databaseHostRejectionReason,
  parseDatabaseConnectionUrl,
} from "../src/lib/hosting/database-config";
import {
  RESERVED_ENV_KEYS,
  deploymentEnvReadiness,
  deploymentEnvTarget,
  envReadinessMessage,
  isProductionEnvRow,
  secretEnvKeyRejectionReason,
  type DeploymentEnvMetadata,
} from "../src/lib/hosting/deployment-env";
import {
  lifecycleFromReadyState,
  publicAttempt,
  wireFullstackStatus,
} from "../src/lib/deployments/fullstack";
import type { FullstackAttemptRow, FullstackDeploymentRow } from "../src/lib/hosting/fullstack-store";
import {
  planFullstackDeployment,
  snapshotHashMatches,
  unsafeDeploymentPath,
} from "../src/lib/runtime/deployment-plan";
import { hashSource } from "../src/lib/mavly/source-hash";

/**
 * ═══ PHASE 5 STATIC CONTRACT TESTS ══════════════════════════════════════════
 *
 * These exercise the PURE rules of full-stack hosting:
 *
 *   · the opt-in configuration gate (flag + explicit cohort + prerequisites);
 *   · the deployable runtime profile and its integrity hash;
 *   · the application database connection contract;
 *   · the deployment environment policy and readiness gate;
 *   · lifecycle → wire-status projection;
 *   · static invariants of migration 20 and of the source that writes it.
 *
 * ⚠️ WHAT IS NOT TESTED HERE: a real Vercel build, a real secret push, a real
 * database connection, Supabase RLS on the new tables, or the RPCs against a
 * database. Those need a disposable environment and remain human-run checks.
 */

const KEY = randomBytes(32).toString("base64");

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [FULLSTACK_HOSTING_ENABLED_ENV]: "on",
    [FULLSTACK_HOSTING_PROJECTS_ENV]: "proj-a,proj-b",
    MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "on",
    VERCEL_API_TOKEN: "test-token",
    MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY: KEY,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

function nextProject(extra: { path: string; content: string }[] = []) {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "generated-app",
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
    },
    {
      path: "app/layout.tsx",
      content:
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
    },
    {
      path: "app/page.tsx",
      content: "export default function Page() { return <main>hello</main>; }",
    },
    ...extra,
  ];
}

function row(overrides: Partial<FullstackDeploymentRow> = {}): FullstackDeploymentRow {
  return {
    project_id: "proj-a",
    provider: "vercel",
    status: "building",
    lifecycle: "building",
    deployment_kind: "fullstack",
    source_snapshot_id: "11111111-1111-1111-1111-111111111111",
    source_hash: "a".repeat(64),
    runtime_profile: "next-app-router",
    deployment_attempt: 1,
    vercel_project_id: "prj_123",
    vercel_project_name: "mavly-proj-a",
    vercel_deployment_id: "dpl_123",
    previous_deployment_id: null,
    url: "https://mavly-proj-a.vercel.app",
    error_code: null,
    error_message: null,
    mavly_hostname: "proj-a.mavly.xyz",
    mavly_domain_status: "verified",
    mavly_domain_error: null,
    mavly_domain_checked_at: null,
    ready_at: null,
    disabled_at: null,
    last_published_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as FullstackDeploymentRow;
}

function envRow(
  overrides: Partial<DeploymentEnvMetadata> = {},
): DeploymentEnvMetadata {
  return {
    secretName: "API_KEY",
    environment: "production",
    envKey: "API_KEY",
    target: "production",
    syncStatus: "synced",
    lastError: null,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as DeploymentEnvMetadata;
}

// ── configuration gate ─────────────────────────────────────────────────────

test("full-stack hosting is off unless the flag, cohort and prerequisites agree", () => {
  assert.equal(readFullstackHostingConfig({} as NodeJS.ProcessEnv).ok, false);
  assert.deepEqual(readFullstackHostingConfig({} as NodeJS.ProcessEnv), { ok: false, reason: "disabled" });

  const missingCohort = readFullstackHostingConfig(
    env({ [FULLSTACK_HOSTING_PROJECTS_ENV]: "" }),
  );
  assert.deepEqual(missingCohort, { ok: false, reason: "missing_cohort" });

  const wildcard = readFullstackHostingConfig(
    env({ [FULLSTACK_HOSTING_PROJECTS_ENV]: "*" }),
  );
  assert.deepEqual(wildcard, { ok: false, reason: "wildcard_cohort" });

  const wildcardEntry = readFullstackHostingConfig(
    env({ [FULLSTACK_HOSTING_PROJECTS_ENV]: "proj-a,*" }),
  );
  assert.deepEqual(wildcardEntry, { ok: false, reason: "wildcard_cohort" });

  const noProvider = readFullstackHostingConfig(
    env({ MAVLY_VERCEL_DEPLOYMENTS_ENABLED: "" }),
  );
  assert.deepEqual(noProvider, { ok: false, reason: "provider_not_configured" });

  const noSecretsKey = readFullstackHostingConfig(
    env({ MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY: "" }),
  );
  assert.deepEqual(noSecretsKey, { ok: false, reason: "secrets_key_missing" });

  const valid = readFullstackHostingConfig(env());
  assert.equal(valid.ok, true);
  if (valid.ok === true) {
    assert.equal(valid.config.provider, "vercel");
    assert.equal(valid.config.runtime, "nextjs");
    assert.deepEqual([...valid.config.cohort].sort(), ["proj-a", "proj-b"]);
  }
});

test("the cohort parser refuses an implicit or malformed project set", () => {
  assert.deepEqual(parseFullstackCohort(""), { ok: false, reason: "missing_cohort" });
  assert.deepEqual(parseFullstackCohort("  "), { ok: false, reason: "missing_cohort" });
  assert.deepEqual(parseFullstackCohort("*"), { ok: false, reason: "wildcard_cohort" });
  assert.deepEqual(parseFullstackCohort("proj a"), { ok: false, reason: "missing_cohort" });

  const parsed = parseFullstackCohort(" PROJ-A ; proj-b , ");
  assert.equal(parsed.ok, true);
  if (parsed.ok === true) {
    assert.deepEqual([...parsed.cohort].sort(), ["proj-a", "proj-b"]);
  }
});

test("a requested project is detected even when a prerequisite is missing", () => {
  // Fully configured.
  assert.equal(isFullstackHostingProject("proj-a", env()), true);
  assert.equal(isFullstackHostingProject("proj-z", env()), false);

  // The operator named the project but the token is absent. This must still be
  // detected so the deploy is REFUSED instead of silently published as static.
  const broken = env({ VERCEL_API_TOKEN: "" });
  assert.equal(isFullstackHostingProject("proj-a", broken), false);
  assert.equal(isFullstackHostingRequested("proj-a", broken), true);

  // Flag off means no intent at all: existing static behaviour is preserved.
  assert.equal(
    isFullstackHostingRequested("proj-a", env({ [FULLSTACK_HOSTING_ENABLED_ENV]: "" })),
    false,
  );
  // Wildcard is not an intent: the cohort is unusable.
  assert.equal(
    isFullstackHostingRequested(
      "proj-a",
      env({ [FULLSTACK_HOSTING_PROJECTS_ENV]: "*" }),
    ),
    false,
  );
});

test("every configuration refusal names the missing prerequisite without a value", () => {
  for (const reason of [
    "disabled",
    "missing_cohort",
    "wildcard_cohort",
    "provider_not_configured",
    "secrets_key_missing",
  ] as const) {
    const message = fullstackConfigRefusal(reason);
    assert.ok(message.length > 20);
    assert.doesNotMatch(message, /test-token/);
    assert.doesNotMatch(message, new RegExp(KEY.replace(/[+/=]/g, "\\$&")));
  }
});

// ── runtime profile and snapshot integrity ─────────────────────────────────

test("a generated Next.js App Router project resolves to a deployable plan", () => {
  const files = nextProject([
    { path: "app/api/hello/route.ts", content: "export async function GET() { return Response.json({ ok: true }); }" },
    { path: "src/middleware.ts", content: "export function middleware() {}" },
    { path: "app/actions.ts", content: '"use server";\nexport async function save() {}' },
  ]);
  const resolved = planFullstackDeployment(files);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.equal(resolved.plan.profile, "next-app-router");
  assert.equal(resolved.plan.sourceHash, hashSource(files));
  assert.deepEqual(resolved.plan.serverRoutePaths, ["app/api/hello/route.ts"]);
  assert.equal(resolved.plan.hasMiddleware, true);
  assert.equal(resolved.plan.usesServerActions, true);
  assert.equal(resolved.plan.requiresDatabase, false);
  assert.equal(resolved.plan.fileCount, files.length);
});

test("a source that reads DATABASE_URL is flagged as database-dependent", () => {
  const files = nextProject([
    {
      path: "app/api/db/route.ts",
      content:
        "const url = process.env.DATABASE_URL;\nexport async function GET() { return Response.json({ url: Boolean(url) }); }",
    },
  ]);
  const resolved = planFullstackDeployment(files);
  assert.equal(resolved.ok, true);
  if (resolved.ok === true) assert.equal(resolved.plan.requiresDatabase, true);
});

test("a static export is refused instead of silently dropping server routes", () => {
  const resolved = planFullstackDeployment(
    nextProject([
      { path: "next.config.js", content: 'module.exports = { output: "export" };' },
      { path: "app/api/hello/route.ts", content: "export async function GET() { return new Response('ok'); }" },
    ]),
  );
  assert.equal(resolved.ok, false);
  if (resolved.ok === false) {
    assert.equal(resolved.code, "unsupported_runtime");
    assert.match(resolved.summary, /static export/i);
  }
});

test("a non-Next or non-App-Router project is refused, not guessed", () => {
  const plain = planFullstackDeployment([
    { path: "index.html", content: "<html><body>static</body></html>" },
  ]);
  assert.equal(plain.ok, false);

  const noLayout = planFullstackDeployment([
    nextProject()[0],
    nextProject()[2],
  ]);
  assert.equal(noLayout.ok, false);
});

test("a snapshot path that could leak a secret or escape the tree is refused", () => {
  assert.equal(unsafeDeploymentPath(".env"), true);
  assert.equal(unsafeDeploymentPath(".env.local"), true);
  assert.equal(unsafeDeploymentPath("app/.env.production"), true);
  assert.equal(unsafeDeploymentPath("node_modules/react/index.js"), true);
  assert.equal(unsafeDeploymentPath(".git/config"), true);
  assert.equal(unsafeDeploymentPath("../escape.ts"), true);
  assert.equal(unsafeDeploymentPath("/etc/passwd"), true);
  assert.equal(unsafeDeploymentPath("app/page.tsx"), false);

  const refused = planFullstackDeployment(
    nextProject([{ path: ".env.production", content: "SECRET=value" }]),
  );
  assert.equal(refused.ok, false);
});

test("the deployment hash must equal the verified hash", () => {
  const hash = "a".repeat(64);
  assert.equal(snapshotHashMatches(hash, hash), true);
  assert.equal(snapshotHashMatches(hash, "b".repeat(64)), false);
  assert.equal(snapshotHashMatches(hash, null), false);
  assert.equal(snapshotHashMatches("", ""), false);
});

// ── application database contract ──────────────────────────────────────────

test("a TLS postgres URL is accepted and decomposed without exposing the password", () => {
  const url = "postgresql://app_user:s3cret-pass@db.example.com:5432/mavly_app?sslmode=require";
  const parsed = parseDatabaseConnectionUrl(url);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.metadata.provider, "postgres");
  assert.equal(parsed.metadata.host, "db.example.com");
  assert.equal(parsed.metadata.port, 5432);
  assert.equal(parsed.metadata.databaseName, "mavly_app");
  assert.equal(parsed.metadata.username, "app_user");
  assert.equal(parsed.metadata.sslMode, "require");
  assert.equal(parsed.metadata.connectionMode, "session");
  assert.equal(parsed.metadata.secretName, DATABASE_URL_SECRET_NAME);
  assert.match(parsed.metadata.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(databaseConnectionFingerprint(url), parsed.metadata.fingerprint);

  const serialized = JSON.stringify(parsed.metadata);
  assert.doesNotMatch(serialized, /s3cret-pass/);
});

test("Supabase pooler hosts are recognised and default to transaction mode", () => {
  const parsed = parseDatabaseConnectionUrl(
    "postgres://postgres.abcdef:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require",
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok === true) {
    assert.equal(parsed.metadata.provider, "supabase");
    assert.equal(parsed.metadata.connectionMode, "transaction");
  }
});

test("unsafe or incomplete database URLs are refused with an actionable message", () => {
  const cases: [unknown, RegExp][] = [
    [undefined, /required/i],
    ["", /required/i],
    ["mysql://u:p@db.example.com/app", /postgres/i],
    ["postgres://u:p@localhost:5432/app", /local database/i],
    ["postgres://u:p@10.0.0.5:5432/app", /private-network/i],
    ["postgres://u:p@[::1]:5432/app", /IPv6/i],
    ["postgres://db.example.com/app", /username/i],
    ["postgres://u@db.example.com/app", /password/i],
    ["postgres://u:p@db.example.com/app?sslmode=disable", /TLS is required/i],
    ["postgres://u:p@db.example.com:99999/app", /not a valid URL|port/i],
    ["postgres://u:p@db/app", /fully qualified/i],
  ];
  for (const [input, pattern] of cases) {
    const parsed = parseDatabaseConnectionUrl(input);
    assert.equal(parsed.ok, false, `refuses ${String(input)}`);
    if (parsed.ok === false) assert.match(parsed.error, pattern);
  }

  assert.match(String(databaseHostRejectionReason("127.0.0.1")), /private-network/);
  assert.match(String(databaseHostRejectionReason("service.internal")), /private-network/);
  assert.equal(databaseHostRejectionReason("db.example.com"), null);
});

test("database readiness requires the synced env row to carry the same fingerprint", () => {
  const fingerprint = databaseConnectionFingerprint(
    "postgres://u:p@db.example.com/app?sslmode=require",
  );
  assert.equal(
    databaseConfigMatchesEnv({
      fingerprint,
      envFingerprint: fingerprint,
      envStatus: "synced",
    }),
    true,
  );
  assert.equal(
    databaseConfigMatchesEnv({
      fingerprint,
      envFingerprint: fingerprint,
      envStatus: "failed",
    }),
    false,
  );
  assert.equal(
    databaseConfigMatchesEnv({
      fingerprint,
      envFingerprint: "b".repeat(64),
      envStatus: "synced",
    }),
    false,
  );
});

// ── environment policy and readiness ───────────────────────────────────────

test("Mavly, provider and browser-visible names cannot become application secrets", () => {
  for (const key of RESERVED_ENV_KEYS) {
    assert.match(String(secretEnvKeyRejectionReason(key)), /reserved|never injected/i);
  }
  assert.match(String(secretEnvKeyRejectionReason("NEXT_PUBLIC_API_KEY")), /browser bundle/i);
  assert.match(String(secretEnvKeyRejectionReason("MAVLY_ANYTHING")), /reserved/i);
  assert.match(String(secretEnvKeyRejectionReason("VERCEL_ANYTHING")), /reserved/i);
  assert.match(String(secretEnvKeyRejectionReason("")), /needs a name/i);
  assert.equal(secretEnvKeyRejectionReason("STRIPE_SECRET_KEY"), null);
  assert.equal(secretEnvKeyRejectionReason("DATABASE_URL"), null);
});

test("secrets map to the production target and development stays out of it", () => {
  assert.equal(deploymentEnvTarget("production"), "production");
  assert.equal(deploymentEnvTarget("both"), "production");
  assert.equal(deploymentEnvTarget("development"), "development");
  assert.equal(isProductionEnvRow({ environment: "production" }), true);
  assert.equal(isProductionEnvRow({ environment: "both" }), true);
  assert.equal(isProductionEnvRow({ environment: "development" }), false);
});

test("an unsynced production secret blocks readiness; revoked and development do not", () => {
  assert.equal(deploymentEnvReadiness([]).ready, true);

  for (const status of ["pending", "awaiting_project", "failed"] as const) {
    const readiness = deploymentEnvReadiness([envRow({ syncStatus: status })]);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.blockingKeys, ["API_KEY"]);
    assert.match(envReadinessMessage(readiness), /API_KEY/);
  }

  assert.equal(
    deploymentEnvReadiness([envRow({ syncStatus: "revoked" })]).ready,
    true,
  );
  assert.equal(
    deploymentEnvReadiness([
      envRow({ environment: "development", target: "development", syncStatus: "failed" }),
    ]).ready,
    true,
  );

  const awaiting = deploymentEnvReadiness([envRow({ syncStatus: "awaiting_project" })]);
  assert.equal(awaiting.reason, "awaiting_project");
  assert.match(envReadinessMessage(awaiting), /Re-save/);
});

// ── lifecycle → wire projection ────────────────────────────────────────────

test("provider readyState maps conservatively to the attempt lifecycle", () => {
  assert.equal(lifecycleFromReadyState("READY"), "ready");
  assert.equal(lifecycleFromReadyState("ERROR"), "failed");
  assert.equal(lifecycleFromReadyState("BLOCKED"), "failed");
  assert.equal(lifecycleFromReadyState("CANCELED"), "cancelled");
  assert.equal(lifecycleFromReadyState("BUILDING"), "building");
  assert.equal(lifecycleFromReadyState("QUEUED"), "building");
  assert.equal(lifecycleFromReadyState("something-new"), "building");
});

test("a ready deployment only becomes success once the Mavly address is verified", () => {
  const ready = wireFullstackStatus(
    row({
      lifecycle: "ready",
      status: "ready",
      mavly_domain_status: "verified",
      ready_at: "2026-01-02T00:00:00.000Z",
    }),
  );
  assert.equal(ready.status, "success");
  assert.equal(ready.liveUrl, "https://proj-a.mavly.xyz");
  assert.equal(ready.canUnpublish, true);

  const pendingDomain = wireFullstackStatus(
    row({ lifecycle: "ready", status: "ready", mavly_domain_status: "pending" }),
  );
  assert.equal(pendingDomain.status, "deploying");
  assert.equal(pendingDomain.step, "domain");
  assert.equal(pendingDomain.liveUrl, undefined);
});

test("in-flight, failed and disabled rows are projected truthfully", () => {
  const building = wireFullstackStatus(row({ lifecycle: "building" }));
  assert.equal(building.status, "deploying");
  assert.equal(building.step, "building");

  const rolling = wireFullstackStatus(row({ lifecycle: "rolling_back" }));
  assert.equal(rolling.step, "rollback");

  const failed = wireFullstackStatus(
    row({
      lifecycle: "failed",
      status: "error",
      error_code: "build_failed",
      error_message: "The build failed.",
      previous_deployment_id: "dpl_previous",
    }),
  );
  assert.equal(failed.status, "error");
  assert.equal(failed.errorDetails?.stage, "build");
  assert.equal(failed.canUnpublish, true);

  const domainFailed = wireFullstackStatus(
    row({
      lifecycle: "failed",
      status: "error",
      mavly_domain_status: "error",
      mavly_domain_error: "DNS is not configured.",
    }),
  );
  assert.equal(domainFailed.errorDetails?.stage, "domain");
  assert.match(String(domainFailed.errorDetails?.message), /DNS/);

  const disabled = wireFullstackStatus(
    row({ lifecycle: "disabled", status: "unpublished", url: null }),
  );
  assert.equal(disabled.status, "unpublished");
  assert.equal(disabled.canUnpublish, false);
  assert.equal(disabled.liveUrl, undefined);

  assert.equal(wireFullstackStatus(null).status, "unpublished");
});

test("attempt history is metadata only", () => {
  const attempt: FullstackAttemptRow = {
    id: "22222222-2222-2222-2222-222222222222",
    project_id: "proj-a",
    attempt: 3,
    kind: "deploy",
    lifecycle: "ready",
    snapshot_id: "11111111-1111-1111-1111-111111111111",
    source_hash: "a".repeat(64),
    runtime_profile: "next-app-router",
    verification_id: null,
    provider: "vercel",
    provider_project_id: "prj_123",
    provider_deployment_id: "dpl_123",
    provider_url: "https://mavly-proj-a.vercel.app",
    target_attempt_id: null,
    error_code: null,
    error_message: null,
    trace_id: "trace-secret-ish",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:05:00.000Z",
    updated_at: "2026-01-01T00:05:00.000Z",
  };
  const publicRow = publicAttempt(attempt);
  assert.equal(publicRow.attempt, 3);
  assert.equal(publicRow.deploymentId, "dpl_123");
  assert.equal("traceId" in publicRow, false);
  assert.doesNotMatch(JSON.stringify(publicRow), /trace-secret-ish/);
});

// ── migration 20 static invariants ─────────────────────────────────────────

const SQL = readFileSync(
  new URL("../supabase/migrations/20_fullstack_hosting.sql", import.meta.url),
  "utf8",
);

function functionBody(name: string): string {
  const start = SQL.indexOf(`function public.${name}`);
  assert.ok(start >= 0, `migration defines ${name}`);
  return SQL.slice(start, SQL.indexOf("$$;", start) + 3);
}

function tableBody(name: string): string {
  const start = SQL.indexOf(`create table if not exists public.${name}`);
  assert.ok(start >= 0, `migration creates ${name}`);
  return SQL.slice(start, SQL.indexOf("\n);", start) + 3);
}

test("the deployment mapping's attempt-owned columns are not client-writable", () => {
  assert.match(SQL, /revoke update on public\.project_deployments from authenticated/);
  const grant = SQL.slice(
    SQL.indexOf("grant update (\n  provider,"),
    SQL.indexOf(") on public.project_deployments to authenticated;"),
  );
  for (const column of [
    "status",
    "url",
    "vercel_deployment_id",
    "mavly_hostname",
    "active_version_id",
    "updated_at",
  ]) {
    assert.match(
      grant,
      new RegExp(`\\n  ${column}(?:,|\\n)`),
      `legacy column ${column} stays writable`,
    );
  }
  for (const column of [
    "lifecycle",
    "deployment_kind",
    "source_snapshot_id",
    "source_hash",
    "deployment_attempt",
    "ready_at",
    "disabled_at",
  ]) {
    assert.doesNotMatch(
      grant,
      new RegExp(`\\n  ${column},`),
      `attempt-owned column ${column} is RPC-only`,
    );
  }
});

test("migration 20 is additive, installed after 19, and marked as 20", () => {
  assert.match(SQL, /create or replace function public\.fullstack_hosting_schema_version\(\)/);
  const marker = functionBody("fullstack_hosting_schema_version");
  assert.match(marker, /select 20/);
  assert.match(marker, /security invoker/);
  assert.doesNotMatch(marker, /security definer/);

  assert.doesNotMatch(SQL, /drop table/i);
  assert.doesNotMatch(SQL, /delete from public\.project_files/i);
  assert.match(SQL, /add column if not exists deployment_kind/);
  assert.match(SQL, /add column if not exists lifecycle/);
  assert.match(SQL, /add column if not exists source_snapshot_id/);
  assert.match(SQL, /add column if not exists deployment_attempt/);
});

test("the attempt table is public-select but service-RPC-write only", () => {
  const attempts = tableBody("project_deployment_attempts");
  assert.match(attempts, /unique \(project_id, attempt\)/);
  assert.match(attempts, /source_hash text not null check \(source_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(attempts, /kind text not null default 'deploy' check \(kind in \('deploy', 'rollback'\)\)/);

  assert.match(SQL, /create unique index if not exists project_deployment_attempts_active_uidx/);
  assert.match(SQL, /alter table public\.project_deployment_attempts enable row level security/);
  assert.match(SQL, /revoke all on public\.project_deployment_attempts from authenticated/);
  assert.match(SQL, /grant select \(/);
});

test("env metadata and database metadata never store a value or ciphertext", () => {
  const envTable = tableBody("project_deployment_env");
  assert.doesNotMatch(envTable, /value_ciphertext/i);
  assert.doesNotMatch(envTable, /\bsecret_value\b/i);
  assert.match(envTable, /value_fingerprint/);

  const dbTable = tableBody("project_database_configs");
  assert.doesNotMatch(dbTable, /connection_url/i);
  assert.doesNotMatch(dbTable, /password/i);
  assert.doesNotMatch(dbTable, /\bvalue\b/i);
  assert.match(dbTable, /connection_fingerprint/);
  assert.match(dbTable, /secret_name text not null default 'DATABASE_URL'/);
});

test("the claim RPC verifies ownership, snapshot hash and a PASSED verification", () => {
  const claim = functionBody("claim_fullstack_attempt");
  assert.match(claim, /security definer/);
  assert.match(claim, /v_uid := \(select auth\.uid\(\)\)/);
  assert.match(claim, /p\.user_id = v_uid/);
  assert.match(claim, /s\.source_hash = p_source_hash/);
  assert.match(claim, /v\.status = 'passed'/);
  assert.match(claim, /effective_snapshot_id/);
  assert.match(claim, /effective_source_hash/);
  assert.match(claim, /a deployment attempt is already in progress/);
  assert.match(claim, /pg_advisory_xact_lock/);
  assert.match(claim, /previous_deployment_id/);
});

test("the settle RPC is attempt-fenced and refuses ready while a prerequisite is unsynced", () => {
  const settle = functionBody("settle_fullstack_attempt");
  assert.match(settle, /security definer/);
  assert.match(settle, /a\.attempt > v_attempt\.attempt/);
  assert.match(settle, /d\.deployment_attempt = v_attempt\.attempt/);
  assert.match(settle, /deployment environment is not synced/);
  assert.match(settle, /database configuration is not synced/);
  assert.match(settle, /e\.sync_status in \('pending', 'awaiting_project', 'failed'\)/);
  assert.match(settle, /v_attempt\.finished_at is not null/);
});

test("disable and env-sync are authenticated security-definer operations", () => {
  const disable = functionBody("disable_fullstack_attempt");
  assert.match(disable, /security definer/);
  assert.match(disable, /p\.user_id = v_uid/);
  assert.match(disable, /lifecycle = 'disabled'/);

  const sync = functionBody("record_deployment_env_sync");
  assert.match(sync, /security definer/);
  assert.match(sync, /p\.user_id = v_uid/);
  assert.match(sync, /p_secret_name !~ '\^\[A-Za-z_\]/);
  assert.match(sync, /sync_status = excluded\.sync_status/);
});

// ── source-level invariants ────────────────────────────────────────────────

const FULLSTACK_SOURCE = readFileSync(
  new URL("../src/lib/deployments/fullstack.ts", import.meta.url),
  "utf8",
);
const SECRET_SYNC_SOURCE = readFileSync(
  new URL("../src/lib/hosting/secret-sync.ts", import.meta.url),
  "utf8",
);
const SERVICE_SOURCE = readFileSync(
  new URL("../src/lib/deployments/service.ts", import.meta.url),
  "utf8",
);

test("the deployment service cannot read a secret value or use a service-role client", () => {
  for (const source of [FULLSTACK_SOURCE, SECRET_SYNC_SOURCE]) {
    assert.doesNotMatch(source, /decryptProjectSecretValue/);
    assert.doesNotMatch(source, /value_ciphertext/);
    assert.doesNotMatch(source, /createWorkerClient|service-role/i);
    assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
  }
});

test("a project in the cohort is routed before any static resolution", () => {
  const start = SERVICE_SOURCE.indexOf("export async function publishProject(");
  assert.ok(start >= 0);
  const body = SERVICE_SOURCE.slice(start, SERVICE_SOURCE.indexOf("function releasableStatus("));

  const fullstackBranch = body.indexOf("isFullstackHostingRequested(projectId)");
  const staticPreview = body.indexOf("resolveStaticPreview(");
  assert.ok(fullstackBranch >= 0, "publishProject checks the full-stack gate");
  assert.ok(staticPreview >= 0, "publishProject still resolves a static preview");
  assert.ok(
    fullstackBranch < staticPreview,
    "the full-stack branch runs before static file resolution",
  );
  assert.match(body, /publishFullstackProject\(userId, projectId, options\)/);
});

test("the full-stack deploy uses the provider build and requires a verified snapshot", () => {
  assert.match(FULLSTACK_SOURCE, /resolveVerifiedSource\(projectId, options\.snapshotId/);
  assert.match(FULLSTACK_SOURCE, /planFullstackDeployment\(source\.source\.files\)/);
  assert.match(FULLSTACK_SOURCE, /snapshotHashMatches\(plan\.plan\.sourceHash/);
  assert.match(FULLSTACK_SOURCE, /framework: "nextjs"/);
  assert.match(FULLSTACK_SOURCE, /claimFullstackAttempt\(/);
  assert.match(FULLSTACK_SOURCE, /settleFullstackAttempt\(/);
  assert.match(FULLSTACK_SOURCE, /rollbackVercelDeployment\(/);
  assert.match(FULLSTACK_SOURCE, /removeVercelProjectDomain\(/);
});

test("the secret write-through pushes plaintext only inside the save request", () => {
  assert.match(SECRET_SYNC_SOURCE, /upsertVercelEnv\(/);
  assert.match(SECRET_SYNC_SOURCE, /value: input\.value/);
  assert.match(SECRET_SYNC_SOURCE, /sync_status|syncStatus: "synced"/);
  // A no-op outside the cohort is what keeps static publishing unchanged.
  assert.match(SECRET_SYNC_SOURCE, /shouldSyncSecretToHosting/);
  assert.match(SECRET_SYNC_SOURCE, /isFullstackHostingProject/);
});
