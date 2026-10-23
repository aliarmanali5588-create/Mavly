/**
 * Server-only configuration for the GitHub integration.
 *
 * ⚠️ THIS MODULE IS SERVER-ONLY. It reads secrets from `process.env`. Never
 * import it from a client component and never give these variables a
 * `NEXT_PUBLIC_` prefix — the client secret and the encryption key would end
 * up in the browser bundle.
 *
 * The integration is a GITHUB APP used with USER-TO-SERVER tokens: the user
 * authorizes Mavly in GitHub's own OAuth screen, and the token Mavly keeps
 * acts as that user, limited to the repositories the user granted and to the
 * App's own permissions.
 *
 * ⚠️ IT IS NOT A PERSONAL ACCESS TOKEN OF THE PLATFORM OWNER. Every Mavly user
 * gets their own token, and revoking the App's authorization in GitHub ends
 * that user's access immediately.
 */

export const GITHUB_OAUTH_CALLBACK_PATH = "/auth/github/callback";

/** The fixed GitHub endpoints. Nothing here is built from user input. */
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";

export interface GithubIntegrationConfig {
  /** The GitHub App's client id. */
  clientId: string;
  /** The GitHub App's client secret. */
  clientSecret: string;
  /** The exact callback URL registered on the App. */
  redirectUri: string;
  /** 32 bytes, base64-encoded: the key that encrypts stored tokens. */
  encryptionKey: Buffer;
}

export type GithubIntegrationConfigProblem =
  | "missing_client_id"
  | "missing_client_secret"
  | "invalid_redirect_uri"
  | "invalid_encryption_key";

type ConfigResult =
  | { ok: true; config: GithubIntegrationConfig }
  | { ok: false; reason: GithubIntegrationConfigProblem };

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * The callback URL must be the path this app actually serves, must carry no
 * query string, and must be https (or http on loopback, for local work).
 */
function parseRedirectUri(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.search || url.hash) return null;
    if (url.pathname !== GITHUB_OAUTH_CALLBACK_PATH) return null;
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

export function githubIntegrationConfig(): ConfigResult {
  const clientId = (process.env.GITHUB_APP_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GITHUB_APP_CLIENT_SECRET ?? "").trim();
  const redirectUri = parseRedirectUri(process.env.GITHUB_OAUTH_REDIRECT_URI ?? "");
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
