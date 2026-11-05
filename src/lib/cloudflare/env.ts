/**
 * ═══ CLOUDFLARE GENERATION ENVIRONMENT ══════════════════════════════════════
 *
 * Cloudflare owns generation EXECUTION; Supabase stays the source of truth.
 * Nothing here is read by the Next.js app, and no secret is ever returned to a
 * browser or written to a log.
 *
 * ⚠️ A HALF-CONFIGURED DEPLOYMENT RUNS NOTHING. `parseCloudflareEnv` reports the
 * exact missing binding and `generationEnabled` stays false; the dispatcher then
 * refuses to create a Workflow instead of starting a paid run it cannot finish.
 *
 * This module is pure: it reads the object it is given and never touches
 * `process.env` itself, so the worker entrypoint decides where bindings live.
 */

export const ENABLED_ENV = "MAVLY_CLOUDFLARE_GENERATION_ENABLED";
export const DISPATCH_SECRET_ENV = "MAVLY_CLOUDFLARE_DISPATCH_SECRET";
export const SUPABASE_URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
export const SUPABASE_ANON_ENV = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
export const SERVICE_ROLE_ENV = "SUPABASE_SERVICE_ROLE_KEY";
export const OPENROUTER_ENV = "OPENROUTER_API_KEY";
export const E2B_KEY_ENV = "E2B_API_KEY";
export const E2B_TEMPLATE_ENV = "E2B_VERIFICATION_TEMPLATE_ID";

export type CloudflareEnvProblem =
  | "generation_disabled"
  | "missing_supabase_url"
  | "missing_supabase_anon_key"
  | "missing_service_role"
  | "missing_openrouter_key"
  | "missing_dispatch_secret"
  | "dispatch_secret_too_short"
  | "missing_e2b_key"
  | "missing_e2b_template";

export interface CloudflareEnv {
  [key: string]: unknown;
  MAVLY_CLOUDFLARE_GENERATION_ENABLED?: string;
  MAVLY_CLOUDFLARE_DISPATCH_SECRET?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENROUTER_API_KEY?: string;
  E2B_API_KEY?: string;
  E2B_VERIFICATION_TEMPLATE_ID?: string;
  NODE_ENV?: string;
}

export interface CloudflareGenerationConfig {
  requested: boolean;
  ready: boolean;
  problems: CloudflareEnvProblem[];
  supabaseUrl: string | null;
  dispatchSecret: string | null;
  e2bTemplate: string | null;
  verificationReady: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truthy(value: unknown): boolean {
  const raw = text(value)?.toLowerCase();
  return raw === "true" || raw === "1";
}

/**
 * Pure configuration parse. A problem is reported once, in a stable order, so
 * the health endpoint and the dispatcher explain the same thing.
 */
export function parseCloudflareEnv(env: CloudflareEnv): CloudflareGenerationConfig {
  const problems: CloudflareEnvProblem[] = [];
  const requested = truthy(env[ENABLED_ENV]);
  if (!requested) problems.push("generation_disabled");

  const supabaseUrl = text(env[SUPABASE_URL_ENV]);
  if (!supabaseUrl) problems.push("missing_supabase_url");
  if (!text(env[SUPABASE_ANON_ENV])) problems.push("missing_supabase_anon_key");
  if (!text(env[SERVICE_ROLE_ENV])) problems.push("missing_service_role");
  if (!text(env[OPENROUTER_ENV])) problems.push("missing_openrouter_key");

  const dispatchSecret = text(env[DISPATCH_SECRET_ENV]);
  if (!dispatchSecret) problems.push("missing_dispatch_secret");
  else if (dispatchSecret.length < 32) problems.push("dispatch_secret_too_short");

  const e2bTemplate = text(env[E2B_TEMPLATE_ENV]);
  const verificationProblems: CloudflareEnvProblem[] = [];
  if (!text(env[E2B_KEY_ENV])) verificationProblems.push("missing_e2b_key");
  if (!e2bTemplate) verificationProblems.push("missing_e2b_template");

  const generationProblems = problems.filter(
    (problem) =>
      problem !== "missing_e2b_key" && problem !== "missing_e2b_template",
  );

  return {
    requested,
    ready: requested && generationProblems.length === 0,
    problems: [...generationProblems, ...verificationProblems],
    supabaseUrl,
    dispatchSecret,
    e2bTemplate,
    /**
     * Verification is a separate capability. A deployment can generate without
     * it; the run then reports verification as unavailable instead of claiming
     * a check that never ran.
     */
    verificationReady: requested && verificationProblems.length === 0,
  };
}

/** Deterministic Workflow instance id. One run can never start two instances. */
export function workflowIdForRun(runId: string): string {
  return `run-${runId.replace(/-/g, "")}`;
}

/** Bounded, constant-time comparison for the internal dispatch credential. */
export function dispatchSecretMatches(
  expected: string | null,
  presented: string | null,
): boolean {
  if (!expected || !presented) return false;
  if (expected.length !== presented.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}
