/**
 * ═══ DEPLOYMENT ENVIRONMENT POLICY — WHICH SECRETS MAY REACH A RUNTIME? ═════
 *
 * A generated application runs in a provider runtime with its own environment.
 * Mavly's own server environment must never be copied there, and a secret must
 * never be exposed through a client-visible name.
 *
 * Rules enforced here (pure, unit-tested):
 *
 *   · `NEXT_PUBLIC_*` values are refused: Next.js inlines them into the browser
 *     bundle, so a saved secret under that name would be published.
 *   · Mavly-owned and provider-owned prefixes/names are refused: a generated app
 *     must never receive a Mavly, Vercel or service-role credential.
 *   · Only `production` / `both` secrets are synced to the production runtime;
 *     `development` stays out of production.
 *   · A deployment cannot be marked ready while a production secret is not
 *     actually synced to the provider.
 */

export type DeploymentEnvEnvironment = "development" | "production" | "both";

export type DeploymentEnvSyncStatus =
  | "pending"
  | "synced"
  | "awaiting_project"
  | "failed"
  | "revoked";

export type DeploymentEnvTarget = "production" | "development";

export interface DeploymentEnvMetadata {
  secretName: string;
  environment: DeploymentEnvEnvironment;
  envKey: string;
  target: DeploymentEnvTarget;
  syncStatus: DeploymentEnvSyncStatus;
  lastError: string | null;
  revision: number;
  updatedAt: string;
}

/** Exact names that must never be injected into generated application code. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "VERCEL_API_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY",
  "MAVLY_INTEGRATION_ENCRYPTION_KEY",
  "MAVLY_GENERATION_WORKER_SECRET",
  "FREEMODEL_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
]);

export const RESERVED_ENV_PREFIXES: readonly string[] = [
  "MAVLY_",
  "VERCEL_",
  "NEXT_PUBLIC_",
];

/** Why this secret name may not be synced, or null when it is acceptable. */
export function secretEnvKeyRejectionReason(name: string): string | null {
  const key = (name ?? "").trim();
  if (!key) return "The secret needs a name.";
  if (RESERVED_ENV_KEYS.has(key)) {
    return `${key} is reserved by Mavly and is never injected into a generated application.`;
  }
  for (const prefix of RESERVED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) {
      if (prefix === "NEXT_PUBLIC_") {
        return "Next.js publishes NEXT_PUBLIC_* values in the browser bundle, so they cannot hold a secret.";
      }
      return `${prefix} names are reserved by Mavly or the hosting provider.`;
    }
  }
  return null;
}

export function deploymentEnvTarget(
  environment: DeploymentEnvEnvironment,
): DeploymentEnvTarget {
  return environment === "development" ? "development" : "production";
}

/** The env keys this secret produces. Kept as a list for a future multi-key form. */
export function deploymentEnvKeys(secretName: string): string[] {
  return [secretName];
}

/** A production secret is one that the production runtime receives. */
export function isProductionEnvRow(
  row: Pick<DeploymentEnvMetadata, "environment">,
): boolean {
  return row.environment !== "development";
}

export interface EnvReadiness {
  ready: boolean;
  /** Env key names only — never values. */
  blockingKeys: string[];
  reason: "pending" | "awaiting_project" | "failed" | null;
}

/**
 * Whether every production secret is actually present in the provider.
 * `awaiting_project` means no provider project existed when the value was saved,
 * so the value was never pushed. Re-saving the secret, then redeploying, is the
 * documented recovery — the plaintext deliberately cannot be read back later.
 */
export function deploymentEnvReadiness(
  rows: readonly DeploymentEnvMetadata[],
): EnvReadiness {
  const blocking = rows.filter(
    (row) =>
      isProductionEnvRow(row) &&
      (row.syncStatus === "pending" ||
        row.syncStatus === "awaiting_project" ||
        row.syncStatus === "failed"),
  );

  if (blocking.length === 0) {
    return { ready: true, blockingKeys: [], reason: null };
  }

  const reason = blocking.some((row) => row.syncStatus === "failed")
    ? "failed"
    : blocking.some((row) => row.syncStatus === "pending")
      ? "pending"
      : "awaiting_project";

  return {
    ready: false,
    blockingKeys: blocking
      .map((row) => row.envKey || row.secretName)
      .sort(),
    reason,
  };
}

export function envReadinessMessage(readiness: EnvReadiness): string {
  if (readiness.ready) return "";
  const keys = readiness.blockingKeys.join(", ");
  switch (readiness.reason) {
    case "awaiting_project":
      return `These secrets were saved before a hosting project existed: ${keys}. Re-save them, then deploy.`;
    case "failed":
      return `These secrets could not be synced to the hosting provider: ${keys}. Re-save them, then deploy.`;
    default:
      return `These secrets are not synced yet: ${keys}.`;
  }
}
