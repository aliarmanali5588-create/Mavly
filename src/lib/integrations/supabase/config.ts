/**
 * ═══ SUPABASE MANAGEMENT API OAUTH — CONFIGURATION ══════════════════════════
 *
 * Server-only. Reads secrets from `process.env`; never import this from a client
 * component and never give these variables a `NEXT_PUBLIC_` prefix.
 *
 * ⚠️ THIS IS THE MANAGEMENT API OAUTH APP, NOT SUPABASE AUTH'S OAUTH SERVER.
 * The two are different products with different endpoints:
 *
 *   · Management API OAuth (this file) authorizes Mavly to act on the user's
 *     ORGANIZATIONS AND PROJECTS. Endpoints are on `api.supabase.com`.
 *   · Supabase Auth's OAuth 2.1 server authorizes a third party to act as an
 *     END USER OF ONE PROJECT. Endpoints are on `<ref>.supabase.co/auth/v1`.
 *
 * Using the wrong one would produce a token that cannot list projects.
 *
 * ⚠️ SCOPES ARE CONFIGURED ON THE OAUTH APP, NOT IN THE REQUEST. Supabase
 * deprecated the `scope` authorize parameter: the granted scopes come back in
 * the token response and are read from there. We never assume what was granted.
 */

export const SUPABASE_OAUTH_CALLBACK_PATH = "/auth/supabase/callback";

/** Fixed endpoints. Nothing here is ever built from user input. */
export const SUPABASE_OAUTH_AUTHORIZE_URL = "https://api.supabase.com/v1/oauth/authorize";
export const SUPABASE_OAUTH_TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
export const SUPABASE_MANAGEMENT_API_URL = "https://api.supabase.com/v1";

/**
 * ═══ THE MINIMUM SCOPE SET ══════════════════════════════════════════════════
 *
 * Declared here so the required OAuth App configuration is documented in code,
 * and so the broker can refuse an action whose scope was not granted.
 *
 * ⚠️ THIS IS NOT THE REQUEST. It is the set Mavly's implemented actions need.
 * The OAuth App must be registered with exactly these; requesting more would
 * violate least privilege, and requesting fewer would make the broker refuse
 * actions the UI offers.
 */
export const SUPABASE_REQUIRED_SCOPES = [
  "projects:read",
  "organizations:read",
  "database:read",
  "database:write",
  "edge_functions:read",
] as const;

export type SupabaseScope = (typeof SUPABASE_REQUIRED_SCOPES)[number];

export interface SupabaseOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** The exact callback URL registered on the OAuth App. */
  redirectUri: string;
  /** 32 bytes: the key that encrypts stored tokens. */
  encryptionKey: Buffer;
}

export type SupabaseOAuthConfigProblem =
  | "missing_client_id"
  | "missing_client_secret"
  | "invalid_redirect_uri"
  | "invalid_encryption_key";

export type SupabaseOAuthConfigResult =
  | { ok: true; config: SupabaseOAuthConfig }
  | { ok: false; reason: SupabaseOAuthConfigProblem };

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * The callback must be the path this app actually serves, carry no query or
 * fragment, and be https (or http on loopback for local work).
 */
function parseRedirectUri(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.search || url.hash) return null;
    if (url.pathname !== SUPABASE_OAUTH_CALLBACK_PATH) return null;
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * A 32-byte key, base64-encoded. `Buffer.from` is permissive about malformed
 * base64, so the length check is the real validation: it fails closed rather
 * than silently deriving a shorter key.
 */
function parseEncryptionKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
}

/**
 * ⚠️ THE ENCRYPTION KEY IS SHARED WITH THE GITHUB INTEGRATION ON PURPOSE.
 * `MAVLY_INTEGRATION_ENCRYPTION_KEY` already exists and is already server-only;
 * a second key would be a second thing to rotate and a second way to get it
 * wrong. The AAD below still binds every Supabase ciphertext to its own purpose,
 * so a GitHub token cannot be decrypted as a Supabase token even under the same
 * key.
 */
export function supabaseOAuthConfig(): SupabaseOAuthConfigResult {
  const clientId = (process.env.SUPABASE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.SUPABASE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = parseRedirectUri(process.env.SUPABASE_OAUTH_REDIRECT_URI ?? "");
  const encryptionKey = parseEncryptionKey(
    process.env.MAVLY_INTEGRATION_ENCRYPTION_KEY ?? "",
  );

  if (!clientId) return { ok: false, reason: "missing_client_id" };
  if (!clientSecret) return { ok: false, reason: "missing_client_secret" };
  if (!redirectUri) return { ok: false, reason: "invalid_redirect_uri" };
  if (!encryptionKey) return { ok: false, reason: "invalid_encryption_key" };

  return { ok: true, config: { clientId, clientSecret, redirectUri, encryptionKey } };
}

/**
 * AAD for a stored token. Purpose-scoped so the access token, the refresh token
 * and the PKCE verifier are mutually undecryptable, and bound to the user and
 * project so a ciphertext cannot be moved between rows.
 */
export function tokenAad(input: {
  userId: string;
  projectId: string;
  purpose: "access" | "refresh" | "pkce";
}): string {
  return `supabase-oauth:${input.purpose}:${input.userId}:${input.projectId}`;
}
