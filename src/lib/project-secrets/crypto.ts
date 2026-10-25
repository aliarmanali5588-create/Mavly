/**
 * Authenticated encryption for project secret values. Server-only.
 *
 * AES-256-GCM with a random 96-bit IV and a versioned payload. The associated
 * data binds a ciphertext to its owner, project and row, so copying it into
 * another row, project or account makes decryption fail instead of silently
 * returning another user's value.
 *
 * ⚠️ NEVER log, return or render the ciphertext. It is only useful to this
 * module, and only on the server.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ProjectSecretOwner {
  userId: string;
  projectId: string;
  secretId: string;
}

function associatedData(owner: ProjectSecretOwner): Buffer {
  return Buffer.from(
    `mavly-project-secret\u0000${owner.userId}\u0000${owner.projectId}\u0000${owner.secretId}`,
    "utf8",
  );
}

export function encryptProjectSecretValue(
  encryptionKey: Buffer,
  value: string,
  owner: ProjectSecretOwner,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(associatedData(owner));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/**
 * Returns `null` for a malformed payload, the wrong key, or a payload that was
 * moved to another owner. It never throws and never logs the value.
 */
export function decryptProjectSecretValue(
  encryptionKey: Buffer,
  payload: string,
  owner: ProjectSecretOwner,
): string | null {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(associatedData(owner));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
