/**
 * Platform-wide generation worker configuration.
 *
 * Production deployments always dispatch eligible runs to the durable queue.
 * The Cloudflare Cron Worker and the app server need only the existing
 * server-side Supabase service-role key and Supabase URL. Local development,
 * local production-mode starts and Vercel preview deployments retain inline
 * execution.
 */

import { sanitizeWorkerId } from "./leases";

export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";
export const SUPABASE_URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
export const CLOUDFLARE_WORKER_ENV = "MAVLY_CLOUDFLARE_WORKER";

export type WorkerConfigProblem = "missing_service_role" | "missing_supabase_url";

export interface GenerationWorkerConfig {
  /** Production dispatch is automatic; there is no worker feature flag. */
  requested: true;
  ready: boolean;
  workerId: string;
  production: boolean;
  problems: WorkerConfigProblem[];
}

export type WorkerEnvironment = Record<string, string | undefined>;

/** Pure configuration parse. Reads no environment of its own. */
export function parseWorkerConfig(env: WorkerEnvironment): GenerationWorkerConfig {
  const problems: WorkerConfigProblem[] = [];
  if (!env[SERVICE_ROLE_ENV]?.trim()) problems.push("missing_service_role");
  if (!env[SUPABASE_URL_ENV]?.trim()) problems.push("missing_supabase_url");

  const productionRuntime =
    env.VERCEL_ENV === "production" || env[CLOUDFLARE_WORKER_ENV] === "true";

  return {
    requested: true,
    ready: problems.length === 0,
    workerId: sanitizeWorkerId("cloudflare-generation-worker"),
    production: env.NODE_ENV === "production" && productionRuntime,
    problems,
  };
}

/** This deployment's configuration, read at call time. */
export function generationWorkerConfig(): GenerationWorkerConfig {
  return parseWorkerConfig(process.env);
}

/**
 * Production runs use the durable worker globally; local development and
 * preview deployments preserve the existing inline path.
 */
export function dispatchModeForProject(
  _projectId: string,
  config: GenerationWorkerConfig = generationWorkerConfig(),
): "worker" | "inline" {
  return config.production ? "worker" : "inline";
}
