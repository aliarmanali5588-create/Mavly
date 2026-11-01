import { createHash } from "node:crypto";

import { isRoutableProjectSlug } from "@/lib/project-slug";

import {
  isEnrollmentMode,
  type EnrollmentMode,
} from "./enrollment";

export const MANAGED_BACKENDS_ENABLED_ENV = "MAVLY_MANAGED_BACKENDS_ENABLED";
/**
 * ⚠️ LEGACY. This was the ONLY authorization mechanism: an operator pasted every
 * eligible project UUID here. It is retained for two reasons and neither is
 * "keep doing it by hand":
 *
 *   1. Backward compatibility. When `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE` is
 *      unset, this list IS the authorization, exactly as before, so an existing
 *      deployment keeps working through the migration.
 *   2. It becomes the source of the `allowlisted` enrollment cohort once an
 *      enrollment mode is configured. It is never a bypass around the registry.
 */
export const MANAGED_BACKENDS_PROJECTS_ENV = "MAVLY_MANAGED_BACKENDS_PROJECTS";
/**
 * ═══ ENROLLMENT CONFIGURATION (migration 37) ════════════════════════════════
 *
 * Unset means "legacy": authorization comes from MAVLY_MANAGED_BACKENDS_PROJECTS
 * and no enrollment row is required. Any explicit value — including `disabled` —
 * switches the deployment to the database-backed enrollment registry, and the
 * legacy list stops being an authorization path.
 */
export const MANAGED_BACKENDS_ENROLLMENT_MODE_ENV =
  "MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE";
export const MANAGED_BACKENDS_ROLLOUT_PERCENT_ENV =
  "MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT";
/** Server-only. Never returned by a route, a status projection or a log line. */
export const MANAGED_BACKENDS_ROLLOUT_SALT_ENV =
  "MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT";
export const MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS_ENV =
  "MAVLY_MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS";
/** Explicit internal/test projects, for `internal` mode. */
export const MANAGED_BACKENDS_INTERNAL_PROJECTS_ENV =
  "MAVLY_MANAGED_BACKENDS_INTERNAL_PROJECTS";
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
/** A bounded ceiling on concurrent provisions. Never unbounded, never zero. */
const MAX_ACTIVE_PROVISIONS_CEILING = 50;
const DEFAULT_MAX_ACTIVE_PROVISIONS = 5;

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
  | "invalid_rpc_secret"
  | "invalid_enrollment_mode"
  | "invalid_rollout_percent"
  | "missing_rollout_salt"
  | "invalid_max_active_provisions";

/**
 * The enrollment half of the configuration. `mode: null` means the deployment is
 * still on the legacy static allowlist; anything else means the enrollment
 * registry is authoritative.
 */
export interface ManagedBackendEnrollmentConfig {
  mode: EnrollmentMode | null;
  /** 0–99. Meaningful only for `percentage`. */
  rolloutPercent: number;
  /** Server-only salt. Empty unless `percentage` is configured. */
  rolloutSalt: string;
  maxActiveProvisions: number;
  internalProjects: string[];
  /** True when the database-backed registry decides authorization. */
  registryAuthoritative: boolean;
}

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
  enrollment: ManagedBackendEnrollmentConfig;
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

/**
 * ═══ ENROLLMENT CONFIGURATION PARSING ═══════════════════════════════════════
 *
 * Every failure mode here fails CLOSED. A malformed percentage, a missing salt
 * for `percentage`, or a nonsense capacity does not fall back to "enroll
 * everyone" — it records a problem, which makes `ready` false, which blocks
 * provisioning entirely. That is the only safe direction.
 */
export function parseEnrollmentConfig(
  env: Environment,
  problems: ManagedBackendConfigProblem[],
): ManagedBackendEnrollmentConfig {
  const rawMode = env[MANAGED_BACKENDS_ENROLLMENT_MODE_ENV]?.trim().toLowerCase();
  const internalProjects = splitCohort(env[MANAGED_BACKENDS_INTERNAL_PROJECTS_ENV]);

  /**
   * An unset mode is the documented legacy path: the static project list is the
   * authorization. An explicitly EMPTY value is a configuration mistake and is
   * refused rather than silently treated as legacy, because a half-migrated
   * deployment should stop, not quietly keep the old behavior.
   */
  if (rawMode === undefined) {
    return {
      mode: null,
      rolloutPercent: 0,
      rolloutSalt: "",
      maxActiveProvisions: DEFAULT_MAX_ACTIVE_PROVISIONS,
      internalProjects,
      registryAuthoritative: false,
    };
  }

  if (!isEnrollmentMode(rawMode)) {
    problems.push("invalid_enrollment_mode");
    return {
      mode: "disabled",
      rolloutPercent: 0,
      rolloutSalt: "",
      maxActiveProvisions: DEFAULT_MAX_ACTIVE_PROVISIONS,
      internalProjects,
      registryAuthoritative: true,
    };
  }

  const rawPercent = env[MANAGED_BACKENDS_ROLLOUT_PERCENT_ENV]?.trim() ?? "";
  let rolloutPercent = 0;
  if (rawMode === "percentage") {
    /**
     * ⚠️ NO IMPLICIT 100. A missing or malformed percentage is refused, never
     * defaulted upward. `0` is the only safe default and it enrolls nobody.
     */
    if (!/^\d{1,3}$/.test(rawPercent)) {
      problems.push("invalid_rollout_percent");
    } else {
      const parsed = Number.parseInt(rawPercent, 10);
      if (parsed < 0 || parsed > 99) problems.push("invalid_rollout_percent");
      else rolloutPercent = parsed;
    }
  } else if (rawPercent) {
    // A percentage outside `percentage` mode is dead configuration. Refuse it so
    // an operator does not believe a rollout is in effect when it is not.
    if (!/^\d{1,3}$/.test(rawPercent) || Number.parseInt(rawPercent, 10) > 99) {
      problems.push("invalid_rollout_percent");
    }
  }

  const rolloutSalt =
    rawMode === "percentage" ? (env[MANAGED_BACKENDS_ROLLOUT_SALT_ENV]?.trim() ?? "") : "";
  if (rawMode === "percentage" && rolloutSalt.length < 16) {
    // A short salt makes the bucket predictable across deployments. 16 chars is
    // a floor, not a recommendation; generate 32 random bytes.
    problems.push("missing_rollout_salt");
  }

  const rawMax = env[MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS_ENV]?.trim() ?? "";
  let maxActiveProvisions = DEFAULT_MAX_ACTIVE_PROVISIONS;
  if (rawMax) {
    if (!/^\d{1,2}$/.test(rawMax)) {
      problems.push("invalid_max_active_provisions");
    } else {
      const parsed = Number.parseInt(rawMax, 10);
      if (parsed < 1 || parsed > MAX_ACTIVE_PROVISIONS_CEILING) {
        problems.push("invalid_max_active_provisions");
      } else {
        maxActiveProvisions = parsed;
      }
    }
  }

  return {
    mode: rawMode,
    rolloutPercent,
    rolloutSalt,
    maxActiveProvisions,
    internalProjects,
    registryAuthoritative: true,
  };
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
  const enrollment = parseEnrollmentConfig(env, problems);

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
  /**
   * ⚠️ THE COHORT RULE DEPENDS ON THE AUTHORIZATION MODEL.
   *
   * Legacy: the project list IS the authorization, so an empty list (or `*`)
   * must keep failing closed exactly as before.
   *
   * Registry: the list is no longer an authorization path, so it is allowed to
   * be empty — that is the whole point of this change. `*` is still refused
   * everywhere, because a wildcard cohort is the one value that would turn a
   * list into "everyone".
   */
  if (cohort.includes("*")) problems.push("missing_cohort");
  else if (!enrollment.registryAuthoritative && cohort.length === 0) {
    problems.push("missing_cohort");
  }
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
    enrollment,
    problems,
  };
}

export function managedBackendConfig(
  env: Environment = process.env,
): ManagedBackendConfig {
  return parseManagedBackendConfig(env);
}
