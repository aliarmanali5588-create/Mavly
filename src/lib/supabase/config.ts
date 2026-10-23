/**
 * ═══ SUPABASE CONFIGURATION — READ ONCE, FROM THE PUBLIC ENV VARS ═══════════
 *
 * The project reference (`cazmezhpanwdjgsqugzr`, project "Mavly") is already
 * provisioned; this app only needs the two public keys to talk to it:
 *
 *   NEXT_PUBLIC_SUPABASE_URL      → https://<ref>.supabase.co
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY → the `anon` / publishable key
 *
 * ⚠️ THE NAMES ARE EXACT. The browser signs in through Supabase directly, so
 * these two values are read by a CLIENT component (`src/lib/supabase/client.ts`
 * → `src/lib/auth/oauth.ts`), and a client bundle can only see `NEXT_PUBLIC_*`
 * variables — they are inlined into the JavaScript at build time. A deployment
 * that sets `SUPABASE_URL` / `SUPABASE_ANON_KEY` (no prefix) therefore reads
 * empty here, and the sign-in buttons answer `not_configured`.
 *
 * ⚠️ `NEXT_PUBLIC_*` IS INLINED AT BUILD TIME: after the variables are saved in
 * Vercel the project has to be REBUILT (a redeploy without a cache bust) —
 * saving the variable alone changes nothing that is already deployed.
 *
 * ⚠️ THE SERVICE-ROLE KEY IS DELIBERATELY NOT READ HERE. This app needs no
 * privileged Supabase access, and a key that only the server can read has no
 * business in a module a client bundle can pull in.
 *
 * ⚠️ THE APP FAILS CLOSED WITHOUT THESE. Authentication is not optional for the
 * builder: with no keys there is no way to prove who the visitor is, so `/dashboard`
 * refuses to render the builder and `/login` explains which variable is
 * missing. There is no "local mode" escape hatch — an env-shaped bypass is
 * exactly the kind of thing that ends up enabled in production.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * What is wrong with the public Supabase configuration — if anything.
 *
 * The four states are kept apart so the sign-in page can say something useful
 * ("the URL is missing", "the key is missing", "the URL is not a valid URL")
 * without ever showing a key, a secret or a session token.
 */
export type SupabaseConfigProblem =
  | "missing_url"
  | "missing_key"
  | "invalid_url"
  | "invalid_key";

/**
 * A Supabase project URL is a plain http(s) URL. Anything else would make
 * `createBrowserClient` throw inside a click handler, so it is rejected here
 * instead — the app then fails closed with a readable message.
 */
export function isValidSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The problem with a given pair of values, or `null` when they are usable.
 *
 * Pure: it takes the values as arguments, so it can be tested without touching
 * the environment and without reading a secret.
 */
export function configProblem(
  url: string,
  key: string,
): SupabaseConfigProblem | null {
  const trimmedUrl = url.trim();
  const trimmedKey = key.trim();

  if (!trimmedUrl) return "missing_url";
  if (!trimmedKey) return "missing_key";
  if (!isValidSupabaseUrl(trimmedUrl)) return "invalid_url";
  // A key never contains whitespace; catching it here means a half-pasted
  // value fails with a clear message instead of a 401 from the Auth server.
  if (/\s/.test(trimmedKey)) return "invalid_key";

  return null;
}

/** The problem with THIS deployment's configuration, or `null` when it is fine. */
export function supabaseConfigProblem(): SupabaseConfigProblem | null {
  return configProblem(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** True when this deployment can actually authenticate somebody. */
export function isSupabaseConfigured(): boolean {
  return supabaseConfigProblem() === null;
}
