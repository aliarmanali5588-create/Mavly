import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { VERIFICATION_VALUE_PREFIX } from "./instructions";

/**
 * Server-only verification-token primitives.
 *
 * The raw token is generated here, shown once to the owning session through an
 * owner-checked RPC, and stored alongside a SHA-256 hash. It is never logged and
 * never placed in a public project payload.
 */

export function generateVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A TXT answer can contain several quoted chunks (`"abc" "def"`), which DNS
 * concatenates. Normalise that shape before comparing the exact expected value.
 */
export function normalizeTxtValue(raw: string): string {
  const value = raw.trim();
  const parts = value.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts || parts.length === 0) return value;
  return parts
    .map((part) => part.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
    .join("");
}

export function txtValueMatches(records: readonly string[], token: string): boolean {
  const expected = `${VERIFICATION_VALUE_PREFIX}${token}`;
  return records.some((record) => constantTimeEqual(normalizeTxtValue(record).trim(), expected));
}

/** The hash stored in the database must match the token the worker was given. */
export function tokenHashMatches(token: string, storedHash: string): boolean {
  return constantTimeEqual(hashVerificationToken(token), storedHash.toLowerCase());
}
