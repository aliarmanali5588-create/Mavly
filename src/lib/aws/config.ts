/**
 * Server-only configuration for the AWS static frontend publisher.
 *
 * ═══ NO PER-CUSTOMER CONFIGURATION ══════════════════════════════════════════
 *
 * AWS resource identifiers are stable infrastructure configuration, set once by
 * the operator. They are never per-project and are never changed when a new
 * customer creates a project.
 *
 * ⚠️ `MAVLY_AWS_FRONTEND_HOSTING_PROJECTS` IS NOT AN ONBOARDING ALLOWLIST. It is
 * an OPTIONAL EMERGENCY RESTRICTION. Leave it empty for normal operation: project
 * eligibility then comes from the database (`aws_hosting_eligibility`, migration
 * 61), which checks ownership, suspension, generated source, the canonical
 * billing plan, published-site limits and platform capacity.
 *
 * When the variable is set, ONLY those project ids may use AWS hosting — useful
 * to confine a staging deployment to one internal project. `*` is refused: an
 * unrestricted wildcard is never a supported rollout shortcut. The restriction
 * can be removed at any time without changing AWS resources.
 *
 * ⚠️ SERVER-ONLY. This module holds no secret, but the browser must never decide
 * whether a deployment is enabled. Do not import it into a client component.
 */

export type AwsFrontendHostingProblem =
  | "disabled"
  | "missing_bucket"
  | "invalid_bucket"
  | "missing_region"
  | "invalid_region"
  | "missing_key_value_store"
  | "invalid_project_restriction";

export interface AwsFrontendHostingConfig {
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  keyValueStoreArn: string | null;
  /**
   * `null` = no restriction; any eligible project may publish (the database is
   * authoritative). A set = temporary emergency restriction to those ids.
   */
  restrictedProjects: ReadonlySet<string> | null;
  problem: AwsFrontendHostingProblem | null;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_VALUE_STORE_ARN =
  /^arn:aws:cloudfront::\d{12}:key-value-store\/[a-f0-9-]+$/i;

/**
 * Parse the optional emergency restriction. `null` means "no restriction".
 * A wildcard, an empty entry, or an invalid slug makes the whole configuration
 * invalid instead of silently authorizing everyone.
 */
function parseRestriction(
  raw: string | undefined,
): ReadonlySet<string> | null | "invalid" {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value === "*" || value.includes("*")) return "invalid";

  const projects = value.split(",").map((project) => project.trim().toLowerCase());
  if (
    projects.some(
      (project) =>
        !project ||
        project.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(project),
    )
  ) {
    return "invalid";
  }
  return new Set(projects);
}

export function readAwsFrontendHostingConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): AwsFrontendHostingConfig {
  const enabled = ENABLED_VALUES.has(
    (env.MAVLY_AWS_FRONTEND_HOSTING_ENABLED ?? "").trim().toLowerCase(),
  );
  const bucket = (env.MAVLY_AWS_S3_BUCKET ?? "").trim() || null;
  const rawRegion = (env.MAVLY_AWS_REGION ?? "").trim().toLowerCase();
  const region = rawRegion || null;
  const rawKeyValueStoreArn =
    (env.MAVLY_AWS_CLOUDFRONT_KEY_VALUE_STORE_ARN ?? "").trim();
  const keyValueStoreArn =
    rawKeyValueStoreArn && KEY_VALUE_STORE_ARN.test(rawKeyValueStoreArn)
      ? rawKeyValueStoreArn
      : null;
  const restriction = parseRestriction(env.MAVLY_AWS_FRONTEND_HOSTING_PROJECTS);
  const restrictedProjects = restriction === "invalid" ? null : restriction;

  if (!enabled) {
    return {
      enabled: false,
      bucket,
      region,
      keyValueStoreArn,
      restrictedProjects,
      problem: "disabled",
    };
  }

  let problem: AwsFrontendHostingProblem | null = null;
  if (!bucket) {
    problem = "missing_bucket";
  } else if (
    !S3_BUCKET.test(bucket) ||
    bucket.includes("..") ||
    bucket.includes(".-") ||
    bucket.includes("-.") ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(bucket)
  ) {
    problem = "invalid_bucket";
  } else if (!region) {
    problem = "missing_region";
  } else if (!AWS_REGION.test(region)) {
    problem = "invalid_region";
  } else if (!keyValueStoreArn) {
    problem = "missing_key_value_store";
  } else if (restriction === "invalid") {
    problem = "invalid_project_restriction";
  }

  return { enabled, bucket, region, keyValueStoreArn, restrictedProjects, problem };
}

export function isAwsFrontendHostingConfigured(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const config = readAwsFrontendHostingConfig(env);
  return config.enabled && config.problem === null;
}

/**
 * ⚠️ THIS IS NOT THE ELIGIBILITY DECISION. It answers one narrow question: is
 * the project excluded by the optional operator emergency restriction?
 *
 * With no restriction configured it returns `true` for every project, which
 * means "not excluded" — the database eligibility RPC is what actually decides.
 * Callers that need a publish decision must use `readAwsHostingEligibility`.
 */
export function isAwsFrontendHostingProject(
  projectId: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const config = readAwsFrontendHostingConfig(env);
  if (!config.enabled || config.problem !== null) return false;
  if (config.restrictedProjects === null) return true;
  return config.restrictedProjects.has(projectId.trim().toLowerCase());
}

export function describeAwsFrontendHostingConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): {
  configured: boolean;
  enabled: boolean;
  problem: string | null;
  bucket: string | null;
  region: string | null;
  restrictedProjectCount: number | null;
} {
  const config = readAwsFrontendHostingConfig(env);
  return {
    configured: config.enabled && config.problem === null,
    enabled: config.enabled,
    problem: config.problem,
    bucket: config.bucket,
    region: config.region,
    restrictedProjectCount: config.restrictedProjects?.size ?? null,
  };
}
