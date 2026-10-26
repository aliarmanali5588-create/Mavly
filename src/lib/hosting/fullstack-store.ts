/**
 * ═══ FULL-STACK DEPLOYMENT PERSISTENCE (CALLER-SCOPED) ══════════════════════
 *
 * Every read and write goes through the caller's RLS-scoped Supabase client.
 * Writes that decide deployment state are SECURITY DEFINER RPCs from migration
 * 20, because they must verify ownership and the attempt fence INSIDE the
 * database:
 *
 *   claim_fullstack_attempt   — one active attempt, immutable snapshot binding,
 *                               a PASSED verification for that exact hash;
 *   settle_fullstack_attempt  — fenced by attempt number; refuses `ready` while
 *                               a production secret or database URL is unsynced;
 *   disable_fullstack_attempt — an explicit, auditable disabled state;
 *   record_deployment_env_sync— metadata-only env sync state (never a value).
 *
 * The service-role client is deliberately NOT used here. A user's own session
 * is sufficient because each RPC checks `auth.uid()` ownership itself.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";

import type { DatabaseConfigRow } from "./database-config";
import type { DeploymentEnvMetadata, DeploymentEnvSyncStatus } from "./deployment-env";

export type FullstackLifecycle =
  | "queued"
  | "building"
  | "deploying"
  | "ready"
  | "failed"
  | "cancelled"
  | "rolling_back"
  | "disabled";

export interface FullstackDeploymentRow {
  project_id: string;
  provider: "vercel" | "shared";
  status: string;
  lifecycle: FullstackLifecycle | null;
  deployment_kind: "static" | "fullstack";
  source_snapshot_id: string | null;
  source_hash: string | null;
  runtime_profile: string | null;
  deployment_attempt: number | null;
  vercel_project_id: string | null;
  vercel_project_name: string;
  vercel_deployment_id: string | null;
  previous_deployment_id: string | null;
  url: string | null;
  error_code: string | null;
  error_message: string | null;
  mavly_hostname: string | null;
  mavly_domain_status: "pending" | "verified" | "error" | null;
  mavly_domain_error: string | null;
  mavly_domain_checked_at: string | null;
  ready_at: string | null;
  disabled_at: string | null;
  last_published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FullstackAttemptRow {
  id: string;
  project_id: string;
  attempt: number;
  kind: "deploy" | "rollback";
  lifecycle: FullstackLifecycle;
  snapshot_id: string | null;
  source_hash: string;
  runtime_profile: string;
  verification_id: string | null;
  provider: "vercel";
  provider_project_id: string | null;
  provider_deployment_id: string | null;
  provider_url: string | null;
  target_attempt_id: string | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface FullstackEnvRow extends DeploymentEnvMetadata {
  provider: "vercel";
  providerEnvId: string | null;
  valueFingerprint: string | null;
  syncedAt: string | null;
}

export interface FullstackState {
  mapping: FullstackDeploymentRow;
  attempts: FullstackAttemptRow[];
  env: FullstackEnvRow[];
}

export type FullstackStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "conflict"
  | "validation"
  | "not_found"
  | "stale"
  | "error";

export interface FullstackStoreFailure {
  ok: false;
  code: FullstackStoreFailureCode;
  error: string;
}

export type FullstackStoreResult<T> =
  | { ok: true; data: T }
  | FullstackStoreFailure;

export function isFullstackStoreFailure<T>(
  result: FullstackStoreResult<T>,
): result is FullstackStoreFailure {
  return result.ok === false;
}

const MAPPING_COLUMNS = [
  "project_id",
  "provider",
  "status",
  "lifecycle",
  "deployment_kind",
  "source_snapshot_id",
  "source_hash",
  "runtime_profile",
  "deployment_attempt",
  "vercel_project_id",
  "vercel_project_name",
  "vercel_deployment_id",
  "previous_deployment_id",
  "url",
  "error_code",
  "error_message",
  "mavly_hostname",
  "mavly_domain_status",
  "mavly_domain_error",
  "mavly_domain_checked_at",
  "ready_at",
  "disabled_at",
  "last_published_at",
  "created_at",
  "updated_at",
].join(",");

const ATTEMPT_COLUMNS = [
  "id",
  "project_id",
  "attempt",
  "kind",
  "lifecycle",
  "snapshot_id",
  "source_hash",
  "runtime_profile",
  "verification_id",
  "provider",
  "provider_project_id",
  "provider_deployment_id",
  "provider_url",
  "target_attempt_id",
  "error_code",
  "error_message",
  "trace_id",
  "started_at",
  "finished_at",
  "updated_at",
].join(",");

const ENV_COLUMNS = [
  "secret_name",
  "environment",
  "env_key",
  "target",
  "sync_status",
  "provider",
  "provider_env_id",
  "revision",
  "last_error",
  "value_fingerprint",
  "synced_at",
  "updated_at",
].join(",");

/** Names migration 20 owns. Used to distinguish "not applied" from a real fault. */
const FULLSTACK_OBJECTS = [
  "project_deployment_attempts",
  "project_deployment_env",
  "project_database_configs",
  "claim_fullstack_attempt",
  "settle_fullstack_attempt",
  "disable_fullstack_attempt",
  "record_deployment_env_sync",
  "fullstack_hosting_schema_version",
  "project_verifications",
  "effective_snapshot_id",
  "effective_source_hash",
  "verified_at",
  "deployment_kind",
  "lifecycle",
  "source_snapshot_id",
  "source_hash",
  "deployment_attempt",
  "previous_deployment_id",
  "readiness_checked_at",
  "ready_at",
  "disabled_at",
] as const;

const MISSING_CODES = new Set([
  "42P01",
  "42703",
  "42883",
  "PGRST202",
  "PGRST204",
  "PGRST205",
]);

function failure(
  code: FullstackStoreFailureCode,
  error: string,
): FullstackStoreFailure {
  return { ok: false, code, error };
}

export function isMissingFullstackSchema(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  const code = (error.code ?? "").toUpperCase();
  const message = (error.message ?? "").toLowerCase();
  const looksMissing =
    MISSING_CODES.has(code) ||
    message.includes("does not exist") ||
    message.includes("could not find the function") ||
    message.includes("could not find the table") ||
    message.includes("could not find the column") ||
    message.includes("schema cache");
  if (!looksMissing) return false;
  return FULLSTACK_OBJECTS.some((name) => message.includes(name.toLowerCase()));
}

const MIGRATION_MESSAGE =
  "Full-stack hosting is not installed. Apply supabase/migrations/19_runtime_verification.sql and supabase/migrations/20_fullstack_hosting.sql.";

function mapDatabaseError(scope: string, error: {
  code?: string | null;
  message?: string | null;
}): FullstackStoreFailure {
  if (isMissingFullstackSchema(error)) {
    console.warn(`[fullstack] ${scope}: schema 20 is missing`);
    return failure("migration_required", MIGRATION_MESSAGE);
  }

  const code = (error.code ?? "").toUpperCase();
  const message = (error.message ?? "").toLowerCase();

  if (
    code === "23505" ||
    message.includes("already in progress")
  ) {
    return failure("conflict", "A deployment attempt is already in progress.");
  }
  if (
    code === "42501" ||
    message.includes("not authenticated") ||
    message.includes("project not found")
  ) {
    // Never disclose whether the project exists: the route already proved
    // ownership, so this only happens for a stale session or a forged RPC call.
    return failure("not_found", "Project not found.");
  }
  if (
    message.includes("passed verification") ||
    message.includes("verified snapshot") ||
    message.includes("does not match the verified source") ||
    message.includes("not synced") ||
    message.includes("connectivity check") ||
    message.includes("rollback target") ||
    message.includes("invalid lifecycle") ||
    message.includes("invalid deployment kind") ||
    message.includes("invalid source hash") ||
    message.includes("unsupported runtime") ||
    message.includes("provider project name")
  ) {
    return failure("validation", humanRpcMessage(message));
  }

  console.error(`[fullstack] ${scope} failed (${code || "unknown"})`);
  return failure("error", "Could not complete the deployment operation.");
}

/**
 * RPC exception texts are deliberately safe to show: they name a prerequisite or
 * a state, never a value. Anything unmatched never reaches the browser.
 */
function humanRpcMessage(message: string): string {
  if (message.includes("passed verification")) {
    return "This snapshot has no passed build verification. Verify the project, then deploy.";
  }
  if (message.includes("verified snapshot")) {
    return "A verified source snapshot is required before a full-stack deployment.";
  }
  if (message.includes("does not match the verified source")) {
    return "The snapshot content does not match the verified source hash.";
  }
  if (message.includes("deployment environment is not synced")) {
    return "A production secret is not synced to the hosting provider. Re-save the secret, then deploy.";
  }
  if (message.includes("database configuration is not synced")) {
    return "The database configuration is not synced to the hosting provider. Save the database connection again, then deploy.";
  }
  if (message.includes("connectivity check")) {
    return "The database connection has not passed a live connectivity check. Save the connection again to verify it, then deploy.";
  }
  if (message.includes("rollback target")) {
    return "That rollback target is not available.";
  }
  if (message.includes("already in progress")) {
    return "A deployment attempt is already in progress.";
  }
  return "The deployment request was refused.";
}

function supabaseMissing(): FullstackStoreFailure {
  return failure("unavailable", "Supabase is not configured.");
}

export async function readFullstackState(
  projectId: string,
): Promise<FullstackStoreResult<FullstackState>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const [mappingResult, attemptsResult, envResult] = await Promise.all([
    supabase
      .from("project_deployments")
      .select(MAPPING_COLUMNS)
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("project_deployment_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("project_id", projectId)
      .order("attempt", { ascending: false })
      .limit(25),
    supabase
      .from("project_deployment_env")
      .select(ENV_COLUMNS)
      .eq("project_id", projectId)
      .order("secret_name", { ascending: true }),
  ]);

  if (mappingResult.error) {
    return mapDatabaseError("read mapping", mappingResult.error);
  }
  if (attemptsResult.error) {
    return mapDatabaseError("read attempts", attemptsResult.error);
  }
  if (envResult.error) {
    return mapDatabaseError("read env metadata", envResult.error);
  }
  if (!mappingResult.data) {
    return failure("not_found", "This project has no deployment record yet.");
  }

  return {
    ok: true,
    data: {
      mapping: mappingResult.data as unknown as FullstackDeploymentRow,
      attempts: (attemptsResult.data ?? []) as unknown as FullstackAttemptRow[],
      env: ((envResult.data ?? []) as unknown as Record<string, unknown>[]).map(mapEnvRow),
    },
  };
}

function mapEnvRow(row: Record<string, unknown>): FullstackEnvRow {
  return {
    secretName: String(row.secret_name ?? ""),
    environment: (row.environment ?? "production") as FullstackEnvRow["environment"],
    envKey: String(row.env_key ?? row.secret_name ?? ""),
    target: (row.target ?? "production") as FullstackEnvRow["target"],
    syncStatus: (row.sync_status ?? "pending") as DeploymentEnvSyncStatus,
    lastError: (row.last_error as string | null) ?? null,
    revision: Number(row.revision ?? 1),
    updatedAt: String(row.updated_at ?? ""),
    provider: "vercel",
    providerEnvId: (row.provider_env_id as string | null) ?? null,
    valueFingerprint: (row.value_fingerprint as string | null) ?? null,
    syncedAt: (row.synced_at as string | null) ?? null,
  };
}

/**
 * Only the pre-existing mapping columns. Safe to call before migration 20, so
 * the secret write-through can decide whether a provider project already exists
 * without breaking a database that has not been migrated yet.
 */
export async function readProviderProject(
  projectId: string,
): Promise<FullstackStoreResult<{
  vercel_project_id: string | null;
  vercel_project_name: string;
}>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase
    .from("project_deployments")
    .select("vercel_project_id,vercel_project_name")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return mapDatabaseError("read provider project", error);
  return {
    ok: true,
    data: {
      vercel_project_id: (data?.vercel_project_id as string | null) ?? null,
      vercel_project_name: String(data?.vercel_project_name ?? ""),
    },
  };
}

/**
 * The mapping's kind. A database without migration 20 has no `deployment_kind`
 * column, so a missing schema is reported as `null` rather than an error: the
 * caller then keeps the existing static behaviour. This read never decides
 * authorization; ownership was already proved.
 */
export async function readDeploymentKind(
  projectId: string,
): Promise<"static" | "fullstack" | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("project_deployments")
    .select("deployment_kind")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) {
    if (isMissingFullstackSchema(error)) return null;
    console.warn(`[fullstack] could not read the deployment kind (${error.code ?? "unknown"})`);
    return null;
  }
  const kind = (data as { deployment_kind?: string | null } | null)?.deployment_kind;
  return kind === "fullstack" ? "fullstack" : kind === "static" ? "static" : null;
}

export async function readDeploymentEnvRow(
  projectId: string,
  secretName: string,
  environment: string,
): Promise<FullstackStoreResult<FullstackEnvRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase
    .from("project_deployment_env")
    .select(ENV_COLUMNS)
    .eq("project_id", projectId)
    .eq("secret_name", secretName)
    .eq("environment", environment)
    .maybeSingle();

  if (error) return mapDatabaseError("read env row", error);
  return { ok: true, data: data ? mapEnvRow(data as unknown as Record<string, unknown>) : null };
}

export async function listDeploymentEnv(
  projectId: string,
): Promise<FullstackStoreResult<FullstackEnvRow[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase
    .from("project_deployment_env")
    .select(ENV_COLUMNS)
    .eq("project_id", projectId)
    .order("secret_name", { ascending: true });

  if (error) return mapDatabaseError("list env", error);
  return {
    ok: true,
    data: ((data ?? []) as unknown as Record<string, unknown>[]).map(mapEnvRow),
  };
}

export interface ClaimFullstackAttemptInput {
  projectId: string;
  kind: "deploy" | "rollback";
  snapshotId: string;
  sourceHash: string;
  runtimeProfile: "next-app-router";
  vercelProjectName: string;
  targetAttemptId?: string | null;
}

export interface ClaimedAttempt {
  attemptId: string;
  attempt: number;
  providerProjectId: string | null;
  providerDeploymentId: string | null;
}

export async function claimFullstackAttempt(
  input: ClaimFullstackAttemptInput,
): Promise<FullstackStoreResult<ClaimedAttempt>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase.rpc("claim_fullstack_attempt", {
    p_project_id: input.projectId,
    p_kind: input.kind,
    p_snapshot_id: input.snapshotId,
    p_source_hash: input.sourceHash,
    p_runtime_profile: input.runtimeProfile,
    p_vercel_project_name: input.vercelProjectName,
    p_target_attempt_id: input.targetAttemptId ?? null,
  });

  if (error) return mapDatabaseError("claim attempt", error);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    return failure("error", "Could not claim a deployment attempt.");
  }
  const record = row as Record<string, unknown>;
  const attemptId = record.attempt_id ?? record.id;
  if (typeof attemptId !== "string") {
    return failure("error", "Could not claim a deployment attempt.");
  }
  return {
    ok: true,
    data: {
      attemptId,
      attempt: Number(record.attempt ?? 0),
      providerProjectId: (record.provider_project_id as string | null) ?? null,
      providerDeploymentId: (record.provider_deployment_id as string | null) ?? null,
    },
  };
}

export interface SettleFullstackAttemptInput {
  attemptId: string;
  lifecycle: Exclude<FullstackLifecycle, "queued" | "disabled">;
  providerDeploymentId?: string | null;
  providerUrl?: string | null;
  providerProjectId?: string | null;
  domainStatus?: "pending" | "verified" | "error" | null;
  domainError?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  traceId?: string | null;
}

/**
 * `stale` means a newer attempt owns the mapping — the caller must ignore its
 * own provider result rather than overwrite newer state.
 */
export async function settleFullstackAttempt(
  input: SettleFullstackAttemptInput,
): Promise<FullstackStoreResult<{ settled: boolean }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase.rpc("settle_fullstack_attempt", {
    p_attempt_id: input.attemptId,
    p_lifecycle: input.lifecycle,
    p_provider_deployment_id: input.providerDeploymentId ?? null,
    p_provider_url: input.providerUrl ?? null,
    p_provider_project_id: input.providerProjectId ?? null,
    p_domain_status: input.domainStatus ?? null,
    p_domain_error: input.domainError ?? null,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage
      ? input.errorMessage.replace(/[\r\n\t]+/g, " ").slice(0, 500)
      : null,
    p_trace_id: input.traceId ?? null,
  });

  if (error) return mapDatabaseError("settle attempt", error);
  if (data === false) {
    return failure("stale", "A newer deployment attempt owns this project.");
  }
  return { ok: true, data: { settled: true } };
}

export async function disableFullstackDeployment(
  projectId: string,
): Promise<FullstackStoreResult<{ disabled: boolean }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase.rpc("disable_fullstack_attempt", {
    p_project_id: projectId,
  });
  if (error) return mapDatabaseError("disable deployment", error);
  return { ok: true, data: { disabled: data === true } };
}

export interface RecordDeploymentEnvSyncInput {
  projectId: string;
  secretName: string;
  environment: "development" | "production" | "both";
  envKey: string;
  target: "production" | "development";
  syncStatus: DeploymentEnvSyncStatus;
  valueFingerprint?: string | null;
  providerEnvId?: string | null;
  lastError?: string | null;
}

export async function recordDeploymentEnvSync(
  input: RecordDeploymentEnvSyncInput,
): Promise<FullstackStoreResult<{ recorded: true }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { error } = await supabase.rpc("record_deployment_env_sync", {
    p_project_id: input.projectId,
    p_secret_name: input.secretName,
    p_environment: input.environment,
    p_env_key: input.envKey,
    p_target: input.target,
    p_sync_status: input.syncStatus,
    p_value_fingerprint: input.valueFingerprint ?? null,
    p_provider_env_id: input.providerEnvId ?? null,
    p_last_error: input.lastError
      ? input.lastError.replace(/[\r\n\t]+/g, " ").slice(0, 300)
      : null,
  });

  if (error) return mapDatabaseError("record env sync", error);
  return { ok: true, data: { recorded: true } };
}

export interface DatabaseConfigWriteInput {
  projectId: string;
  userId: string;
  provider: "postgres" | "supabase";
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslMode: "require" | "verify-full";
  connectionMode: "transaction" | "session";
  secretName: "DATABASE_URL";
  envKey: "DATABASE_URL";
  connectionFingerprint: string;
  /**
   * The timestamp of a successful, bounded connectivity check. `null` only for
   * a migration/repair write that intentionally does not claim verification.
   */
  verifiedAt: string | null;
}

export async function upsertDatabaseConfig(
  input: DatabaseConfigWriteInput,
): Promise<FullstackStoreResult<{ configured: true }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const now = new Date().toISOString();
  const { error } = await supabase.from("project_database_configs").upsert(
    {
      project_id: input.projectId,
      user_id: input.userId,
      provider: input.provider,
      host: input.host,
      port: input.port,
      database_name: input.databaseName,
      username: input.username,
      ssl_mode: input.sslMode,
      connection_mode: input.connectionMode,
      secret_name: input.secretName,
      env_key: input.envKey,
      connection_fingerprint: input.connectionFingerprint,
      status: "configured",
      verified_at: input.verifiedAt,
      updated_at: now,
    },
    { onConflict: "project_id" },
  );

  if (error) return mapDatabaseError("save database config", error);
  return { ok: true, data: { configured: true } };
}

export async function readDatabaseConfig(
  projectId: string,
): Promise<FullstackStoreResult<DatabaseConfigRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase
    .from("project_database_configs")
    .select(
      "project_id,user_id,provider,host,port,database_name,username,ssl_mode,connection_mode,secret_name,env_key,connection_fingerprint,status,verified_at,created_at,updated_at",
    )
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) return mapDatabaseError("read database config", error);
  return { ok: true, data: (data as unknown as DatabaseConfigRow | null) ?? null };
}

export async function deleteDatabaseConfig(
  projectId: string,
): Promise<FullstackStoreResult<{ deleted: boolean }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return supabaseMissing();

  const { data, error } = await supabase
    .from("project_database_configs")
    .delete()
    .eq("project_id", projectId)
    .select("project_id")
    .maybeSingle();

  if (error) return mapDatabaseError("delete database config", error);
  return { ok: true, data: { deleted: Boolean(data) } };
}
