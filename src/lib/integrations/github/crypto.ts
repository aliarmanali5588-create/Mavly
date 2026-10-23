/**
 * Authenticated encryption and OAuth helpers for the GitHub integration.
 * Server-only: importing this module into a client component would leak the
 * encryption key into the browser bundle.
 *
 * The cipher is the same shape the Supabase integration uses (AES-256-GCM with
 * associated data), so a token copied from one table into another fails to
 * decrypt in the other.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function aadFor(clientId: string, aad: string): Buffer {
  return Buffer.from(`${clientId}\u0000${aad}`, "utf8");
}

/** AES-256-GCM. The associated data binds a ciphertext to its purpose. */
export function encryptSecret(
  clientId: string,
  encryptionKey: Buffer,
  plaintext: string,
  aad: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aadFor(clientId, aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(
  clientId: string,
  encryptionKey: Buffer,
  payload: string,
  aad: string,
): string | null {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(aadFor(clientId, aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** The PKCE S256 challenge. GitHub supports PKCE for OAuth Apps and GitHub Apps. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Only same-origin application paths are valid OAuth return destinations.
 * Reject protocol-relative URLs, backslashes, control characters and API
 * routes (a browser navigation back to an API response is not useful).
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.startsWith("/\\") || path.includes("\\")) return null;
  if (path.startsWith("/api/")) return null;
  if (path.length > 2048 || /[\u0000-\u001f]/.test(path)) return null;
  return path;
}
