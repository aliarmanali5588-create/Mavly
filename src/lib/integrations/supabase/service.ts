/**
 * Access-token lifecycle for the Supabase integration.
 *
 * Access tokens are refreshed shortly before expiry. A revoked or expired
 * refresh token deletes the local connection so the UI can ask the user to
 * reconnect instead of retrying a token that can never work.
 */

import type { SupabaseIntegrationConfig } from "./config";
import { decryptSecret } from "./crypto";
import {
  isOAuthFailure,
  refreshAccessToken,
  type SupabaseOAuthErrorCode,
} from "./oauth";
import {
  deleteConnection,
  getConnection,
  isStoreFailure,
  updateConnectionTokens,
  type StoreErrorCode,
  type SupabaseConnectionRow,
} from "./store";

const REFRESH_WINDOW_MS = 2 * 60 * 1000;
const refreshLocks = new Map<string, Promise<AccessTokenResult>>();

export type AccessTokenFailure =
  | StoreErrorCode
  | "reconnect_required"
  | SupabaseOAuthErrorCode;

export type AccessTokenSuccess = { ok: true; accessToken: string };
export type AccessTokenFailureResult = { ok: false; code: AccessTokenFailure };
export type AccessTokenResult = AccessTokenSuccess | AccessTokenFailureResult;

export function isAccessTokenFailure(
  result: AccessTokenResult,
): result is AccessTokenFailureResult {
  return result.ok === false;
}

function needsRefresh(expiresAt: string): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp - Date.now() <= REFRESH_WINDOW_MS;
}

async function clearAndRequireReconnect(
  userId: string,
  code: AccessTokenFailure,
): Promise<AccessTokenResult> {
  await deleteConnection(userId);
  return { ok: false, code };
}

async function refreshStoredConnection(
  userId: string,
  config: SupabaseIntegrationConfig,
  row: SupabaseConnectionRow,
): Promise<AccessTokenResult> {
  const refreshToken = decryptSecret(
    config,
    row.refresh_token_ciphertext,
    `supabase-refresh-token:${userId}`,
  );
  if (!refreshToken) {
    return clearAndRequireReconnect(userId, "reconnect_required");
  }

  const refreshed = await refreshAccessToken(config, refreshToken);
  if (isOAuthFailure(refreshed)) {
    if (
      refreshed.code === "oauth_invalid_grant" ||
      refreshed.code === "oauth_unauthorized" ||
      refreshed.code === "oauth_insufficient_scope"
    ) {
      const latest = await getConnection(userId);
      if (
        !isStoreFailure(latest) &&
        latest.data &&
        latest.data.refresh_token_ciphertext !== row.refresh_token_ciphertext
      ) {
        const accessToken = decryptSecret(
          config,
          latest.data.access_token_ciphertext,
          `supabase-access-token:${userId}`,
        );
        if (accessToken) return { ok: true, accessToken };
      }
      return clearAndRequireReconnect(userId, "reconnect_required");
    }
    return { ok: false, code: refreshed.code };
  }

  const saved = await updateConnectionTokens(userId, refreshed.data, config);
  if (isStoreFailure(saved)) return { ok: false, code: saved.code };

  return { ok: true, accessToken: refreshed.data.accessToken };
}

export async function getAccessToken(
  userId: string,
  config: SupabaseIntegrationConfig,
): Promise<AccessTokenResult> {
  const stored = await getConnection(userId);
  if (isStoreFailure(stored)) {
    return { ok: false, code: stored.code };
  }
  if (!stored.data) return { ok: false, code: "not_connected" };

  const row = stored.data;

  if (!needsRefresh(row.access_token_expires_at)) {
    const accessToken = decryptSecret(
      config,
      row.access_token_ciphertext,
      `supabase-access-token:${userId}`,
    );
    if (!accessToken) {
      return clearAndRequireReconnect(userId, "reconnect_required");
    }
    return { ok: true, accessToken };
  }

  const pending = refreshLocks.get(userId);
  if (pending) return pending;

  let tracked: Promise<AccessTokenResult>;
  tracked = refreshStoredConnection(userId, config, row).finally(() => {
    if (refreshLocks.get(userId) === tracked) refreshLocks.delete(userId);
  });
  refreshLocks.set(userId, tracked);
  return tracked;
}
