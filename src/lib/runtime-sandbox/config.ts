/**
 * ═══ LIVE RUNTIME SANDBOX CONFIGURATION ═════════════════════════════════════
 *
 * The live preview runtime is OPT-IN, COHORT-SCOPED and OFF BY DEFAULT:
 *
 *   MAVLY_RUNTIME_SANDBOX_ENABLED            1 / true / yes / on
 *   MAVLY_RUNTIME_SANDBOX_PROJECTS           comma/semicolon separated project ids
 *   E2B_API_KEY                              server-only provider key
 *   MAVLY_RUNTIME_SANDBOX_TEMPLATE           E2B template with Node + npm (default `base`)
 *   MAVLY_RUNTIME_SANDBOX_PORT               dev-server port (default 5173)
 *   MAVLY_RUNTIME_SANDBOX_MAX_LIFETIME_SECONDS   sandbox lifetime (default 1800, max 3600)
 *   MAVLY_RUNTIME_SANDBOX_IDLE_SECONDS       idle window before expiry (default 600)
 *   MAVLY_RUNTIME_SANDBOX_INSTALL_TIMEOUT_SECONDS (default 120, max 420)
 *   MAVLY_RUNTIME_SANDBOX_STARTUP_TIMEOUT_SECONDS (default 60, max 180)
 *   MAVLY_RUNTIME_SANDBOX_MAX_FILES          sync file cap (default 400, max 1000)
 *   MAVLY_RUNTIME_SANDBOX_MAX_FILE_BYTES     per-file cap (default 262144)
 *   MAVLY_RUNTIME_SANDBOX_MAX_TOTAL_BYTES    total sync cap (default 4194304)
 *   MAVLY_RUNTIME_SANDBOX_MAX_ACTIVE_PER_USER (default 2, max 5)
 *   MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE        1/on: let QA/Security read real runtime results
 *   MAVLY_RUNTIME_SANDBOX_QA_BUILD           1/on: also run one bounded production build for QA
 *   NEXT_PUBLIC_SUPABASE_URL                 the project URL (already required by the app)
 *
 * ⚠️ EVERY PREREQUISITE IS ALL-OR-NOTHING. A half-configured deployment must not
 * create a sandbox that cannot run, and it must never fall back to executing
 * generated code on a Mavly host.
 *
 * ⚠️ `apiKey` IS SERVER-ONLY. It must never be serialized into a status, a log,
 * an event or a stored row, and this module is imported only by server code.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { SUPABASE_URL_ENV } from "@/lib/generation/worker-config";

export const RUNTIME_ENABLED_ENV = "MAVLY_RUNTIME_SANDBOX_ENABLED";
export const RUNTIME_PROJECTS_ENV = "MAVLY_RUNTIME_SANDBOX_PROJECTS";
export const E2B_API_KEY_ENV = "E2B_API_KEY";
export const RUNTIME_TEMPLATE_ENV = "MAVLY_RUNTIME_SANDBOX_TEMPLATE";
export const RUNTIME_PORT_ENV = "MAVLY_RUNTIME_SANDBOX_PORT";
export const RUNTIME_MAX_LIFETIME_ENV = "MAVLY_RUNTIME_SANDBOX_MAX_LIFETIME_SECONDS";
export const RUNTIME_IDLE_ENV = "MAVLY_RUNTIME_SANDBOX_IDLE_SECONDS";
export const RUNTIME_INSTALL_TIMEOUT_ENV = "MAVLY_RUNTIME_SANDBOX_INSTALL_TIMEOUT_SECONDS";
export const RUNTIME_STARTUP_TIMEOUT_ENV = "MAVLY_RUNTIME_SANDBOX_STARTUP_TIMEOUT_SECONDS";
export const RUNTIME_MAX_FILES_ENV = "MAVLY_RUNTIME_SANDBOX_MAX_FILES";
export const RUNTIME_MAX_FILE_BYTES_ENV = "MAVLY_RUNTIME_SANDBOX_MAX_FILE_BYTES";
export const RUNTIME_MAX_TOTAL_BYTES_ENV = "MAVLY_RUNTIME_SANDBOX_MAX_TOTAL_BYTES";
export const RUNTIME_MAX_ACTIVE_ENV = "MAVLY_RUNTIME_SANDBOX_MAX_ACTIVE_PER_USER";
export const RUNTIME_QA_EVIDENCE_ENV = "MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE";
export const RUNTIME_QA_BUILD_ENV = "MAVLY_RUNTIME_SANDBOX_QA_BUILD";

export const MAX_RUNTIME_COHORT = 500;
export const DEFAULT_TEMPLATE = "base";
export const MIN_SANDBOX_LIFETIME_SECONDS = 120;
export const MAX_SANDBOX_LIFETIME_SECONDS = 3600;
export const MAX_INSTALL_TIMEOUT_SECONDS = 420;
export const MAX_STARTUP_TIMEOUT_SECONDS = 180;
export const MAX_SYNC_FILES = 1000;
export const MAX_SYNC_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_ACTIVE_PER_USER = 5;

export type RuntimeConfigProblem =
  | "disabled"
  | "missing_cohort"
  | "invalid_cohort"
  | "missing_api_key"
  | "invalid_template"
  | "invalid_port"
  | "invalid_limit"
  | "missing_supabase_url";

export interface RuntimeSandboxConfig {
  /** The flag was turned on, even if a prerequisite is missing. */
  requested: boolean;
  /** Every prerequisite is present and valid. */
  ready: boolean;
  problems: RuntimeConfigProblem[];
  cohort: string[];
  /** Server-only. Never serialize this field. */
  apiKey: string | null;
  template: string;
  port: number;
  maxLifetimeSeconds: number;
  idleSeconds: number;
  installTimeoutMs: number;
  startupTimeoutMs: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxActivePerUser: number;
  qaEvidence: boolean;
  qaBuild: boolean;
}

export type RuntimeEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  /**
   * COMMAS AND SEMICOLONS ONLY. Splitting on whitespace would turn the malformed
   * entry "Alpha App" into two plausible project ids and hide the typo.
   */
  const entries = raw
    .split(/[,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique: string[] = [];
  for (const entry of entries) {
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_RUNTIME_COHORT);
}

interface BoundedInteger {
  value: number;
  valid: boolean;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): BoundedInteger {
  if (raw === undefined || raw.trim() === "") return { value: fallback, valid: true };
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { value: fallback, valid: false };
  }
  return { value: parsed, valid: true };
}

const TEMPLATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

/** Pure configuration parse. Reads no environment of its own. */
export function parseRuntimeSandboxConfig(env: RuntimeEnvironment): RuntimeSandboxConfig {
  const requested = isOn(env[RUNTIME_ENABLED_ENV]);
  const cohort = splitCohort(env[RUNTIME_PROJECTS_ENV] ?? "");
  const problems: RuntimeConfigProblem[] = [];
  if (!requested) problems.push("disabled");

  if (cohort.length === 0) problems.push("missing_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }

  const apiKey = env[E2B_API_KEY_ENV]?.trim() || null;
  if (!apiKey) problems.push("missing_api_key");

  const rawTemplate = env[RUNTIME_TEMPLATE_ENV]?.trim() || DEFAULT_TEMPLATE;
  const template = TEMPLATE_PATTERN.test(rawTemplate) ? rawTemplate : DEFAULT_TEMPLATE;
  if (template !== rawTemplate) problems.push("invalid_template");

  const port = boundedInteger(env[RUNTIME_PORT_ENV], 5173, 1024, 65535);
  if (!port.valid) problems.push("invalid_port");

  const lifetime = boundedInteger(
    env[RUNTIME_MAX_LIFETIME_ENV],
    1800,
    MIN_SANDBOX_LIFETIME_SECONDS,
    MAX_SANDBOX_LIFETIME_SECONDS,
  );
  const idle = boundedInteger(env[RUNTIME_IDLE_ENV], 600, 60, MAX_SANDBOX_LIFETIME_SECONDS);
  /**
   * The defaults fit inside the route's 300 s function budget with room for
   * create, sync and the readiness probe. Raising them is allowed but may make
   * the synchronous start request time out before the lifecycle finishes.
   */
  const install = boundedInteger(
    env[RUNTIME_INSTALL_TIMEOUT_ENV],
    120,
    30,
    MAX_INSTALL_TIMEOUT_SECONDS,
  );
  const startup = boundedInteger(
    env[RUNTIME_STARTUP_TIMEOUT_ENV],
    60,
    20,
    MAX_STARTUP_TIMEOUT_SECONDS,
  );
  const maxFiles = boundedInteger(env[RUNTIME_MAX_FILES_ENV], 400, 10, MAX_SYNC_FILES);
  const maxFileBytes = boundedInteger(
    env[RUNTIME_MAX_FILE_BYTES_ENV],
    256 * 1024,
    1024,
    MAX_SYNC_FILE_BYTES,
  );
  const maxTotalBytes = boundedInteger(
    env[RUNTIME_MAX_TOTAL_BYTES_ENV],
    4 * 1024 * 1024,
    16 * 1024,
    MAX_SYNC_TOTAL_BYTES,
  );
  const maxActive = boundedInteger(env[RUNTIME_MAX_ACTIVE_ENV], 2, 1, MAX_ACTIVE_PER_USER);
  if (
    !lifetime.valid ||
    !idle.valid ||
    !install.valid ||
    !startup.valid ||
    !maxFiles.valid ||
    !maxFileBytes.valid ||
    !maxTotalBytes.valid ||
    !maxActive.valid
  ) {
    problems.push("invalid_limit");
  }
  /** An idle window longer than the sandbox's own lifetime is misleading. */
  const idleSeconds = Math.min(idle.value, lifetime.value);

  if (!env[SUPABASE_URL_ENV]?.trim()) problems.push("missing_supabase_url");

  return {
    requested,
    ready: problems.length === 0,
    problems,
    cohort,
    apiKey,
    template,
    port: port.value,
    maxLifetimeSeconds: lifetime.value,
    idleSeconds,
    installTimeoutMs: install.value * 1000,
    startupTimeoutMs: startup.value * 1000,
    maxFiles: maxFiles.value,
    maxFileBytes: maxFileBytes.value,
    maxTotalBytes: maxTotalBytes.value,
    maxActivePerUser: maxActive.value,
    qaEvidence: isOn(env[RUNTIME_QA_EVIDENCE_ENV]),
    qaBuild: isOn(env[RUNTIME_QA_BUILD_ENV]),
  };
}

/** This deployment's configuration, read at call time. */
export function runtimeSandboxConfig(): RuntimeSandboxConfig {
  return parseRuntimeSandboxConfig(process.env);
}

export function isProjectInRuntimeCohort(
  projectId: string,
  config: RuntimeSandboxConfig = runtimeSandboxConfig(),
): boolean {
  return config.ready && config.cohort.includes(projectId.toLowerCase());
}

export function runtimeProblemSummary(config: RuntimeSandboxConfig): string {
  if (config.ready) return "Live runtime previews are configured.";
  if (config.problems.includes("disabled")) {
    return "Live runtime previews are switched off for this deployment.";
  }
  return `Live runtime previews are not ready: ${config.problems.join(", ")}.`;
}
