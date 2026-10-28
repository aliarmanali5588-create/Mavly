import { isRoutableProjectSlug } from "@/lib/project-slug";

export const MANAGED_BACKENDS_ENABLED_ENV = "MAVLY_MANAGED_BACKENDS_ENABLED";
export const MANAGED_BACKENDS_PROJECTS_ENV = "MAVLY_MANAGED_BACKENDS_PROJECTS";
export const NEON_AGENT_PLAN_APPROVED_ENV = "MAVLY_NEON_AGENT_PLAN_APPROVED";
export const NEON_API_KEY_ENV = "NEON_API_KEY";
export const NEON_ORG_ID_ENV = "NEON_ORG_ID";
export const NEON_REGION_ID_ENV = "NEON_REGION_ID";
export const MANAGED_BACKENDS_ENCRYPTION_KEY_ENV =
  "MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY";

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
  | "invalid_encryption_key";

export interface ManagedBackendConfig {
  requested: boolean;
  ready: boolean;
  apiKey: string | null;
  orgId: string | null;
  regionId: string | null;
  cohort: string[];
  encryptionKey: Buffer | null;
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

function parseEncryptionKey(value: string | undefined): Buffer | null {
  const encoded = value?.trim() ?? "";
  if (!encoded || /\s/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 && key.toString("base64") === encoded ? key : null;
}

export function parseManagedBackendConfig(env: Environment): ManagedBackendConfig {
  const requested = isOn(env[MANAGED_BACKENDS_ENABLED_ENV]);
  const apiKey = env[NEON_API_KEY_ENV]?.trim() || null;
  const orgId = env[NEON_ORG_ID_ENV]?.trim() || null;
  const regionId = env[NEON_REGION_ID_ENV]?.trim().toLowerCase() || null;
  const cohort = splitCohort(env[MANAGED_BACKENDS_PROJECTS_ENV]);
  const encryptionKey = parseEncryptionKey(env[MANAGED_BACKENDS_ENCRYPTION_KEY_ENV]);
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

  return {
    requested,
    ready: problems.length === 0,
    apiKey,
    orgId,
    regionId,
    cohort,
    encryptionKey,
    problems,
  };
}

export function managedBackendConfig(
  env: Environment = process.env,
): ManagedBackendConfig {
  return parseManagedBackendConfig(env);
}
