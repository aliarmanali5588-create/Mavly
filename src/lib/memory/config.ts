/**
 * ═══ AGENT MEMORY — OPT-IN CONFIGURATION ════════════════════════════════════
 *
 * Persistent memory is off by default and restricted to an explicit project
 * cohort. When it is off, generation behaves exactly as before: no memory read,
 * no memory write and no context-selection change.
 *
 * Prerequisites:
 *   MAVLY_AGENT_MEMORY_ENABLED=on
 *   MAVLY_AGENT_MEMORY_PROJECTS=<explicit ids>   (never `*`)
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * No new secret is needed: memory uses the same project-scoped Supabase access
 * as every other child table. The table is installed by migration 24.
 */

import { isValidSupabaseUrl } from "@/lib/supabase/config";

export const AGENT_MEMORY_ENABLED_ENV = "MAVLY_AGENT_MEMORY_ENABLED";
export const AGENT_MEMORY_PROJECTS_ENV = "MAVLY_AGENT_MEMORY_PROJECTS";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type AgentMemoryReason =
  | "disabled"
  | "missing_cohort"
  | "wildcard_cohort"
  | "supabase_not_configured";

export interface AgentMemoryConfig {
  cohort: ReadonlySet<string>;
}

export type AgentMemoryConfigResult =
  | { ok: true; config: AgentMemoryConfig; reason?: never }
  | { ok: false; reason: AgentMemoryReason; config?: never };

export function isAgentMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env[AGENT_MEMORY_ENABLED_ENV] ?? "").trim().toLowerCase());
}

export type MemoryCohortResult =
  | { ok: true; cohort: ReadonlySet<string> }
  | { ok: false; reason: "missing_cohort" | "wildcard_cohort" };

export function parseAgentMemoryCohort(raw: string | undefined): MemoryCohortResult {
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

export function readAgentMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentMemoryConfigResult {
  if (!isAgentMemoryEnabled(env)) return { ok: false, reason: "disabled" };

  const cohort = parseAgentMemoryCohort(env[AGENT_MEMORY_PROJECTS_ENV]);
  if ("reason" in cohort) return { ok: false, reason: cohort.reason };

  if (
    !isValidSupabaseUrl((env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()) ||
    !(env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim()
  ) {
    return { ok: false, reason: "supabase_not_configured" };
  }

  return { ok: true, config: { cohort: cohort.cohort } };
}

export function isAgentMemoryProject(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = readAgentMemoryConfig(env);
  if (!("config" in result)) return false;
  const id = projectId.trim().toLowerCase();
  return Boolean(id) && result.config.cohort.has(id);
}

export function agentMemoryRefusal(reason: AgentMemoryReason): string {
  switch (reason) {
    case "disabled":
      return "Project memory is not enabled on this Mavly deployment.";
    case "missing_cohort":
      return "Project memory has no explicit project cohort, so no project is eligible.";
    case "wildcard_cohort":
      return "Project memory requires explicit project ids; a wildcard cohort is refused.";
    case "supabase_not_configured":
      return "Project memory requires the Supabase URL and anon key.";
  }
}
