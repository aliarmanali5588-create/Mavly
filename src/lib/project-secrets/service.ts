/**
 * Project secret management.
 *
 * The route has already authenticated the caller and proved project ownership
 * before this module runs. Each operation repeats the project/user predicates in
 * the store, so a mismatched secret id cannot cross projects.
 *
 * ⚠️ SECRET VALUES ARE WRITE-ONLY. Create and update accept a plaintext value,
 * encrypt it immediately and never read it back. No function here returns a
 * value or ciphertext to a route.
 *
 * ⚠️ INJECTION IS COHORT-GATED AND PROVIDER-SIDE. Static publishing never
 * injects a secret. For an explicitly configured full-stack hosting project the
 * optional write-through pushes the value into the hosting provider's encrypted
 * environment in the same request that saved it (see `hosting/secret-sync.ts`).
 * There is still no read-back path, and an unsynced secret blocks a deployment
 * from being reported ready.
 */

import { randomUUID } from "node:crypto";

import type { VcaasSecret } from "@/lib/vcaas-types";
import {
  syncProjectSecretRemoved,
  syncProjectSecretSaved,
} from "@/lib/hosting/secret-sync";
import { projectSecretsCryptoConfig } from "./config";
import { encryptProjectSecretValue } from "./crypto";
import {
  deleteProjectSecretRow,
  insertProjectSecret,
  isProjectSecretStoreFailure,
  listProjectSecretMetadata,
  updateProjectSecretRow,
  type ProjectSecretMetadataRow,
  type ProjectSecretStoreFailure,
  type ProjectSecretStoreResult,
} from "./store";
import {
  validateCreateSecretInput,
  validateUpdateSecretInput,
  type SecretEnvironment,
} from "./validation";

export interface ProjectSecretServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type ProjectSecretServiceResult<T> =
  | { ok: true; data: T }
  | ProjectSecretServiceFailure;

export function isProjectSecretServiceFailure<T>(
  result: ProjectSecretServiceResult<T>,
): result is ProjectSecretServiceFailure {
  return result.ok === false;
}

export interface ProjectSecretStore {
  list(
    projectId: string,
    userId: string,
  ): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow[]>>;
  insert(input: {
    id: string;
    projectId: string;
    userId: string;
    secretName: string;
    environment: SecretEnvironment;
    valueCiphertext: string;
    now: string;
  }): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow>>;
  update(input: {
    id: string;
    projectId: string;
    userId: string;
    secretName?: string;
    environment?: SecretEnvironment;
    valueCiphertext?: string;
    now: string;
  }): Promise<ProjectSecretStoreResult<ProjectSecretMetadataRow>>;
  remove(
    projectId: string,
    userId: string,
    secretId: string,
  ): Promise<ProjectSecretStoreResult<{ deleted: true }>>;
}

export interface ProjectSecretsServiceDeps {
  config: () => ReturnType<typeof projectSecretsCryptoConfig>;
  store: ProjectSecretStore;
  newSecretId: () => string;
  now: () => string;
  /**
   * Optional hosting write-through. It receives the plaintext at the only moment
   * it exists on the server (this request) and NEVER returns or logs it. It is a
   * no-op unless the project is in the full-stack hosting cohort.
   */
  sync?: ProjectSecretsSync;
}

export interface ProjectSecretsSync {
  saved(input: {
    projectId: string;
    userId: string;
    secretName: string;
    environment: SecretEnvironment;
    value: string | null;
    previous?: { secretName: string; environment: SecretEnvironment } | null;
  }): Promise<void>;
  removed(input: {
    projectId: string;
    userId: string;
    secretName: string;
    environment: SecretEnvironment;
  }): Promise<void>;
}

const defaultDeps: ProjectSecretsServiceDeps = {
  config: projectSecretsCryptoConfig,
  store: {
    list: listProjectSecretMetadata,
    insert: insertProjectSecret,
    update: updateProjectSecretRow,
    remove: deleteProjectSecretRow,
  },
  newSecretId: () => randomUUID(),
  now: () => new Date().toISOString(),
  sync: {
    saved: syncProjectSecretSaved,
    removed: syncProjectSecretRemoved,
  },
};

/**
 * The write-through must never turn a successful encrypted write into a failed
 * request, and it must never be able to leak a value into the response.
 */
async function runSync(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // The sync implementation already records state and never throws; this is a
    // last-resort guard.
  }
}

function failure(status: number, code: string, error: string): ProjectSecretServiceFailure {
  return { ok: false, status, code, error };
}

function fromStoreFailure(storeFailure: ProjectSecretStoreFailure): ProjectSecretServiceFailure {
  switch (storeFailure.code) {
    case "migration_required":
      return failure(503, "MIGRATION_REQUIRED", storeFailure.error);
    case "unavailable":
      return failure(503, "BACKEND_NOT_CONFIGURED", storeFailure.error);
    case "conflict":
      return failure(409, "CONFLICT", storeFailure.error);
    case "not_found":
      return failure(404, "PROJECT_NOT_FOUND", storeFailure.error);
    default:
      return failure(500, "UNKNOWN", storeFailure.error);
  }
}

/** Metadata only — there is deliberately no value or ciphertext field. */
export function toSecretMetadata(row: ProjectSecretMetadataRow): VcaasSecret {
  return {
    _id: row.id,
    secretName: row.secret_name,
    environment: row.environment,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSecretId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function listProjectSecrets(
  projectId: string,
  userId: string,
  deps: ProjectSecretsServiceDeps = defaultDeps,
): Promise<ProjectSecretServiceResult<VcaasSecret[]>> {
  const rows = await deps.store.list(projectId, userId);
  if (isProjectSecretStoreFailure(rows)) return fromStoreFailure(rows);
  return { ok: true, data: rows.data.map(toSecretMetadata) };
}

export async function createProjectSecret(
  projectId: string,
  userId: string,
  body: unknown,
  deps: ProjectSecretsServiceDeps = defaultDeps,
): Promise<ProjectSecretServiceResult<VcaasSecret>> {
  const input = validateCreateSecretInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);

  const config = deps.config();
  if (!config.ok) return failure(503, "BACKEND_NOT_CONFIGURED", config.error);

  const secretId = deps.newSecretId();
  const valueCiphertext = encryptProjectSecretValue(
    config.config.encryptionKey,
    input.value.secretValue,
    { userId, projectId, secretId },
  );

  const inserted = await deps.store.insert({
    id: secretId,
    projectId,
    userId,
    secretName: input.value.secretName,
    environment: input.value.environment,
    valueCiphertext,
    now: deps.now(),
  });
  if (isProjectSecretStoreFailure(inserted)) return fromStoreFailure(inserted);
  if (deps.sync) {
    await runSync(() =>
      deps.sync!.saved({
        projectId,
        userId,
        secretName: input.value.secretName,
        environment: input.value.environment,
        value: input.value.secretValue,
      }),
    );
  }
  return { ok: true, data: toSecretMetadata(inserted.data) };
}

export async function updateProjectSecret(
  projectId: string,
  userId: string,
  secretId: string,
  body: unknown,
  deps: ProjectSecretsServiceDeps = defaultDeps,
): Promise<ProjectSecretServiceResult<VcaasSecret>> {
  if (!isSecretId(secretId)) {
    return failure(404, "PROJECT_NOT_FOUND", "Secret not found.");
  }

  const input = validateUpdateSecretInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);

  /**
   * A rename or environment move must revoke the OLD provider key. The metadata
   * row is read (metadata only) before the update so the write-through knows the
   * previous name/environment; a failure here does not block the update.
   */
  let previous: { secretName: string; environment: SecretEnvironment } | null = null;
  if (deps.sync) {
    const before = await deps.store.list(projectId, userId);
    if (!isProjectSecretStoreFailure(before)) {
      const row = before.data.find((entry) => entry.id === secretId);
      if (row) previous = { secretName: row.secret_name, environment: row.environment };
    }
  }

  let valueCiphertext: string | undefined;
  if (input.value.secretValue !== undefined) {
    const config = deps.config();
    if (!config.ok) return failure(503, "BACKEND_NOT_CONFIGURED", config.error);
    valueCiphertext = encryptProjectSecretValue(
      config.config.encryptionKey,
      input.value.secretValue,
      { userId, projectId, secretId },
    );
  }

  const updated = await deps.store.update({
    id: secretId,
    projectId,
    userId,
    ...(input.value.secretName !== undefined
      ? { secretName: input.value.secretName }
      : {}),
    ...(input.value.environment !== undefined
      ? { environment: input.value.environment }
      : {}),
    ...(valueCiphertext !== undefined ? { valueCiphertext } : {}),
    now: deps.now(),
  });
  if (isProjectSecretStoreFailure(updated)) return fromStoreFailure(updated);

  if (deps.sync) {
    await runSync(() =>
      deps.sync!.saved({
        projectId,
        userId,
        secretName: updated.data.secret_name,
        environment: updated.data.environment,
        // No new value ⇒ nothing exists to push. The write-through records the
        // row as unsynced and the readiness gate asks the user to re-save it.
        value: input.value.secretValue ?? null,
        previous,
      }),
    );
  }

  return { ok: true, data: toSecretMetadata(updated.data) };
}

export async function deleteProjectSecret(
  projectId: string,
  userId: string,
  secretId: string,
  deps: ProjectSecretsServiceDeps = defaultDeps,
): Promise<ProjectSecretServiceResult<{ deleted: true }>> {
  if (!isSecretId(secretId)) {
    return failure(404, "PROJECT_NOT_FOUND", "Secret not found.");
  }

  let removedMetadata: { secretName: string; environment: SecretEnvironment } | null = null;
  if (deps.sync) {
    const before = await deps.store.list(projectId, userId);
    if (!isProjectSecretStoreFailure(before)) {
      const row = before.data.find((entry) => entry.id === secretId);
      if (row) {
        removedMetadata = { secretName: row.secret_name, environment: row.environment };
      }
    }
  }

  const removed = await deps.store.remove(projectId, userId, secretId);
  if (isProjectSecretStoreFailure(removed)) return fromStoreFailure(removed);

  if (deps.sync && removedMetadata) {
    const target = removedMetadata;
    await runSync(() =>
      deps.sync!.removed({
        projectId,
        userId,
        secretName: target.secretName,
        environment: target.environment,
      }),
    );
  }

  return { ok: true, data: removed.data };
}
