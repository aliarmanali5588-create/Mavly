import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function associatedData(
  userId: string,
  projectId: string,
  registryId: string,
): Buffer {
  return Buffer.from(
    `mavly-managed-backend\u0000${userId}\u0000${projectId}\u0000${registryId}`,
    "utf8",
  );
}

export function encryptManagedBackendConnection(
  key: Buffer,
  connectionUri: string,
  owner: { userId: string; projectId: string; registryId: string },
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(
    associatedData(owner.userId, owner.projectId, owner.registryId),
  );
  const ciphertext = Buffer.concat([
    cipher.update(connectionUri, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptManagedBackendConnection(
  key: Buffer,
  payload: string,
  owner: { userId: string; projectId: string; registryId: string },
): string | null {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(
      associatedData(owner.userId, owner.projectId, owner.registryId),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
