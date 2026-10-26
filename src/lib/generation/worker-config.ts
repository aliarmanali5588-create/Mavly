/**
 * ═══ GENERATION WORKER CONFIGURATION ═════════════════════════════════════════
 *
 * The worker is OPT-IN and COHORT-SCOPED. It is enabled only when all of these
 * are present in the server environment:
 *
 *   MAVLY_GENERATION_WORKER_ENABLED  1 / true / yes / on
 *   MAVLY_GENERATION_WORKER_SECRET   ≥ 32 characters, shared with the scheduler
 *   MAVLY_GENERATION_WORKER_PROJECTS comma/space separated project ids
 *   SUPABASE_SERVICE_ROLE_KEY        server-only; never NEXT_PUBLIC_*
 *   NEXT_PUBLIC_SUPABASE_URL         the project URL
 *
 * ⚠️ A PROJECT NOT IN THE COHORT KEEPS THE EXISTING `after()` PATH. Admission
 * decides the dispatch mode (`inline` or `worker`) before the run is created,
 * so there is no window in which both mechanisms may run the same job.
 *
 * ⚠️ A TYPO IN THE COHORT IS A CONFIGURATION ERROR, NOT AN EMPTY FILTER. If any
 * listed id is invalid the worker reports not-ready and refuses to start, so a
 * malformed rollout cannot silently claim jobs outside the intended set.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { sanitizeWorkerId } from "./leases";

export const WORKER_ENABLED_ENV = "MAVLY_GENERATION_WORKER_ENABLED";
export const WORKER_SECRET_ENV = "MAVLY_GENERATION_WORKER_SECRET";
export const WORKER_PROJECTS_ENV = "MAVLY_GENERATION_WORKER_PROJECTS";
export const WORKER_ID_ENV = "MAVLY_GENERATION_WORKER_ID";
export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";
export const SUPABASE_URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";

export const MIN_WORKER_SECRET_LENGTH = 32;
export const MAX_WORKER_COHORT = 500;

export type WorkerConfigProblem =
  | "disabled"
  | "missing_secret"
  | "weak_secret"
  | "missing_cohort"
  | "invalid_cohort"
  | "missing_service_role"
  | "missing_supabase_url";

export interface GenerationWorkerConfig {
  /** The flag was turned on, even if another prerequisite is missing. */
  requested: boolean;
  /** Every prerequisite is present and valid. */
  ready: boolean;
  secret: string | null;
  workerId: string;
  cohort: string[];
  problems: WorkerConfigProblem[];
}

export type WorkerEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  const entries = raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique: string[] = [];
  for (const entry of entries) {
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_WORKER_COHORT);
}

/** Pure configuration parse. Reads no environment of its own. */
export function parseWorkerConfig(env: WorkerEnvironment): GenerationWorkerConfig {
  const requested = isOn(env[WORKER_ENABLED_ENV]);
  const secret = env[WORKER_SECRET_ENV]?.trim() || null;
  const cohort = splitCohort(env[WORKER_PROJECTS_ENV] ?? "");
  const workerId = sanitizeWorkerId(env[WORKER_ID_ENV]);

  const problems: WorkerConfigProblem[] = [];
  if (!requested) problems.push("disabled");
  if (!secret) problems.push("missing_secret");
  else if (secret.length < MIN_WORKER_SECRET_LENGTH || /\s/.test(secret)) {
    problems.push("weak_secret");
  }
  if (cohort.length === 0) problems.push("missing_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }
  if (!env[SERVICE_ROLE_ENV]?.trim()) problems.push("missing_service_role");
  if (!env[SUPABASE_URL_ENV]?.trim()) problems.push("missing_supabase_url");

  return {
    requested,
    ready: problems.length === 0,
    secret,
    workerId,
    cohort,
    problems,
  };
}

/** This deployment's configuration, read at call time. */
export function generationWorkerConfig(): GenerationWorkerConfig {
  return parseWorkerConfig(process.env);
}

/**
 * The dispatch mode for a newly admitted run. Only a fully configured worker
 * whose cohort contains this project may take it; everything else stays inline.
 */
export function dispatchModeForProject(
  projectId: string,
  config: GenerationWorkerConfig = generationWorkerConfig(),
): "worker" | "inline" {
  if (!config.ready) return "inline";
  return config.cohort.includes(projectId.toLowerCase()) ? "worker" : "inline";
}

export function isProjectInWorkerCohort(
  projectId: string,
  config: GenerationWorkerConfig = generationWorkerConfig(),
): boolean {
  return config.ready && config.cohort.includes(projectId.toLowerCase());
}
