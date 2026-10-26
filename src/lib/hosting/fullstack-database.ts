/**
 * ═══ APPLICATION DATABASE CONFIGURATION SERVICE ═════════════════════════════
 *
 * One explicit connection per project, supplied by the owner as a connection
 * URL. The URL is:
 *
 *   · validated and decomposed into non-secret metadata,
 *   · verified with ONE bounded, DNS-pinned connection using those credentials,
 *   · stored as an encrypted project secret (`DATABASE_URL`),
 *   · pushed to the hosting provider env in that same request (write-through),
 *   · never returned, logged or embedded in generated source.
 *
 * ⚠️ NO PROVISIONING. Mavly does not create a database, choose a plan, run SQL or
 * migrations. There is no shared Mavly application database: generated apps
 * never receive Mavly's control-plane credentials.
 *
 * ⚠️ VERIFICATION IS A SAVE-TIME CHECK, NOT A CONTINUOUS MONITOR. `verified_at`
 * is written only after a real `select 1` succeeds. Readiness additionally
 * requires the provider env to carry the same URL fingerprint. The plaintext is
 * write-only, so a later outage cannot be re-probed on every deploy; the user
 * re-saves the connection to verify again.
 */

import { getProject, isStoreFailure } from "@/lib/mavly/store";
import {
  createProjectSecret,
  isProjectSecretServiceFailure,
  listProjectSecrets,
  deleteProjectSecret,
  updateProjectSecret,
} from "@/lib/project-secrets/service";

import {
  DATABASE_URL_SECRET_NAME,
  databaseConfigMatchesEnv,
  parseDatabaseConnectionUrl,
  publicDatabaseConfig,
  type PublicDatabaseConfig,
} from "./database-config";
import { verifyDatabaseConnection } from "./database-connectivity";
import {
  fullstackConfigRefusal,
  readFullstackHostingConfig,
} from "./fullstack-config";
import {
  deleteDatabaseConfig as deleteDatabaseConfigRow,
  isFullstackStoreFailure,
  listDeploymentEnv,
  readDatabaseConfig,
  upsertDatabaseConfig,
} from "./fullstack-store";

export interface DatabaseServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type DatabaseServiceResult<T> =
  | { ok: true; data: T }
  | DatabaseServiceFailure;

export function isDatabaseServiceFailure<T>(
  result: DatabaseServiceResult<T>,
): result is DatabaseServiceFailure {
  return result.ok === false;
}

function fail(status: number, code: string, error: string): DatabaseServiceFailure {
  return { ok: false, status, code, error };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireHosting(projectId: string): DatabaseServiceFailure | null {
  const hosting = readFullstackHostingConfig();
  if ("reason" in hosting) {
    return fail(503, "BACKEND_NOT_CONFIGURED", fullstackConfigRefusal(hosting.reason));
  }
  if (!hosting.config.cohort.has(projectId.trim().toLowerCase())) {
    return fail(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Full-stack hosting is not enabled for this project.",
    );
  }
  return null;
}

async function requireOwnedProject(
  userId: string,
  projectId: string,
): Promise<DatabaseServiceFailure | null> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) return fail(500, "UNKNOWN", "Could not load this project.");
  if (!project.data) return fail(404, "PROJECT_NOT_FOUND", "Project not found.");
  return null;
}

function mapStoreFailure(code: string): DatabaseServiceFailure {
  switch (code) {
    case "migration_required":
      return fail(
        503,
        "BACKEND_NOT_CONFIGURED",
        "Full-stack hosting is not installed. Apply supabase/migrations/20_fullstack_hosting.sql.",
      );
    case "conflict":
      return fail(409, "VALIDATION", "A deployment is in progress. Try again shortly.");
    case "unavailable":
      return fail(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured.");
    default:
      return fail(500, "UNKNOWN", "Could not complete the database configuration operation.");
  }
}

export interface DatabaseStatus {
  configured: boolean;
  /** Null when no connection is configured. */
  config: PublicDatabaseConfig | null;
  /** True only when the provider env carries the same URL fingerprint. */
  synced: boolean;
  /** True only after a bounded live connectivity check succeeded. */
  connectionVerified: boolean;
  /** True when the generated source references DATABASE_URL. */
  requiredBySource: boolean;
  /** Whether a deployment may be declared ready. */
  ready: boolean;
  reason: "missing" | "not_synced" | "unverified" | null;
}

/**
 * The shared status read. It never returns the URL, the password or a value.
 * Ownership is checked by the browser-facing caller; the deploy preflight has
 * already proved it before calling here.
 */
async function readDatabaseStatus(
  projectId: string,
  requiredBySource: boolean,
): Promise<DatabaseServiceResult<DatabaseStatus>> {
  const config = await readDatabaseConfig(projectId);
  if (isFullstackStoreFailure(config)) return mapStoreFailure(config.code);

  if (!config.data) {
    return {
      ok: true,
      data: {
        configured: false,
        config: null,
        synced: false,
        connectionVerified: false,
        requiredBySource,
        ready: !requiredBySource,
        reason: requiredBySource ? "missing" : null,
      },
    };
  }

  const env = await listDeploymentEnv(projectId);
  if (isFullstackStoreFailure(env)) return mapStoreFailure(env.code);
  const row = env.data.find(
    (entry) =>
      entry.secretName === config.data?.secret_name && entry.environment !== "development",
  );
  const synced = databaseConfigMatchesEnv({
    fingerprint: config.data.connection_fingerprint,
    envFingerprint: row?.valueFingerprint,
    envStatus: row?.syncStatus,
  });
  const connectionVerified = Boolean(config.data.verified_at);

  return {
    ok: true,
    data: {
      configured: true,
      config: publicDatabaseConfig(config.data),
      synced,
      connectionVerified,
      requiredBySource,
      /**
       * A configured database always needs BOTH a synced provider value and a
       * successful save-time connectivity check, even when the current source
       * does not reference DATABASE_URL. This matches the database-level ready
       * gate, so the workspace can never report `deploying` for ever because a
       * config exists that the RPC refuses.
       */
      ready: synced && connectionVerified,
      reason: !synced ? "not_synced" : !connectionVerified ? "unverified" : null,
    },
  };
}

/** Read-only status. It never returns the URL, the password, or a value. */
export async function getDatabaseStatus(
  userId: string,
  projectId: string,
): Promise<DatabaseServiceResult<DatabaseStatus>> {
  const hostingFailure = requireHosting(projectId);
  if (hostingFailure) return hostingFailure;
  const ownership = await requireOwnedProject(userId, projectId);
  if (ownership) return ownership;
  return readDatabaseStatus(projectId, false);
}

/** Used by the deployment service: does this source need a ready database? */
export async function databaseReadinessForDeployment(
  projectId: string,
  requiredBySource: boolean,
): Promise<DatabaseServiceResult<DatabaseStatus>> {
  const hostingFailure = requireHosting(projectId);
  if (hostingFailure) return hostingFailure;
  return readDatabaseStatus(projectId, requiredBySource);
}

/**
 * Save (create or replace) the project's database connection.
 * The plaintext URL exists only inside this call.
 */
export async function saveDatabaseConfig(
  userId: string,
  projectId: string,
  body: unknown,
): Promise<DatabaseServiceResult<DatabaseStatus>> {
  const hostingFailure = requireHosting(projectId);
  if (hostingFailure) return hostingFailure;
  const ownership = await requireOwnedProject(userId, projectId);
  if (ownership) return ownership;

  const record = recordOf(body);
  const parsed = parseDatabaseConnectionUrl(
    record.connectionUrl,
    record.connectionMode,
  );
  if ("error" in parsed) {
    return fail(400, "VALIDATION", parsed.error);
  }

  /**
   * ⚠️ A LIVE, BOUNDED CHECK BEFORE ANYTHING IS PERSISTED.
   *
   * The plaintext URL is available only in this request. Opening one
   * connection here proves the credentials authenticate and the database
   * answers, instead of recording `configured` for a URL that can only fail at
   * request time. On failure NOTHING is written: the existing secret, metadata
   * and provider env value (if any) stay exactly as they were.
   *
   * The check is DNS-pinned to a validated public address, uses the configured
   * TLS mode, and is bounded by the module's own timeouts.
   */
  const connectivity = await verifyDatabaseConnection({
    connectionUrl: parsed.connectionUrl,
    host: parsed.metadata.host,
    port: parsed.metadata.port,
    sslMode: parsed.metadata.sslMode,
  });
  if ("error" in connectivity) {
    return fail(
      400,
      connectivity.code === "private_address" ? "VALIDATION" : "DATABASE_UNREACHABLE",
      connectivity.error,
    );
  }
  const verifiedAt = new Date().toISOString();

  const secrets = await listProjectSecrets(projectId, userId);
  if (isProjectSecretServiceFailure(secrets)) {
    return fail(secrets.status, secrets.code, secrets.error);
  }
  const existing = secrets.data.find(
    (secret) =>
      secret.secretName === DATABASE_URL_SECRET_NAME && secret.environment !== "development",
  );

  let createdSecretId: string | null = null;
  if (existing) {
    const updated = await updateProjectSecret(projectId, userId, existing._id, {
      secretValue: parsed.connectionUrl,
    });
    if (isProjectSecretServiceFailure(updated)) {
      return fail(updated.status, updated.code, updated.error);
    }
  } else {
    const created = await createProjectSecret(projectId, userId, {
      secretName: DATABASE_URL_SECRET_NAME,
      secretValue: parsed.connectionUrl,
      environment: "production",
    });
    if (isProjectSecretServiceFailure(created)) {
      return fail(created.status, created.code, created.error);
    }
    createdSecretId = created.data._id;
  }

  const saved = await upsertDatabaseConfig({
    projectId,
    userId,
    provider: parsed.metadata.provider,
    host: parsed.metadata.host,
    port: parsed.metadata.port,
    databaseName: parsed.metadata.databaseName,
    username: parsed.metadata.username,
    sslMode: parsed.metadata.sslMode,
    connectionMode: parsed.metadata.connectionMode,
    secretName: DATABASE_URL_SECRET_NAME,
    envKey: parsed.metadata.envKey,
    connectionFingerprint: parsed.metadata.fingerprint,
    verifiedAt,
  });

  if (isFullstackStoreFailure(saved)) {
    /**
     * Do not leave a secret behind for metadata that was never recorded. This is
     * best-effort: the failure response is about the metadata write.
     */
    if (createdSecretId) {
      await deleteProjectSecret(projectId, userId, createdSecretId);
    }
    return mapStoreFailure(saved.code);
  }

  return getDatabaseStatus(userId, projectId);
}

/** Remove the contract and its `DATABASE_URL` secret. Never returns the value. */
export async function removeDatabaseConfig(
  userId: string,
  projectId: string,
): Promise<DatabaseServiceResult<{ deleted: true; secretRemoved: boolean }>> {
  const hostingFailure = requireHosting(projectId);
  if (hostingFailure) return hostingFailure;
  const ownership = await requireOwnedProject(userId, projectId);
  if (ownership) return ownership;

  const removed = await deleteDatabaseConfigRow(projectId);
  if (isFullstackStoreFailure(removed)) return mapStoreFailure(removed.code);

  let secretRemoved = false;
  const secrets = await listProjectSecrets(projectId, userId);
  if (!isProjectSecretServiceFailure(secrets)) {
    const existing = secrets.data.find(
      (secret) =>
        secret.secretName === DATABASE_URL_SECRET_NAME && secret.environment !== "development",
    );
    if (existing) {
      const deleted = await deleteProjectSecret(projectId, userId, existing._id);
      secretRemoved = !isProjectSecretServiceFailure(deleted);
    }
  }

  return { ok: true, data: { deleted: true, secretRemoved } };
}
