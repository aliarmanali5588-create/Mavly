import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

import {
  GET as catchAllGet,
  PATCH as catchAllPatch,
  POST as catchAllPost,
  PUT as catchAllPut,
  DELETE as catchAllDelete,
} from "../src/app/api/vcaas/[...path]/route";
import { checkProjectAccess } from "../src/app/api/vcaas/_shared";
import { classifyVcaasRequest } from "../src/lib/vcaas-scope";
import {
  PROJECT_SECRETS_ENCRYPTION_KEY_ENV,
  projectSecretsCryptoConfig,
} from "../src/lib/project-secrets/config";
import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
} from "../src/lib/project-secrets/crypto";
import {
  createProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  toSecretMetadata,
  updateProjectSecret,
  type ProjectSecretStore,
  type ProjectSecretsServiceDeps,
} from "../src/lib/project-secrets/service";
import type { ProjectSecretMetadataRow } from "../src/lib/project-secrets/store";
import {
  SECRET_VALUE_MAX_BYTES,
  validateCreateSecretInput,
  validateSecretEnvironment,
  validateSecretName,
  validateSecretValue,
  validateUpdateSecretInput,
} from "../src/lib/project-secrets/validation";

/**
 * Project secrets: write-only encrypted storage.
 *
 * Covers the security contract without a database: authenticated route
 * refusal, project-scoped classification, encryption/AAD binding, metadata
 * redaction, input limits, config failure, and create/update/delete wiring.
 * The migration file is checked for RLS and least-privilege grants.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "my-app";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-25T00:00:00.000Z";
const KEY = randomBytes(32);

const owner = { userId: USER, projectId: PROJECT, secretId: SECRET_ID };

function metadata(overrides: Partial<ProjectSecretMetadataRow> = {}): ProjectSecretMetadataRow {
  return {
    id: SECRET_ID,
    project_id: PROJECT,
    secret_name: "STRIPE_SECRET_KEY",
    environment: "production",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function deps(overrides: {
  insert?: ProjectSecretStore["insert"];
  list?: ProjectSecretStore["list"];
  update?: ProjectSecretStore["update"];
  remove?: ProjectSecretStore["remove"];
  config?: ProjectSecretsServiceDeps["config"];
  newSecretId?: ProjectSecretsServiceDeps["newSecretId"];
} = {}): ProjectSecretsServiceDeps {
  return {
    config: overrides.config ?? (() => ({ ok: true, config: { encryptionKey: KEY } })),
    newSecretId: overrides.newSecretId ?? (() => SECRET_ID),
    now: () => NOW,
    store: {
      insert:
        overrides.insert ??
        (async (input) => ({
          ok: true,
          data: metadata({
            secret_name: input.secretName,
            environment: input.environment,
          }),
        })),
      list: overrides.list ?? (async () => ({ ok: true, data: [] })),
      update:
        overrides.update ??
        (async (input) => ({
          ok: true,
          data: metadata({
            secret_name: input.secretName ?? "STRIPE_SECRET_KEY",
            environment: input.environment ?? "production",
          }),
        })),
      remove: overrides.remove ?? (async () => ({ ok: true, data: { deleted: true } })),
    },
  };
}

// ── route boundary ─────────────────────────────────────────────────────────

test("secrets paths are classified as project-scoped", () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const scope = classifyVcaasRequest(method, ["projects", PROJECT, "secrets", SECRET_ID]);
    assert.equal(scope.kind, "project");
    if (scope.kind === "project") assert.equal(scope.projectId, PROJECT);
  }
});

test("secret operations require an owned project row", async () => {
  assert.equal(
    await checkProjectAccess({ userId: USER }, PROJECT, async () => "owned"),
    null,
  );
  const denied = await checkProjectAccess({ userId: USER }, PROJECT, async () => "not-owned");
  assert.ok(denied);
  assert.equal(denied.status, 403);
});

test("every secrets operation refuses an anonymous caller with 401 before work", async () => {
  const request = (method: string, path: string, body?: string) =>
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      ...(body ? { body } : {}),
    });

  const cases: Array<[string, () => Promise<Response>]> = [
    [
      "list",
      () =>
        catchAllGet(
          request("GET", `/api/vcaas/projects/${PROJECT}/secrets`),
          { params: Promise.resolve({ path: ["projects", PROJECT, "secrets"] }) },
        ),
    ],
    [
      "create",
      () =>
        catchAllPost(
          request("POST", `/api/vcaas/projects/${PROJECT}/secrets`, "{}"),
          { params: Promise.resolve({ path: ["projects", PROJECT, "secrets"] }) },
        ),
    ],
    [
      "update",
      () =>
        catchAllPut(
          request(
            "PUT",
            `/api/vcaas/projects/${PROJECT}/secrets/${SECRET_ID}`,
            '{"secretValue":"x"}',
          ),
          {
            params: Promise.resolve({
              path: ["projects", PROJECT, "secrets", SECRET_ID],
            }),
          },
        ),
    ],
    [
      "patch",
      () =>
        catchAllPatch(
          request(
            "PATCH",
            `/api/vcaas/projects/${PROJECT}/secrets/${SECRET_ID}`,
            '{"secretValue":"x"}',
          ),
          {
            params: Promise.resolve({
              path: ["projects", PROJECT, "secrets", SECRET_ID],
            }),
          },
        ),
    ],
    [
      "delete",
      () =>
        catchAllDelete(
          request("DELETE", `/api/vcaas/projects/${PROJECT}/secrets/${SECRET_ID}`),
          {
            params: Promise.resolve({
              path: ["projects", PROJECT, "secrets", SECRET_ID],
            }),
          },
        ),
    ],
  ];

  for (const [name, call] of cases) {
    const response = await call();
    assert.equal(response.status, 401, name);
    const body = (await response.json()) as { ok: boolean; code: string };
    assert.equal(body.ok, false, name);
    assert.equal(body.code, "UNAUTHENTICATED", name);
  }
});

// ── configuration fails closed ─────────────────────────────────────────────

test("a missing or malformed encryption key is a truthful configuration failure", () => {
  const missing = projectSecretsCryptoConfig({} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);

  const malformed = projectSecretsCryptoConfig({
    [PROJECT_SECRETS_ENCRYPTION_KEY_ENV]: "not-base64",
  } as NodeJS.ProcessEnv);
  assert.equal(malformed.ok, false);

  const valid = projectSecretsCryptoConfig({
    [PROJECT_SECRETS_ENCRYPTION_KEY_ENV]: KEY.toString("base64"),
  } as NodeJS.ProcessEnv);
  assert.equal(valid.ok, true);
});

test("create fails closed without an encryption key and never touches storage", async () => {
  let inserted = false;
  const result = await createProjectSecret(
    PROJECT,
    USER,
    { secretName: "API_KEY", secretValue: "value", environment: "production" },
    deps({
      config: () => ({ ok: false, error: "not configured" }),
      insert: async () => {
        inserted = true;
        return { ok: true, data: metadata() };
      },
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 503);
  assert.equal(result.code, "BACKEND_NOT_CONFIGURED");
  assert.equal(inserted, false);
});

// ── encryption ─────────────────────────────────────────────────────────────

test("secret values round-trip through AES-256-GCM and are bound to their owner", () => {
  const value = "sk_live_do_not_log";
  const ciphertext = encryptProjectSecretValue(KEY, value, owner);

  assert.notEqual(ciphertext, value);
  assert.equal(ciphertext.startsWith("v1."), true);
  assert.equal(decryptProjectSecretValue(KEY, ciphertext, owner), value);

  assert.equal(
    decryptProjectSecretValue(KEY, ciphertext, { ...owner, userId: OTHER_USER }),
    null,
  );
  assert.equal(
    decryptProjectSecretValue(KEY, ciphertext, { ...owner, projectId: "other-app" }),
    null,
  );
  assert.equal(
    decryptProjectSecretValue(KEY, ciphertext, { ...owner, secretId: SECRET_ID.replace("3", "4") }),
    null,
  );
  assert.equal(decryptProjectSecretValue(randomBytes(32), ciphertext, owner), null);
});

test("a tampered ciphertext, tag or version fails authentication", () => {
  const ciphertext = encryptProjectSecretValue(KEY, "value", owner);
  const [version, iv, tag, body] = ciphertext.split(".");

  assert.equal(decryptProjectSecretValue(KEY, `v2.${iv}.${tag}.${body}`, owner), null);
  assert.equal(
    decryptProjectSecretValue(KEY, `${version}.${iv}.${"A".repeat(tag.length)}.${body}`, owner),
    null,
  );

  const buffer = Buffer.from(body, "base64url");
  buffer[0] = buffer[0] ^ 0xff;
  assert.equal(
    decryptProjectSecretValue(
      KEY,
      `${version}.${iv}.${tag}.${buffer.toString("base64url")}`,
      owner,
    ),
    null,
  );
});

// ── metadata redaction ─────────────────────────────────────────────────────

test("metadata mapping exposes no value, ciphertext or owner id", () => {
  const result = toSecretMetadata(metadata());
  assert.deepEqual(result, {
    _id: SECRET_ID,
    secretName: "STRIPE_SECRET_KEY",
    environment: "production",
  });
  assert.equal(JSON.stringify(result).includes("ciphertext"), false);
  assert.equal(JSON.stringify(result).includes(USER), false);
});

test("list never selects a value column and maps only metadata", async () => {
  let selected = "";
  const result = await listProjectSecrets(PROJECT, USER, deps({
    list: async (projectId, userId) => {
      assert.equal(projectId, PROJECT);
      assert.equal(userId, USER);
      selected = "metadata-only";
      return { ok: true, data: [metadata()] };
    },
  }));

  assert.equal(selected, "metadata-only");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, [
    { _id: SECRET_ID, secretName: "STRIPE_SECRET_KEY", environment: "production" },
  ]);
});

test("the store's read columns never include value_ciphertext", () => {
  const store = readFileSync(
    new URL("../src/lib/project-secrets/store.ts", import.meta.url),
    "utf8",
  );
  const metadataColumns = store.match(/const METADATA_COLUMNS =\s*([\s\S]*?);/)?.[1] ?? "";
  assert.ok(metadataColumns.length > 0);
  assert.equal(metadataColumns.includes("value_ciphertext"), false);
  assert.equal(metadataColumns.includes("secret_name"), true);
  assert.equal(metadataColumns.includes("environment"), true);
});

// ── validation ─────────────────────────────────────────────────────────────

test("secret names, values and environments are validated", () => {
  assert.equal(validateSecretName("API_KEY").ok, true);
  assert.equal(validateSecretName("_PRIVATE").ok, true);
  assert.equal(validateSecretName("1BAD").ok, false);
  assert.equal(validateSecretName("BAD-NAME").ok, false);
  assert.equal(validateSecretName("A".repeat(129)).ok, false);

  assert.equal(validateSecretValue("value").ok, true);
  assert.equal(validateSecretValue("").ok, false);
  assert.equal(validateSecretValue("bad\u0000value").ok, false);
  assert.equal(validateSecretValue("x".repeat(SECRET_VALUE_MAX_BYTES + 1)).ok, false);

  assert.equal(validateSecretEnvironment("development").ok, true);
  assert.equal(validateSecretEnvironment("production").ok, true);
  assert.equal(validateSecretEnvironment("both").ok, true);
  assert.equal(validateSecretEnvironment("staging").ok, false);
});

test("create rejects malformed input without calling storage", async () => {
  let inserted = false;
  const store = deps({
    insert: async () => {
      inserted = true;
      return { ok: true, data: metadata() };
    },
  });

  for (const body of [
    { secretName: "1BAD", secretValue: "x", environment: "production" },
    { secretName: "API_KEY", secretValue: "", environment: "production" },
    { secretName: "API_KEY", secretValue: "x", environment: "staging" },
  ]) {
    const result = await createProjectSecret(PROJECT, USER, body, store);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  }
  assert.equal(inserted, false);
});

test("update requires at least one recognized field", () => {
  assert.equal(validateUpdateSecretInput({}).ok, false);
  assert.equal(validateUpdateSecretInput({ secretValue: "new" }).ok, true);
  assert.equal(validateUpdateSecretInput({ secretName: "NEW_NAME" }).ok, true);
});

// ── create / update / delete wiring ───────────────────────────────────────

test("create stores ciphertext, not plaintext, bound to the row owner", async () => {
  let received: Parameters<ProjectSecretStore["insert"]>[0] | null = null;
  const result = await createProjectSecret(
    PROJECT,
    USER,
    { secretName: " API_KEY ", secretValue: "super-secret", environment: "production" },
    deps({
      insert: async (input) => {
        received = input;
        return {
          ok: true,
          data: metadata({ secret_name: input.secretName, environment: input.environment }),
        };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.ok(received);
  assert.equal(received!.secretName, "API_KEY");
  assert.notEqual(received!.valueCiphertext, "super-secret");
  assert.equal(
    decryptProjectSecretValue(KEY, received!.valueCiphertext, owner),
    "super-secret",
  );
  if (result.ok) assert.equal(JSON.stringify(result.data).includes("super-secret"), false);
});

test("update re-encrypts only when a new value is supplied, scoped to project and user", async () => {
  let received: Parameters<ProjectSecretStore["update"]>[0] | null = null;
  const result = await updateProjectSecret(
    PROJECT,
    USER,
    SECRET_ID,
    { secretValue: "replacement" },
    deps({
      update: async (input) => {
        received = input;
        return { ok: true, data: metadata() };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.ok(received);
  assert.equal(received!.projectId, PROJECT);
  assert.equal(received!.userId, USER);
  assert.equal(received!.id, SECRET_ID);
  assert.equal(
    decryptProjectSecretValue(KEY, received!.valueCiphertext!, owner),
    "replacement",
  );
});

test("an update without a value does not require the encryption key", async () => {
  let received: Parameters<ProjectSecretStore["update"]>[0] | null = null;
  const result = await updateProjectSecret(
    PROJECT,
    USER,
    SECRET_ID,
    { environment: "development" },
    deps({
      config: () => ({ ok: false, error: "must not be read" }),
      update: async (input) => {
        received = input;
        return { ok: true, data: metadata({ environment: "development" }) };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.ok(received);
  assert.equal(received!.environment, "development");
  assert.equal("valueCiphertext" in received!, false);
});

test("update and delete report a missing or foreign secret without disclosing it", async () => {
  const update = await updateProjectSecret(
    PROJECT,
    USER,
    SECRET_ID,
    { secretValue: "x" },
    deps({
      update: async () => ({ ok: false, code: "not_found", error: "Secret not found." }),
    }),
  );
  assert.equal(update.ok, false);
  if (!update.ok) assert.equal(update.status, 404);

  const remove = await deleteProjectSecret(
    PROJECT,
    USER,
    SECRET_ID,
    deps({
      remove: async () => ({ ok: false, code: "not_found", error: "Secret not found." }),
    }),
  );
  assert.equal(remove.ok, false);
  if (!remove.ok) assert.equal(remove.status, 404);
});

test("delete is scoped to the project and caller", async () => {
  let args: [string, string, string] | null = null;
  const result = await deleteProjectSecret(
    PROJECT,
    USER,
    SECRET_ID,
    deps({
      remove: async (projectId, userId, secretId) => {
        args = [projectId, userId, secretId];
        return { ok: true, data: { deleted: true } };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(args, [PROJECT, USER, SECRET_ID]);
});

test("malformed secret ids are treated as not found, not queried", async () => {
  let called = false;
  const result = await deleteProjectSecret(
    PROJECT,
    USER,
    "not-a-uuid",
    deps({
      remove: async () => {
        called = true;
        return { ok: true, data: { deleted: true } };
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
  assert.equal(called, false);
});

test("store configuration failures become actionable service failures", async () => {
  const migration = await listProjectSecrets(
    PROJECT,
    USER,
    deps({
      list: async () => ({
        ok: false,
        code: "migration_required",
        error: "apply migration 11",
      }),
    }),
  );
  assert.equal(migration.ok, false);
  if (!migration.ok) {
    assert.equal(migration.status, 503);
    assert.equal(migration.code, "MIGRATION_REQUIRED");
    assert.match(migration.error, /migration/i);
  }

  const unavailable = await listProjectSecrets(
    PROJECT,
    USER,
    deps({
      list: async () => ({ ok: false, code: "unavailable", error: "Supabase is not configured." }),
    }),
  );
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.code, "BACKEND_NOT_CONFIGURED");
  }
});

// ── migration invariants ───────────────────────────────────────────────────

const migration = readFileSync(
  new URL("../supabase/migrations/11_project_secrets.sql", import.meta.url),
  "utf8",
);

test("the secrets migration enables RLS with owner-and-project policies", () => {
  assert.equal(migration.includes("alter table public.project_secrets enable row level security"), true);
  assert.equal(/to\s+anon/.test(migration), false, "no anon policy");
  assert.equal(/for\s+all/i.test(migration), false, "no catch-all policy");

  const policies = migration.match(/create policy /g)?.length ?? 0;
  const drops = migration.match(/drop policy if exists/g)?.length ?? 0;
  assert.equal(policies, 4);
  assert.equal(drops, 4);

  const blocks = migration.split(/create policy /).slice(1);
  for (const block of blocks) {
    assert.equal(block.includes("to authenticated"), true);
    assert.equal(block.includes("(select auth.uid()) = user_id"), true);
    assert.equal(block.includes("from public.projects p"), true);
  }
});

test("the authenticated role cannot select ciphertext", () => {
  const selectGrant = migration
    .split("\n")
    .find((line) => line.trimStart().startsWith("grant select ("));
  assert.ok(selectGrant);
  assert.equal(selectGrant.includes("value_ciphertext"), false);
  assert.equal(migration.includes("revoke all on public.project_secrets from authenticated"), true);
  assert.equal(migration.includes("revoke all on public.project_secrets from anon"), true);
});

test("the migration constrains names, environments and duplicates", () => {
  assert.equal(migration.includes("project_secrets_name_format"), true);
  assert.equal(migration.includes("project_secrets_environment_allowed"), true);
  assert.equal(migration.includes("development', 'production', 'both"), true);
  assert.equal(
    migration.includes("create unique index if not exists project_secrets_name_environment_key"),
    true,
  );
});
