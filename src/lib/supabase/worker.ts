/**
 * ═══ THE ONE SERVER-ONLY SERVICE-ROLE CLIENT ════════════════════════════════
 *
 * ⚠️ THIS IS THE INTENTIONAL SERVICE-ROLE EXCEPTION IN MAVLY. It exists only
 * for the durable generation worker, which has no user session and must claim
 * and checkpoint jobs across the cohort. It does not relax any RLS policy:
 *
 *   · user-facing reads and writes keep using the caller's session client;
 *   · the worker RPCs are executable only by `service_role`;
 *   · the worker re-verifies the claimed project's owner before running.
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT OR A PAGE. Only
 * `src/lib/generation/worker.ts` and `src/app/api/generation/worker/route.ts`
 * may import it. `SUPABASE_SERVICE_ROLE_KEY` must never carry a `NEXT_PUBLIC_`
 * prefix, never be returned to the browser and never be logged.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_URL, isValidSupabaseUrl } from "./config";

const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";

/**
 * The key is read here and nowhere else. A truthy result says only that a key
 * exists — it is never the key itself.
 */
export function isWorkerServiceRoleConfigured(): boolean {
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
export function createSupabaseWorkerClient(): SupabaseClient | null {
  if (!isWorkerServiceRoleConfigured()) return null;

  return createClient(SUPABASE_URL, process.env[SERVICE_ROLE_ENV]!.trim(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-mavly-actor": "generation-worker" },
    },
  });
}
