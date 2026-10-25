import { createHash, randomBytes } from "node:crypto";

const PREFIX = "tlm_pk_";

export function generateApiKey(): { plaintext: string; prefix: string; last4: string } {
  // Generate 32 random bytes -> 64 hex chars
  const bytes = randomBytes(32);
  const secret = bytes.toString("hex");
  const plaintext = `${PREFIX}${secret}`;
  const prefix = `${PREFIX}${secret.slice(0, 6)}`;
  const last4 = secret.slice(-4);
  return { plaintext, prefix, last4 };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
