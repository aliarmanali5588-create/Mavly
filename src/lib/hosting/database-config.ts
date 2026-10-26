/**
 * ═══ APPLICATION DATABASE CONTRACT — METADATA ONLY ═════════════════════════
 *
 * A full-stack deployment may need a database. Mavly does not provision one and
 * does not connect to it from its own servers. The user supplies a connection
 * URL ONCE; the server:
 *
 *   1. validates it (scheme, host, TLS, no client-visible conventions),
 *   2. opens ONE bounded, DNS-pinned connection with those credentials,
 *   3. stores the URL as an encrypted project secret named `DATABASE_URL`,
 *   4. extracts non-secret metadata for the workspace and readiness checks,
 *   5. pushes the URL to the hosting provider's encrypted environment API.
 *
 * ⚠️ THE URL IS NEVER RETURNED. There is no read-back path. `DATABASE_URL` is
 * the only accepted env key, and it is a SERVER key: a generated app must not
 * declare it `NEXT_PUBLIC_`.
 *
 * ⚠️ PARSING IS NOT CONNECTIVITY. This module only validates shape and
 * decomposes non-secret metadata. The save service follows it with one bounded,
 * DNS-pinned connection using the supplied credentials; `verified_at` is written
 * only when that check succeeds. A later outage is not re-probed on every
 * deploy because the plaintext URL is write-only.
 *
 * Migrations are never executed here.
 */

import { createHash } from "node:crypto";

export const DATABASE_URL_SECRET_NAME = "DATABASE_URL";
export const DATABASE_URL_ENV_KEY = "DATABASE_URL";

export type DatabaseProvider = "postgres" | "supabase";
export type DatabaseSslMode = "require" | "verify-full";
export type DatabaseConnectionMode = "transaction" | "session";

export interface DatabaseConnectionMetadata {
  provider: DatabaseProvider;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslMode: DatabaseSslMode;
  connectionMode: DatabaseConnectionMode;
  secretName: typeof DATABASE_URL_SECRET_NAME;
  envKey: typeof DATABASE_URL_ENV_KEY;
  /** SHA-256 of the exact stored URL. Not reversible; used only to match rows. */
  fingerprint: string;
}

export type DatabaseValidation =
  | { ok: true; metadata: DatabaseConnectionMetadata; connectionUrl: string }
  | { ok: false; code: "validation" | "unsupported_host"; error: string };

const MAX_CONNECTION_URL_BYTES = 4_096;
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^0\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
];

function reject(error: string, code: "validation" | "unsupported_host" = "validation"): DatabaseValidation {
  return { ok: false, code, error };
}

/**
 * `decodeURIComponent` throws on a malformed percent escape. A pasted URL with
 * a literal `%` in the password must become a validation error, not a 500.
 */
function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * A host that is only meaningful inside some private network is not a usable
 * production database and would make the Mavly readiness contract misleading.
 * IPv6 literals are refused as well: they cannot be parsed safely here without
 * a full implementation, and the metadata column is a hostname.
 */
export function databaseHostRejectionReason(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return "The database host is empty.";
  if (host.startsWith("[") || host.includes(":")) {
    return "Use a hostname for the database host; IPv6 literals are not supported.";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "A local database is not reachable from the hosting runtime.";
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    return "A private-network database host is not reachable from the hosting runtime.";
  }
  if (PRIVATE_V4.some((pattern) => pattern.test(host))) {
    return "A private-network database address is not reachable from the hosting runtime.";
  }
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host)) {
    return "The database host is not a valid hostname.";
  }
  if (!host.includes(".")) {
    return "Use a fully qualified database hostname.";
  }
  return null;
}

export function databaseConnectionFingerprint(connectionUrl: string): string {
  return createHash("sha256").update(connectionUrl, "utf8").digest("hex");
}

function providerFor(host: string): DatabaseProvider {
  return /(?:^|\.)supabase\.(?:co|com)$/.test(host) || host.includes("pooler.supabase.")
    ? "supabase"
    : "postgres";
}

/**
 * Validate and decompose a `postgres://`/`postgresql://` URL. Anything that
 * cannot be represented truthfully in the metadata contract is refused rather
 * than guessed.
 */
export function parseDatabaseConnectionUrl(
  raw: unknown,
  connectionMode?: unknown,
): DatabaseValidation {
  if (typeof raw !== "string") return reject("A database connection URL is required.");
  const connectionUrl = raw.trim();
  if (!connectionUrl) return reject("A database connection URL is required.");
  if (/\s/.test(connectionUrl)) {
    return reject("The database connection URL must not contain whitespace.");
  }
  if (Buffer.byteLength(connectionUrl, "utf8") > MAX_CONNECTION_URL_BYTES) {
    return reject("The database connection URL is too long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    return reject("The database connection URL is not a valid URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return reject("Only postgres:// or postgresql:// connection URLs are supported.");
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const hostProblem = databaseHostRejectionReason(host);
  if (hostProblem) return reject(hostProblem, "unsupported_host");

  const username = decodeComponent(parsed.username || "");
  const password = decodeComponent(parsed.password || "");
  const databaseName = decodeComponent(parsed.pathname.replace(/^\//, ""));
  if (username === null || password === null || databaseName === null) {
    return reject("The database connection URL contains an invalid percent-encoding.");
  }
  if (!username) return reject("The database connection URL has no username.");
  if (!password) return reject("The database connection URL has no password.");
  if (!databaseName) return reject("The database connection URL has no database name.");

  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return reject("The database port is not valid.");
  }

  const sslModeRaw = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
  if (sslModeRaw && sslModeRaw !== "require" && sslModeRaw !== "verify-full") {
    return reject("TLS is required: use sslmode=require or sslmode=verify-full.");
  }
  const sslMode: DatabaseSslMode = sslModeRaw === "verify-full" ? "verify-full" : "require";

  /**
   * Serverless functions should use a transaction pooler. A Supabase pooler
   * hostname identifies that explicitly; otherwise the caller must say so.
   * The default is `session` to avoid silently changing transaction semantics.
   */
  const modeValue = typeof connectionMode === "string" ? connectionMode.trim() : "";
  if (modeValue && modeValue !== "transaction" && modeValue !== "session") {
    return reject("connectionMode must be transaction or session.");
  }
  const pooled = parsed.searchParams.get("pgbouncer") === "true" || host.includes("pooler.");
  const resolvedConnectionMode: DatabaseConnectionMode =
    (modeValue as DatabaseConnectionMode | "") || (pooled ? "transaction" : "session");

  if (host.length > 253) return reject("The database host is too long.");
  if (databaseName.length > 128) return reject("The database name is too long.");
  if (username.length > 128) return reject("The database username is too long.");

  return {
    ok: true,
    connectionUrl,
    metadata: {
      provider: providerFor(host),
      host,
      port,
      databaseName,
      username,
      sslMode,
      connectionMode: resolvedConnectionMode,
      secretName: DATABASE_URL_SECRET_NAME,
      envKey: DATABASE_URL_ENV_KEY,
      fingerprint: databaseConnectionFingerprint(connectionUrl),
    },
  };
}

/** The browser-safe projection. Deliberately excludes the URL and the password. */
export interface PublicDatabaseConfig {
  configured: true;
  provider: DatabaseProvider;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  sslMode: DatabaseSslMode;
  connectionMode: DatabaseConnectionMode;
  envKey: string;
  updatedAt: string;
  /** When a bounded connectivity check last succeeded; null means unverified. */
  verifiedAt: string | null;
}

export interface DatabaseConfigRow {
  project_id: string;
  user_id: string;
  provider: DatabaseProvider;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl_mode: DatabaseSslMode;
  connection_mode: DatabaseConnectionMode;
  secret_name: string;
  env_key: string;
  connection_fingerprint: string;
  status: "configured" | "invalid";
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export function publicDatabaseConfig(row: DatabaseConfigRow): PublicDatabaseConfig {
  return {
    configured: true,
    provider: row.provider,
    host: row.host,
    port: row.port,
    databaseName: row.database_name,
    username: row.username,
    sslMode: row.ssl_mode,
    connectionMode: row.connection_mode,
    envKey: row.env_key,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * Readiness join: the metadata row and the provider-synced env row must describe
 * the SAME URL. A user can edit metadata directly (it is owner-scoped), but only
 * the server writes the synced env fingerprint, so a mismatch cannot be used to
 * claim a database is configured when it is not.
 */
export function databaseConfigMatchesEnv(input: {
  fingerprint: string;
  envFingerprint: string | null | undefined;
  envStatus: string | null | undefined;
}): boolean {
  return (
    Boolean(input.fingerprint) &&
    input.envStatus === "synced" &&
    input.envFingerprint === input.fingerprint
  );
}
