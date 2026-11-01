/**
 * ═══ BACKEND PROVIDER STORE ═════════════════════════════════════════════════
 *
 * Thin, typed wrappers over migration 39's RPCs. Every call is owner-checked
 * inside SQL, so this module never has to trust a project id or a user id it was
 * handed: it passes them through and the database decides.
 *
 * ⚠️ NO FUNCTION HERE RETURNS A CIPHERTEXT OR A CREDENTIAL. The owner projection
 * carries `hasServiceRoleKey` (a boolean) and nothing else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isBackendConnectionState,
  isBackendProvider,
  type BackendConnectionState,
  type BackendProvider,
  type BackendProviderView,
} from "./types";

export type BackendProviderStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "error";

export type BackendProviderStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: BackendProviderStoreFailureCode };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapError(
  operation: string,
  error: { code?: string; message?: string } | null,
): BackendProviderStoreFailureCode {
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "";
  console.error(`[backend-providers] ${operation} failed (${code})`);

  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "migration_required";
  }
  if (code === "42501") return "forbidden";
  if (code === "P0002") return "not_found";
  /**
   * P0001 is the RPCs' own refusal (not ready to activate, or still active when
   * disconnecting). It is a policy refusal the caller must surface verbatim, not
   * a storage failure, so it is kept distinct from `conflict`.
   */
  if (code === "P0001") return "conflict";
  if (code === "23505") return "conflict";
  if (code === "PGRST000" || code === "08000" || code === "08003") return "unavailable";
  if (/not authorized|owner mismatch|authentication required/i.test(message)) {
    return "forbidden";
  }
  return "error";
}

function providerRowFrom(value: unknown): BackendProviderView | null {
  const record = recordOf(value);
  if (!record) return null;
  if (!isBackendProvider(record.provider)) return null;
  if (!isBackendConnectionState(record.status)) return null;

  return {
    provider: record.provider,
    status: record.status,
    active: record.active === true,
    config: recordOf(record.config) ?? {},
    hasServiceRoleKey: record.has_service_role_key === true,
    lastError: typeof record.last_error === "string" ? record.last_error : null,
    verifiedAt: typeof record.verified_at === "string" ? record.verified_at : null,
    connectedAt: typeof record.connected_at === "string" ? record.connected_at : null,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

/** The owner's provider rows. Metadata only. */
export async function readBackendProviders(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<BackendProviderStoreResult<BackendProviderView[]>> {
  const { data, error } = await input.client.rpc("read_backend_providers", {
    p_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("read", error) };
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: true,
    data: rows.flatMap((row) => {
      const view = providerRowFrom(row);
      return view ? [view] : [];
    }),
  };
}

export interface ProviderMutationResult {
  provider: BackendProvider;
  status: BackendConnectionState;
  active: boolean;
}

function mutationFrom(value: unknown): ProviderMutationResult | null {
  const rows = Array.isArray(value) ? value : [value];
  const record = recordOf(rows[0]);
  if (!record) return null;
  if (!isBackendProvider(record.provider)) return null;
  if (!isBackendConnectionState(record.status)) return null;
  return {
    provider: record.provider,
    status: record.status,
    active: record.active === true,
  };
}

/**
 * Record a verified (or unverified) customer Supabase connection.
 *
 * ⚠️ THIS DOES NOT ACTIVATE. Connecting and activating are separate acts so a
 * connection that has never been verified cannot silently become authoritative.
 */
export async function connectExternalSupabase(input: {
  client: SupabaseClient;
  projectId: string;
  config: Record<string, unknown>;
  serviceRoleCiphertext: string;
  anonKeySecretName: string | null;
  verified: boolean;
}): Promise<BackendProviderStoreResult<ProviderMutationResult>> {
  const { data, error } = await input.client.rpc("connect_external_supabase", {
    p_project_id: input.projectId,
    p_config: input.config,
    p_service_role_ciphertext: input.serviceRoleCiphertext,
    p_anon_key_secret_name: input.anonKeySecretName,
    p_verified: input.verified,
  });
  if (error) return { ok: false, code: mapError("connect", error) };
  const result = mutationFrom(data);
  if (!result) return { ok: false, code: "error" };
  return { ok: true, data: result };
}

/**
 * Make one provider authoritative. The SQL refuses a provider that is not ready
 * and enforces at most one active row per project.
 */
export async function activateBackendProvider(input: {
  client: SupabaseClient;
  projectId: string;
  provider: BackendProvider;
}): Promise<BackendProviderStoreResult<ProviderMutationResult>> {
  const { data, error } = await input.client.rpc("activate_backend_provider", {
    p_project_id: input.projectId,
    p_provider: input.provider,
  });
  if (error) return { ok: false, code: mapError("activate", error) };
  const result = mutationFrom(data);
  if (!result) return { ok: false, code: "error" };
  return { ok: true, data: result };
}

/**
 * Disconnect the customer Supabase provider. The SQL refuses while it is active,
 * because a project must never be left with no backend.
 */
export async function disconnectExternalSupabase(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<BackendProviderStoreResult<ProviderMutationResult>> {
  const { data, error } = await input.client.rpc("disconnect_external_supabase", {
    p_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("disconnect", error) };
  const result = mutationFrom(data);
  if (!result) return { ok: false, code: "error" };
  return { ok: true, data: result };
}

/**
 * Server-only: read the encrypted service-role key for a project.
 *
 * ⚠️ CALLED ONLY FROM THE SUPABASE ADAPTER, WITH A SERVICE-ROLE CLIENT. It is
 * never reachable from an owner session, and its result must never be returned
 * to a caller or written to a log.
 */
export async function readBackendProviderSecret(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<
  BackendProviderStoreResult<{ ciphertext: string; config: Record<string, unknown> } | null>
> {
  const { data, error } = await input.client.rpc("read_backend_provider_secret", {
    p_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("read_secret", error) };
  const rows = Array.isArray(data) ? data : [];
  const record = recordOf(rows[0]);
  if (!record) return { ok: true, data: null };
  const ciphertext =
    typeof record.service_role_ciphertext === "string"
      ? record.service_role_ciphertext
      : null;
  if (!ciphertext) return { ok: true, data: null };
  return {
    ok: true,
    data: { ciphertext, config: recordOf(record.config) ?? {} },
  };
}
