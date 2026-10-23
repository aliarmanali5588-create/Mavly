/**
 * Server-only configuration for the Figma integration.
 *
 * Figma is connected with a personal access token (PAT), which is the flow the
 * existing UI describes. The token belongs to the user, is scoped to
 * `current_user:read` and `file_content:read`, and is stored as AES-256-GCM
 * ciphertext.
 *
 * ⚠️ THIS MODULE IS SERVER-ONLY. `MAVLY_INTEGRATION_ENCRYPTION_KEY` must never
 * get a `NEXT_PUBLIC_` prefix.
 */

export const FIGMA_API_URL = "https://api.figma.com";
export const FIGMA_REQUEST_TIMEOUT_MS = 20_000;

export interface FigmaCryptoConfig {
  /** 32 bytes, base64-encoded: the same server-only key used by the other integrations. */
  encryptionKey: Buffer;
}

export type FigmaConfigResult =
  | { ok: true; config: FigmaCryptoConfig }
  | { ok: false; error: string };

function parseEncryptionKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, "base64");
  return key.length === 32 ? key : null;
}

export function figmaCryptoConfig(): FigmaConfigResult {
  const encryptionKey = parseEncryptionKey(
    process.env.MAVLY_INTEGRATION_ENCRYPTION_KEY ?? "",
  );

  if (!encryptionKey) {
    return {
      ok: false,
      error:
        "Figma storage is not configured. Add MAVLY_INTEGRATION_ENCRYPTION_KEY on the server.",
    };
  }

  return { ok: true, config: { encryptionKey } };
}
