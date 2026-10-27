/**
 * ═══ BUSINESS INTEGRATIONS — OPT-IN CONFIGURATION ═══════════════════════════
 *
 * Phase 6 lets a generated application use a real business provider through
 * Mavly. Every prerequisite must be present, otherwise the feature refuses with
 * a precise reason instead of half-working:
 *
 *   MAVLY_BUSINESS_INTEGRATIONS_ENABLED=on
 *   MAVLY_BUSINESS_INTEGRATIONS_PROJECTS=<explicit project ids>   (never `*`)
 *   MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY                          (credential storage)
 *   MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET=<32+ chars>            (webhook write proof)
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY      (gateway RPCs)
 *
 * ⚠️ OFF BY DEFAULT. Enabling it spends real provider money on behalf of a
 * project owner, so it rolls out to a named cohort first. A project outside the
 * cohort keeps every existing behavior and sees a truthful refusal.
 */

import { createHash } from "node:crypto";

import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";
import { isValidSupabaseUrl } from "@/lib/supabase/config";

export const BUSINESS_INTEGRATIONS_ENABLED_ENV =
  "MAVLY_BUSINESS_INTEGRATIONS_ENABLED";
export const BUSINESS_INTEGRATIONS_PROJECTS_ENV =
  "MAVLY_BUSINESS_INTEGRATIONS_PROJECTS";
/**
 * Server-only proof for the anon-callable webhook write RPCs. The migration
 * stores `sha256(secret)` on the integration row; the route sends that hash, so
 * an anon caller that does not know the secret cannot record or apply an event.
 */
export const BUSINESS_INTEGRATIONS_RPC_SECRET_ENV =
  "MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET";
export const PUBLIC_APP_URL_ENV = "NEXT_PUBLIC_APP_URL";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type BusinessIntegrationsReason =
  | "disabled"
  | "missing_cohort"
  | "wildcard_cohort"
  | "secrets_key_missing"
  | "rpc_secret_missing"
  | "supabase_not_configured";

export interface BusinessIntegrationsConfig {
  cohort: ReadonlySet<string>;
}

export type BusinessIntegrationsConfigResult =
  | { ok: true; config: BusinessIntegrationsConfig; reason?: never }
  | { ok: false; reason: BusinessIntegrationsReason; config?: never };

export function isBusinessIntegrationsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return TRUTHY.has((env[BUSINESS_INTEGRATIONS_ENABLED_ENV] ?? "").trim().toLowerCase());
}

export type CohortResult =
  | { ok: true; cohort: ReadonlySet<string> }
  | { ok: false; reason: "missing_cohort" | "wildcard_cohort" };

export function parseBusinessIntegrationsCohort(
  raw: string | undefined,
): CohortResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "missing_cohort" };
  if (trimmed === "*") return { ok: false, reason: "wildcard_cohort" };

  const entries = trimmed
    .split(/[,;]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (entries.length === 0) return { ok: false, reason: "missing_cohort" };
  if (entries.includes("*")) return { ok: false, reason: "wildcard_cohort" };
  if (entries.some((entry) => /\s/.test(entry))) {
    return { ok: false, reason: "missing_cohort" };
  }
  return { ok: true, cohort: new Set(entries) };
}

export function readBusinessIntegrationsConfig(
  env: NodeJS.ProcessEnv = process.env,
): BusinessIntegrationsConfigResult {
  if (!isBusinessIntegrationsEnabled(env)) return { ok: false, reason: "disabled" };

  const cohort = parseBusinessIntegrationsCohort(
    env[BUSINESS_INTEGRATIONS_PROJECTS_ENV],
  );
  if ("reason" in cohort) return { ok: false, reason: cohort.reason };

  if (projectSecretsCryptoConfig(env).ok === false) {
    return { ok: false, reason: "secrets_key_missing" };
  }
  if (integrationRpcSecret(env) === null) {
    return { ok: false, reason: "rpc_secret_missing" };
  }
  if (
    !isValidSupabaseUrl((env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()) ||
    !(env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim()
  ) {
    return { ok: false, reason: "supabase_not_configured" };
  }

  return { ok: true, config: { cohort: cohort.cohort } };
}

export function isBusinessIntegrationsProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = readBusinessIntegrationsConfig(env);
  if (!("config" in result)) return false;
  const id = projectId.trim().toLowerCase();
  return Boolean(id) && result.config.cohort.has(id);
}

export function businessIntegrationsRefusal(
  reason: BusinessIntegrationsReason,
): string {
  switch (reason) {
    case "disabled":
      return "Business integrations are not enabled on this Mavly deployment.";
    case "missing_cohort":
      return "Business integrations have no explicit project cohort, so no project is eligible.";
    case "wildcard_cohort":
      return "Business integrations require explicit project ids; a wildcard cohort is refused.";
    case "secrets_key_missing":
      return "Business integrations require MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY to store credentials.";
    case "rpc_secret_missing":
      return "Business integrations require a server-only MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET (at least 32 characters).";
    case "supabase_not_configured":
      return "Business integrations require the Supabase URL and anon key.";
  }
}

/** The server-only proof value, or null when it is not configured/too short. */
export function integrationRpcSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = (env[BUSINESS_INTEGRATIONS_RPC_SECRET_ENV] ?? "").trim();
  return value.length >= 32 ? value : null;
}

/**
 * SHA-256 of the RPC secret. Only this hash reaches the database; the secret
 * itself never leaves the Mavly server. Returns null when unconfigured.
 */
export function integrationRpcHash(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = integrationRpcSecret(env);
  return secret === null ? null : createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The canonical HTTPS origin for webhook URLs. It is READ FROM CONFIGURATION,
 * never derived from the request Host: a provider webhook address must not
 * change because an attacker sent a different Host header.
 */
export function publicAppOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[PUBLIC_APP_URL_ENV] ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function paymentWebhookUrl(
  webhookToken: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const origin = publicAppOrigin(env);
  if (!origin || !/^whk_[a-f0-9]{48}$/.test(webhookToken)) return null;
  return `${origin}/api/integrations/webhooks/razorpay/${webhookToken}`;
}
