import { createHash } from "node:crypto";

import { isRoutableProjectSlug } from "@/lib/project-slug";

export const MANAGED_BACKENDS_ENABLED_ENV = "MAVLY_MANAGED_BACKENDS_ENABLED";
export const MANAGED_BACKENDS_PROJECTS_ENV = "MAVLY_MANAGED_BACKENDS_PROJECTS";
export const NEON_AGENT_PLAN_APPROVED_ENV = "MAVLY_NEON_AGENT_PLAN_APPROVED";
export const NEON_API_KEY_ENV = "NEON_API_KEY";
export const NEON_ORG_ID_ENV = "NEON_ORG_ID";
export const NEON_REGION_ID_ENV = "NEON_REGION_ID";
export const MANAGED_BACKENDS_ENCRYPTION_KEY_ENV =
  "MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY";
/**
 * The public origin of Mavly's data gateway, e.g. `https://mavly.example`.
 * Generated applications call `<origin>/api/app/v1/...`; their own published
 * origin is derived from the project id, never supplied by a browser.
 */
export const APP_GATEWAY_ORIGIN_ENV = "MAVLY_APP_GATEWAY_ORIGIN";
/**
 * A server-only proof (>= 32 chars) that accompanies every data-gateway RPC.
 * The project's public identifier alone must never be enough to read the
 * encrypted connection URI from PostgREST.
 */
export const MANAGED_BACKENDS_RPC_SECRET_ENV = "MAVLY_MANAGED_BACKENDS_RPC_SECRET";

const MAX_PROJECTS = 500;

export type ManagedBackendConfigProblem =
  | "disabled"
  | "agent_plan_not_approved"
  | "missing_api_key"
  | "missing_org_id"
  | "invalid_org_id"
  | "missing_region_id"
  | "invalid_region_id"
  | "missing_cohort"
  | "invalid_cohort"
  | "invalid_encryption_key"
  | "missing_gateway_origin"
  | "invalid_gateway_origin"
  | "missing_rpc_secret"
  | "invalid_rpc_secret";

export interface ManagedBackendConfig {
  requested: boolean;
  ready: boolean;
  apiKey: string | null;
  orgId: string | null;
  regionId: string | null;
  cohort: string[];
  encryptionKey: Buffer | null;
  /** Absolute https origin of Mavly's data gateway, or null. */
  gatewayOrigin: string | null;
  /** SHA-256 of the server-only gateway proof; the secret itself is not kept. */
  rpcSecretHash: string | null;
  problems: ManagedBackendConfigProblem[];
}

type Environment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(entries)];
}

export function parseEncryptionKey(value: string | undefined): Buffer | null {
  const encoded = value?.trim() ?? "";
  if (!encoded || /\s/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 && key.toString("base64") === encoded ? key : null;
}

/**
 * A gateway origin must be an absolute https origin with no path, credentials,
 * query or fragment. It is used as a fixed prefix; a model, prompt or browser
 * can never supply it.
 */
export function parseGatewayOrigin(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !url.hostname ||
      url.hostname.endsWith(".")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function parseRpcSecret(value: string | undefined): string | null {
  const secret = value ?? "";
  if (secret.length < 32 || secret.length > 512 || /\s/.test(secret)) return null;
  return createHash("sha256").update(secret).digest("hex");
}

export function parseManagedBackendConfig(env: Environment): ManagedBackendConfig {
  const requested = isOn(env[MANAGED_BACKENDS_ENABLED_ENV]);
  const apiKey = env[NEON_API_KEY_ENV]?.trim() || null;
  const orgId = env[NEON_ORG_ID_ENV]?.trim() || null;
  const regionId = env[NEON_REGION_ID_ENV]?.trim().toLowerCase() || null;
  const cohort = splitCohort(env[MANAGED_BACKENDS_PROJECTS_ENV]);
  const encryptionKey = parseEncryptionKey(env[MANAGED_BACKENDS_ENCRYPTION_KEY_ENV]);
  const rawOrigin = env[APP_GATEWAY_ORIGIN_ENV]?.trim() ?? "";
  const gatewayOrigin = parseGatewayOrigin(rawOrigin);
  const rawSecret = env[MANAGED_BACKENDS_RPC_SECRET_ENV]?.trim() ?? "";
  const rpcSecretHash = parseRpcSecret(env[MANAGED_BACKENDS_RPC_SECRET_ENV]);
  const problems: ManagedBackendConfigProblem[] = [];

  if (!requested) problems.push("disabled");
  if (!isOn(env[NEON_AGENT_PLAN_APPROVED_ENV])) {
    problems.push("agent_plan_not_approved");
  }
  if (!apiKey || /\s/.test(apiKey)) problems.push("missing_api_key");
  if (!orgId) problems.push("missing_org_id");
  else if (!/^org-[A-Za-z0-9-]{1,120}$/.test(orgId)) problems.push("invalid_org_id");
  if (!regionId) problems.push("missing_region_id");
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/.test(regionId)) {
    problems.push("invalid_region_id");
  }
  if (cohort.length === 0 || cohort.includes("*")) problems.push("missing_cohort");
  if (cohort.length > MAX_PROJECTS) problems.push("invalid_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }
  if (!encryptionKey) problems.push("invalid_encryption_key");
  if (!rawOrigin) problems.push("missing_gateway_origin");
  else if (!gatewayOrigin) problems.push("invalid_gateway_origin");
  if (!rawSecret) problems.push("missing_rpc_secret");
  else if (!rpcSecretHash) problems.push("invalid_rpc_secret");

  return {
    requested,
    ready: problems.length === 0,
    apiKey,
    orgId,
    regionId,
    cohort,
    encryptionKey,
    gatewayOrigin,
    rpcSecretHash,
    problems,
  };
}

export function managedBackendConfig(
  env: Environment = process.env,
): ManagedBackendConfig {
  return parseManagedBackendConfig(env);
}
