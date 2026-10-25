/**
 * Server-only configuration for Mavly-managed Vercel deployments.
 *
 * ⚠️ DISABLED BY DEFAULT. Enabling this makes Mavly submit users' generated
 * previews to a Vercel account that Mavly operates. Vercel's platform terms and
 * the "Vercel for Platforms" product govern that hosting model; an operator must
 * confirm plan eligibility before setting the flag. See
 * `MAVLY_VERCEL_DEPLOYMENTS.md`.
 *
 * ⚠️ NEVER IMPORT THIS MODULE INTO A CLIENT COMPONENT. `VERCEL_API_TOKEN` must
 * never be prefixed with `NEXT_PUBLIC_`, returned in an API response, or logged.
 *
 * ⚠️ ONLY THE DOCUMENTED NAMES ARE READ. Vercel injects `VERCEL_ORG_ID` and
 * `VERCEL_PROJECT_ID` into every deployment it builds; they describe Mavly's own
 * hosting project, not the team/account that should own generated sites. Treating
 * `VERCEL_ORG_ID` as `teamId` sends requests to a team the token may not belong
 * to and surfaces as a misleading 401/403. The team is `VERCEL_TEAM_ID` only.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export interface VercelDeploymentConfig {
  token: string;
  /** Team that owns the projects. Empty ⇒ the token's personal account. */
  teamId: string | null;
  /** Prefix for generated Vercel project names; sanitized, never client-supplied. */
  projectPrefix: string;
}

export type VercelDeploymentConfigResult =
  | { ok: true; config: VercelDeploymentConfig; reason?: never }
  | { ok: false; reason: "disabled" | "missing-token"; config?: never };

export function isVercelDeploymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has(
    (env.MAVLY_VERCEL_DEPLOYMENTS_ENABLED ?? "").trim().toLowerCase(),
  );
}

function projectPrefix(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 20) || "mavly";
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
      projectPrefix: projectPrefix(env.VERCEL_PROJECT_PREFIX),
    },
  };
}
