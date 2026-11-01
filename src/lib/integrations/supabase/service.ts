/**
 * ═══ SUPABASE OAUTH SERVICE ══════════════════════════════════════════════════
 *
 * Orchestration: start the flow, complete it, list projects, select one, refresh,
 * disconnect. Server-only.
 *
 * ⚠️ NO FUNCTION HERE RETURNS A TOKEN. The one function that reads decrypted
 * tokens is `readTokens` in the store, and it is called only by the broker and by
 * `refreshConnection` below, which writes the new pair back and returns nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { randomToken, sha256Base64Url, pkceChallenge, safeReturnTo } from "@/lib/integrations/github/crypto";
import { connectExternalSupabase } from "@/lib/backend-providers/store";
import { supabaseProviderConfig } from "@/lib/backend-providers/supabase";

import { supabaseOAuthConfig, type SupabaseOAuthConfig } from "./config";
import {
  buildSupabaseAuthorizeUrl,
  exchangeSupabaseCode,
  isSafeProjectRef,
  listProjects,
  refreshSupabaseToken,
} from "./oauth";
import {
  createOAuthState,
  consumeOAuthState,
  consumeSelectionSession,
  deleteConnection,
  markStatus,
  openSelectionSession,
  readConnection,
  readTokens,
  recordAudit,
  saveConnection,
  type SupabaseConnectionView,
  type SupabaseStoreFailureCode,
} from "./store";

export interface SupabaseServiceFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}

export type SupabaseServiceResult<T> =
  | { ok: true; data: T }
  | SupabaseServiceFailure;

function failure(code: string, message: string, status = 400): SupabaseServiceFailure {
  return { ok: false, code, message, status };
}

function storeFailure(code: SupabaseStoreFailureCode, action: string): SupabaseServiceFailure {
  switch (code) {
    case "migration_required":
      return failure(
        "SUPABASE_OAUTH_MIGRATION_REQUIRED",
        "Supabase OAuth storage is not installed. Apply supabase/migrations/40_supabase_oauth.sql.",
        503,
      );
    case "forbidden":
      return failure(
        "SUPABASE_OAUTH_FORBIDDEN",
        "You do not have access to this project's Supabase connection.",
        403,
      );
    case "state_missing":
    case "state_expired":
    case "state_invalid":
      return failure(
        "SUPABASE_OAUTH_STATE_INVALID",
        "That authorization link is no longer valid. Start the connection again.",
        400,
      );
    case "store_unavailable":
      return failure("SUPABASE_OAUTH_UNAVAILABLE", "The connection could not be saved.", 503);
    case "not_found":
      return failure("SUPABASE_OAUTH_NOT_CONNECTED", "No Supabase project is connected.", 404);
    default:
      return failure("SUPABASE_OAUTH_ERROR", `The Supabase connection could not be ${action}.`, 500);
  }
}

function configOrFailure():
  | { ok: true; config: SupabaseOAuthConfig }
  | SupabaseServiceFailure {
  const config = supabaseOAuthConfig();
  if (!config.ok) {
    /**
     * ⚠️ A MISSING OAUTH APP IS A DEPLOYMENT FACT, NOT A USER ERROR. The message
     * names the exact variables so an operator can fix it without reading code.
     */
    return failure(
      "SUPABASE_OAUTH_NOT_CONFIGURED",
      "Supabase OAuth is not configured on this deployment. Set SUPABASE_OAUTH_CLIENT_ID, SUPABASE_OAUTH_CLIENT_SECRET and SUPABASE_OAUTH_REDIRECT_URI.",
      503,
    );
  }
  return { ok: true, config: config.config };
}

/* ───────────────────────────── Start the flow ──────────────────────────── */

export async function startSupabaseOAuth(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  returnTo: unknown;
}): Promise<SupabaseServiceResult<{ authorizationUrl: string }>> {
  const configured = configOrFailure();
  if ("ok" in configured && configured.ok === false) return configured;
  if (!("ok" in configured) || configured.ok !== true) {
    return failure("SUPABASE_OAUTH_NOT_CONFIGURED", "Supabase OAuth is not configured.", 503);
  }

  /**
   * ⚠️ STATE AND VERIFIER ARE GENERATED SERVER-SIDE. The browser receives only
   * the authorization URL, so it never holds a verifier or a secret.
   */
  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  const stateHash = sha256Base64Url(state);

  const saved = await createOAuthState({
    client: input.client,
    stateHash,
    codeVerifier,
    returnTo: safeReturnTo(input.returnTo) ?? "/dashboard",
    mavlyProjectId: input.projectId,
    userId: input.userId,
    config: configured.config,
  });
  if (saved.ok === false) return storeFailure(saved.code, "started");

  return {
    ok: true,
    data: {
      authorizationUrl: buildSupabaseAuthorizeUrl(
        configured.config,
        state,
        pkceChallenge(codeVerifier),
      ),
    },
  };
}

/* ─────────────────────────── Complete the flow ─────────────────────────── */

/**
 * ⚠️ THE TOKEN PAIR IS STORED HERE, BEFORE A PROJECT IS CHOSEN, as a
 * `pending_selection` row. That is what lets the selection step read the token
 * from the database instead of from the browser: no access token or refresh token
 * ever travels through a response body or a client-side store.
 *
 * ⚠️ A PENDING ROW IS NOT A CONNECTION. `pending_selection` cannot serve an agent
 * action (the broker refuses it), so an abandoned flow leaves an unusable row
 * rather than a working credential.
 */
export async function completeSupabaseOAuth(input: {
  client: SupabaseClient;
  userId: string;
  /**
   * ⚠️ NO projectId PARAMETER. The Mavly project comes from the consumed state
   * row, which was written against the verified owner. Accepting it from the
   * callback URL would let a caller pick whose project the token lands in.
   */
  state: string;
  code: string | null;
  error: string | null;
}): Promise<
  SupabaseServiceResult<{
    returnTo: string;
    projectId: string | null;
    projects: Array<{ ref: string; name: string; organizationSlug: string | null }>;
  }>
> {
  const configured = configOrFailure();
  if ("ok" in configured && configured.ok === false) return configured;
  if (!("ok" in configured) || configured.ok !== true) {
    return failure("SUPABASE_OAUTH_NOT_CONFIGURED", "Supabase OAuth is not configured.", 503);
  }

  const consumed = await consumeOAuthState({
    client: input.client,
    stateHash: sha256Base64Url(input.state),
    userId: input.userId,
    config: configured.config,
  });
  if (consumed.ok === false) return storeFailure(consumed.code, "completed");

  const { codeVerifier, returnTo, mavlyProjectId } = consumed.data;

  /**
   * ⚠️ THE STATE IS CONSUMED BEFORE THE ERROR IS CHECKED. A denied consent still
   * burns its state, so the same link cannot be retried into a different outcome.
   */
  if (input.error) {
    return failure("SUPABASE_OAUTH_DENIED", "Supabase authorization was declined.", 400);
  }
  if (!input.code || input.code.length > 4096) {
    return failure("SUPABASE_OAUTH_INVALID_CODE", "Supabase did not return an authorization code.", 400);
  }

  const exchanged = await exchangeSupabaseCode(configured.config, input.code, codeVerifier);
  if (exchanged.ok === false) {
    return failure(
      "SUPABASE_OAUTH_EXCHANGE_FAILED",
      "The Supabase authorization could not be completed.",
      400,
    );
  }

  const projects = await listProjects(exchanged.data.accessToken);
  if (projects.ok === false) {
    return failure(
      "SUPABASE_OAUTH_PROJECTS_FAILED",
      "Your Supabase projects could not be listed.",
      502,
    );
  }

  /**
   * The state row carries the Mavly project. Without it there is nowhere to store
   * the token, so the flow is refused rather than parked somewhere arbitrary.
   */
  if (!mavlyProjectId) {
    return failure(
      "SUPABASE_OAUTH_NO_PROJECT",
      "Start the Supabase connection from a Mavly project.",
      400,
    );
  }

  const saved = await saveConnection({
    client: input.client,
    userId: input.userId,
    projectId: mavlyProjectId,
    config: configured.config,
    projectRef: null,
    projectName: null,
    organizationSlug: null,
    accessToken: exchanged.data.accessToken,
    refreshToken: exchanged.data.refreshToken,
    expiresAt: exchanged.data.expiresAt,
    grantedScopes: exchanged.data.grantedScopes,
  });
  if (saved.ok === false) return storeFailure(saved.code, "saved");

  return {
    ok: true,
    data: {
      returnTo,
      projectId: mavlyProjectId,
      projects: projects.data.map((project) => ({
        ref: project.ref,
        name: project.name,
        organizationSlug: project.organizationSlug,
      })),
    },
  };
}

/* ────────────────────────── Project selection ──────────────────────────── */

/**
 * The projects the STORED token can see, for the selection picker.
 *
 * ⚠️ THIS REPLACES PUTTING THE PROJECT LIST IN THE CALLBACK URL. The old flow
 * base64-encoded refs and names into a query parameter, which put customer
 * project names into access logs, browser history and referrer headers. The list
 * is now derived server-side from the encrypted token row every time it is
 * needed, so nothing identifying travels through the browser's address bar.
 *
 * ⚠️ BOUND TO THE AUTHENTICATED OWNER AND THE CONNECTION. The token is read
 * through an owner-checked RPC, so this cannot list another account's projects,
 * and it only works while a `pending_selection` or `connected` row exists.
 */
export async function listSelectableProjects(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
}): Promise<
  SupabaseServiceResult<{
    projects: Array<{ ref: string; name: string; organizationSlug: string | null }>;
  }>
> {
  const configured = configOrFailure();
  if ("ok" in configured && configured.ok === false) return configured;
  if (!("ok" in configured) || configured.ok !== true) {
    return failure("SUPABASE_OAUTH_NOT_CONFIGURED", "Supabase OAuth is not configured.", 503);
  }

  const stored = await readTokens({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: configured.config,
  });
  if (stored.ok === false) return storeFailure(stored.code, "listed");
  if (!stored.data || !stored.data.accessToken) {
    return failure(
      "SUPABASE_OAUTH_NOT_CONNECTED",
      "Start the Supabase connection again.",
      409,
    );
  }

  const projects = await listProjects(stored.data.accessToken);
  if (projects.ok === false) {
    return failure(
      "SUPABASE_OAUTH_PROJECTS_FAILED",
      "Your Supabase projects could not be listed.",
      502,
    );
  }

  return {
    ok: true,
    data: {
      projects: projects.data.map((project) => ({
        ref: project.ref,
        name: project.name,
        organizationSlug: project.organizationSlug,
      })),
    },
  };
}

/**
 * Open a short-lived selection session for the picker.
 *
 * ⚠️ THE SESSION IS THE BINDING, NOT THE PROJECT ID ALONE. It names the
 * authenticated user and the Mavly project, expires in ten minutes, and is
 * consumed by the selection it authorizes. That is what lets the callback URL
 * carry no project data at all: the browser holds an opaque id, not a list of
 * customer refs and names.
 */
export async function openSupabaseSelection(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<SupabaseServiceResult<{ selectionId: string; expiresAt: string }>> {
  const opened = await openSelectionSession({
    client: input.client,
    projectId: input.projectId,
  });
  if (opened.ok === false) return storeFailure(opened.code, "selection");
  return { ok: true, data: opened.data };
}

/**
 * ⚠️ THE TOKEN COMES FROM THE STORE, NOT FROM THE REQUEST. The browser sends only
 * the project ref it wants. That ref is then checked against the live project list
 * the stored token can actually see, so a forged ref cannot attach a project the
 * user has no access to.
 */
export async function selectSupabaseProject(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  supabaseProjectRef: unknown;
  /** Required: the single-use session that authorizes this selection. */
  selectionId: unknown;
}): Promise<SupabaseServiceResult<{ connection: SupabaseConnectionView }>> {
  const configured = configOrFailure();
  if ("ok" in configured && configured.ok === false) return configured;
  if (!("ok" in configured) || configured.ok !== true) {
    return failure("SUPABASE_OAUTH_NOT_CONFIGURED", "Supabase OAuth is not configured.", 503);
  }

  if (!isSafeProjectRef(input.supabaseProjectRef)) {
    return failure("SUPABASE_OAUTH_INVALID_PROJECT", "Choose a Supabase project.", 400);
  }

  /**
   * ═══ THE SELECTION SESSION IS CONSUMED FIRST ═════════════════════════════
   *
   * ⚠️ BEFORE ANY TOKEN IS READ OR ANY PROJECT IS LISTED. The session is
   * delete-returning, so a replayed id fails here and never reaches the token
   * store. An expired, already-used, or foreign session is refused with the same
   * code so the caller cannot distinguish "wrong user" from "expired".
   */
  const consumed = await consumeSelectionSession({
    client: input.client,
    projectId: input.projectId,
    selectionId: input.selectionId,
  });
  if (consumed.ok === false) {
    return failure(
      "SUPABASE_OAUTH_SELECTION_INVALID",
      "That selection expired. Start the Supabase connection again.",
      409,
    );
  }

  const stored = await readTokens({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: configured.config,
  });
  if (stored.ok === false) return storeFailure(stored.code, "read");
  if (!stored.data || !stored.data.accessToken) {
    return failure(
      "SUPABASE_OAUTH_NOT_CONNECTED",
      "Start the Supabase connection again.",
      409,
    );
  }

  const projects = await listProjects(stored.data.accessToken);
  if (projects.ok === false) {
    return failure(
      "SUPABASE_OAUTH_PROJECTS_FAILED",
      "Your Supabase projects could not be verified.",
      502,
    );
  }
  const selected = projects.data.find((project) => project.ref === input.supabaseProjectRef);
  if (!selected) {
    return failure(
      "SUPABASE_OAUTH_PROJECT_NOT_AUTHORIZED",
      "That Supabase project is not available to this authorization.",
      403,
    );
  }

  /**
   * ═══ REGISTER THE BACKEND PROVIDER ═══════════════════════════════════════
   *
   * ⚠️ WITHOUT THIS STEP THE CONNECTION IS INERT. The OAuth token row alone does
   * not make the project's backend the customer's Supabase database: the
   * Backend Center reads `project_backend_providers`, so an OAuth-only connection
   * would show "connected" in the card while "Use this backend" never appeared
   * and the generated app kept using whatever it used before.
   *
   * ⚠️ `verified: true` IS EARNED, NOT ASSUMED. The token was just used to list
   * projects and the chosen ref was found in that list, so Supabase has confirmed
   * this account can reach this project.
   *
   * ⚠️ NO SERVICE-ROLE KEY IS STORED. The OAuth flow exists precisely so the user
   * never has to mint one. `service_role_ciphertext` stays null, which the
   * migration 39 constraint permits.
   *
   * ⚠️ THIS DOES NOT ACTIVATE. Connecting and making authoritative are separate
   * acts, so an existing active backend is never silently replaced.
   */
  const registered = await connectExternalSupabase({
    client: input.client,
    projectId: input.projectId,
    config: supabaseProviderConfig({
      projectRef: selected.ref,
      host: `${selected.ref}.supabase.co`,
    }),
    serviceRoleCiphertext: null,
    anonKeySecretName: null,
    verified: true,
  });
  if (registered.ok === false) {
    /**
     * ⚠️ A PROVIDER-REGISTRY FAILURE DOES NOT FAIL THE SELECTION. The encrypted
     * token row is already saved and is what the broker uses; the registry row is
     * what the Backend Center displays. Reporting the whole selection as failed
     * would tell the user nothing was connected when the connection works.
     */
    console.error("[supabase-oauth] provider registration failed", registered.code);
  }

  /**
   * ⚠️ THE TOKEN IS RE-SAVED WITH THE REF. `saveConnection` derives
   * `connected` from the ref, so this single write is the transition out of
   * `pending_selection`.
   */
  const saved = await saveConnection({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: configured.config,
    projectRef: selected.ref,
    projectName: selected.name,
    organizationSlug: selected.organizationSlug,
    accessToken: stored.data.accessToken,
    refreshToken: stored.data.refreshToken,
    expiresAt: stored.data.expiresAt,
    grantedScopes: stored.data.grantedScopes,
  });
  if (saved.ok === false) return storeFailure(saved.code, "saved");

  const connection = await readConnection({
    client: input.client,
    projectId: input.projectId,
  });
  if (connection.ok === false) return storeFailure(connection.code, "read");
  if (!connection.data) {
    return failure("SUPABASE_OAUTH_ERROR", "The connection was not saved.", 500);
  }

  return { ok: true, data: { connection: connection.data } };
}

/* ─────────────────────────────── Refresh ───────────────────────────────── */

/**
 * Refresh the stored token pair.
 *
 * ⚠️ A REFUSED REFRESH IS TERMINAL. Supabase answers 401 when the user revoked
 * the app, so the row is marked `revoked` and the caller is told to reconnect.
 * Retrying would loop forever against a credential that will never work again.
 */
export async function refreshConnection(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
}): Promise<SupabaseServiceResult<{ refreshed: boolean }>> {
  const configured = configOrFailure();
  if ("ok" in configured && configured.ok === false) return configured;
  if (!("ok" in configured) || configured.ok !== true) {
    return failure("SUPABASE_OAUTH_NOT_CONFIGURED", "Supabase OAuth is not configured.", 503);
  }

  const stored = await readTokens({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: configured.config,
  });
  if (stored.ok === false) return storeFailure(stored.code, "refreshed");
  if (!stored.data || !stored.data.refreshToken) {
    return failure(
      "SUPABASE_OAUTH_NO_REFRESH_TOKEN",
      "This connection cannot be refreshed. Reconnect to continue.",
      409,
    );
  }

  const refreshed = await refreshSupabaseToken(configured.config, stored.data.refreshToken);
  if (refreshed.ok === false) {
    const revoked = refreshed.code === "supabase_unauthorized";
    await markStatus({
      client: input.client,
      projectId: input.projectId,
      status: revoked ? "revoked" : "reconnection_required",
      lastError: revoked
        ? "Supabase access was revoked."
        : "The Supabase authorization could not be refreshed.",
    });
    return failure(
      revoked ? "SUPABASE_OAUTH_REVOKED" : "SUPABASE_OAUTH_REFRESH_FAILED",
      revoked
        ? "Supabase access was revoked. Reconnect to continue."
        : "The Supabase authorization could not be refreshed.",
      409,
    );
  }

  const saved = await saveConnection({
    client: input.client,
    userId: input.userId,
    projectId: input.projectId,
    config: configured.config,
    projectRef: stored.data.projectRef,
    projectName: null,
    organizationSlug: null,
    accessToken: refreshed.data.accessToken,
    refreshToken: refreshed.data.refreshToken ?? stored.data.refreshToken,
    expiresAt: refreshed.data.expiresAt,
    grantedScopes:
      refreshed.data.grantedScopes.length > 0
        ? refreshed.data.grantedScopes
        : stored.data.grantedScopes,
  });
  if (saved.ok === false) return storeFailure(saved.code, "refreshed");

  return { ok: true, data: { refreshed: true } };
}

/* ────────────────────────────── Disconnect ─────────────────────────────── */

/**
 * ⚠️ DISCONNECT DELETES MAVLY'S TOKEN ROW ONLY. The customer's Supabase project,
 * its database and its data are untouched: Mavly never owned them.
 */
export async function disconnectSupabase(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<SupabaseServiceResult<{ disconnected: true }>> {
  const deleted = await deleteConnection({
    client: input.client,
    projectId: input.projectId,
  });
  if (deleted.ok === false) return storeFailure(deleted.code, "disconnected");
  return { ok: true, data: { disconnected: true } };
}

/* ─────────────────────────────── Status ────────────────────────────────── */

export async function readSupabaseStatus(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<SupabaseServiceResult<{ connection: SupabaseConnectionView | null }>> {
  const connection = await readConnection({
    client: input.client,
    projectId: input.projectId,
  });
  if (connection.ok === false) return storeFailure(connection.code, "read");
  return { ok: true, data: { connection: connection.data } };
}

export { recordAudit };
