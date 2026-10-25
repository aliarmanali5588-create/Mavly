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
  | { ok: true; config: VercelDeploymentConfig }
  | { ok: false; reason: "disabled" | "missing-token" };

export function isVercelDeploymentsEnabled(): boolean {
  return ENABLED_VALUES.has((process.env.MAVLY_VERCEL_DEPLOYMENTS_ENABLED ?? "").trim().toLowerCase());
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

export function readVercelDeploymentConfig(): VercelDeploymentConfigResult {
  // Also check alternative env var names for flexibility
  const enabled = process.env.MAVLY_VERCEL_DEPLOYMENTS_ENABLED 
    || process.env.VERCEL_DEPLOYMENTS_ENABLED 
    || process.env.ENABLE_VERCEL_DEPLOYMENTS
    || process.env.NEXT_PUBLIC_MAVLY_VERCEL_DEPLOYMENTS_ENABLED;
  
  const enabledValues = new Set(["1", "true", "yes", "on"]);
  if (enabled && enabledValues.has((enabled ?? "").trim().toLowerCase())) {
    // Explicitly enabled via alternative var
  } else if (!isVercelDeploymentsEnabled()) {
    return { ok: false, reason: "disabled" };
  }

  let token = (process.env.VERCEL_API_TOKEN?.trim()
    || process.env.VERCEL_TOKEN?.trim()
    || process.env.VERCEL_AUTH_TOKEN?.trim()
    || process.env.VERCEL_ACCESS_TOKEN?.trim())
    || "";
  if (!token) return { ok: false, reason: "missing-token" };
  // Be defensive: accept tokens that may include a "Bearer " prefix
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  if (!token) return { ok: false, reason: "missing-token" };

  const teamId = (process.env.VERCEL_TEAM_ID?.trim()
    || process.env.VERCEL_ORG_ID?.trim()
    || process.env.VERCEL_TEAM_ID_SLUG?.trim())
    || "";
  return {
    ok: true,
    config: {
      token,
      teamId: teamId || null,
      projectPrefix: projectPrefix(process.env.VERCEL_PROJECT_PREFIX || process.env.VERCEL_PROJECT_NAME_PREFIX),
    },
  };
}
