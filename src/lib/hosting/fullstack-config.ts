/**
 * ═══ FULL-STACK HOSTING — OPT-IN CONFIGURATION ══════════════════════════════
 *
 * Phase 5 hosts a *supported* generated Next.js App Router project on Vercel's
 * native Next.js runtime: server route handlers, server actions and API routes
 * execute inside the Vercel deployment, not inside Mavly.
 *
 * ⚠️ OFF BY DEFAULT, AND NARROWER THAN STATIC PUBLISHING. Enabling this needs
 * ALL of:
 *
 *   MAVLY_FULLSTACK_HOSTING_ENABLED=on
 *   MAVLY_FULLSTACK_HOSTING_PROJECTS=<explicit project ids>   (never `*`)
 *   the existing Vercel publishing configuration (flag + VERCEL_API_TOKEN)
 *   MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY (database credentials are project
 *   secrets; without the key the database contract cannot fail closed)
 *
 * A wildcard cohort is refused on purpose. A full-stack deployment spends real
 * provider build minutes and can expose server-side data; it must be rolled out
 * to a named cohort first, exactly like the worker and sandbox cohorts.
 *
 * ⚠️ SERVER-ONLY. Read by the deployment service and the secret write-through.
 * It holds no secret, but the browser must never decide whether a project may
 * run server code.
 */

import { projectSecretsCryptoConfig } from "@/lib/project-secrets/config";
import {
  isVercelDeploymentConfigFailure,
  readVercelDeploymentConfig,
} from "@/lib/vercel/config";

export const FULLSTACK_HOSTING_ENABLED_ENV = "MAVLY_FULLSTACK_HOSTING_ENABLED";
export const FULLSTACK_HOSTING_PROJECTS_ENV = "MAVLY_FULLSTACK_HOSTING_PROJECTS";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type FullstackConfigReason =
  | "disabled"
  | "missing_cohort"
  | "wildcard_cohort"
  | "provider_not_configured"
  | "secrets_key_missing";

export interface FullstackHostingConfig {
  provider: "vercel";
  runtime: "nextjs";
  /** Explicit project ids only; there is no wildcard form. */
  cohort: ReadonlySet<string>;
}

export type FullstackConfigResult =
  | { ok: true; config: FullstackHostingConfig; reason?: never }
  | { ok: false; reason: FullstackConfigReason; config?: never };

export function isFullstackHostingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return TRUTHY.has((env[FULLSTACK_HOSTING_ENABLED_ENV] ?? "").trim().toLowerCase());
}

export type FullstackCohortResult =
  | { ok: true; cohort: ReadonlySet<string> }
  | { ok: false; reason: "missing_cohort" | "wildcard_cohort" };

/**
 * Parse the explicit cohort. `*` is refused: a full-stack deployment is a
 * materially larger grant than a static publish, so "every project" is not a
 * supported shorthand here even if shared hosting allows it.
 */
export function parseFullstackCohort(raw: string | undefined): FullstackCohortResult {
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

/**
 * Resolve the complete prerequisite set. A partial configuration is a refusal
 * with a precise reason, never a silent fallback to static publishing: a user
 * who asked for a full-stack deployment must not receive a static site that
 * quietly dropped every API route.
 */
export function readFullstackHostingConfig(
  env: NodeJS.ProcessEnv = process.env,
): FullstackConfigResult {
  if (!isFullstackHostingEnabled(env)) return { ok: false, reason: "disabled" };

  const cohort = parseFullstackCohort(env[FULLSTACK_HOSTING_PROJECTS_ENV]);
  if ("reason" in cohort) return { ok: false, reason: cohort.reason };

  const vercel = readVercelDeploymentConfig(env);
  if (isVercelDeploymentConfigFailure(vercel)) {
    return { ok: false, reason: "provider_not_configured" };
  }

  const secrets = projectSecretsCryptoConfig(env);
  if (secrets.ok === false) return { ok: false, reason: "secrets_key_missing" };

  return {
    ok: true,
    config: { provider: "vercel", runtime: "nextjs", cohort: cohort.cohort },
  };
}

/** True only for a configured, explicitly listed project. Never throws. */
export function isFullstackHostingProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = readFullstackHostingConfig(env);
  if (!("config" in result)) return false;
  const id = projectId.trim().toLowerCase();
  return Boolean(id) && result.config.cohort.has(id);
}

/**
 * Whether the operator INTENDS this project to use full-stack hosting, even if a
 * prerequisite (provider credentials, secrets key) is currently missing.
 *
 * ⚠️ THIS EXISTS TO PREVENT A SILENT DOWNGRADE. Without it, a broken full-stack
 * configuration would make the project look "not in the cohort" and the next
 * deploy would quietly publish a static site that drops every API route. The
 * caller refuses with the precise missing prerequisite instead.
 */
export function isFullstackHostingRequested(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isFullstackHostingEnabled(env)) return false;
  const cohort = parseFullstackCohort(env[FULLSTACK_HOSTING_PROJECTS_ENV]);
  if (!("cohort" in cohort)) return false;
  const id = projectId.trim().toLowerCase();
  return Boolean(id) && cohort.cohort.has(id);
}

/**
 * A user-facing refusal. It names the exact prerequisite without echoing any
 * value, and it never claims the feature is merely "unavailable" when the
 * operator has not configured it.
 */
export function fullstackConfigRefusal(reason: FullstackConfigReason): string {
  switch (reason) {
    case "disabled":
      return "Full-stack hosting is not enabled on this Mavly deployment.";
    case "missing_cohort":
      return "Full-stack hosting has no explicit project cohort, so no project is eligible.";
    case "wildcard_cohort":
      return "Full-stack hosting requires explicit project ids; a wildcard cohort is refused.";
    case "provider_not_configured":
      return "Full-stack hosting requires the Vercel publishing configuration (flag and VERCEL_API_TOKEN).";
    case "secrets_key_missing":
      return "Full-stack hosting requires MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY for project secrets.";
  }
}
