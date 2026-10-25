import { randomUUID } from "node:crypto";

import type { ProjectApiKey } from "@/lib/vcaas-types";
import { generateApiKey, hashApiKey } from "./crypto";
import {
  insertProjectApiKey,
  isProjectApiKeyStoreFailure,
  listProjectApiKeys,
  revokeProjectApiKey,
  rotateProjectApiKey,
  type ProjectApiKeyRow,
  type ProjectApiKeyStoreFailure,
} from "./store";
import { validateCreateApiKeyInput } from "./validation";

export interface ProjectApiKeyServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type ProjectApiKeyServiceResult<T> =
  | { ok: true; data: T }
  | ProjectApiKeyServiceFailure;

export function isProjectApiKeyServiceFailure<T>(
  result: ProjectApiKeyServiceResult<T>,
): result is ProjectApiKeyServiceFailure {
  return result.ok === false;
}

function failure(status: number, code: string, error: string): ProjectApiKeyServiceFailure {
  return { ok: false, status, code, error };
}

function fromStoreFailure(storeFailure: ProjectApiKeyStoreFailure): ProjectApiKeyServiceFailure {
  switch (storeFailure.code) {
    case "migration_required":
      return failure(503, "MIGRATION_REQUIRED", storeFailure.error);
    case "unavailable":
      return failure(503, "BACKEND_NOT_CONFIGURED", storeFailure.error);
    case "conflict":
      return failure(409, "CONFLICT", storeFailure.error);
    case "not_found":
      return failure(404, "NOT_FOUND", storeFailure.error);
    default:
      return failure(500, "UNKNOWN", storeFailure.error);
  }
}

function toProjectApiKey(row: ProjectApiKeyRow): ProjectApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    last4: row.key_last4,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    env: row.env,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    managed: row.managed ?? undefined,
  };
}

export async function listApiKeys(
  projectId: string,
  userId: string,
): Promise<ProjectApiKeyServiceResult<{ keys: ProjectApiKey[] }>> {
  const rows = await listProjectApiKeys(projectId, userId);
  if (isProjectApiKeyStoreFailure(rows)) return fromStoreFailure(rows);
  return { ok: true, data: { keys: rows.data.map(toProjectApiKey) } };
}

export async function createApiKey(
  projectId: string,
  userId: string,
  body: unknown,
): Promise<ProjectApiKeyServiceResult<{ key: ProjectApiKey & { plaintext: string } }>> {
  const input = validateCreateApiKeyInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);

  const { plaintext, prefix, last4 } = generateApiKey();
  const keyHash = hashApiKey(plaintext);
  const now = new Date().toISOString();
  const id = randomUUID();

  const inserted = await insertProjectApiKey({
    id,
    projectId,
    userId,
    name: input.value.name,
    keyPrefix: prefix,
    keyHash,
    keyLast4: last4,
    scopes: input.value.scopes,
    env: input.value.env,
    managed: null,
    now,
  });
  if (isProjectApiKeyStoreFailure(inserted)) return fromStoreFailure(inserted);
  return {
    ok: true,
    data: {
      key: {
        ...toProjectApiKey(inserted.data),
        plaintext,
      },
    },
  };
}

export async function revokeApiKey(
  projectId: string,
  userId: string,
  keyId: string,
): Promise<ProjectApiKeyServiceResult<{ key: ProjectApiKey }>> {
  // Don't allow revoking managed keys? UI says revoke button only shown for custom (non-managed) in some cases
  // But enforce safely
  const now = new Date().toISOString();
  const result = await revokeProjectApiKey(projectId, userId, keyId, now);
  if (isProjectApiKeyStoreFailure(result)) return fromStoreFailure(result);
  return { ok: true, data: { key: toProjectApiKey(result.data) } };
}

export async function rotateApiKey(
  projectId: string,
  userId: string,
  keyId: string,
): Promise<ProjectApiKeyServiceResult<{ key: ProjectApiKey & { plaintext: string } }>> {
  const { plaintext, prefix, last4 } = generateApiKey();
  const keyHash = hashApiKey(plaintext);
  const now = new Date().toISOString();

  const result = await rotateProjectApiKey(projectId, userId, keyId, {
    keyPrefix: prefix,
    keyHash,
    keyLast4: last4,
    now,
  });
  if (isProjectApiKeyStoreFailure(result)) return fromStoreFailure(result);
  return {
    ok: true,
    data: {
      key: {
        ...toProjectApiKey(result.data),
        plaintext,
      },
    },
  };
}
