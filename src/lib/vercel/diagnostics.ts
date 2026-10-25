/**
 * Server-only diagnostics for Vercel API failures.
 *
 * A failed publish used to leave only a generic user-facing message, so the
 * operator could not tell an expired token from a wrong team id. These helpers
 * record just enough to answer that question without ever writing a credential,
 * authorization header or full upstream body to the logs.
 *
 * NEVER pass an authorization header here. `secret` exists solely so a token is
 * redacted if Vercel ever echoes it inside an error message.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Environment variables that older/looser builds accepted but this build does
 * not read. Reporting their names (never values) makes a configuration-name
 * mismatch obvious on the first failed publish.
 */
const IGNORED_ENV_NAMES = [
  "VERCEL_DEPLOYMENTS_ENABLED",
  "ENABLE_VERCEL_DEPLOYMENTS",
  "NEXT_PUBLIC_MAVLY_VERCEL_DEPLOYMENTS_ENABLED",
  "VERCEL_TOKEN",
  "VERCEL_AUTH_TOKEN",
  "VERCEL_ACCESS_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_TEAM_ID_SLUG",
  "VERCEL_PROJECT_NAME_PREFIX",
] as const;

export interface VercelConfigPresence {
  enabled: boolean;
  tokenConfigured: boolean;
  teamIdConfigured: boolean;
  /** Names only. Values are never read for logging. */
  ignoredEnvNames: string[];
}

export interface VercelFailureDiagnostic {
  operation: string;
  method: string;
  /** Path only: no query string, no origin, no credentials. */
  endpoint: string;
  status: number;
  upstreamCode: string;
  upstreamMessage: string;
  requestId: string | null;
  config: VercelConfigPresence;
}

export function sanitizeVercelDiagnosticText(
  raw: unknown,
  secret: string | null = null,
  maxLength = 300,
): string {
  if (typeof raw !== "string") return "";
  let text = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (secret && secret.length >= 8) {
    text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  return text.slice(0, Math.max(0, maxLength));
}

export function vercelConfigPresence(
  env: NodeJS.ProcessEnv = process.env,
): VercelConfigPresence {
  const enabled = (env.MAVLY_VERCEL_DEPLOYMENTS_ENABLED ?? "").trim().toLowerCase();
  return {
    enabled: ENABLED_VALUES.has(enabled),
    tokenConfigured: Boolean(env.VERCEL_API_TOKEN?.trim()),
    teamIdConfigured: Boolean(env.VERCEL_TEAM_ID?.trim()),
    ignoredEnvNames: IGNORED_ENV_NAMES.filter((name) => Boolean(env[name]?.trim())),
  };
}

export function formatVercelFailureDiagnostic(
  diagnostic: VercelFailureDiagnostic,
): string {
  return JSON.stringify({ source: "vercel", ...diagnostic });
}
