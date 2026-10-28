/**
 * ═══ MULTI-AGENT CONFIGURATION — OPT-IN, COHORT-SCOPED, OFF BY DEFAULT ═══════
 *
 *   MAVLY_MULTI_AGENT_ENABLED          1 / true / yes / on
 *   MAVLY_MULTI_AGENT_PROJECTS         comma/semicolon separated project ids
 *   MAVLY_MULTI_AGENT_REPAIR_ENABLED   1 / true / yes / on (diagnostic repair task)
 *   MAVLY_MULTI_AGENT_MAX_REPAIRS      0..2, default 1
 *   MAVLY_MULTI_AGENT_MAX_PROVIDER_CALLS 1..24, default 8
 *   MAVLY_MULTI_AGENT_MAX_WALL_CLOCK_MS  30000..900000, default 240000
 *   MAVLY_DEPLOYMENT_APPROVAL_REQUIRED 1 / true / yes / on (Phase 10 gate)
 *   MAVLY_DEPLOYMENT_APPROVAL_TTL_MINUTES 5..1440, default 60
 *
 * ⚠️ THE WORKFLOW LAYER RUNS ONLY WHERE THE DURABLE WORKER RUNS. An inline
 * `after()` run has no durable scheduler and no confined service client, so it
 * keeps the existing pipeline unchanged. Every prerequisite must be present; a
 * half-configured deployment reports the exact problem instead of silently
 * pretending the workflow ran.
 *
 * ⚠️ THE DEPLOYMENT APPROVAL GATE IS INDEPENDENT. `MAVLY_DEPLOYMENT_APPROVAL_REQUIRED`
 * can be enabled without multi-agent orchestration, and the gate is also applied
 * automatically to every multi-agent cohort project.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { parseWorkerConfig } from "@/lib/generation/worker-config";

export const MULTI_AGENT_ENABLED_ENV = "MAVLY_MULTI_AGENT_ENABLED";
export const MULTI_AGENT_PROJECTS_ENV = "MAVLY_MULTI_AGENT_PROJECTS";
export const MULTI_AGENT_REPAIR_ENABLED_ENV = "MAVLY_MULTI_AGENT_REPAIR_ENABLED";
export const MULTI_AGENT_MAX_REPAIRS_ENV = "MAVLY_MULTI_AGENT_MAX_REPAIRS";
export const MULTI_AGENT_MAX_PROVIDER_CALLS_ENV = "MAVLY_MULTI_AGENT_MAX_PROVIDER_CALLS";
export const MULTI_AGENT_MAX_WALL_CLOCK_ENV = "MAVLY_MULTI_AGENT_MAX_WALL_CLOCK_MS";
export const DEPLOYMENT_APPROVAL_REQUIRED_ENV = "MAVLY_DEPLOYMENT_APPROVAL_REQUIRED";
export const DEPLOYMENT_APPROVAL_TTL_ENV = "MAVLY_DEPLOYMENT_APPROVAL_TTL_MINUTES";
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

export const MAX_MULTI_AGENT_COHORT = 500;
export const DEFAULT_APPROVAL_TTL_MINUTES = 60;
export const MIN_APPROVAL_TTL_MINUTES = 5;
export const MAX_APPROVAL_TTL_MINUTES = 1_440;

export type MultiAgentConfigProblem =
  | "disabled"
  | "missing_cohort"
  | "invalid_cohort"
  | "worker_not_ready"
  | "missing_service_role"
  | "missing_ai_key";

export interface MultiAgentConfig {
  requested: boolean;
  ready: boolean;
  cohort: string[];
  repairEnabled: boolean;
  maxRepairs: number;
  maxProviderCalls: number;
  maxWallClockMs: number;
  problems: MultiAgentConfigProblem[];
}

export type MultiAgentEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  const unique: string[] = [];
  for (const entry of raw.split(/[,;]+/).map((item) => item.trim().toLowerCase())) {
    if (entry && !unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_MULTI_AGENT_COHORT);
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw?.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/** Pure configuration parse. Reads no environment of its own. */
export function parseMultiAgentConfig(env: MultiAgentEnvironment): MultiAgentConfig {
  const requested = isOn(env[MULTI_AGENT_ENABLED_ENV]);
  const cohort = splitCohort(env[MULTI_AGENT_PROJECTS_ENV] ?? "");
  const worker = parseWorkerConfig(env);

  const problems: MultiAgentConfigProblem[] = [];
  if (!requested) problems.push("disabled");
  if (cohort.length === 0) problems.push("missing_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }
  if (!worker.ready) problems.push("worker_not_ready");
  if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim()) problems.push("missing_service_role");
  if (!env[OPENROUTER_KEY_ENV]?.trim()) problems.push("missing_ai_key");

  const repairRequested = isOn(env[MULTI_AGENT_REPAIR_ENABLED_ENV]);
  const maxRepairs = repairRequested
    ? boundedInt(env[MULTI_AGENT_MAX_REPAIRS_ENV], 1, 0, 2)
    : 0;

  return {
    requested,
    ready: problems.length === 0,
    cohort,
    repairEnabled: repairRequested && maxRepairs > 0,
    maxRepairs,
    maxProviderCalls: boundedInt(env[MULTI_AGENT_MAX_PROVIDER_CALLS_ENV], 8, 1, 24),
    maxWallClockMs: boundedInt(
      env[MULTI_AGENT_MAX_WALL_CLOCK_ENV],
      4 * 60_000,
      30_000,
      15 * 60_000,
    ),
    problems,
  };
}

export function multiAgentConfig(): MultiAgentConfig {
  return parseMultiAgentConfig(process.env);
}

export function isProjectInMultiAgentCohort(
  projectId: string,
  config: MultiAgentConfig = multiAgentConfig(),
): boolean {
  return config.ready && config.cohort.includes(projectId.toLowerCase());
}

export function multiAgentProblemMessage(problems: readonly MultiAgentConfigProblem[]): string {
  if (problems.includes("disabled")) {
    return "Multi-agent orchestration is not enabled on this Mavly deployment.";
  }
  if (problems.includes("invalid_cohort")) {
    return "MAVLY_MULTI_AGENT_PROJECTS contains an invalid project id.";
  }
  if (problems.includes("missing_cohort")) {
    return "MAVLY_MULTI_AGENT_PROJECTS is empty; no project is authorized.";
  }
  if (problems.includes("worker_not_ready")) {
    return "Multi-agent orchestration requires the durable generation worker (migration 16 and its configuration).";
  }
  if (problems.includes("missing_service_role")) {
    return "Multi-agent orchestration requires SUPABASE_SERVICE_ROLE_KEY.";
  }
  return "Multi-agent orchestration requires OPENROUTER_API_KEY.";
}

// ── Deployment approval ─────────────────────────────────────────────────────

export interface DeploymentApprovalConfig {
  required: boolean;
  ttlMinutes: number;
}

export function parseDeploymentApprovalConfig(
  env: MultiAgentEnvironment,
): DeploymentApprovalConfig {
  return {
    required: isOn(env[DEPLOYMENT_APPROVAL_REQUIRED_ENV]),
    ttlMinutes: boundedInt(
      env[DEPLOYMENT_APPROVAL_TTL_ENV],
      DEFAULT_APPROVAL_TTL_MINUTES,
      MIN_APPROVAL_TTL_MINUTES,
      MAX_APPROVAL_TTL_MINUTES,
    ),
  };
}

export function deploymentApprovalConfig(): DeploymentApprovalConfig {
  return parseDeploymentApprovalConfig(process.env);
}

/**
 * The gate applies when the operator requires it platform-wide, or when this
 * project is in the multi-agent cohort (the orchestration contract assumes it).
 */
export function deploymentApprovalRequiredFor(
  projectId: string,
  env: MultiAgentEnvironment = process.env,
): boolean {
  if (parseDeploymentApprovalConfig(env).required) return true;
  return isProjectInMultiAgentCohort(projectId, parseMultiAgentConfig(env));
}
