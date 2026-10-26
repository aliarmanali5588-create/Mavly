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
 * ⚠️ THE SERVICE-ROLE KEY IS DELIBERATELY NOT READ HERE. Its only reader is
 * `src/lib/supabase/worker.ts`, which must never be imported by a client
 * bundle or a page; no key belongs in a module a client can pull in.
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

/**
 * ═══ ONE COOKIE POLICY FOR EVERY SUPABASE CLIENT ════════════════════════════
 *
 * The browser, the server components and the proxy all read the SAME session
 * cookies. If one of them wrote different attributes the browser would keep
 * two divergent copies — the classic "signed in on one request, signed out on
 * the next" bug. So the attributes live here, once.
 *
 *   · `path: "/"`        every route on the app shares one session.
 *   · `sameSite: "lax"`  required for the OAuth redirect back to
 *                        `/auth/callback` (a top-level GET). `strict` would
 *                        drop the requirement on that navigation.
 *   · `secure`           true when the canonical app origin is explicitly
 *                        HTTPS. An unset or http `NEXT_PUBLIC_APP_URL` keeps
 *                        the library's default (no Secure) instead of making
 *                        the cookie unusable over http — which is how the
 *                        documented `npm run build && npm start` smoke test
 *                        runs.
 *   · `maxAge`           400 days — the browser-enforced ceiling. This is what
 *                        makes the session survive closing and reopening the
 *                        browser, unlike a session cookie that dies with the
 *                        tab. Supabase's refresh token is what actually decides
 *                        whether the session is still valid; the cookie only
 *                        has to be around long enough to ask.
 *
 * ⚠️ NO `domain`. The session is host-only on purpose: tenant sites live on
 * `*.mavly.xyz` and must never receive the app's cookies. The canonical app
 * origin must be the host users actually open (see `NEXT_PUBLIC_APP_URL`);
 * signing in on one host and opening another is two cookie jars.
 *
 * ⚠️ NO `httpOnly`. The SSR architecture has the browser Supabase client read
 * its own PKCE verifier from this jar; the server still authorizes every
 * request by verifying the token with the Auth server (`getUser()`), so
 * JavaScript readability is not the security boundary.
 */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type SupabaseAuthCookieOptions = {
  path: "/";
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
};

/**
 * Pure policy so the HTTPS/local decision is testable without an environment.
 *
 * Secure follows the explicit canonical origin. It is NOT derived from
 * `NODE_ENV`: `next build && next start` is a documented local smoke test over
 * http, and a Secure cookie there would be rejected (login would appear broken
 * only in that mode). Set `NEXT_PUBLIC_APP_URL=https://<canonical-host>` in
 * production to enable Secure.
 */
export function resolveAuthCookieOptions(input: {
  appUrl: string;
}): SupabaseAuthCookieOptions {
  let secure = false;
  const appUrl = input.appUrl.trim();
  if (appUrl) {
    try {
      secure = new URL(appUrl).protocol === "https:";
    } catch {
      /* an unreadable value must not switch Secure on or off */
    }
  }
  return {
    path: "/",
    sameSite: "lax",
    secure,
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  };
}

// Read as a direct property access (`NEXT_PUBLIC_*` is inlined into the client
// bundle at build time; passing `process.env` around is not).
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

/** The cookie attributes every Supabase client in this app must use. */
export function authCookieOptions(): SupabaseAuthCookieOptions {
  return resolveAuthCookieOptions({ appUrl: APP_URL });
}
