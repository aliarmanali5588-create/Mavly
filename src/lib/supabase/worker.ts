/**
 * ═══ THE ONE SERVER-ONLY SERVICE-ROLE CLIENT ════════════════════════════════
 *
 * ⚠️ SERVICE-ROLE CLIENTS ARE SERVER-ONLY. The worker client is used by the
 * durable generation worker. The credit client is used only for the narrow
 * credit admission and owner-checked terminal RPCs in `credits/store.ts`.
 * Neither client relaxes any RLS policy:
 *
 *   · user-facing reads and writes keep using the caller's session client;
 *   · trusted RPCs are executable only by `service_role`;
 *   · the worker re-verifies the claimed project's owner before running.
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT OR A PAGE. Only the worker,
 * its route, and the server-side credit store may import it.
 * `SUPABASE_SERVICE_ROLE_KEY` must never carry a `NEXT_PUBLIC_` prefix, never
 * be returned to the browser and never be logged.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_URL, isValidSupabaseUrl } from "./config";

const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

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
 */
function createServiceRoleClient(actor: "generation-worker" | "credit-accounting"): SupabaseClient | null {
  if (!isServiceRoleConfigured()) return null;

  return createClient(SUPABASE_URL, process.env[SERVICE_ROLE_ENV]!.trim(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-mavly-actor": actor },
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
