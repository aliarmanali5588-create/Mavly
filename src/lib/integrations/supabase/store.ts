/**
 * Persistence for the Supabase integration.
 *
 * Every query uses the caller's RLS-scoped client. There is no service-role
 * path. Ciphertext columns are never returned to the browser by any route.
 */

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupabaseIntegrationConfig } from "./config";
import { decryptSecret, encryptSecret } from "./crypto";
import type { SupabaseTokenSet } from "./oauth";
import type {
  SupabaseIntegrationSummary,
  SupabaseSelectedProject,
} from "./types";

export interface SupabaseConnectionRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: string;
  selected_project_ref: string | null;
  selected_project_name: string | null;
  selected_organization_id: string | null;
  selected_organization_slug: string | null;
  created_at: string;
  updated_at: string;
}

export type StoreErrorCode =
  | "store_unavailable"
  | "not_connected"
  | "state_missing"
  | "state_expired"
  | "state_invalid";

export type StoreSuccess<T> = { ok: true; data: T };
export type StoreFailure = { ok: false; code: StoreErrorCode };
export type StoreResult<T> = StoreSuccess<T> | StoreFailure;

export function isStoreFailure<T>(result: StoreResult<T>): result is StoreFailure {
  return result.ok === false;
}

function accessAad(userId: string): string {
  return `supabase-access-token:${userId}`;
}

function refreshAad(userId: string): string {
  return `supabase-refresh-token:${userId}`;
}

function stateAad(userId: string, stateHash: string): string {
  return `supabase-oauth-state:${userId}:${stateHash}`;
}

function expiresAt(tokens: SupabaseTokenSet): string {
  return new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
}

export function summarizeConnection(
  row: SupabaseConnectionRow | null,
): SupabaseIntegrationSummary {
  if (!row) {
    return {
      connected: false,
      selectedProject: null,
      connectedAt: null,
      tokenExpiresAt: null,
    };
  }

  const selectedProject =
    row.selected_project_ref &&
    row.selected_project_name &&
    row.selected_organization_id &&
    row.selected_organization_slug
      ? {
          ref: row.selected_project_ref,
          name: row.selected_project_name,
          organizationId: row.selected_organization_id,
          organizationSlug: row.selected_organization_slug,
        }
      : null;

  return {
    connected: true,
    selectedProject,
    connectedAt: row.created_at,
    tokenExpiresAt: row.access_token_expires_at,
  };
}

export async function getConnection(
  userId: string,
): Promise<StoreResult<SupabaseConnectionRow | null>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("supabase_integrations")
    .select(
      "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, selected_project_ref, selected_project_name, selected_organization_id, selected_organization_slug, created_at, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[supabase-integration] connection lookup failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: (data as SupabaseConnectionRow | null) ?? null };
}

export async function saveNewConnection(
  userId: string,
  tokens: SupabaseTokenSet,
  config: SupabaseIntegrationConfig,
): Promise<StoreResult<{ summary: SupabaseIntegrationSummary }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("supabase_integrations")
    .upsert(
      {
        user_id: userId,
        created_at: now,
        access_token_ciphertext: encryptSecret(
          config,
          tokens.accessToken,
          accessAad(userId),
        ),
        refresh_token_ciphertext: encryptSecret(
          config,
          tokens.refreshToken,
          refreshAad(userId),
        ),
        access_token_expires_at: expiresAt(tokens),
        selected_project_ref: null,
        selected_project_name: null,
        selected_organization_id: null,
        selected_organization_slug: null,
        updated_at: now,
      },
      { onConflict: "user_id" },
    )
    .select(
      "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, selected_project_ref, selected_project_name, selected_organization_id, selected_organization_slug, created_at, updated_at",
    )
    .maybeSingle();

  if (error || !data) {
    console.error("[supabase-integration] connection save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return {
    ok: true,
    data: { summary: summarizeConnection(data as SupabaseConnectionRow) },
  };
}

export async function updateConnectionTokens(
  userId: string,
  tokens: SupabaseTokenSet,
  config: SupabaseIntegrationConfig,
): Promise<StoreResult<{ summary: SupabaseIntegrationSummary }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("supabase_integrations")
    .update({
      access_token_ciphertext: encryptSecret(
        config,
        tokens.accessToken,
        accessAad(userId),
      ),
      refresh_token_ciphertext: encryptSecret(
        config,
        tokens.refreshToken,
        refreshAad(userId),
      ),
      access_token_expires_at: expiresAt(tokens),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select(
      "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, selected_project_ref, selected_project_name, selected_organization_id, selected_organization_slug, created_at, updated_at",
    )
    .maybeSingle();

  if (error || !data) return { ok: false, code: "not_connected" };
  return {
    ok: true,
    data: { summary: summarizeConnection(data as SupabaseConnectionRow) },
  };
}

export async function saveSelectedProject(
  userId: string,
  project: SupabaseSelectedProject,
): Promise<StoreResult<{ summary: SupabaseIntegrationSummary }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("supabase_integrations")
    .update({
      selected_project_ref: project.ref,
      selected_project_name: project.name,
      selected_organization_id: project.organizationId,
      selected_organization_slug: project.organizationSlug,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select(
      "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, selected_project_ref, selected_project_name, selected_organization_id, selected_organization_slug, created_at, updated_at",
    )
    .maybeSingle();

  if (error || !data) return { ok: false, code: "not_connected" };
  return {
    ok: true,
    data: { summary: summarizeConnection(data as SupabaseConnectionRow) },
  };
}

export async function deleteConnection(userId: string): Promise<StoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { error } = await supabase
    .from("supabase_integrations")
    .delete()
    .eq("user_id", userId);

  if (error) {
    console.error("[supabase-integration] connection delete failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

export async function createOAuthState(
  userId: string,
  stateHash: string,
  codeVerifier: string,
  returnTo: string,
  config: SupabaseIntegrationConfig,
): Promise<StoreResult<true>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  await supabase
    .from("supabase_oauth_states")
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString());

  const { error } = await supabase.from("supabase_oauth_states").insert({
    state_hash: stateHash,
    user_id: userId,
    code_verifier_ciphertext: encryptSecret(
      config,
      codeVerifier,
      stateAad(userId, stateHash),
    ),
    return_to: returnTo,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (error) {
    console.error("[supabase-integration] OAuth state save failed");
    return { ok: false, code: "store_unavailable" };
  }
  return { ok: true, data: true };
}

/**
 * Delete and return the state row in one statement. The state is therefore
 * single-use even if two callbacks arrive at the same moment.
 */
export async function consumeOAuthState(
  userId: string,
  stateHash: string,
  config: SupabaseIntegrationConfig,
): Promise<
  StoreResult<{ codeVerifier: string; returnTo: string }>
> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, code: "store_unavailable" };

  const { data, error } = await supabase
    .from("supabase_oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", userId)
    .select("code_verifier_ciphertext, return_to, expires_at")
    .maybeSingle();

  if (error) {
    console.error("[supabase-integration] OAuth state consume failed");
    return { ok: false, code: "store_unavailable" };
  }
  if (!data) return { ok: false, code: "state_missing" };

  const row = data as {
    code_verifier_ciphertext: string;
    return_to: string;
    expires_at: string;
  };
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, code: "state_expired" };
  }

  const codeVerifier = decryptSecret(
    config,
    row.code_verifier_ciphertext,
    stateAad(userId, stateHash),
  );
  if (!codeVerifier) return { ok: false, code: "state_invalid" };

  return {
    ok: true,
    data: { codeVerifier, returnTo: row.return_to },
  };
}
