/**
 * ═══ VERIFICATION SANDBOX CONFIGURATION ═════════════════════════════════════
 *
 * Verification is OPT-IN, COHORT-SCOPED and OFF BY DEFAULT:
 *
 *   MAVLY_VERIFICATION_SANDBOX_ENABLED   1 / true / yes / on
 *   MAVLY_VERIFICATION_SANDBOX_PROVIDER  vercel (default) — e2b is implemented via Cloudflare adapter
 *   MAVLY_VERIFICATION_SANDBOX_PROJECTS  comma/semicolon separated project ids
 *   MAVLY_VERIFICATION_REPAIR_ENABLED    1 / true / yes / on (bounded AI repair)
 *   MAVLY_VERIFICATION_MAX_REPAIRS       0..2, default 1 when repair is enabled
 *   VERCEL_OIDC_TOKEN                    or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID
 *   SUPABASE_SERVICE_ROLE_KEY            worker-owned rows only
 *   NEXT_PUBLIC_SUPABASE_URL             the project URL
 *
 * ⚠️ EVERY PREREQUISITE IS ALL-OR-NOTHING. A half-configured deployment must
 * not enqueue a verification that nothing can ever run. The config is reported
 * as not-ready and the enqueue is skipped; the existing worker is unaffected.
 *
 * ⚠️ CREDENTIALS ARE NEVER PART OF A RESPONSE. This object is server-only and
 * its `credentials` field must not be serialized into a result or an event.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { SERVICE_ROLE_ENV, SUPABASE_URL_ENV } from "@/lib/generation/worker-config";

import { clampMaxRepairs, type VerificationProvider } from "./state";

export const SANDBOX_ENABLED_ENV = "MAVLY_VERIFICATION_SANDBOX_ENABLED";
export const SANDBOX_PROVIDER_ENV = "MAVLY_VERIFICATION_SANDBOX_PROVIDER";
export const SANDBOX_PROJECTS_ENV = "MAVLY_VERIFICATION_SANDBOX_PROJECTS";
export const REPAIR_ENABLED_ENV = "MAVLY_VERIFICATION_REPAIR_ENABLED";
export const MAX_REPAIRS_ENV = "MAVLY_VERIFICATION_MAX_REPAIRS";
export const VERCEL_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";
export const VERCEL_TOKEN_ENV = "VERCEL_TOKEN";
export const VERCEL_TEAM_ID_ENV = "VERCEL_TEAM_ID";
export const VERCEL_PROJECT_ID_ENV = "VERCEL_PROJECT_ID";

export const MAX_SANDBOX_COHORT = 500;

export type VerificationConfigProblem =
  | "disabled"
  | "unknown_provider"
  | "provider_not_implemented"
  | "missing_cohort"
  | "invalid_cohort"
  | "missing_credentials"
  | "missing_service_role"
  | "missing_supabase_url";

interface ProviderCredentials {
  oidcToken: string | null;
  token: string | null;
  teamId: string | null;
  projectId: string | null;
}

export interface VerificationSandboxConfig {
  /** The flag was turned on, even if a prerequisite is missing. */
  requested: boolean;
  /** Every prerequisite is present and valid. */
  ready: boolean;
  provider: VerificationProvider | null;
  cohort: string[];
  /** Bounded repair is separately opt-in and never implied by verification. */
  repairEnabled: boolean;
  /** 0 disables repair; otherwise 1 by default and never more than 2. */
  maxRepairs: number;
  problems: VerificationConfigProblem[];
  /** Server-only. Never serialize or log this field. */
  credentials: ProviderCredentials;
}

export type SandboxEnvironment = Record<string, string | undefined>;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function splitCohort(raw: string): string[] {
  /**
   * ⚠️ COMMAS AND SEMICOLONS ONLY. Splitting on whitespace would silently turn
   * the malformed entry "Alpha App" into two plausible project ids, hiding a
   * typo instead of refusing the configuration.
   */
  const entries = raw
    .split(/[,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const unique: string[] = [];
  for (const entry of entries) {
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_SANDBOX_COHORT);
}

/** Pure configuration parse. Reads no environment of its own. */
export function parseVerificationConfig(env: SandboxEnvironment): VerificationSandboxConfig {
  const requested = isOn(env[SANDBOX_ENABLED_ENV]);
  const rawProvider = env[SANDBOX_PROVIDER_ENV]?.trim().toLowerCase() || "vercel";
  const cohort = splitCohort(env[SANDBOX_PROJECTS_ENV] ?? "");

  const problems: VerificationConfigProblem[] = [];
  if (!requested) problems.push("disabled");

  let provider: VerificationProvider | null = null;
  if (rawProvider === "vercel" || rawProvider === "e2b") {
    provider = rawProvider;
  } else {
    problems.push("unknown_provider");
  }
  if (cohort.length === 0) problems.push("missing_cohort");
  if (cohort.some((projectId) => !isRoutableProjectSlug(projectId))) {
    problems.push("invalid_cohort");
  }

  const credentials: ProviderCredentials = {
    oidcToken: env[VERCEL_OIDC_TOKEN_ENV]?.trim() || null,
    token: env[VERCEL_TOKEN_ENV]?.trim() || null,
    teamId: env[VERCEL_TEAM_ID_ENV]?.trim() || null,
    projectId: env[VERCEL_PROJECT_ID_ENV]?.trim() || null,
  };
  const hasOidc = Boolean(credentials.oidcToken);
  const hasAccessToken = Boolean(
    credentials.token && credentials.teamId && credentials.projectId,
  );
  if (provider === "vercel" && !hasOidc && !hasAccessToken) {
    problems.push("missing_credentials");
  }

  if (!env[SERVICE_ROLE_ENV]?.trim()) problems.push("missing_service_role");
  if (!env[SUPABASE_URL_ENV]?.trim()) problems.push("missing_supabase_url");

  const repairRequested = isOn(env[REPAIR_ENABLED_ENV]);
  const rawMaxRepairs = env[MAX_REPAIRS_ENV]?.trim();
  const parsedMaxRepairs = rawMaxRepairs
    ? Number.parseInt(rawMaxRepairs, 10)
    : Number.NaN;
  const maxRepairs = repairRequested
    ? clampMaxRepairs(Number.isFinite(parsedMaxRepairs) ? parsedMaxRepairs : undefined)
    : 0;

  /**
   * A disabled deployment has selected no provider, even though the provider
   * name defaults to Vercel once it is switched on. Reporting "vercel" here
   * would suggest an active integration that does not exist.
   */
  if (!requested) provider = null;

  return {
    requested,
    ready: problems.length === 0,
    provider,
    cohort,
    repairEnabled: repairRequested && maxRepairs > 0,
    maxRepairs,
    problems,
    credentials,
  };
}

/** This deployment's configuration, read at call time. */
export function verificationSandboxConfig(): VerificationSandboxConfig {
  return parseVerificationConfig(process.env);
}

export function isProjectInVerificationCohort(
  projectId: string,
  config: VerificationSandboxConfig = verificationSandboxConfig(),
): boolean {
  return config.ready && config.cohort.includes(projectId.toLowerCase());
}
