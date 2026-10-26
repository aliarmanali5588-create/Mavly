import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ipAddressRejectionReason,
  resolvedAddressRejectionReason,
} from "../src/lib/hosting/database-address";
import {
  classifyDatabaseConnectivityError,
  databaseConnectivityFailureMessage,
  type DatabaseConnectivityFailureCode,
} from "../src/lib/hosting/database-connectivity";
import {
  databaseConnectionFingerprint,
  parseDatabaseConnectionUrl,
  publicDatabaseConfig,
  type DatabaseConfigRow,
} from "../src/lib/hosting/database-config";

/**
 * ═══ PHASE 5 COMPLETION REGRESSIONS ═════════════════════════════════════════
 *
 * The previous Phase 5 pass left four concrete gaps, pinned here:
 *
 *   1. status/unpublish/takedown depended on the current rollout flag, so a
 *      live full-stack row could fall through to the static path;
 *   2. the first deploy could never sync a secret saved before the provider
 *      project existed (a permanent `awaiting_project` deadlock);
 *   3. provider actions trusted ids/names from a deployment row that
 *      authenticated RPCs can write;
 *   4. saving a database URL recorded `verified_at` without ever connecting.
 *
 * Pure rules are exercised directly. The rest are structural invariants on the
 * exact ordering and arguments in the source, in the same style as the existing
 * migration/route tests. No provider, database or Supabase session is used.
 */

const FULLSTACK = readFileSync(
  new URL("../src/lib/deployments/fullstack.ts", import.meta.url),
  "utf8",
);
const SERVICE = readFileSync(
  new URL("../src/lib/deployments/service.ts", import.meta.url),
  "utf8",
);
const SECRET_SYNC = readFileSync(
  new URL("../src/lib/hosting/secret-sync.ts", import.meta.url),
  "utf8",
);
const DB_SERVICE = readFileSync(
  new URL("../src/lib/hosting/fullstack-database.ts", import.meta.url),
  "utf8",
);
const DB_STORE = readFileSync(
  new URL("../src/lib/hosting/fullstack-store.ts", import.meta.url),
  "utf8",
);
const CONNECTIVITY = readFileSync(
  new URL("../src/lib/hosting/database-connectivity.ts", import.meta.url),
  "utf8",
);
const SQL = readFileSync(
  new URL("../supabase/migrations/20_fullstack_hosting.sql", import.meta.url),
  "utf8",
);
const PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function section(source: string, startNeedle: string, endNeedle?: string): string {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  const end = endNeedle ? source.indexOf(endNeedle, start) : source.length;
  assert.ok(end > start, `missing ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
}

function sqlFunction(name: string): string {
  const start = SQL.indexOf(`function public.${name}`);
  assert.ok(start >= 0, `migration defines ${name}`);
  return SQL.slice(start, SQL.indexOf("$$;", start) + 3);
}

// ── 1. status/takedown are independent of the rollout flag ─────────────────

test("an existing full-stack row is detected without asking the current cohort", () => {
  const body = section(FULLSTACK, "export async function isFullstackDeploymentRow(");
  assert.match(body, /readDeploymentKind\(projectId\)/);
  assert.doesNotMatch(body, /isFullstackHostingRequested/);
  assert.doesNotMatch(body, /isFullstackHostingProject/);
});

test("a deploy of an existing full-stack row never falls through to static", () => {
  const body = section(SERVICE, "export async function publishProject(", "function releasableStatus(");
  assert.match(body, /isFullstackHostingRequested\(projectId\)/);
  assert.match(body, /isFullstackDeploymentRow\(projectId\)/);
  assert.match(body, /publishFullstackProject\(userId, projectId, options\)/);
});

test("takedown and rollback require only the provider configuration", () => {
  for (const [name, next] of [
    ["export async function rollbackFullstackProject(", "// ─────────────────────────────── disable"],
    ["export async function disableFullstackProject(", "// ─────────────────────────────── history"],
  ] as const) {
    const body = section(FULLSTACK, name, next);
    assert.doesNotMatch(body, /hostingGate\(\)/, `${name} must not depend on the rollout flags`);
    assert.match(body, /vercelGate\(\)/, `${name} needs the provider config`);
  }
});

test("a cohort removal stops new full-stack builds with a refusal", () => {
  const body = section(
    FULLSTACK,
    "export async function publishFullstackProject(",
    "// ─────────────────────────────── status",
  );
  assert.match(body, /if \(!isFullstackHostingProject\(projectId\)\)/);
});

// ── 2. the first deploy can sync secrets saved before the project existed ──

test("the provider project is resolved before the env/database readiness gate", () => {
  const body = section(
    FULLSTACK,
    "export async function publishFullstackProject(",
    "// ─────────────────────────────── status",
  );
  const claimAt = body.indexOf("claimFullstackAttempt(");
  const projectAt = body.indexOf("const existingByName = await getVercelProject(");
  const envAt = body.indexOf("const env = await listDeploymentEnv(");
  const databaseAt = body.indexOf("await databaseReadinessForDeployment(");
  const domainAt = body.indexOf("assignMavlyDomain(");
  const uploadAt = body.indexOf("uploadAll(");

  for (const [label, index] of [
    ["claim", claimAt],
    ["project", projectAt],
    ["env", envAt],
    ["database", databaseAt],
    ["domain", domainAt],
    ["upload", uploadAt],
  ] as const) {
    assert.ok(index >= 0, `${label} step is present`);
  }
  assert.ok(claimAt < projectAt, "claim precedes project resolution");
  assert.ok(projectAt < envAt, "the project exists before secrets are checked");
  assert.ok(envAt < databaseAt, "env readiness precedes database readiness");
  assert.ok(databaseAt < domainAt, "readiness is checked before domain side effects");
  assert.ok(domainAt < uploadAt, "readiness is checked before the upload/build");
  assert.match(body, /secrets_not_synced/);
  assert.match(body, /database_not_synced/);
});

// ── 3. provider targeting is server-derived ────────────────────────────────

test("the deploy target is the derived owner-bound name, not a row value", () => {
  const body = section(
    FULLSTACK,
    "export async function publishFullstackProject(",
    "// ─────────────────────────────── status",
  );
  assert.match(body, /const name = vercelProjectName\(config\.projectPrefix, projectId, userId\)/);
  assert.match(body, /vercelProjectName: name/);
  assert.match(body, /const existingByName = await getVercelProject\(config, name\)/);
  assert.doesNotMatch(body, /storedName\s*\|\|\s*requestedName/);
  assert.doesNotMatch(body, /resolveVercelProject\(/);
});

test("status, rollback and takedown resolve the deterministic project", () => {
  const uses = FULLSTACK.match(/resolveHostingProject\(/g) ?? [];
  assert.ok(uses.length >= 4, "definition + status + rollback + takedown");
  assert.doesNotMatch(FULLSTACK, /hostingProjectReference/);
});

test("takedown only deletes the project's own production deployments", () => {
  const body = section(
    FULLSTACK,
    "export async function disableFullstackProject(",
    "// ─────────────────────────────── history",
  );
  assert.match(body, /listVercelProductionDeployments\(config, target\)/);
  assert.match(body, /new Set<string>\(isVercelFailure\(listed\) \? \[\] : listed\.data\)/);
  // A mapped id outside the bounded list is added only after the provider
  // confirms it belongs to this project.
  assert.match(body, /mapped\.data\.projectId === target/);
  assert.match(body, /deploymentIds\.add\(mappedId\)/);
  assert.doesNotMatch(body, /deploymentIds\.add\(row\./);
});

test("a deployment id from another project is rejected on read and rollback", () => {
  assert.match(FULLSTACK, /remote\.data\.projectId !== providerProject/);
  assert.match(FULLSTACK, /deployment_not_owned/);
  assert.match(FULLSTACK, /rollback_target_not_owned/);

  const provider = readFileSync(
    new URL("../src/lib/vercel/provider.ts", import.meta.url),
    "utf8",
  );
  assert.match(provider, /projectId: stringOf\(record\.projectId\)/);
});

test("the secret write-through targets the derived project name", () => {
  assert.match(SECRET_SYNC, /vercelProjectName\(\s*vercel\.config\.projectPrefix,/);
  assert.match(
    SECRET_SYNC,
    /const targetProject = vercelProjectName\(\s*vercel\.config\.projectPrefix,\s*input\.projectId,\s*input\.userId,?\s*\)/,
  );
  assert.doesNotMatch(
    SECRET_SYNC,
    /providerProject\.data\.vercel_project_id\s*\|\|\s*providerProject\.data\.vercel_project_name/,
  );
});

test("the ready transition requires an in-flight attempt with a stable deployment", () => {
  const settle = sqlFunction("settle_fullstack_attempt");
  assert.match(settle, /ready requires an in-flight deployment attempt/);
  assert.match(settle, /ready cannot change the provider deployment/);
  assert.match(
    settle,
    /v_attempt\.lifecycle not in \('building', 'deploying', 'rolling_back'\)/,
  );
  assert.match(
    settle,
    /v_attempt\.provider_deployment_id <> p_provider_deployment_id/,
  );
  assert.match(
    settle,
    /database configuration has not passed a connectivity check/,
  );
});

test("the rollback flow records rolling_back before it can settle ready", () => {
  const body = section(
    FULLSTACK,
    "export async function rollbackFullstackProject(",
    "// ─────────────────────────────── disable",
  );
  const rollingAt = body.indexOf('lifecycle: "rolling_back"');
  const readyAt = body.indexOf('lifecycle: "ready"');
  assert.ok(rollingAt >= 0, "rolling_back is recorded");
  assert.ok(readyAt > rollingAt, "rolling_back precedes ready");
});

// ── 4. a live, bounded database check precedes persistence ─────────────────

test("the address policy refuses private, loopback and metadata ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
  ]) {
    assert.match(String(ipAddressRejectionReason(address)), /private|reserved/i, address);
  }
});

test("globally routable addresses are accepted", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(ipAddressRejectionReason(address), null, address);
  }
});

test("a mixed DNS answer is refused because the driver could pick the private one", () => {
  assert.ok(resolvedAddressRejectionReason(["8.8.8.8", "10.0.0.1"]));
  assert.equal(resolvedAddressRejectionReason(["8.8.8.8", "1.1.1.1"]), null);
  assert.match(
    String(resolvedAddressRejectionReason([])),
    /did not resolve/i,
  );
});

test("driver errors become a value-free failure vocabulary", () => {
  const cases: [unknown, DatabaseConnectivityFailureCode][] = [
    [{ code: "28P01" }, "auth"],
    [{ code: "28000" }, "auth"],
    [{ code: "42501" }, "auth"],
    [{ code: "3D000" }, "database"],
    [{ code: "ENOTFOUND" }, "dns"],
    [{ code: "EAI_AGAIN" }, "dns"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ code: "ECONNREFUSED" }, "unreachable"],
    [{ code: "ENETUNREACH" }, "unreachable"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "tls"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls"],
    [new Error("password authentication failed for user"), "auth"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyDatabaseConnectivityError(error), expected, String(error));
  }
});

test("failure copy never echoes the URL, host, username or password", () => {
  const url = "postgresql://app_user:s3cret-pass@db.example.com/app?sslmode=require";
  const parsed = parseDatabaseConnectionUrl(url);
  assert.equal(parsed.ok, true);
  // The internal validation result carries the URL for the secret write; the
  // metadata projection and the public projection do not.
  if (parsed.ok === true) {
    const metadata = JSON.stringify(parsed.metadata);
    assert.equal(metadata.includes("s3cret-pass"), false);
    assert.equal(metadata.includes("db.example.com"), true, "host is non-secret metadata");
  }

  for (const code of [
    "dns",
    "private_address",
    "timeout",
    "auth",
    "tls",
    "unreachable",
    "database",
    "error",
  ] as const) {
    const message = databaseConnectivityFailureMessage(code);
    assert.doesNotMatch(message, /s3cret-pass/);
    assert.doesNotMatch(message, /postgres(?:ql)?:\/\//);
    assert.doesNotMatch(message, /app_user/);
    assert.doesNotMatch(message, /db\.example\.com/);
  }
});

test("a malformed percent escape is a validation error, not a crash", () => {
  const parsed = parseDatabaseConnectionUrl(
    "postgresql://app_user:p%zz@db.example.com/app?sslmode=require",
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok === false) assert.match(parsed.error, /percent-encoding|not a valid URL/i);
});

test("the save path verifies live connectivity before persisting anything", () => {
  const body = section(
    DB_SERVICE,
    "export async function saveDatabaseConfig(",
    "export async function removeDatabaseConfig(",
  );
  const verifyAt = body.indexOf("await verifyDatabaseConnection(");
  const secretsAt = body.indexOf("await listProjectSecrets(");
  const createAt = body.indexOf("await createProjectSecret(");
  const metadataAt = body.indexOf("await upsertDatabaseConfig(");

  for (const [label, index] of [
    ["verify", verifyAt],
    ["secrets", secretsAt],
    ["create", createAt],
    ["metadata", metadataAt],
  ] as const) {
    assert.ok(index >= 0, `${label} step is present`);
  }
  assert.ok(verifyAt < secretsAt, "the live check precedes the secret write");
  assert.ok(verifyAt < createAt, "the live check precedes secret creation");
  assert.ok(verifyAt < metadataAt, "the live check precedes the metadata write");
  assert.match(body, /verifiedAt/);
  assert.match(body, /DATABASE_UNREACHABLE/);
});

test("verified_at is written from the check result, never unconditionally", () => {
  assert.match(DB_STORE, /verified_at: input\.verifiedAt/);
  assert.doesNotMatch(DB_STORE, /verified_at:\s*now/);
  assert.match(DB_SERVICE, /connectionVerified/);
  assert.match(DB_SERVICE, /"unverified"/);
  assert.match(CONNECTIVITY, /select 1 as mavly_database_verification/);
  assert.match(CONNECTIVITY, /lookup\(input\.host/);
  assert.match(CONNECTIVITY, /resolvedAddressRejectionReason/);
  assert.match(CONNECTIVITY, /connectionTimeoutMillis/);
  assert.match(CONNECTIVITY, /query_timeout/);
});

test("the public database projection carries metadata only plus the check time", () => {
  const fingerprint = databaseConnectionFingerprint(
    "postgresql://app_user:s3cret-pass@db.example.com/app?sslmode=require",
  );
  const row: DatabaseConfigRow = {
    project_id: "proj-a",
    user_id: "11111111-1111-4111-8111-111111111111",
    provider: "postgres",
    host: "db.example.com",
    port: 5432,
    database_name: "app",
    username: "app_user",
    ssl_mode: "require",
    connection_mode: "session",
    secret_name: "DATABASE_URL",
    env_key: "DATABASE_URL",
    connection_fingerprint: fingerprint,
    status: "configured",
    verified_at: "2026-01-02T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  const projected = publicDatabaseConfig(row);
  assert.equal(projected.verifiedAt, row.verified_at);
  assert.equal("connectionUrl" in projected, false);
  assert.equal(JSON.stringify(projected).includes("s3cret-pass"), false);
});

test("pg is a runtime dependency and never reaches the browser catalog", () => {
  assert.equal(typeof PACKAGE.dependencies?.pg, "string");
  assert.equal(typeof PACKAGE.devDependencies?.["@types/pg"], "string");
  assert.match(CONNECTIVITY, /from "pg"/);

  const clientCatalog = readFileSync(
    new URL("../src/lib/vcaas.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(clientCatalog, /database-connectivity/);
  assert.doesNotMatch(clientCatalog, /from ["']pg["']/);
  assert.doesNotMatch(clientCatalog, /fullstack-database/);
});
