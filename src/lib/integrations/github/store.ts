/**
 * Persistence for the GitHub integration.
 *
 * ⚠️ EVERY QUERY USES THE CALLER'S RLS-SCOPED CLIENT. There is no service-role
 * path: `github_connections` and `github_oauth_states` are user-scoped by their
 * own policies, and `github_repository_connections` inherits the project's
 * ownership row.
 *
 * ⚠️ THE CIPHERTEXT COLUMNS NEVER LEAVE THIS MODULE. A route answers with a
 * summary — a login, a repository name, a branch — and never with a token.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { GithubIntegrationConfig } from "./config";
import { decryptSecret, encryptSecret } from "./crypto";
import type { GithubTokenSet } from "./oauth";

export interface GithubConnectionRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
  granted_scope: string | null;
  github_user_id: number | null;
  github_login: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubRepositoryConnectionRow {
  id: string;
  project_id: string;
  user_id: string;
  repository_id: number;
  owner_login: string;
  owner_type: string;
  repository_name: string;
  repository_full_name: string;
  default_branch: string;
  branch: string;
  last_synced_commit_sha: string | null;
  last_pushed_commit_sha: string | null;
  last_pushed_at: string | null;
  last_pushed_paths: unknown;
  sync_status: string;
  sync_message: string | null;
  created_at: string;
  updated_at: string;
}

export type GithubStoreErrorCode =
  | "store_unavailable"
  | "not_connected"
  | "state_missing"
  | "state_expired"
  | "state_invalid";

export type GithubStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: GithubStoreErrorCode };

export function isGithubStoreFailure<T>(
  result: GithubStoreResult<T>,
): result is { ok: false; code: GithubStoreErrorCode } {
  return result.ok === false;
}

function accessAad(userId: string): string {
  return `github-access-token:${userId}`;
}

function refreshAad(userId: string): string {
  return `github-refresh-token:${userId}`;
}

function stateAad(userId: string, stateHash: string): string {
  return `github-oauth-state:${userId}:${stateHash}`;
}

const CONNECTION_COLUMNS =
  "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, granted_scope, github_user_id, github_login, created_at, updated_at";

const REPOSITORY_COLUMNS =
  "id,project_id,user_id,repository_id,owner_login,owner_type,repository_name,repository_full_name,default_branch,branch,last_synced_commit_sha,last_pushed_commit_sha,last_pushed_at,last_pushed_paths,sync_status,sync_message,created_at,updated_at";

/* ───────────────────────── The account connection ───────────────────────── */

export async function getConnection(
  userId: string,
): Promise<GithubStoreResult<GithubConnectionRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("github_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[github] connection lookup failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: (data as GithubConnectionRow | null) ?? null };
}

export async function saveConnection(
  userId: string,
  tokens: GithubTokenSet,
  account: { id: number; login: string } | null,
  config: GithubIntegrationConfig,
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase.from("github_connections").upsert(
    {
      user_id: userId,
      access_token_ciphertext: encryptSecret(
        config.clientId,
        config.encryptionKey,
        tokens.accessToken,
        accessAad(userId),
      ),
      refresh_token_ciphertext: tokens.refreshToken
        ? encryptSecret(
            config.clientId,
            config.encryptionKey,
            tokens.refreshToken,
            refreshAad(userId),
          )
        : null,
      access_token_expires_at: tokens.expiresAt,
      granted_scope: tokens.scope,
      github_user_id: account?.id ?? null,
      github_login: account?.login ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[github] connection save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

export async function updateConnectionTokens(
  userId: string,
  tokens: GithubTokenSet,
  config: GithubIntegrationConfig,
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase
    .from("github_connections")
    .update({
      access_token_ciphertext: encryptSecret(
        config.clientId,
        config.encryptionKey,
        tokens.accessToken,
        accessAad(userId),
      ),
      ...(tokens.refreshToken
        ? {
            refresh_token_ciphertext: encryptSecret(
              config.clientId,
              config.encryptionKey,
              tokens.refreshToken,
              refreshAad(userId),
            ),
          }
        : {}),
      access_token_expires_at: tokens.expiresAt,
      granted_scope: tokens.scope,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) {
    console.error("[github] connection token update failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

export async function deleteConnection(userId: string): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase
    .from("github_connections")
    .delete()
    .eq("user_id", userId);

  if (error) {
    console.error("[github] connection delete failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

/**
 * The access token of a connection, decrypted.
 *
 * ⚠️ THE REFRESH IS HANDLED BY THE CALLER, which needs the configuration to
 * refresh the token; this returns the stored pair and lets the caller decide.
 */
export async function readTokens(
  userId: string,
  config: GithubIntegrationConfig,
): Promise<
  GithubStoreResult<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }>
> {
  const connection = await getConnection(userId);
  if (isGithubStoreFailure(connection)) return connection;
  if (!connection.data) return { ok: false, code: "not_connected" };

  const accessToken = decryptSecret(
    config.clientId,
    config.encryptionKey,
    connection.data.access_token_ciphertext,
    accessAad(userId),
  );
  if (!accessToken) return { ok: false, code: "not_connected" };

  const refreshToken = connection.data.refresh_token_ciphertext
    ? decryptSecret(
        config.clientId,
        config.encryptionKey,
        connection.data.refresh_token_ciphertext,
        refreshAad(userId),
      )
    : null;

  return {
    ok: true,
    data: {
      accessToken,
      refreshToken,
      expiresAt: connection.data.access_token_expires_at,
    },
  };
}

/* ───────────────────────────── OAuth state ─────────────────────────────── */

export async function createOAuthState(
  userId: string,
  stateHash: string,
  codeVerifier: string,
  returnTo: string,
  config: GithubIntegrationConfig,
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase.from("github_oauth_states").insert({
    state_hash: stateHash,
    user_id: userId,
    code_verifier_ciphertext: encryptSecret(
      config.clientId,
      config.encryptionKey,
      codeVerifier,
      stateAad(userId, stateHash),
    ),
    return_to: returnTo,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (error) {
    console.error("[github] OAuth state save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

/**
 * Delete and return the state row in one statement, so the state is single-use
 * even if two callbacks arrive at the same moment.
 */
export async function consumeOAuthState(
  userId: string,
  stateHash: string,
  config: GithubIntegrationConfig,
): Promise<GithubStoreResult<{ codeVerifier: string; returnTo: string }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("github_oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", userId)
    .select("code_verifier_ciphertext, return_to, expires_at")
    .maybeSingle();

  if (error) {
    console.error("[github] OAuth state consume failed");
    return { ok: false, code: "store_unavailable" };
  }
  if (!data) return { ok: false, code: "state_missing" };

  const row = data as {
    code_verifier_ciphertext: string;
    return_to: string;
    expires_at: string;
  };
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, code: "state_expired" };
  }

  const codeVerifier = decryptSecret(
    config.clientId,
    config.encryptionKey,
    row.code_verifier_ciphertext,
    stateAad(userId, stateHash),
  );
  if (!codeVerifier) return { ok: false, code: "state_invalid" };

  return { ok: true, data: { codeVerifier, returnTo: row.return_to } };
}

/* ─────────────────────── The project's repository ──────────────────────── */

export async function getRepositoryConnection(
  projectId: string,
): Promise<GithubStoreResult<GithubRepositoryConnectionRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("github_repository_connections")
    .select(REPOSITORY_COLUMNS)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) {
    console.error("[github] repository connection lookup failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: (data as GithubRepositoryConnectionRow | null) ?? null };
}

export interface RepositoryConnectionInput {
  projectId: string;
  userId: string;
  repositoryId: number;
  ownerLogin: string;
  ownerType: string;
  repositoryName: string;
  repositoryFullName: string;
  defaultBranch: string;
  branch: string;
}

export async function saveRepositoryConnection(
  input: RepositoryConnectionInput,
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase.from("github_repository_connections").upsert(
    {
      project_id: input.projectId,
      user_id: input.userId,
      repository_id: input.repositoryId,
      owner_login: input.ownerLogin,
      owner_type: input.ownerType,
      repository_name: input.repositoryName,
      repository_full_name: input.repositoryFullName,
      default_branch: input.defaultBranch,
      branch: input.branch,
      sync_status: "connected",
      sync_message: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id" },
  );

  if (error) {
    console.error("[github] repository connection save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

export async function updateRepositorySync(
  projectId: string,
  patch: {
    lastSyncedCommitSha?: string | null;
    lastPushedCommitSha?: string | null;
    lastPushedAt?: string | null;
    lastPushedPaths?: readonly string[];
    syncStatus?: string;
    syncMessage?: string | null;
    branch?: string;
  },
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.lastSyncedCommitSha !== undefined) {
    updates.last_synced_commit_sha = patch.lastSyncedCommitSha;
  }
  if (patch.lastPushedCommitSha !== undefined) {
    updates.last_pushed_commit_sha = patch.lastPushedCommitSha;
  }
  if (patch.lastPushedAt !== undefined) updates.last_pushed_at = patch.lastPushedAt;
  if (patch.lastPushedPaths !== undefined) {
    updates.last_pushed_paths = [...patch.lastPushedPaths].slice(0, 1_000);
  }
  if (patch.syncStatus !== undefined) updates.sync_status = patch.syncStatus;
  if (patch.syncMessage !== undefined) updates.sync_message = patch.syncMessage;
  if (patch.branch !== undefined) updates.branch = patch.branch;

  const { error } = await supabase
    .from("github_repository_connections")
    .update(updates)
    .eq("project_id", projectId);

  if (error) {
    console.error("[github] repository connection update failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

export async function deleteRepositoryConnection(
  projectId: string,
): Promise<GithubStoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase
    .from("github_repository_connections")
    .delete()
    .eq("project_id", projectId);

  if (error) {
    console.error("[github] repository connection delete failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}
