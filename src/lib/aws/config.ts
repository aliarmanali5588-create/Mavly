/**
 * Server-only configuration for the opt-in AWS static frontend publisher.
 */

export type AwsFrontendHostingProblem =
  | "disabled"
  | "missing_bucket"
  | "invalid_bucket"
  | "missing_region"
  | "invalid_region"
  | "missing_key_value_store"
  | "missing_cohort"
  | "invalid_cohort";

export interface AwsFrontendHostingConfig {
  enabled: boolean;
  bucket: string | null;
  region: string | null;
  keyValueStoreArn: string | null;
  cohort: ReadonlySet<string> | null;
  problem: AwsFrontendHostingProblem | null;
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_VALUE_STORE_ARN =
  /^arn:aws:cloudfront::\d{12}:key-value-store\/[a-f0-9-]+$/i;

function parseCohort(raw: string | undefined): ReadonlySet<string> | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const projects = value.split(",").map((project) => project.trim().toLowerCase());
  if (
    projects.some(
      (project) =>
        !project ||
        project.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(project),
    )
  ) {
    return null;
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
  const rawCohort = (env.MAVLY_AWS_FRONTEND_HOSTING_PROJECTS ?? "").trim();
  const cohort = parseCohort(rawCohort);

  if (!enabled) {
    return {
      enabled: false,
      bucket,
      region,
      keyValueStoreArn,
      cohort,
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
  } else if (!cohort) {
    problem = rawCohort ? "invalid_cohort" : "missing_cohort";
  }

  return { enabled, bucket, region, keyValueStoreArn, cohort, problem };
}

export function isAwsFrontendHostingConfigured(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const config = readAwsFrontendHostingConfig(env);
  return config.enabled && config.problem === null;
}

export function isAwsFrontendHostingProject(
  projectId: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const config = readAwsFrontendHostingConfig(env);
  if (!config.enabled || config.problem !== null || !config.cohort) return false;
  return config.cohort.has(projectId.trim().toLowerCase());
}

export function describeAwsFrontendHostingConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): {
  configured: boolean;
  enabled: boolean;
  problem: string | null;
  bucket: string | null;
  region: string | null;
  cohortSize: number | null;
} {
  const config = readAwsFrontendHostingConfig(env);
  return {
    configured: config.enabled && config.problem === null,
    enabled: config.enabled,
    problem: config.problem,
    bucket: config.bucket,
    region: config.region,
    cohortSize: config.cohort?.size ?? null,
  };
}
