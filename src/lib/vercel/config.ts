/**
 * Opt-in configuration for Vercel-backed publishing.
 *
 * The flag and the token are read from server environment variables only and
 * never exposed to the client. Publishing stays disabled until an operator
 * explicitly enables it and supplies a Vercel token.
 *
 * ⚠️ VERCEL PROJECT NAMES ARE DETERMINISTIC from the authoritative Mavly project
 * UUID (see `vercelProjectName`). There is no configurable prefix: repeated
 * publishes and retries resolve the same project, and different Mavly projects
 * never share a Vercel project.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export interface VercelDeploymentConfig {
  token: string;
  teamId: string | null;
}

export interface VercelConfigFailure {
  reason: "disabled" | "missing-token";
}

export type VercelDeploymentConfigResult =
  | { ok: true; config: VercelDeploymentConfig }
  | { ok: false; reason: VercelConfigFailure["reason"] };

export function isVercelDeploymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has(
    (env.MAVLY_VERCEL_DEPLOYMENTS_ENABLED ?? "").trim().toLowerCase(),
  );
}

export function isVercelDeploymentConfigFailure(
  result: VercelDeploymentConfigResult,
): result is Extract<VercelDeploymentConfigResult, { ok: false }> {
  return result.ok === false;
}

export function readVercelDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): VercelDeploymentConfigResult {
  if (!isVercelDeploymentsEnabled(env)) return { ok: false, reason: "disabled" };

  let token = env.VERCEL_API_TOKEN?.trim() ?? "";
  if (!token) return { ok: false, reason: "missing-token" };
  // Be defensive: accept tokens that may include a "Bearer " prefix
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  if (!token) return { ok: false, reason: "missing-token" };

  const teamId = env.VERCEL_TEAM_ID?.trim() ?? "";
  return {
    ok: true,
    config: {
      token,
      teamId: teamId || null,
    },
  };
}
