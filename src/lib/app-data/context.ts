/**
 * ═══ SHARED GATEWAY CONTEXT ════════════════════════════════════════════════
 *
 * Resolves one public project id to its ready managed backend, and hands a
 * bounded database client to a handler. Everything that can fail closed lives
 * here so the data and auth handlers cannot accidentally skip it:
 *
 *   · the gateway feature must be configured; otherwise 404 (never a hint);
 *   · the project id must resolve through `data_gateway_context`, which requires
 *     a `ready` row AND the server-only RPC proof;
 *   · the stored ciphertext must decrypt with the server-only key;
 *   · the stored data model must still validate;
 *   · the durable rate window must admit the request.
 *
 * ⚠️ THE CONNECTION URI NEVER LEAVES THIS MODULE'S CALL STACK. It is not put in
 * a response, a log line, an error message or a header.
 */

import { Client } from "pg";

import { decryptManagedBackendConnection } from "@/lib/managed-backend/crypto";
import {
  parseAppDataModel,
  type AppDataModel,
} from "@/lib/managed-backend/model";

import { appDataGatewayConfig } from "./config";
import {
  consumeGatewayRate,
  resolveGatewayProject,
  type GatewayStoreFailureCode,
} from "./store";

const CONNECT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 5_000;

export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{3,62}$/;

export interface GatewayResponse {
  status: number;
  body: Record<string, unknown>;
  cookies?: string[];
}

export function gatewayOk(
  data: unknown,
  status = 200,
  cookies?: string[],
): GatewayResponse {
  return { status, body: { ok: true, data }, ...(cookies ? { cookies } : {}) };
}

export function gatewayFail(
  status: number,
  code: string,
  error: string,
): GatewayResponse {
  return { status, body: { ok: false, code, error } };
}

export function gatewayStoreFailure(code: GatewayStoreFailureCode): GatewayResponse {
  if (code === "migration_required") {
    return gatewayFail(
      503,
      "migration_required",
      "The managed data gateway is not installed on this deployment.",
    );
  }
  if (code === "unavailable") {
    return gatewayFail(503, "unavailable", "The data gateway is unavailable.");
  }
  return gatewayFail(500, "error", "The request could not be completed.");
}

export interface ResolvedApp {
  projectId: string;
  /** Mavly's owning user. Used only for decryption AAD; never returned. */
  ownerUserId: string;
  registryId: string;
  model: AppDataModel;
  /** Server-only. */
  connectionUri: string;
}

export type AppResolution =
  | { ok: true; app: ResolvedApp }
  | { ok: false; response: GatewayResponse };

const NOT_FOUND = gatewayFail(404, "not_found", "Not found.");

export async function resolveApp(projectId: unknown): Promise<AppResolution> {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    return { ok: false, response: NOT_FOUND };
  }

  const config = appDataGatewayConfig();
  if (!config.ready || !config.rpcHash || !config.encryptionKey) {
    // A disabled or half-configured gateway is indistinguishable from an
    // unknown project on a public path.
    return { ok: false, response: NOT_FOUND };
  }

  const resolved = await resolveGatewayProject({
    projectId,
    rpcHash: config.rpcHash,
  });
  if (resolved.ok === false) {
    return { ok: false, response: gatewayStoreFailure(resolved.code) };
  }
  if (!resolved.data) return { ok: false, response: NOT_FOUND };
  const row = resolved.data;
  if (row.project_id !== projectId) return { ok: false, response: NOT_FOUND };

  const connectionUri = decryptManagedBackendConnection(
    config.encryptionKey,
    row.connection_uri_ciphertext,
    {
      userId: row.user_id,
      projectId: row.project_id,
      registryId: row.registry_id,
    },
  );
  if (!connectionUri) {
    console.error(
      `[app-data] stored connection configuration could not be decrypted for ${projectId}`,
    );
    return {
      ok: false,
      response: gatewayFail(
        503,
        "backend_misconfigured",
        "The managed backend is not available.",
      ),
    };
  }

  const parsed = parseAppDataModel(row.data_model);
  if (!parsed.ok) {
    console.error(`[app-data] stored data model is invalid for ${projectId}`);
    return {
      ok: false,
      response: gatewayFail(
        503,
        "backend_misconfigured",
        "The managed backend is not available.",
      ),
    };
  }

  return {
    ok: true,
    app: {
      projectId: row.project_id,
      ownerUserId: row.user_id,
      registryId: row.registry_id,
      model: parsed.model,
      connectionUri,
    },
  };
}

/** Returns a refusal response, or null when the request may proceed. */
export async function admit(
  projectId: string,
  action: "read" | "write" | "auth",
): Promise<GatewayResponse | null> {
  const config = appDataGatewayConfig();
  if (!config.ready || !config.rpcHash) {
    return gatewayFail(404, "not_found", "Not found.");
  }
  const result = await consumeGatewayRate({
    projectId,
    action,
    rpcHash: config.rpcHash,
  });
  if (result.ok === false) return gatewayStoreFailure(result.code);
  if (!result.data) {
    return gatewayFail(
      429,
      "rate_limited",
      "Too many requests. Try again in a minute.",
    );
  }
  return null;
}

export type DbOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; response: GatewayResponse };

function mapDbError(error: unknown): GatewayResponse {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505") {
    return gatewayFail(409, "conflict", "That record already exists.");
  }
  if (code === "23503" || code === "23514") {
    return gatewayFail(409, "conflict", "The request conflicts with existing data.");
  }
  if (
    code === "22001" ||
    code === "22003" ||
    code === "22P02" ||
    code === "22007"
  ) {
    return gatewayFail(422, "invalid_input", "Some values are not valid.");
  }
  if (code === "42P01" || code === "42703" || code === "42883") {
    return gatewayFail(
      503,
      "backend_not_ready",
      "The application database schema is not available.",
    );
  }
  if (typeof code === "string" && code.startsWith("08")) {
    return gatewayFail(503, "unavailable", "The application database is unavailable.");
  }
  return gatewayFail(500, "error", "The request could not be completed.");
}

export async function withDatabase<T>(
  connectionUri: string,
  run: (client: Client) => Promise<T>,
): Promise<DbOutcome<T>> {
  const client = new Client({
    connectionString: connectionUri,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "mavly-app-data-gateway",
  });
  try {
    await client.connect();
  } catch {
    return {
      ok: false,
      response: gatewayFail(503, "unavailable", "The application database is unavailable."),
    };
  }
  try {
    return { ok: true, data: await run(client) };
  } catch (error) {
    return { ok: false, response: mapDbError(error) };
  } finally {
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}
