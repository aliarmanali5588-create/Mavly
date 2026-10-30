/**
 * The generated application's data gateway is separately gated from Neon
 * *provisioning*. Turning provisioning off must not break a published app whose
 * backend is already `ready`, so this configuration requires only what serving a
 * request needs: an https origin, the server-only RPC proof, and the key that
 * decrypts a stored connection URI.
 *
 * Pure parse: no I/O.
 */

import {
  APP_GATEWAY_ORIGIN_ENV,
  MANAGED_BACKENDS_ENCRYPTION_KEY_ENV,
  MANAGED_BACKENDS_RPC_SECRET_ENV,
  parseEncryptionKey,
  parseGatewayOrigin,
  parseRpcSecret,
} from "@/lib/managed-backend/config";

export type AppDataGatewayProblem =
  | "missing_gateway_origin"
  | "invalid_gateway_origin"
  | "missing_rpc_secret"
  | "invalid_rpc_secret"
  | "invalid_encryption_key";

export interface AppDataGatewayConfig {
  ready: boolean;
  origin: string | null;
  rpcHash: string | null;
  encryptionKey: Buffer | null;
  problems: AppDataGatewayProblem[];
}

type Environment = Record<string, string | undefined>;

export function parseAppDataGatewayConfig(env: Environment): AppDataGatewayConfig {
  const rawOrigin = env[APP_GATEWAY_ORIGIN_ENV]?.trim() ?? "";
  const origin = parseGatewayOrigin(rawOrigin);
  const rawSecret = env[MANAGED_BACKENDS_RPC_SECRET_ENV]?.trim() ?? "";
  const rpcHash = parseRpcSecret(rawSecret);
  const encryptionKey = parseEncryptionKey(env[MANAGED_BACKENDS_ENCRYPTION_KEY_ENV]);
  const problems: AppDataGatewayProblem[] = [];

  if (!rawOrigin) problems.push("missing_gateway_origin");
  else if (!origin) problems.push("invalid_gateway_origin");
  if (!rawSecret) problems.push("missing_rpc_secret");
  else if (!rpcHash) problems.push("invalid_rpc_secret");
  if (!encryptionKey) problems.push("invalid_encryption_key");

  return {
    ready: problems.length === 0,
    origin,
    rpcHash,
    encryptionKey,
    problems,
  };
}

export function appDataGatewayConfig(
  env: Environment = process.env,
): AppDataGatewayConfig {
  return parseAppDataGatewayConfig(env);
}
