import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagedBackendConfig } from "./config";
import {
  decryptManagedBackendConnection,
  encryptManagedBackendConnection,
} from "./crypto";
import {
  createNeonProject,
  findNeonProject,
  getNeonConnectionUri,
  neonProjectName,
  type NeonFailure,
} from "./neon";
import {
  claimManagedBackend,
  completeManagedBackend,
  failManagedBackend,
  markManagedBackendCreateStarted,
  type ManagedBackendStoreFailureCode,
} from "./store";

const DATABASE_PROBE_TIMEOUT_MS = 5_000;

export interface ManagedBackendFailure {
  ok: false;
  code: string;
  error: string;
}

export type ManagedBackendResult =
  | { ok: true; status: "provisioned" | "reused"; regionId: string }
  | ManagedBackendFailure;

function failure(code: string, error: string): ManagedBackendFailure {
  return { ok: false, code, error };
}

function storeError(code: ManagedBackendStoreFailureCode): ManagedBackendFailure {
  if (code === "migration_required") {
    return failure(
      "MANAGED_BACKEND_MIGRATION_REQUIRED",
      "Managed database storage is not installed. Apply supabase/migrations/30_managed_backends.sql.",
    );
  }
  if (code === "unavailable") {
    return failure("MANAGED_BACKEND_UNAVAILABLE", "Supabase is unavailable.");
  }
  if (code === "forbidden") {
    return failure("MANAGED_BACKEND_FORBIDDEN", "The project owner could not be verified.");
  }
  if (code === "conflict") {
    return failure(
      "MANAGED_BACKEND_BUSY",
      "Database provisioning is already being handled. Resume generation shortly.",
    );
  }
  return failure("MANAGED_BACKEND_STORAGE_ERROR", "Could not update managed database state.");
}

function providerError(error: NeonFailure): ManagedBackendFailure {
  if (error.outcomeUnknown) {
    return failure(
      "NEON_PROVISIONING_OUTCOME_UNKNOWN",
      "Neon did not confirm whether the database was created. Mavly will reconcile by its unique project name before retrying and will not issue a duplicate create request.",
    );
  }
  if (error.code === "provider_auth") {
    return failure("NEON_CONFIGURATION_ERROR", "The Neon API key or organization is not authorized.");
  }
  if (error.code === "provider_rate_limited") {
    return failure("NEON_RATE_LIMITED", "Neon temporarily rate-limited database provisioning.");
  }
  if (error.code === "provider_unavailable") {
    return failure("NEON_UNAVAILABLE", "Neon is temporarily unavailable.");
  }
  if (error.code === "project_name_ambiguous") {
    return failure(
      "NEON_PROJECT_AMBIGUOUS",
      "More than one Neon project matches this Mavly project. Provisioning stopped for manual reconciliation.",
    );
  }
  if (error.code === "connection_uri_invalid") {
    return failure(
      "NEON_CONNECTION_CONFIGURATION_ERROR",
      "Neon returned an invalid database connection configuration.",
    );
  }
  return failure("NEON_PROVISIONING_FAILED", "Neon did not provision the database.");
}

async function probeConnection(connectionUri: string): Promise<boolean> {
  const client = new Client({
    connectionString: connectionUri,
    connectionTimeoutMillis: DATABASE_PROBE_TIMEOUT_MS,
    query_timeout: DATABASE_PROBE_TIMEOUT_MS,
    statement_timeout: DATABASE_PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const result = await client.query("select 1");
    return result.rows.length === 1 && result.rows[0]?.["?column?"] === 1;
  } catch {
    return false;
  } finally {
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}

async function saveFailure(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  failure: ManagedBackendFailure;
  outcomeUnknown: boolean;
}): Promise<ManagedBackendFailure> {
  const saved = await failManagedBackend({
    client: input.client,
    projectId: input.projectId,
    projectCreatedAt: input.projectCreatedAt,
    leaseToken: input.leaseToken,
    code: input.failure.code,
    outcomeUnknown: input.outcomeUnknown,
  });
  return saved.ok ? input.failure : storeError((saved as { code: ManagedBackendStoreFailureCode }).code);
}

export async function ensureManagedBackend(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: ManagedBackendConfig;
}): Promise<ManagedBackendResult> {
  const { config } = input;
  if (!config.ready || !config.orgId || !config.regionId || !config.encryptionKey) {
    return failure(
      "MANAGED_BACKEND_CONFIGURATION_REQUIRED",
      "Managed database provisioning is enabled for this project but its Neon platform prerequisites are incomplete.",
    );
  }

  const leaseToken = randomUUID();
  const claim = await claimManagedBackend({
    client: input.client,
    projectId: input.projectId,
    userId: input.userId,
    leaseToken,
    regionId: config.regionId,
  });
  if (claim.ok === false) return storeError(claim.code);
  if (claim.data.claimStatus === "busy") {
    return failure(
      "MANAGED_BACKEND_BUSY",
      "Database provisioning is already in progress. Resume generation shortly.",
    );
  }
  if (claim.data.claimStatus === "provisioned") {
    return { ok: true, status: "reused", regionId: claim.data.regionId ?? config.regionId };
  }

  const projectCreatedAt = claim.data.projectCreatedAt;
  const registryId = claim.data.registryId;
  if (!registryId) return storeError("error");
  const name = neonProjectName(input.userId, input.projectId, registryId);
  let projectId = claim.data.neonProjectId;
  let connectionUri =
    claim.data.connectionUriCiphertext === null
      ? null
      : decryptManagedBackendConnection(
          config.encryptionKey,
          claim.data.connectionUriCiphertext,
          {
            userId: input.userId,
            projectId: input.projectId,
            registryId,
          },
        );

  if (claim.data.connectionUriCiphertext && !connectionUri) {
    return saveFailure({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      failure: failure(
        "MANAGED_BACKEND_CREDENTIALS_UNREADABLE",
        "The stored database configuration could not be decrypted. The backend was not changed.",
      ),
      outcomeUnknown: false,
    });
  }

  if (connectionUri && projectId) {
    const storedConnectionUri = claim.data.connectionUriCiphertext;
    if (!storedConnectionUri) {
      return saveFailure({
        client: input.client,
        projectId: input.projectId,
        projectCreatedAt,
        leaseToken,
        failure: failure(
          "MANAGED_BACKEND_CREDENTIALS_MISSING",
          "The managed database connection configuration is missing. No new Neon project was created.",
        ),
        outcomeUnknown: true,
      });
    }
    if (!(await probeConnection(connectionUri))) {
      const saved = await completeManagedBackend({
        client: input.client,
        projectId: input.projectId,
        projectCreatedAt,
        leaseToken,
        neonProjectId: projectId,
        regionId: claim.data.regionId ?? config.regionId,
        connectionUriCiphertext: storedConnectionUri,
        connectionVerified: false,
      });
      if (saved.ok === false) return storeError(saved.code);
      return failure(
        "NEON_CONNECTION_UNAVAILABLE",
        "The managed database exists, but its connection could not be verified.",
      );
    }
    const saved = await completeManagedBackend({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      neonProjectId: projectId,
      regionId: claim.data.regionId ?? config.regionId,
      connectionUriCiphertext: storedConnectionUri,
      connectionVerified: true,
    });
    if (saved.ok === false) return storeError(saved.code);
    return {
      ok: true,
      status: "provisioned",
      regionId: claim.data.regionId ?? config.regionId,
    };
  }

  const reconciliationConfig =
    claim.data.creationAttempted && claim.data.regionId
      ? { ...config, regionId: claim.data.regionId }
      : config;
  const existing = await findNeonProject(reconciliationConfig, name);
  if (existing.ok === false) {
    const outcomeUnknown =
      existing.outcomeUnknown || claim.data.creationAttempted;
    return saveFailure({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      failure: providerError(existing),
      outcomeUnknown,
    });
  }

  if (
    existing.data &&
    projectId &&
    existing.data.id !== projectId
  ) {
    return saveFailure({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      failure: failure(
        "NEON_PROJECT_AMBIGUOUS",
        "The stored Neon project does not match the project found during reconciliation.",
      ),
      outcomeUnknown: true,
    });
  }

  let neonProjectId = existing.data?.id ?? projectId;
  if (!neonProjectId && claim.data.creationAttempted) {
    return saveFailure({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      failure: providerError({
        ok: false,
        code: "provisioning_outcome_unknown",
        outcomeUnknown: true,
      }),
      outcomeUnknown: true,
    });
  }

  if (!neonProjectId) {
    const marked = await markManagedBackendCreateStarted({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
    });
    if (marked.ok === false) return storeError(marked.code);

    const created = await createNeonProject(config, name);
    if (created.ok === false) {
      return saveFailure({
        client: input.client,
        projectId: input.projectId,
        projectCreatedAt,
        leaseToken,
        failure: providerError(created),
        outcomeUnknown: created.outcomeUnknown,
      });
    }
    neonProjectId = created.data.id;
  }

  const uriResult = await getNeonConnectionUri(config, neonProjectId);
  if (uriResult.ok === false) {
    return saveFailure({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      failure: providerError(uriResult),
      outcomeUnknown: true,
    });
  }
  connectionUri = uriResult.data;

  if (!(await probeConnection(connectionUri))) {
    const encryptedUri = encryptManagedBackendConnection(
      config.encryptionKey,
      connectionUri,
      { userId: input.userId, projectId: input.projectId, registryId },
    );
    const saved = await completeManagedBackend({
      client: input.client,
      projectId: input.projectId,
      projectCreatedAt,
      leaseToken,
      neonProjectId,
      regionId: config.regionId,
      connectionUriCiphertext: encryptedUri,
      connectionVerified: false,
    });
    if (saved.ok === false) return storeError(saved.code);
    return failure(
      "NEON_CONNECTION_UNAVAILABLE",
      "Neon created the database, but Mavly could not verify its connection. The project is retained for safe reuse and will not be recreated.",
    );
  }

  const encryptedUri = encryptManagedBackendConnection(
    config.encryptionKey,
    connectionUri,
    { userId: input.userId, projectId: input.projectId, registryId },
  );
  const completed = await completeManagedBackend({
    client: input.client,
    projectId: input.projectId,
    projectCreatedAt,
    leaseToken,
    neonProjectId,
    regionId: config.regionId,
    connectionUriCiphertext: encryptedUri,
    connectionVerified: true,
  });
  if (completed.ok === false) return storeError(completed.code);

  return { ok: true, status: "provisioned", regionId: config.regionId };
}
