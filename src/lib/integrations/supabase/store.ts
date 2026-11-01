/**
 * ═══ SUPABASE OAUTH TOKEN STORE ═════════════════════════════════════════════
 *
 * Typed wrappers over migration 40's RPCs, plus the encrypt/decrypt boundary.
 *
 * ⚠️ EVERY FUNCTION THAT TOUCHES A TOKEN IS SERVER-ONLY. `readTokens` returns a
 * decrypted access token, so its result must never be serialized into a response,
 * an error message, a log line or a model prompt.
 *
 * ⚠️ THE OWNER PROJECTION NEVER CARRIES A TOKEN. `readConnection` returns
 * metadata only, because that is what the UI needs and nothing more.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret } from "@/lib/integrations/github/crypto";
import { tokenAad, type SupabaseOAuthConfig } from "./config";

export type SupabaseStoreFailureCode =
  | "store_unavailable"
  | "migration_required"
  | "forbidden"
  | "state_missing"
  | "state_expired"
  | "state_invalid"
  | "not_found"
  | "error";

export type SupabaseStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: SupabaseStoreFailureCode };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapError(
  operation: string,
  error: { code?: string; message?: string } | null,
): SupabaseStoreFailureCode {
  const code = error?.code ?? "unknown";
  const message = error?.message ?? "";
  console.error(`[supabase-oauth] ${operation} failed (${code})`);

  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") {
    return "migration_required";
  }
  if (code === "42501") return "forbidden";
  if (code === "P0002") return "state_missing";
  if (code === "P0001") {
    return /expired/i.test(message) ? "state_expired" : "error";
  }
  if (/authentication required|owner mismatch/i.test(message)) return "forbidden";
  return "error";
}

/* ───────────────────────────── OAuth state ─────────────────────────────── */

export async function createOAuthState(input: {
  client: SupabaseClient;
  stateHash: string;
  codeVerifier: string;
  returnTo: string;
  mavlyProjectId: string | null;
  userId: string;
  config: SupabaseOAuthConfig;
}): Promise<SupabaseStoreResult<true>> {
  /**
   * The verifier is encrypted with AAD bound to the user and the state hash, so
   * a ciphertext lifted from one state row cannot be replayed into another.
   */
  const ciphertext = encryptSecret(
    input.config.clientId,
    input.config.encryptionKey,
    input.codeVerifier,
    tokenAad({
      userId: input.userId,
      projectId: input.stateHash,
      purpose: "pkce",
    }),
  );

  const { error } = await input.client.rpc("create_supabase_oauth_state", {
    p_state_hash: input.stateHash,
    p_code_verifier_ciphertext: ciphertext,
    p_return_to: input.returnTo,
    p_mavly_project_id: input.mavlyProjectId,
  });
  if (error) return { ok: false, code: mapError("state_create", error) };
  return { ok: true, data: true };
}

export async function consumeOAuthState(input: {
  client: SupabaseClient;
  stateHash: string;
  userId: string;
  config: SupabaseOAuthConfig;
}): Promise<SupabaseStoreResult<{ codeVerifier: string; returnTo: string; mavlyProjectId: string | null }>> {
  const { data, error } = await input.client.rpc("consume_supabase_oauth_state", {
    p_state_hash: input.stateHash,
  });
  if (error) return { ok: false, code: mapError("state_consume", error) };

  const rows = Array.isArray(data) ? data : [];
  const row = recordOf(rows[0]);
  if (!row) return { ok: false, code: "state_missing" };

  const ciphertext =
    typeof row.code_verifier_ciphertext === "string" ? row.code_verifier_ciphertext : null;
  if (!ciphertext) return { ok: false, code: "state_invalid" };

  const codeVerifier = decryptSecret(
    input.config.clientId,
    input.config.encryptionKey,
    ciphertext,
    tokenAad({
      userId: input.userId,
      projectId: input.stateHash,
      purpose: "pkce",
    }),
  );
  if (!codeVerifier) return { ok: false, code: "state_invalid" };

  return {
    ok: true,
    data: {
      codeVerifier,
      returnTo: typeof row.return_to === "string" ? row.return_to : "/dashboard",
      mavlyProjectId:
        typeof row.mavly_project_id === "string" ? row.mavly_project_id : null,
    },
  };
}

/* ──────────────────────────── The connection ───────────────────────────── */

export interface SupabaseConnectionView {
  /** Null while the row is `pending_selection`: the user has not chosen yet. */
  supabaseProjectRef: string | null;
  supabaseProjectName: string | null;
  organizationSlug: string | null;
  status: "pending_selection" | "connected" | "expired" | "revoked" | "reconnection_required";
  grantedScopes: string[];
  accessTokenExpiresAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
}

const CONNECTION_STATUSES = new Set([
  "pending_selection",
  "connected",
  "expired",
  "revoked",
  "reconnection_required",
]);

function connectionViewFrom(value: unknown): SupabaseConnectionView | null {
  const record = recordOf(value);
  if (!record) return null;
  const status = typeof record.status === "string" ? record.status : null;
  if (!status || !CONNECTION_STATUSES.has(status)) return null;
  const ref =
    typeof record.supabase_project_ref === "string" ? record.supabase_project_ref : null;
  // A row that is not pending selection must name a project; the database enforces
  // this too, so a missing ref here means the row is malformed.
  if (!ref && status !== "pending_selection") return null;

  return {
    supabaseProjectRef: ref,
    supabaseProjectName:
      typeof record.supabase_project_name === "string" ? record.supabase_project_name : null,
    organizationSlug:
      typeof record.organization_slug === "string" ? record.organization_slug : null,
    status: status as SupabaseConnectionView["status"],
    grantedScopes: Array.isArray(record.granted_scopes)
      ? record.granted_scopes.filter((entry): entry is string => typeof entry === "string")
      : [],
    accessTokenExpiresAt:
      typeof record.access_token_expires_at === "string"
        ? record.access_token_expires_at
        : null,
    lastError: typeof record.last_error === "string" ? record.last_error : null,
    connectedAt: typeof record.connected_at === "string" ? record.connected_at : null,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
  };
}

/** Owner-facing metadata. No token, ever. */
export async function readConnection(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<SupabaseStoreResult<SupabaseConnectionView | null>> {
  const { data, error } = await input.client.rpc("read_supabase_oauth_connection", {
    p_mavly_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("connection_read", error) };
  const rows = Array.isArray(data) ? data : [];
  return { ok: true, data: connectionViewFrom(rows[0]) };
}

export async function saveConnection(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: SupabaseOAuthConfig;
  /** Null stores a `pending_selection` row: the token is saved, no project chosen yet. */
  projectRef: string | null;
  projectName: string | null;
  organizationSlug: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  grantedScopes: string[];
}): Promise<SupabaseStoreResult<true>> {
  const accessCiphertext = encryptSecret(
    input.config.clientId,
    input.config.encryptionKey,
    input.accessToken,
    tokenAad({ userId: input.userId, projectId: input.projectId, purpose: "access" }),
  );
  const refreshCiphertext = input.refreshToken
    ? encryptSecret(
        input.config.clientId,
        input.config.encryptionKey,
        input.refreshToken,
        tokenAad({ userId: input.userId, projectId: input.projectId, purpose: "refresh" }),
      )
    : null;

  const { error } = await input.client.rpc("save_supabase_oauth_connection", {
    p_mavly_project_id: input.projectId,
    p_supabase_project_ref: input.projectRef,
    p_supabase_project_name: input.projectName,
    p_organization_slug: input.organizationSlug,
    p_access_token_ciphertext: accessCiphertext,
    p_refresh_token_ciphertext: refreshCiphertext,
    p_access_token_expires_at: input.expiresAt,
    p_granted_scopes: input.grantedScopes,
  });
  if (error) return { ok: false, code: mapError("connection_save", error) };
  return { ok: true, data: true };
}

/**
 * ⚠️ SERVER-ONLY. Returns decrypted tokens. The caller must be the broker or the
 * refresh path, never a route that serializes its result.
 */
export async function readTokens(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  config: SupabaseOAuthConfig;
}): Promise<
  SupabaseStoreResult<{
    projectRef: string | null;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: string | null;
    grantedScopes: string[];
    status: string;
  } | null>
> {
  const { data, error } = await input.client.rpc("read_supabase_oauth_tokens", {
    p_mavly_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("tokens_read", error) };

  const rows = Array.isArray(data) ? data : [];
  const row = recordOf(rows[0]);
  if (!row) return { ok: true, data: null };

  const projectRef =
    typeof row.supabase_project_ref === "string" ? row.supabase_project_ref : null;

  const accessCiphertext =
    typeof row.access_token_ciphertext === "string" ? row.access_token_ciphertext : null;
  const refreshCiphertext =
    typeof row.refresh_token_ciphertext === "string" ? row.refresh_token_ciphertext : null;

  const accessToken = accessCiphertext
    ? decryptSecret(
        input.config.clientId,
        input.config.encryptionKey,
        accessCiphertext,
        tokenAad({ userId: input.userId, projectId: input.projectId, purpose: "access" }),
      )
    : null;
  const refreshToken = refreshCiphertext
    ? decryptSecret(
        input.config.clientId,
        input.config.encryptionKey,
        refreshCiphertext,
        tokenAad({ userId: input.userId, projectId: input.projectId, purpose: "refresh" }),
      )
    : null;

  return {
    ok: true,
    data: {
      projectRef,
      accessToken,
      refreshToken,
      expiresAt:
        typeof row.access_token_expires_at === "string" ? row.access_token_expires_at : null,
      grantedScopes: Array.isArray(row.granted_scopes)
        ? row.granted_scopes.filter((entry): entry is string => typeof entry === "string")
        : [],
      status: typeof row.status === "string" ? row.status : "connected",
    },
  };
}

export async function markStatus(input: {
  client: SupabaseClient;
  projectId: string;
  status: "pending_selection" | "connected" | "expired" | "revoked" | "reconnection_required";
  lastError: string | null;
}): Promise<SupabaseStoreResult<true>> {
  const { error } = await input.client.rpc("mark_supabase_oauth_status", {
    p_mavly_project_id: input.projectId,
    p_status: input.status,
    p_last_error: input.lastError,
  });
  if (error) return { ok: false, code: mapError("status_mark", error) };
  return { ok: true, data: true };
}

export async function deleteConnection(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<SupabaseStoreResult<true>> {
  const { error } = await input.client.rpc("delete_supabase_oauth_connection", {
    p_mavly_project_id: input.projectId,
  });
  if (error) return { ok: false, code: mapError("connection_delete", error) };
  return { ok: true, data: true };
}

/**
 * Append an audit row. `metadata` must be counts and identifiers only: this
 * table is owner-readable, so SQL text and row values must never reach it.
 */
export async function recordAudit(input: {
  client: SupabaseClient;
  projectId: string;
  projectRef: string | null;
  action: string;
  outcome: "allowed" | "refused" | "failed" | "pending_approval";
  reasonCode: string | null;
  metadata: Record<string, unknown>;
}): Promise<SupabaseStoreResult<true>> {
  const { error } = await input.client.rpc("record_supabase_oauth_audit", {
    p_mavly_project_id: input.projectId,
    p_supabase_project_ref: input.projectRef,
    p_action: input.action,
    p_outcome: input.outcome,
    p_reason_code: input.reasonCode,
    p_metadata: input.metadata,
  });
  if (error) return { ok: false, code: mapError("audit_record", error) };
  return { ok: true, data: true };
}
