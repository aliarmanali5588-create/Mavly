/**
 * ═══ END-USER AUTH FOR GENERATED APPLICATIONS ══════════════════════════════
 *
 * This is authentication INSIDE a customer's generated app. It is completely
 * separate from Mavly's Supabase session: a user signed into Mavly is not
 * signed into an app they generated, and the two identities never mix.
 *
 * Primitives are deliberately boring and standard:
 *   · passwords: scrypt (N=16384, r=8, p=1) with a 16-byte random salt, stored
 *     as a self-describing string — never plaintext, never reversible;
 *   · sessions: 32 random bytes, sent to the caller, stored ONLY as a SHA-256
 *     hash, with an absolute expiry and an explicit revocation timestamp;
 *   · comparison is constant-time for both secrets.
 *
 * ⚠️ PASSWORDS AND SESSION TOKENS ARE NEVER LOGGED, and no function here
 * returns a stored hash.
 *
 * Server-only (node:crypto), imported only by the gateway service.
 */

import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const EMAIL_MAX_LENGTH = 254;
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_COOKIE_PREFIX = "mavly_s_";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_KEY_BYTES);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time verification. A malformed stored value is a non-match, not an
 * exception, so a data problem cannot become an authentication bypass.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, saltPart, hashPart] = parts;
  if (rawN !== String(SCRYPT_N) || rawR !== String(SCRYPT_R) || rawP !== String(SCRYPT_P)) {
    return false;
  }
  try {
    const salt = Buffer.from(saltPart, "base64url");
    const expected = Buffer.from(hashPart, "base64url");
    if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEY_BYTES) {
      return false;
    }
    const actual = await deriveKey(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > EMAIL_MAX_LENGTH) return null;
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(email)) return null;
  return email;
}

/** A human-usable reason, or null when the password is acceptable. */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string") return "A password is required.";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `The password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!password.trim()) return "The password cannot be only whitespace.";
  if (email && password.trim().toLowerCase() === email.toLowerCase()) {
    return "The password cannot be the same as the email address.";
  }
  return null;
}

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(now: number = Date.now()): string {
  return new Date(now + SESSION_TTL_SECONDS * 1000).toISOString();
}

/** Cookie names are per project so two apps on the same host cannot collide. */
export function sessionCookieName(projectId: string): string | null {
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(projectId)) return null;
  return `${SESSION_COOKIE_PREFIX}${projectId}`;
}

/**
 * The cookie is scoped to the project's own gateway path, HttpOnly, Secure and
 * SameSite=Lax. Lax is chosen deliberately: the published app lives on a Mavly
 * subdomain, which is the same site as the gateway, so the cookie is sent
 * without enabling third-party-cookie-dependent behavior.
 */
export function sessionCookie(
  projectId: string,
  token: string,
  maxAgeSeconds: number = SESSION_TTL_SECONDS,
): string | null {
  const name = sessionCookieName(projectId);
  if (!name || !SESSION_TOKEN_PATTERN.test(token)) return null;
  return [
    `${name}=${token}`,
    `Path=/api/app/v1/apps/${projectId}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export function clearedSessionCookie(projectId: string): string | null {
  const name = sessionCookieName(projectId);
  if (!name) return null;
  return [
    `${name}=`,
    `Path=/api/app/v1/apps/${projectId}`,
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** Extract a session token from a cookie header, scoped by project name. */
export function sessionTokenFromCookie(
  cookieHeader: string | null,
  projectId: string,
): string | null {
  const name = sessionCookieName(projectId);
  if (!name || !cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return SESSION_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}
