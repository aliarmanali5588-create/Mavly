/**
 * ═══ BACKEND PROVIDER SERVICE ═══════════════════════════════════════════════
 *
 * The orchestration half: validate a credential, encrypt it, persist it, and
 * decide whether a switch is legal. Every entry point is server-only.
 *
 * ⚠️ THE SERVICE-ROLE KEY IS ENCRYPTED WITH THE PROJECT-SECRETS KEY BUT IS NOT A
 * PROJECT SECRET. `project_secrets` values are synced into a deployed
 * application's environment; a service-role key must never be, because it
 * bypasses RLS for every end user of the generated app. It is stored in
 * `project_backend_providers.service_role_ciphertext` and read only by the
 * server adapter.
 */

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
} from "@/lib/project-secrets/crypto";
import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";

import {
  activateBackendProvider,
  connectExternalSupabase,
  disconnectExternalSupabase,
  readBackendProviders,
  readBackendProviderSecret,
  type BackendProviderStoreFailureCode,
  type BackendProviderStoreResult,
} from "./store";
import {
  supabaseProviderConfig,
  verifySupabaseCredentials,
  type SupabaseCredentials,
} from "./supabase";
import {
  buildBackendCenterView,
  decideBackendSwitch,
  type BackendCenterView,
  type BackendProvider,
  type BackendProviderView,
} from "./types";

export interface BackendServiceFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
}

export interface BackendServiceSuccess<T> {
  ok: true;
  data: T;
}

export type BackendServiceResult<T> = BackendServiceSuccess<T> | BackendServiceFailure;

function failure(code: string, message: string, status = 400): BackendServiceFailure {
  return { ok: false, code, message, status };
}

/**
 * Map a store failure to a user-facing answer. A missing migration is a
 * deployment fact, not a user error, and says so.
 */
function storeFailure(
  code: BackendProviderStoreFailureCode,
  action: string,
): BackendServiceFailure {
  switch (code) {
    case "migration_required":
      return failure(
        "BACKEND_PROVIDERS_MIGRATION_REQUIRED",
        "Backend provider storage is not installed. Apply supabase/migrations/39_backend_providers.sql.",
        503,
      );
    case "forbidden":
      return failure(
        "BACKEND_PROVIDERS_FORBIDDEN",
        "You do not have access to this project's backend settings.",
        403,
      );
    case "not_found":
      return failure("BACKEND_PROVIDER_NOT_FOUND", "That backend is not connected.", 404);
    case "conflict":
      return failure(
        "BACKEND_PROVIDER_CONFLICT",
        `The backend could not be ${action} in its current state.`,
        409,
      );
    case "unavailable":
      return failure(
        "BACKEND_PROVIDERS_UNAVAILABLE",
        "The backend provider service is unavailable.",
        503,
      );
    default:
      return failure(
        "BACKEND_PROVIDERS_ERROR",
        `The backend could not be ${action}.`,
        500,
      );
  }
}

/**
 * The encryption key is the existing project-secrets key. Reusing it means one
 * server-only secret to manage, and the AAD below still binds each ciphertext to
 * its own project and provider row.
 */
function encryptionKey(): Buffer | null {
  const config = projectSecretsCryptoConfig();
  if (!config.ok) return null;
  return config.config.encryptionKey;
}

/**
 * AAD for the service-role key. Distinct from the project-secret AAD, so a
 * ciphertext cannot be moved between the two stores even with the same key.
 */
function providerSecretOwner(input: {
  userId: string;
  projectId: string;
  provider: BackendProvider;
}) {
  return {
    userId: input.userId,
    projectId: input.projectId,
    secretId: `backend-provider:${input.provider}`,
  };
}

/**
 * ═══ CONNECT ════════════════════════════════════════════════════════════════
 *
 * Validate against the live project, encrypt the service-role key, persist, and
 * report the resulting state. It does NOT activate: a fresh connection is never
 * authoritative until the user chooses it.
 */
export async function connectSupabaseBackend(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
  credentials: Partial<SupabaseCredentials>;
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<BackendServiceResult<{ provider: BackendProviderView }>> {
  const key = encryptionKey();
  if (!key) {
    return failure(
      "BACKEND_PROVIDERS_ENCRYPTION_UNAVAILABLE",
      "Credential storage is not configured on this deployment, so no credentials were saved.",
      503,
    );
  }

  const credentials: SupabaseCredentials = {
    projectUrl: input.credentials.projectUrl ?? "",
    anonKey: input.credentials.anonKey ?? "",
    serviceRoleKey: input.credentials.serviceRoleKey ?? "",
  };

  const verified = await verifySupabaseCredentials(credentials, {
    fetchImpl: input.fetchImpl,
  });
  if (verified.ok === false) {
    /**
     * The validation code is already a stable, credential-free identifier, so it
     * is surfaced with a SUPABASE_ prefix rather than re-derived from a string.
     */
    return failure(`SUPABASE_${verified.code.toUpperCase()}`, verified.message, 400);
  }

  /**
   * ⚠️ THE ANON KEY IS PUBLIC AND MAY LIVE IN `project_secrets`, because
   * generated code legitimately needs it. The service-role key never does.
   */
  const ciphertext = encryptProjectSecretValue(
    key,
    credentials.serviceRoleKey,
    providerSecretOwner({
      userId: input.userId,
      projectId: input.projectId,
      provider: "external_supabase",
    }),
  );

  const saved = await connectExternalSupabase({
    client: input.client,
    projectId: input.projectId,
    config: supabaseProviderConfig({
      projectRef: verified.projectRef,
      host: verified.host,
    }),
    serviceRoleCiphertext: ciphertext,
    anonKeySecretName: null,
    verified: true,
  });
  if (saved.ok === false) return storeFailure(saved.code, "connected");

  const providers = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (providers.ok === false) return storeFailure(providers.code, "read");

  const row = providers.data.find((entry) => entry.provider === "external_supabase");
  if (!row) return failure("BACKEND_PROVIDERS_ERROR", "The connection was not saved.", 500);

  return { ok: true, data: { provider: row } };
}

/**
 * ═══ SWITCH ═════════════════════════════════════════════════════════════════
 *
 * The only path that changes which backend is authoritative. The rules live in
 * `decideBackendSwitch` so the API and the UI cannot disagree.
 */
export async function switchBackendProvider(input: {
  client: SupabaseClient;
  projectId: string;
  target: BackendProvider;
  confirmed: boolean;
}): Promise<BackendServiceResult<{ activeProvider: BackendProvider; view: BackendCenterView }>> {
  const providers = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (providers.ok === false) return storeFailure(providers.code, "read");

  const active = providers.data.find((entry) => entry.active) ?? null;
  const targetRow = providers.data.find((entry) => entry.provider === input.target) ?? null;

  const decision = decideBackendSwitch({
    currentActive: active?.provider ?? null,
    target: input.target,
    targetStatus: targetRow?.status ?? null,
    confirmed: input.confirmed,
  });

  if (!decision.allowed) {
    /**
     * A confirmation requirement is not an error: it is the API asking the
     * caller to repeat the request deliberately. 409 with the message the UI
     * shows is the honest shape.
     */
    if (decision.refusal === "confirmation_required") {
      return failure(
        "BACKEND_SWITCH_CONFIRMATION_REQUIRED",
        decision.confirmationMessage ?? "Confirm the backend switch.",
        409,
      );
    }
    if (decision.refusal === "already_active") {
      return failure(
        "BACKEND_PROVIDER_ALREADY_ACTIVE",
        "That backend is already active.",
        409,
      );
    }
    if (decision.refusal === "target_not_connected") {
      return failure(
        "BACKEND_PROVIDER_NOT_CONNECTED",
        "Connect that backend before switching to it.",
        400,
      );
    }
    return failure(
      "BACKEND_PROVIDER_NOT_READY",
      "That backend is not ready to become active.",
      409,
    );
  }

  const activated = await activateBackendProvider({
    client: input.client,
    projectId: input.projectId,
    provider: input.target,
  });
  if (activated.ok === false) return storeFailure(activated.code, "activated");

  const after = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (after.ok === false) return storeFailure(after.code, "read");

  return {
    ok: true,
    data: {
      activeProvider: activated.data.provider,
      view: buildBackendCenterView({
        providers: after.data,
        managedBackendState: null,
      }),
    },
  };
}

/**
 * ═══ DISCONNECT ═════════════════════════════════════════════════════════════
 *
 * Refused while active: a project must always have a backend. The SQL enforces
 * this too, so a direct RPC call cannot get around it.
 */
export async function disconnectSupabaseBackend(input: {
  client: SupabaseClient;
  projectId: string;
}): Promise<BackendServiceResult<{ provider: BackendProviderView }>> {
  const disconnected = await disconnectExternalSupabase({
    client: input.client,
    projectId: input.projectId,
  });
  if (disconnected.ok === false) return storeFailure(disconnected.code, "disconnected");

  const providers = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (providers.ok === false) return storeFailure(providers.code, "read");

  const row = providers.data.find((entry) => entry.provider === "external_supabase");
  if (!row) return failure("BACKEND_PROVIDERS_ERROR", "The backend was not found.", 500);
  return { ok: true, data: { provider: row } };
}

/**
 * The page projection for the Database center.
 */
export async function readBackendCenter(input: {
  client: SupabaseClient;
  projectId: string;
  managedBackendState: string | null;
}): Promise<BackendServiceResult<BackendCenterView>> {
  const providers = await readBackendProviders({
    client: input.client,
    projectId: input.projectId,
  });
  if (providers.ok === false) return storeFailure(providers.code, "read");

  return {
    ok: true,
    data: buildBackendCenterView({
      providers: providers.data,
      managedBackendState: input.managedBackendState,
    }),
  };
}

/**
 * ═══ SERVER-ONLY CREDENTIAL READ ════════════════════════════════════════════
 *
 * Used by the Supabase adapter when it needs to act on the customer's project.
 * Returns a decrypted key, so its result must never be serialized to a response.
 */
export async function readSupabaseServiceRoleKey(input: {
  client: SupabaseClient;
  userId: string;
  projectId: string;
}): Promise<BackendServiceResult<{ serviceRoleKey: string; projectRef: string }>> {
  const key = encryptionKey();
  if (!key) {
    return failure(
      "BACKEND_PROVIDERS_ENCRYPTION_UNAVAILABLE",
      "Credential storage is not configured on this deployment.",
      503,
    );
  }

  const stored = await readBackendProviderSecret({
    client: input.client,
    projectId: input.projectId,
  });
  if (stored.ok === false) return storeFailure(stored.code, "read");
  if (!stored.data) {
    /**
     * ⚠️ THIS IS NOT ALWAYS "NOT CONNECTED". A Supabase project connected through
     * Management API OAuth has no service-role key by design, so the registry row
     * exists with a null ciphertext. Saying "no connection is stored" would send
     * the user to reconnect a connection that is working. The honest answer is
     * that this path has no key to offer, because the OAuth flow never mints one.
     */
    return failure(
      "SUPABASE_SERVICE_ROLE_KEY_UNAVAILABLE",
      "This Supabase connection has no service-role key. OAuth connections act through the Management API broker instead.",
      409,
    );
  }

  let serviceRoleKey: string;
  try {
    serviceRoleKey = decryptProjectSecretValue(
      key,
      stored.data.ciphertext,
      providerSecretOwner({
        userId: input.userId,
        projectId: input.projectId,
        provider: "external_supabase",
      }),
    );
  } catch {
    /**
     * A decryption failure means the row was written under a different key or a
     * different owner. It is never a reason to fall back to another credential.
     */
    return failure(
      "SUPABASE_CREDENTIALS_UNREADABLE",
      "The stored Supabase credentials could not be read. Reconnect the backend.",
      409,
    );
  }

  const projectRef =
    typeof stored.data.config.projectRef === "string" ? stored.data.config.projectRef : "";
  return { ok: true, data: { serviceRoleKey, projectRef } };
}

/** Exposed for tests: a deterministic owner descriptor. */
export function backendProviderSecretOwnerForTest(input: {
  userId: string;
  projectId: string;
}) {
  return providerSecretOwner({
    userId: input.userId,
    projectId: input.projectId,
    provider: "external_supabase",
  });
}

export { randomUUID };
