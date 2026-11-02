/**
 * The data gateway is reached by a generated application, so it has no Supabase
 * session. It uses the public anon client exactly like the Phase 6 payment
 * gateway: the only things it can call are two SECURITY DEFINER functions, and
 * both require a server-only RPC proof. The project id is public (it is already
 * in the published hostname); it is not a credential.
 *
 * ⚠️ The context RPC returns the connection URI as CIPHERTEXT. Decryption
 * happens in the service with the server-only key; this module never sees a
 * plaintext credential and never returns one to a caller.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isValidSupabaseUrl,
} from "@/lib/supabase/config";

export interface GatewayContextRow {
  project_id: string;
  user_id: string;
  registry_id: string;
  project_created_at: string;
  connection_uri_ciphertext: string;
  data_model: unknown;
  auth_required: boolean;
  gateway_origin: string;
}

export type GatewayStoreFailureCode =
  | "unavailable"
  | "migration_required"
  | "not_found"
  | "rate_limited"
  | "error";

export type GatewayStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: GatewayStoreFailureCode };

export function mapError(error: { code?: string } | null): GatewayStoreFailureCode {
  const code = error?.code ?? "unknown";
  console.error(`[app-data] gateway RPC failed (${code})`);
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "migration_required";
  }
  if (code === "PGRST000" || code === "08000" || code === "08003") {
    return "unavailable";
  }
  return "error";
}

let cachedClient: SupabaseClient | null = null;

export function publicClient(): SupabaseClient | null {
  if (!isValidSupabaseUrl(SUPABASE_URL) || !SUPABASE_ANON_KEY) return null;
  if (!cachedClient) {
    cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedClient;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function resolveGatewayProject(input: {
  projectId: string;
  rpcHash: string;
}): Promise<GatewayStoreResult<GatewayContextRow | null>> {
  const client = publicClient();
  if (!client) return { ok: false, code: "unavailable" };

  const { data, error } = await client.rpc("data_gateway_context", {
    p_project_id: input.projectId,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return { ok: false, code: mapError(error) };

  const record = recordOf(Array.isArray(data) ? data[0] : data);
  if (!record) return { ok: true, data: null };
  if (
    typeof record.project_id !== "string" ||
    typeof record.user_id !== "string" ||
    typeof record.registry_id !== "string" ||
    typeof record.project_created_at !== "string" ||
    typeof record.connection_uri_ciphertext !== "string" ||
    typeof record.gateway_origin !== "string" ||
    record.data_model === null ||
    record.data_model === undefined
  ) {
    return { ok: false, code: "error" };
  }

  return {
    ok: true,
    data: {
      project_id: record.project_id,
      user_id: record.user_id,
      registry_id: record.registry_id,
      project_created_at: record.project_created_at,
      connection_uri_ciphertext: record.connection_uri_ciphertext,
      data_model: record.data_model,
      auth_required: record.auth_required === true,
      gateway_origin: record.gateway_origin,
    },
  };
}

/**
 * Durable, fixed-limit admission. Any RPC failure is a refusal: the gateway
 * never falls back to an in-memory counter for a public endpoint.
 */
export async function consumeGatewayRate(input: {
  projectId: string;
  action: "read" | "write" | "auth";
  rpcHash: string;
}): Promise<GatewayStoreResult<boolean>> {
  const client = publicClient();
  if (!client) return { ok: false, code: "unavailable" };

  const { data, error } = await client.rpc("consume_app_gateway_rate", {
    p_project_id: input.projectId,
    p_action: input.action,
    p_rpc_hash: input.rpcHash,
  });
  if (error) return { ok: false, code: mapError(error) };
  return { ok: true, data: data === true };
}
