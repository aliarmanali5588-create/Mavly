/**
 * ═══ THE PUBLIC SUPABASE CLIENT (NO SESSION, NO COOKIES) ════════════════════
 *
 * The tenant runtime serves anonymous visitors. It must not read, refresh or
 * write anybody's session cookie, and it must run as the `anon` role so that the
 * ONLY thing it can reach is the published-only RPC surface created by
 * `supabase/migrations/14_shared_hosting.sql`.
 *
 * ⚠️ THIS IS NOT A SERVICE-ROLE CLIENT. It carries the same public anon key the
 * browser already has. The security comes from the RPC grants and their
 * `SECURITY DEFINER` bodies, not from a privileged credential — and a
 * service-role key must never appear in this file or on this path.
 *
 * ⚠️ `persistSession: false` — a shared server process must never keep or
 * refresh a user session. There is no user here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./config";

/**
 * One instance per process. It holds no session (`persistSession: false`), so
 * sharing it is safe and saves recreating a client (and its fetch/auth plumbing)
 * for every lookup a tenant request makes.
 */
let cached: SupabaseClient | null = null;

export function createSupabasePublicClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (cached) return cached;

  cached = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "x-mavly-surface": "tenant-runtime" },
    },
  });

  return cached;
}
