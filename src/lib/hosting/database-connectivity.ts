/**
 * ═══ BOUNDED APPLICATION-DATABASE CONNECTIVITY CHECK ════════════════════════
 *
 * Saving an application database URL is the one moment its plaintext exists on
 * Mavly's servers. This module uses that moment to prove the database actually
 * accepts a connection with the supplied credentials, instead of recording
 * "configured" for a URL that can only fail at request time.
 *
 * ⚠️ SERVER-ONLY. Imported only by the full-stack database service. It opens a
 * single PostgreSQL connection, runs `select 1`, and closes it. It never
 * provisions a database, never runs DDL/migrations, and never reads application
 * data.
 *
 * ⚠️ THE HOST IS ATTACKER-CONTROLLED. It is resolved once, every resolved
 * address must be globally routable (`database-address.ts`), and the socket is
 * pinned to a validated address so DNS cannot be rebound to a private service
 * between the check and the connect. TLS identity is still verified against the
 * original hostname (servername), not the pinned IP.
 *
 * ⚠️ NOTHING HERE LOGS OR RETURNS THE URL, PASSWORD OR A DRIVER ERROR BODY.
 * Failure messages are a small fixed vocabulary keyed by a classified code.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "pg";

import { resolvedAddressRejectionReason } from "./database-address";

/** The bounded budget for one verification. */
const DNS_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 4_000;
/** Includes DNS + TCP + TLS + the query. */
const OVERALL_TIMEOUT_MS = 7_500;
const CLOSE_GRACE_MS = 500;

export type DatabaseConnectivityFailureCode =
  | "dns"
  | "private_address"
  | "timeout"
  | "auth"
  | "tls"
  | "unreachable"
  | "database"
  | "error";

export type DatabaseConnectivityResult =
  | { ok: true; latencyMs: number }
  | { ok: false; code: DatabaseConnectivityFailureCode; error: string };

/**
 * Fixed, value-free copy. A raw driver message can name a host/user and is
 * never shown or logged.
 */
export function databaseConnectivityFailureMessage(
  code: DatabaseConnectivityFailureCode,
): string {
  switch (code) {
    case "dns":
      return "The database host could not be resolved.";
    case "private_address":
      return "The database host resolves to a private, loopback or reserved address. Use a publicly reachable database.";
    case "timeout":
      return "The database did not answer the verification query in time.";
    case "auth":
      return "The database rejected the username or password in the connection URL.";
    case "tls":
      return "TLS verification failed for the database connection. Use a certificate the hostname matches, or sslmode=require.";
    case "unreachable":
      return "The database refused the connection or is unreachable from Mavly.";
    case "database":
      return "The database named in the connection URL does not exist.";
    default:
      return "The database did not answer the verification query.";
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code.toUpperCase() : "";
  }
  return "";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
]);

/** Pure classification so the mapping is testable without a database. */
export function classifyDatabaseConnectivityError(
  error: unknown,
): DatabaseConnectivityFailureCode {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);

  if (TLS_ERROR_CODES.has(code) || /certificate|self[- ]signed|altname|tls|ssl/i.test(message)) {
    return "tls";
  }
  if (
    /password authentication failed|authentication failed|role .* does not exist|permission denied/i.test(
      message,
    )
  ) {
    return "auth";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") return "dns";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EPIPE" ||
    code === "53300" // too_many_connections
  ) {
    return "unreachable";
  }
  if (code === "28P01" || code === "28000" || code === "42501") return "auth";
  if (code === "3D000") return "database";
  if (code === "57P01" || code === "57P03") return "unreachable";
  return "error";
}

async function closeQuietly(client: Client): Promise<void> {
  await Promise.race([
    client.end().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
  ]);
}

/**
 * Verify that `input.connectionUrl` can authenticate and run a trivial query.
 *
 * @param input.connectionUrl the plaintext URL (never stored by this module)
 * @param input.host the validated hostname (resolved and checked here)
 * @param input.port the database port
 * @param input.sslMode libpq TLS mode from the parsed URL
 */
export async function verifyDatabaseConnection(input: {
  connectionUrl: string;
  host: string;
  port: number;
  sslMode: "require" | "verify-full";
}): Promise<DatabaseConnectivityResult> {
  const startedAt = Date.now();

  let lookupTimer: NodeJS.Timeout | undefined;
  let addresses: { address: string }[];
  try {
    addresses = await Promise.race([
      lookup(input.host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        lookupTimer = setTimeout(() => {
          reject(Object.assign(new Error("dns lookup timed out"), { code: "ETIMEDOUT" }));
        }, DNS_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const classified = classifyDatabaseConnectivityError(error);
    const code: DatabaseConnectivityFailureCode =
      classified === "dns" || classified === "timeout" ? classified : "error";
    return { ok: false, code, error: databaseConnectivityFailureMessage(code) };
  } finally {
    if (lookupTimer) clearTimeout(lookupTimer);
  }

  const resolved = resolvedAddressRejectionReason(addresses.map((entry) => entry.address));
  if (resolved) {
    return {
      ok: false,
      code: "private_address",
      error: `${databaseConnectivityFailureMessage("private_address")} (${resolved})`,
    };
  }

  /**
   * Pin the TCP connection to the address that was just validated. Prefer an
   * IPv4 address: the hosting runtime is reachable over IPv4, and a DNS answer
   * may list an IPv6 address first. TLS still verifies the certificate against
   * the original hostname below.
   */
  const pinnedAddress =
    addresses.find((entry) => isIP(entry.address) === 4)?.address ?? addresses[0].address;
  const servername = isIP(input.host) === 0 ? input.host : undefined;

  let url: URL;
  try {
    url = new URL(input.connectionUrl);
  } catch {
    return { ok: false, code: "error", error: "The database connection URL is not valid." };
  }

  let client: Client;
  try {
    client = new Client({
      host: pinnedAddress,
      port: input.port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      application_name: "mavly-database-verification",
      keepAlive: false,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      ssl: {
        // libpq semantics: `require` encrypts without CA verification,
        // `verify-full` verifies the hostname and chain.
        rejectUnauthorized: input.sslMode === "verify-full",
        ...(servername ? { servername } : {}),
      },
    });
  } catch {
    return {
      ok: false,
      code: "error",
      error: "The database connection could not be prepared for verification.",
    };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const attempt = client
      .connect()
      .then(() => client.query("select 1 as mavly_database_verification"))
      .then(() => ({ kind: "ok" as const }))
      .catch((error: unknown) => ({ kind: "error" as const, error }));

    const remaining = Math.max(1_000, OVERALL_TIMEOUT_MS - (Date.now() - startedAt));
    const overall = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    });

    const outcome = await Promise.race([attempt, overall]);
    if (outcome.kind === "timeout") {
      return {
        ok: false,
        code: "timeout",
        error: databaseConnectivityFailureMessage("timeout"),
      };
    }
    if (outcome.kind === "error") {
      const code = classifyDatabaseConnectivityError(outcome.error);
      return { ok: false, code, error: databaseConnectivityFailureMessage(code) };
    }
    return { ok: true, latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
    await closeQuietly(client);
  }
}
