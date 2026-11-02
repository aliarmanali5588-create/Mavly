"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  authCookieOptions,
  isSupabaseConfigured,
} from "./config";

/**
 * ═══ THE BROWSER-SIDE SUPABASE CLIENT ═══════════════════════════════════════
 *
 * One client per browser tab, created lazily. The session lives in cookies
 * (that is what `@supabase/ssr` does), so the server and the browser always
 * agree on who is signed in — there is no second, divergent store.
 *
 * ⚠️ RETURNS `null` WHEN SUPABASE IS NOT CONFIGURED. `createBrowserClient`
 * throws on an empty URL, and "sign-in is not configured" is a state the UI
 * has to be able to show — not a crash on the marketing page.
 *
 * ⚠️ THIS IS THE ONLY PLACE A CLIENT-SIDE AUTH CALL IS MADE FROM. The sign-in
 * buttons (marketing homepage and `/login`) go through `startOAuth` in
 * `src/lib/auth/oauth.ts`; nothing else in the app talks to Supabase directly.
 */
let cachedClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!cachedClient) {
    cachedClient = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      // Same attributes as the server/proxy clients — one cookie jar, one
      // session. These are explicit so a browser/PWA restart cannot depend on
      // a library default changing between releases.
      cookieOptions: authCookieOptions(),
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return cachedClient;
}

/**
 * The same client under the name the first version of the sign-in flow used.
 * Both names refer to one client — a second instance would mean a second
 * session store in the same tab.
 */
export const createSupabaseBrowserClient = getSupabaseBrowserClient;
