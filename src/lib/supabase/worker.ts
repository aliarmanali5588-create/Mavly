/**
 * ═══ THE ONE SERVER-ONLY SERVICE-ROLE CLIENT ════════════════════════════════
 *
 * ⚠️ SERVICE-ROLE CLIENTS ARE SERVER-ONLY. The worker client is used by the
 * scheduled generation worker and the owner-checked Android artifact download.
 * The credit client is used only for narrow credit RPCs in `credits/store.ts`.
 * Neither client relaxes any RLS policy:
 *
 *   · user-facing reads and writes keep using the caller's session client;
 *   · trusted RPCs are executable only by `service_role`;
 *   · the worker re-verifies the claimed project's owner before running.
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT OR A PAGE. Only the worker,
 * scheduled entrypoint, credit store and owner-checked artifact handler may
 * import it.
 * `SUPABASE_SERVICE_ROLE_KEY` must never carry a `NEXT_PUBLIC_` prefix, never
 * be returned to the browser and never be logged.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_URL, isValidSupabaseUrl } from "./config";

const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/**
 * Determines whether a key is in the legacy JWT format (3 dot-separated parts).
 * Legacy keys: `eyJ...` (3-part JWT)
 * New opaque keys: `sb_secret_...` or `sb_publishable_...` (no dots, or not 3 parts)
 */
function isLegacyJwtKey(key: string): boolean {
  const trimmed = key.trim();
  const parts = trimmed.split(".");
  return parts.length === 3;
}

/**
 * Create a fetch wrapper that handles new-format API keys correctly.
 *
 * @supabase/supabase-js@2.118.0 sends all keys as `Authorization: Bearer <key>`.
 * For legacy JWT keys, this is correct; GoTrue validates them as JWTs.
 * For new opaque keys (sb_secret_..., sb_publishable_...), GoTrue rejects them
 * as malformed JWTs. These keys should only be sent in the `apikey` header.
 *
 * This wrapper strips `Authorization: Bearer <opaque_key>` for new-format keys,
 * leaving `apikey` intact so the Supabase API Gateway can route them correctly.
 */
function createAuthCompatibleFetch(key: string): typeof fetch {
  const trimmedKey = key.trim();
  const isLegacy = isLegacyJwtKey(trimmedKey);

  return async (input, init) => {
    const headers = new Headers(init?.headers);

    // For new-format keys, strip the Bearer Authorization header.
    // GoTrue cannot validate opaque keys as JWTs; the API Gateway handles them.
    if (!isLegacy) {
      const auth = headers.get("authorization");
      if (auth === `Bearer ${trimmedKey}`) {
        headers.delete("authorization");
      }
    }

    return fetch(input, { ...init, headers });
  };
}


/**
 * The key is read here and nowhere else. A truthy result says only that a key
 * exists — it is never the key itself.
 */
function isServiceRoleConfigured(): boolean {
  return (
    isValidSupabaseUrl(SUPABASE_URL) &&
    typeof process.env[SERVICE_ROLE_ENV] === "string" &&
    process.env[SERVICE_ROLE_ENV]!.trim().length >= 20
  );
}

/**
 * A non-persistent client. There is no session to refresh and no cookie jar:
 * every call carries the service-role authorization header.
 *
 * Uses an auth-compatible fetch wrapper that corrects header handling for
 * new-format API keys (sb_secret_..., sb_publishable_...).
 */
function createServiceRoleClient(
  actor: "generation-worker" | "credit-accounting" | "account-administration"
): SupabaseClient | null {
  if (!isServiceRoleConfigured()) return null;

  const serviceRoleKey = process.env[SERVICE_ROLE_ENV]!.trim();

  return createClient(SUPABASE_URL, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-mavly-actor": actor },
      fetch: createAuthCompatibleFetch(serviceRoleKey),
    },
  });
}

export function createSupabaseWorkerClient(): SupabaseClient | null {
  return createServiceRoleClient("generation-worker");
}

/** Used only by the server-side credit RPC wrappers; never expose to a client. */
export function createSupabaseCreditClient(): SupabaseClient | null {
  return createServiceRoleClient("credit-accounting");
}

/**
 * ═══ ACCOUNT ADMINISTRATION (block / unblock) ═══════════════════════════════
 *
 * Only the admin account-status route may use this. It exists because banning
 * an account is a Supabase Auth ADMIN operation, which requires the service-role
 * key — there is no session-scoped equivalent.
 *
 * ⚠️ THE CALLER MUST ALREADY HAVE PROVEN IT IS AN ADMIN, SERVER-SIDE, through
 * `requireAdmin()`. This client grants no authority of its own; it is a
 * capability, and the route is the only place allowed to hold it.
 * ⚠️ NEVER import this from a client component or a page.
 */
export function createSupabaseAccountAdminClient(): SupabaseClient | null {
  return createServiceRoleClient("account-administration");
}
