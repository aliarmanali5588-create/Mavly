/**
 * ═══ SUPABASE CLIENTS INSIDE THE CLOUDFLARE WORKER ══════════════════════════
 *
 * Two clients, two clearly different authorities:
 *
 *   · `createWorkerClient` is the SERVICE-ROLE client. It is used only for the
 *     trusted RPCs (dispatch claim, run-targeted claim) and by the generation
 *     pipeline, which re-verifies the owner itself. It is never returned from a
 *     route and never handed to the browser.
 *   · `createUserClient` carries the caller's own access token against the anon
 *     key. Every read it performs is still filtered by RLS, so a project the
 *     caller does not own simply does not exist.
 *
 * The anon key is public by design; `SUPABASE_SERVICE_ROLE_KEY` is not. Neither
 * is logged here.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { CloudflareEnv } from "./env";

interface ClientOptions {
  env: CloudflareEnv;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createWorkerClient({ env }: ClientOptions): SupabaseClient | null {
  const url = readText(env.NEXT_PUBLIC_SUPABASE_URL);
  const key = readText(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-mavly-actor": "cloudflare-generation" } },
  });
}

export function createUserClient(
  { env }: ClientOptions,
  accessToken: string,
): SupabaseClient | null {
  const url = readText(env.NEXT_PUBLIC_SUPABASE_URL);
  const key = readText(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!url || !key || !accessToken) return null;
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
