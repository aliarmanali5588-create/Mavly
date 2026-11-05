/**
 * ═══ SECRET WRITE-THROUGH — THE ONLY PLACE PLAINTEXT MEETS A RUNTIME ════════
 *
 * Mavly's project secrets are write-only: the authenticated role cannot SELECT
 * `value_ciphertext`, and there is no "read value" API. That is deliberate, and
 * Phase 5 does not weaken it with a privileged read path.
 *
 * Instead, a secret is pushed to the hosting provider at the ONE moment its
 * plaintext already exists on the server: the create/update request that saved
 * it. After that the plaintext is gone.
 *
 * Consequences, documented rather than hidden:
 *
 *   · If no provider project exists yet, the value is NOT stored anywhere in
 *     plaintext; the metadata row becomes `awaiting_project` and the user must
 *     re-save the secret before the first deployment can be ready.
 *   · If the provider call fails, the row becomes `failed`; the deployment gate
 *     refuses `ready` until the secret is re-saved and synced.
 *   · Rotation/revocation = save/delete the secret, then redeploy. The provider
 *     env value is replaced or removed in the same request.
 *
 * ⚠️ NOTHING HERE THROWS INTO THE SECRET ROUTE. The encrypted database write has
 * already succeeded; a provider failure is recorded as state and reported by the
 * deployment readiness gate.
 * ⚠️ NO VALUE, CIPHERTEXT OR PROVIDER BODY IS LOGGED.
 */

import { databaseConnectionFingerprint } from "./database-config";
import {
  deploymentEnvTarget,
  secretEnvKeyRejectionReason,
  type DeploymentEnvEnvironment,
  type DeploymentEnvSyncStatus,
} from "./deployment-env";
import { isFullstackHostingProject, readFullstackHostingConfig } from "./fullstack-config";
import {
  isFullstackStoreFailure,
  readDeploymentEnvRow,
  readProviderProject,
  recordDeploymentEnvSync,
} from "./fullstack-store";
import {
  isVercelDeploymentConfigFailure,
  readVercelDeploymentConfig,
} from "@/lib/vercel/config";
import {
  deleteVercelEnv,
  isVercelFailure,
  upsertVercelEnv,
  vercelProjectName,
} from "@/lib/vercel/provider";

export interface SecretSavedInput {
  projectId: string;
  userId: string;
  secretName: string;
  environment: DeploymentEnvEnvironment;
  /** Null on a rename/metadata-only update: there is no plaintext to push. */
  value: string | null;
  /** The row's name/environment before an update, when they changed. */
  previous?: { secretName: string; environment: DeploymentEnvEnvironment } | null;
}

export interface SecretRemovedInput {
  projectId: string;
  userId: string;
  secretName: string;
  environment: DeploymentEnvEnvironment;
}

/**
 * True only when the write-through should do any work at all. Kept pure so a
 * test can prove that a non-cohort project never reaches the provider.
 */
export function shouldSyncSecretToHosting(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isFullstackHostingProject(projectId, env);
}

function fingerprint(value: string): string {
  return databaseConnectionFingerprint(value);
}

async function record(input: {
  projectId: string;
  secretName: string;
  environment: DeploymentEnvEnvironment;
  envKey: string;
  syncStatus: DeploymentEnvSyncStatus;
  valueFingerprint?: string | null;
  providerEnvId?: string | null;
  lastError?: string | null;
}): Promise<void> {
  const recorded = await recordDeploymentEnvSync({
    projectId: input.projectId,
    secretName: input.secretName,
    environment: input.environment,
    envKey: input.envKey,
    target: deploymentEnvTarget(input.environment),
    syncStatus: input.syncStatus,
    valueFingerprint: input.valueFingerprint ?? null,
    providerEnvId: input.providerEnvId ?? null,
    lastError: input.lastError ?? null,
  });
  if (isFullstackStoreFailure(recorded) && recorded.code !== "migration_required") {
    console.warn(`[fullstack] env metadata was not recorded (${recorded.code})`);
  }
}

async function removeProviderValue(
  projectId: string,
  userId: string,
  secretName: string,
  environment: DeploymentEnvEnvironment,
): Promise<void> {
  const existing = await readDeploymentEnvRow(projectId, secretName, environment);
  if (isFullstackStoreFailure(existing) || !existing.data) return;
  const envId = existing.data.providerEnvId;
  if (!envId) return;

  const vercel = readVercelDeploymentConfig();
  if (isVercelDeploymentConfigFailure(vercel)) return;

  const providerProject = await readProviderProject(projectId);
  if (isFullstackStoreFailure(providerProject)) return;
  if (!providerProject.data.vercel_project_id && !providerProject.data.vercel_project_name) return;

  /**
   * ⚠️ The target is the deterministic, owner-bound project name, never the id
   * stored on the deployment row. Deployment RPCs can write that row; the name
   * includes a hash of the caller's user id, so it cannot be chosen for another
   * tenant.
   */
  const target = vercelProjectName(projectId, userId);

  const removed = await deleteVercelEnv(vercel.config, target, envId);
  if (isVercelFailure(removed)) {
    // Keep the row truthful: the value may still exist at the provider.
    await record({
      projectId,
      secretName,
      environment,
      envKey: existing.data.envKey,
      syncStatus: "failed",
      valueFingerprint: existing.data.valueFingerprint,
      providerEnvId: envId,
      lastError: `provider_${removed.failure.status || "error"}`,
    });
  }
}

/** Called AFTER a secret was persisted. Never throws. */
export async function syncProjectSecretSaved(input: SecretSavedInput): Promise<void> {
  try {
    if (!shouldSyncSecretToHosting(input.projectId)) return;
    const hosting = readFullstackHostingConfig();
    if (hosting.ok === false) return;

    // A rename or environment move leaves an old provider value behind.
    if (
      input.previous &&
      (input.previous.secretName !== input.secretName ||
        input.previous.environment !== input.environment)
    ) {
      await removeProviderValue(
        input.projectId,
        input.userId,
        input.previous.secretName,
        input.previous.environment,
      );
      await record({
        projectId: input.projectId,
        secretName: input.previous.secretName,
        environment: input.previous.environment,
        envKey: input.previous.secretName,
        syncStatus: "revoked",
      });
    }

    const valueFingerprint = input.value === null ? null : fingerprint(input.value);
    const target = deploymentEnvTarget(input.environment);

    /**
     * A metadata-only update carries no plaintext. If the name/environment did
     * not change, the existing provider value is untouched and stays synced. If
     * it DID change, the new key cannot be pushed truthfully, so it is recorded
     * as failed with an actionable message rather than guessing.
     */
    const renamed = Boolean(
      input.previous &&
        (input.previous.secretName !== input.secretName ||
          input.previous.environment !== input.environment),
    );
    if (input.value === null) {
      if (!renamed) return;
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "failed",
        valueFingerprint: null,
        lastError: "Re-save the secret value so it can be synced to the hosting provider.",
      });
      return;
    }

    // Development secrets never reach the production runtime. They are recorded
    // for visibility only, and they do not block a production deployment.
    if (target === "development") {
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "pending",
        valueFingerprint,
      });
      return;
    }

    const rejection = secretEnvKeyRejectionReason(input.secretName);
    if (rejection) {
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "failed",
        valueFingerprint,
        lastError: rejection,
      });
      return;
    }

    const providerProject = await readProviderProject(input.projectId);
    if (isFullstackStoreFailure(providerProject)) {
      if (providerProject.code !== "migration_required") {
        console.warn(`[fullstack] could not read the provider mapping (${providerProject.code})`);
      }
      return;
    }
    if (
      !providerProject.data.vercel_project_id &&
      !providerProject.data.vercel_project_name
    ) {
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "awaiting_project",
        valueFingerprint,
      });
      return;
    }

    const vercel = readVercelDeploymentConfig();
    if (isVercelDeploymentConfigFailure(vercel)) {
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "failed",
        valueFingerprint,
        lastError: "provider_not_configured",
      });
      return;
    }

    /**
     * ⚠️ The target is the deterministic, owner-bound project name, never the id
     * stored on the deployment row (which deployment RPCs can write). The name
     * includes a hash of the caller's user id, so another tenant's project is
     * not addressable.
     */
    const targetProject = vercelProjectName(input.projectId, input.userId);

    const pushed = await upsertVercelEnv(vercel.config, targetProject, {
      key: input.secretName,
      value: input.value,
      target: ["production"],
    });

    if (isVercelFailure(pushed)) {
      await record({
        projectId: input.projectId,
        secretName: input.secretName,
        environment: input.environment,
        envKey: input.secretName,
        syncStatus: "failed",
        valueFingerprint,
        lastError: `provider_${pushed.failure.status || "error"}`,
      });
      return;
    }

    await record({
      projectId: input.projectId,
      secretName: input.secretName,
      environment: input.environment,
      envKey: input.secretName,
      syncStatus: "synced",
      valueFingerprint,
      providerEnvId: pushed.data.id,
    });
  } catch (error) {
    // A write-through failure must not fail the secret write or echo a value.
    console.error(
      "[fullstack] secret write-through failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}

/** Called AFTER a secret row was deleted. Never throws. */
export async function syncProjectSecretRemoved(input: SecretRemovedInput): Promise<void> {
  try {
    if (!shouldSyncSecretToHosting(input.projectId)) return;
    const hosting = readFullstackHostingConfig();
    if (hosting.ok === false) return;

    await removeProviderValue(input.projectId, input.userId, input.secretName, input.environment);
    await record({
      projectId: input.projectId,
      secretName: input.secretName,
      environment: input.environment,
      envKey: input.secretName,
      syncStatus: "revoked",
    });
  } catch (error) {
    console.error(
      "[fullstack] secret revoke failed:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
