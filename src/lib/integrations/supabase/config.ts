/**
 * Server-only configuration for the user-owned Supabase integration.
 *
 * This module reads secrets from `process.env`. Never import it from a client
 * component and never rename these variables with a `NEXT_PUBLIC_` prefix.
 */

export const SUPABASE_OAUTH_CALLBACK_PATH = "/auth/supabase/callback";

export interface SupabaseIntegrationConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
}

export type SupabaseIntegrationConfigProblem =
  | "missing_client_id"
  | "missing_client_secret"
  | "invalid_redirect_uri"
  | "invalid_encryption_key";

type ConfigResult =
  | { ok: true; config: SupabaseIntegrationConfig }
  | { ok: false; reason: SupabaseIntegrationConfigProblem };

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

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

export function supabaseIntegrationConfig(): ConfigResult {
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

  return {
    ok: true,
    config: { clientId, clientSecret, redirectUri, encryptionKey },
  };
}
