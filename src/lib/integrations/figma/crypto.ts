/**
 * Authenticated encryption for stored Figma access tokens. Server-only.
 *
 * The cipher matches the other integrations (AES-256-GCM, versioned payload,
 * purpose-bound associated data). The associated data names both the project
 * and the owner, so a ciphertext copied into another project or account does
 * not decrypt.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function aad(projectId: string, userId: string): Buffer {
  return Buffer.from(`figma-access-token\u0000${projectId}\u0000${userId}`, "utf8");
}

export function encryptFigmaToken(
  encryptionKey: Buffer,
  token: string,
  projectId: string,
  userId: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad(projectId, userId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptFigmaToken(
  encryptionKey: Buffer,
  payload: string,
  projectId: string,
  userId: string,
): string | null {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(aad(projectId, userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
