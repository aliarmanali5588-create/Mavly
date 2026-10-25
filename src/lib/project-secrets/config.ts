/**
 * Server-only configuration for project secret storage.
 *
 * Secret VALUES are encrypted with AES-256-GCM before they reach Supabase. The
 * key lives only in the server environment. It must never be renamed with a
 * `NEXT_PUBLIC_` prefix, stored in the database, returned by a route, or logged.
 *
 * A dedicated key is used (rather than the integration key) so project secrets
 * and third-party OAuth tokens can be rotated independently.
 */

export const PROJECT_SECRETS_ENCRYPTION_KEY_ENV =
  "MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY";

export interface ProjectSecretsCryptoConfig {
  /** 32 bytes, decoded from a base64-encoded server environment variable. */
  encryptionKey: Buffer;
}

export type ProjectSecretsConfigResult =
  | { ok: true; config: ProjectSecretsCryptoConfig; error?: never }
  | { ok: false; error: string; config?: never };

/**
 * `Buffer.from` accepts malformed base64 without complaint, so the length check
 * is the real validation. Anything other than exactly 32 bytes fails closed.
 */
function parseEncryptionKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
}

export function projectSecretsCryptoConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProjectSecretsConfigResult {
  const encryptionKey = parseEncryptionKey(
    env[PROJECT_SECRETS_ENCRYPTION_KEY_ENV] ?? "",
  );

  if (!encryptionKey) {
    return {
      ok: false,
      error:
        "Project secret storage is not configured. Add MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY on the server (32 random bytes, base64-encoded).",
    };
  }

  return { ok: true, config: { encryptionKey } };
}
