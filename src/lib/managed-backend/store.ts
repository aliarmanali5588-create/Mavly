import type { SupabaseClient } from "@supabase/supabase-js";

export type ManagedBackendLifecycle =
  | "provisioning"
  | "provisioned"
  | "failed"
  | "outcome_unknown";

export interface ManagedBackendClaim {
  claimStatus: "claimed" | "busy" | "provisioned";
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
  | "conflict"
  | "error";

export type ManagedBackendStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ManagedBackendStoreFailureCode };

function mapError(
  operation: string,
  error: { code?: string } | null,
): ManagedBackendStoreFailureCode {
  const code = error?.code ?? "unknown";
  console.error(`[managed-backend] ${operation} failed (${code})`);
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
      record.claim_status !== "provisioned") ||
    typeof record.project_created_at !== "string" ||
    !Number.isFinite(Date.parse(record.project_created_at)) ||
    (record.claim_status !== "busy" &&
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
