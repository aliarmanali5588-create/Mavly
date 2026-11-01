import type { SupabaseClient } from "@supabase/supabase-js";

import type { ManagedBackendState } from "./lifecycle";
import type { AppDataModel } from "./model";

export type ManagedBackendLifecycle =
  | "provisioning"
  | "provisioned"
  | "configuring"
  | "ready"
  | "failed"
  | "outcome_unknown"
  | "cleanup_pending";

export interface ManagedBackendClaim {
  /**
   * `not_authorized` is migration 38's first gate: the project has no approved
   * enrollment and the deployment is in strict mode. It is reported as a claim
   * status rather than an exception so the caller can block the backend
   * truthfully instead of treating it as a storage failure.
   */
  claimStatus: "claimed" | "busy" | "provisioned" | "not_authorized";
  neonProjectId: string | null;
  regionId: string | null;
  connectionUriCiphertext: string | null;
  creationAttempted: boolean;
  projectCreatedAt: string;
  registryId: string | null;
}

export type ManagedBackendStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "forbidden"
  /**
   * Migration 38: the enrollment guard inside `begin_managed_backend_configuration`
   * raises `42501` when authorization was withdrawn between the pre-flight check
   * and the configuration claim. It shares SQLSTATE 42501 with an owner mismatch,
   * so it is separated here by message. Reporting it as `forbidden` would tell the
   * operator "the project owner could not be verified" when the real cause is a
   * revoked or suspended enrollment.
   */
  | "not_authorized"
  | "conflict"
  | "error";

export type ManagedBackendStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ManagedBackendStoreFailureCode };

function mapError(
  operation: string,
  error: { code?: string; message?: string } | null,
): ManagedBackendStoreFailureCode {
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "";
  console.error(`[managed-backend] ${operation} failed (${code})`);
  /**
   * The enrollment guard's message is the only way to tell a withdrawn
   * authorization apart from an owner mismatch: both raise 42501. Checked before
   * the generic `forbidden` mapping so a revocation is never misreported.
   */
  if (code === "42501" && /enrollment not authorized/i.test(message)) {
    return "not_authorized";
  }
  if (
    code === "42P01" ||
    code === "42883" ||
    code === "PGRST202" ||
    code === "PGRST205"
  ) {
    return "migration_required";
  }
  if (code === "42501") return "forbidden";
  if (code === "23505" || code === "P0001") return "conflict";
  if (code === "PGRST000" || code === "08000" || code === "08003") {
    return "unavailable";
  }
  return "error";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function claimFrom(value: unknown): ManagedBackendClaim | null {
  const record = recordOf(Array.isArray(value) ? value[0] : value);
  if (!record) return null;
  if (
    (record.claim_status !== "claimed" &&
      record.claim_status !== "busy" &&
      record.claim_status !== "provisioned" &&
      record.claim_status !== "not_authorized") ||
    typeof record.project_created_at !== "string" ||
    !Number.isFinite(Date.parse(record.project_created_at)) ||
    (record.claim_status !== "busy" &&
      record.claim_status !== "not_authorized" &&
      (typeof record.registry_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          record.registry_id,
        )))
  ) {
    return null;
  }
  return {
    claimStatus: record.claim_status,
    neonProjectId:
      typeof record.neon_project_id === "string" ? record.neon_project_id : null,
    regionId: typeof record.region_id === "string" ? record.region_id : null,
    connectionUriCiphertext:
      typeof record.connection_uri_ciphertext === "string"
        ? record.connection_uri_ciphertext
        : null,
    creationAttempted: record.creation_attempted === true,
    projectCreatedAt: record.project_created_at,
    registryId:
      typeof record.registry_id === "string" ? record.registry_id : null,
  };
}

export async function claimManagedBackend(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
  leaseToken: string;
  regionId: string;
}): Promise<ManagedBackendStoreResult<ManagedBackendClaim>> {
  const { data, error } = await input.client.rpc("claim_managed_backend", {
    p_project_id: input.projectId,
    p_user_id: input.userId,
    p_lease_token: input.leaseToken,
    p_region_id: input.regionId,
    p_lease_seconds: 240,
  });
  if (error) return { ok: false, code: mapError("claim", error) };

  const claim = claimFrom(data);
  if (!claim) return { ok: false, code: "error" };
  return { ok: true, data: claim };
}

export async function markManagedBackendCreateStarted(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc(
    "mark_managed_backend_create_started",
    {
      p_project_id: input.projectId,
      p_project_created_at: input.projectCreatedAt,
      p_lease_token: input.leaseToken,
    },
  );
  if (error) return { ok: false, code: mapError("create_start", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

export async function completeManagedBackend(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  neonProjectId: string;
  regionId: string;
  connectionUriCiphertext: string;
  connectionVerified: boolean;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc("complete_managed_backend", {
    p_project_id: input.projectId,
    p_project_created_at: input.projectCreatedAt,
    p_lease_token: input.leaseToken,
    p_neon_project_id: input.neonProjectId,
    p_region_id: input.regionId,
    p_connection_uri_ciphertext: input.connectionUriCiphertext,
    p_connection_verified: input.connectionVerified,
  });
  if (error) return { ok: false, code: mapError("complete", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

export async function failManagedBackend(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  code: string;
  outcomeUnknown: boolean;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc("fail_managed_backend", {
    p_project_id: input.projectId,
    p_project_created_at: input.projectCreatedAt,
    p_lease_token: input.leaseToken,
    p_error_code: input.code,
    p_outcome_unknown: input.outcomeUnknown,
  });
  if (error) return { ok: false, code: mapError("fail", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

// ── Configuration phase (migration 35) ──────────────────────────────────────

export interface ManagedBackendConfigClaim {
  /**
   * `not_authorized` is the configuration-time gate: the enrollment guard inside
   * `begin_managed_backend_configuration` refused because authorization was
   * withdrawn. The SQL raises rather than returning this status, so it reaches
   * the caller through `mapError`; it is declared here so the claim type can
   * never silently narrow to the point where the refusal is unrepresentable.
   */
  claimStatus: "claimed" | "busy" | "not_authorized";
  registryId: string;
  projectCreatedAt: string;
  neonProjectId: string;
  regionId: string;
  connectionUriCiphertext: string;
}

/** The owner-visible registry projection. Never contains ciphertext. */
export interface ManagedBackendStatusRow {
  status: ManagedBackendState;
  registryId: string;
  projectCreatedAt: string;
  regionId: string;
  dataModel: AppDataModel | null;
  authRequired: boolean;
  /** The stored connection was verified at least once. */
  connectionVerified: boolean;
  schemaVerified: boolean;
  migrationStepCount: number;
  gatewayConfigured: boolean;
  /** The origin stored when the gateway was configured, or null. */
  gatewayOrigin: string | null;
  errorCode: string | null;
  lastStep: string | null;
  updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configClaimFrom(value: unknown): ManagedBackendConfigClaim | null {
  const record = recordOf(Array.isArray(value) ? value[0] : value);
  if (!record) return null;
  if (
    record.claim_status !== "claimed" &&
    record.claim_status !== "busy" &&
    record.claim_status !== "not_authorized"
  ) {
    return null;
  }
  if (record.claim_status === "not_authorized") {
    return {
      claimStatus: "not_authorized",
      registryId: "",
      projectCreatedAt:
        typeof record.project_created_at === "string"
          ? record.project_created_at
          : new Date(0).toISOString(),
      neonProjectId: "",
      regionId: "",
      connectionUriCiphertext: "",
    };
  }
  if (record.claim_status === "busy") {
    return {
      claimStatus: "busy",
      registryId:
        typeof record.registry_id === "string" ? record.registry_id : "",
      projectCreatedAt:
        typeof record.project_created_at === "string"
          ? record.project_created_at
          : new Date(0).toISOString(),
      neonProjectId: "",
      regionId: "",
      connectionUriCiphertext: "",
    };
  }
  if (
    typeof record.registry_id !== "string" ||
    !UUID.test(record.registry_id) ||
    typeof record.neon_project_id !== "string" ||
    typeof record.region_id !== "string" ||
    typeof record.connection_uri_ciphertext !== "string" ||
    typeof record.project_created_at !== "string"
  ) {
    return null;
  }
  return {
    claimStatus: "claimed",
    registryId: record.registry_id,
    projectCreatedAt: record.project_created_at,
    neonProjectId: record.neon_project_id,
    regionId: record.region_id,
    connectionUriCiphertext: record.connection_uri_ciphertext,
  };
}

export async function beginManagedBackendConfiguration(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
  leaseToken: string;
}): Promise<ManagedBackendStoreResult<ManagedBackendConfigClaim>> {
  const { data, error } = await input.client.rpc(
    "begin_managed_backend_configuration",
    {
      p_project_id: input.projectId,
      p_user_id: input.userId,
      p_lease_token: input.leaseToken,
    },
  );
  if (error) return { ok: false, code: mapError("config_claim", error) };
  const claim = configClaimFrom(data);
  if (!claim) return { ok: false, code: "error" };
  return { ok: true, data: claim };
}

export async function recordManagedBackendMigration(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  stepName: string;
  checksum: string;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc(
    "record_managed_backend_migration",
    {
      p_project_id: input.projectId,
      p_project_created_at: input.projectCreatedAt,
      p_lease_token: input.leaseToken,
      p_step_name: input.stepName,
      p_checksum: input.checksum,
    },
  );
  if (error) return { ok: false, code: mapError("migration_record", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

export async function completeManagedBackendConfiguration(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  dataModel: AppDataModel;
  dataModelChecksum: string;
  stepCount: number;
  authRequired: boolean;
  gatewayOrigin: string;
  gatewaySecretHash: string;
  schemaVerified: boolean;
  runtimeVerified: boolean;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc(
    "complete_managed_backend_configuration",
    {
      p_project_id: input.projectId,
      p_project_created_at: input.projectCreatedAt,
      p_lease_token: input.leaseToken,
      p_data_model: input.dataModel,
      p_data_model_checksum: input.dataModelChecksum,
      p_step_count: input.stepCount,
      p_auth_required: input.authRequired,
      p_gateway_origin: input.gatewayOrigin,
      p_gateway_secret_hash: input.gatewaySecretHash,
      p_schema_verified: input.schemaVerified,
      p_runtime_verified: input.runtimeVerified,
    },
  );
  if (error) return { ok: false, code: mapError("config_complete", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

export async function failManagedBackendConfiguration(input: {
  client: SupabaseClient;
  projectId: string;
  projectCreatedAt: string;
  leaseToken: string;
  code: string;
  step: string;
}): Promise<ManagedBackendStoreResult<void>> {
  const { data, error } = await input.client.rpc(
    "fail_managed_backend_configuration",
    {
      p_project_id: input.projectId,
      p_project_created_at: input.projectCreatedAt,
      p_lease_token: input.leaseToken,
      p_error_code: input.code,
      p_step: input.step,
    },
  );
  if (error) return { ok: false, code: mapError("config_fail", error) };
  if (data !== true) return { ok: false, code: "conflict" };
  return { ok: true, data: undefined };
}

function parseDataModel(value: unknown): AppDataModel | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AppDataModel)
    : null;
}

function statusRowFrom(value: unknown): ManagedBackendStatusRow | null {
  const record = recordOf(Array.isArray(value) ? value[0] : value);
  if (!record) return null;
  const status = record.status;
  if (typeof status !== "string") return null;
  if (
    typeof record.registry_id !== "string" ||
    typeof record.project_created_at !== "string" ||
    typeof record.region_id !== "string"
  ) {
    return null;
  }
  return {
    status: status as ManagedBackendState,
    registryId: record.registry_id,
    projectCreatedAt: record.project_created_at,
    regionId: record.region_id,
    dataModel: parseDataModel(record.data_model),
    authRequired: record.auth_required === true,
    connectionVerified:
      typeof record.connection_verified_at === "string" &&
      Number.isFinite(Date.parse(record.connection_verified_at)),
    schemaVerified:
      typeof record.schema_verified_at === "string" &&
      Number.isFinite(Date.parse(record.schema_verified_at)),
    migrationStepCount:
      typeof record.migration_step_count === "number"
        ? record.migration_step_count
        : 0,
    gatewayConfigured:
      typeof record.gateway_origin === "string" &&
      typeof record.gateway_configured_at === "string",
    gatewayOrigin:
      typeof record.gateway_origin === "string" ? record.gateway_origin : null,
    errorCode: typeof record.error_code === "string" ? record.error_code : null,
    lastStep: typeof record.last_step === "string" ? record.last_step : null,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
  };
}

/** Owner-scoped read used by the authenticated status surface. */
export async function managedBackendStatus(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<ManagedBackendStoreResult<ManagedBackendStatusRow | null>> {
  const { data, error } = await input.client.rpc("managed_backend_status", {
    p_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("status", error) };
  return { ok: true, data: statusRowFrom(data) };
}

/** Service-role read used by the generation worker before configuring. */
export async function managedBackendLifecycle(input: {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}): Promise<ManagedBackendStoreResult<ManagedBackendStatusRow | null>> {
  const { data, error } = await input.client.rpc("managed_backend_lifecycle", {
    p_project_id: input.projectId,
    p_user_id: input.userId,
  });
  if (error) return { ok: false, code: mapError("lifecycle", error) };
  return { ok: true, data: statusRowFrom(data) };
}
