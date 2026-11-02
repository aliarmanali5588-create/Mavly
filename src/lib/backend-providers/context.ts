/**
 * ═══ AUTHORITATIVE BACKEND CONTEXT ══════════════════════════════════════════
 *
 * One structured answer to "which backend does this project use", shared by
 * every agent role, the coding engine and the generated-app gateway.
 *
 * ⚠️ THE WHOLE POINT IS THAT THEY CANNOT DISAGREE. Before this module the coding
 * engine received a `managedBackendContext` that only described managed Neon, and
 * the six orchestration roles received nothing at all. A planner could therefore
 * plan a Supabase schema for a project served by Neon, and the repair role could
 * "fix" a connection the project does not use.
 *
 * ⚠️ THIS MODULE DOES NOT DECIDE WHICH BACKEND IS SELECTED. The database does
 * (`read_backend_context`, migration 48). This module turns that row into the
 * structured context and the prompt block, and refuses to invent a provider when
 * the row is missing or contradictory.
 *
 * ⚠️ PROVIDER IDS ARE THE PERSISTED ONES. `mavly_managed_neon` and
 * `external_supabase` are constrained by `project_backend_providers_provider_check`
 * and by every stored row. The brief's shorter `managed_neon` is the same thing;
 * renaming the enum would be a destructive migration for a cosmetic gain.
 *
 * PURE MODULE: no Supabase, no Next.js, no provider import. Everything here is
 * unit-testable without a database.
 */

import type { BackendProvider } from "./types";

/**
 * The backend as the agents see it. `none` is a real state, not an absence: a
 * project with no backend must be told so, or an agent will assume one exists.
 */
export type BackendContextProvider = BackendProvider | "none";

export const BACKEND_CONTEXT_PROVIDERS = [
  "mavly_managed_neon",
  "external_supabase",
  "none",
] as const;

export function isBackendContextProvider(value: unknown): value is BackendContextProvider {
  return (
    typeof value === "string" &&
    (BACKEND_CONTEXT_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Who owns the database. This is what changes an agent's advice, not the name. */
export type BackendDatabaseOwner = "mavly" | "customer" | "none";

export interface BackendAgentContext {
  backend_provider: BackendContextProvider;
  backend_status: string;
  backend_active: boolean;
  database_owner: BackendDatabaseOwner;
  /** True only when the agent may read/write the application schema. */
  schema_access: boolean;
  /** The single instruction block the agent must obey. */
  backend_instructions: string;
  /**
   * The epoch the selection was read at. A run records this and refuses to
   * continue if the project's epoch has moved, so one generation cannot mix two
   * providers.
   */
  selection_epoch: number;
}

/**
 * The raw projection `read_backend_context` returns. Kept separate from the
 * agent context because it is also what the gateway needs (the data model and
 * the gateway origin), and the two consumers must not diverge.
 */
export interface BackendContextRow {
  backend_provider: BackendContextProvider;
  backend_status: string;
  backend_active: boolean;
  selection_epoch: number;
  managed_ready: boolean;
  supabase_ready: boolean;
  supabase_project_ref: string | null;
  data_model: unknown;
  gateway_origin: string | null;
}

/**
 * ═══ THE INSTRUCTIONS ═══════════════════════════════════════════════════════
 *
 * ⚠️ EACH BLOCK NAMES THE FORBIDDEN ACTION EXPLICITLY. "Use the selected backend"
 * is not an instruction a model can act on; "never provision a competing Neon
 * backend" is. The negative half is the part that prevents the failure the brief
 * is actually about.
 */
export const BACKEND_INSTRUCTIONS: Record<BackendContextProvider, string> = {
  mavly_managed_neon:
    "Use the project's Mavly-managed Neon backend. Never attempt to use customer Supabase credentials, never ask the user for a Supabase URL or key, and never create a competing backend. All persistence goes through Mavly's data API for this project.",
  external_supabase:
    "Use the user's explicitly selected Supabase project through Mavly's authorized server-side integration. Never provision a competing Neon backend, never ask for a service-role key, and never invent a database connection. All persistence goes through the authorized Supabase integration for this project.",
  none:
    "No backend has been selected. Do not assume Neon or Supabase is available. Do not include a database client, a connection string, or claim working persistence. Ask the user to enable or connect a backend when persistent database functionality is required.",
};

function ownerFor(provider: BackendContextProvider): BackendDatabaseOwner {
  if (provider === "mavly_managed_neon") return "mavly";
  if (provider === "external_supabase") return "customer";
  return "none";
}

/**
 * Build the agent context from the authoritative row.
 *
 * ⚠️ `schema_access` IS NOT `backend_active`. A backend can be selected and still
 * not be usable: managed Neon is only usable when its schema was verified and the
 * gateway configured, and Supabase only when the connection is verified. Telling
 * an agent it has schema access it does not have is how generated code ships a
 * data layer that 500s on first request.
 */
export function buildBackendAgentContext(row: BackendContextRow): BackendAgentContext {
  const provider = row.backend_provider;

  /**
   * ⚠️ A SELECTED BUT UNREADY BACKEND IS REPORTED AS SELECTED AND UNUSABLE.
   * Collapsing it to `none` would invite the agent to propose a different
   * backend, which is exactly the silent provider change the brief forbids.
   */
  const schemaAccess =
    provider === "mavly_managed_neon"
      ? row.managed_ready && row.backend_active
      : provider === "external_supabase"
        ? row.supabase_ready && row.backend_active
        : false;

  return {
    backend_provider: provider,
    backend_status: row.backend_status,
    backend_active: row.backend_active,
    database_owner: ownerFor(provider),
    schema_access: schemaAccess,
    backend_instructions: BACKEND_INSTRUCTIONS[provider],
    selection_epoch: row.selection_epoch,
  };
}

/**
 * ═══ THE PROMPT BLOCK ═══════════════════════════════════════════════════════
 *
 * Rendered as a system-message section. It is server-authored and carries no
 * credential, so it is safe to place in a system prompt.
 */
export function renderBackendContextBlock(context: BackendAgentContext): string {
  const lines = [
    "Backend selection (server-controlled; this is authoritative for this project):",
    `- Provider: ${context.backend_provider}`,
    `- Status: ${context.backend_status}`,
    `- Active: ${context.backend_active ? "yes" : "no"}`,
    `- Database owner: ${context.database_owner}`,
    `- Schema access: ${context.schema_access ? "available" : "not available"}`,
    `- ${context.backend_instructions}`,
  ];

  if (context.backend_provider !== "none" && !context.schema_access) {
    /**
     * The honest middle state. Without this the model sees "provider: neon" and
     * writes a data layer for a database that is not serving yet.
     */
    lines.push(
      "- The selected backend is not currently usable. Do not claim working persistence, and do not switch to another provider. Keep any data layer clearly labelled and incomplete rather than inventing one.",
    );
  }

  lines.push(
    "- You may not provision, connect, replace or switch the backend. Only the user can do that, from the Database page.",
  );

  return lines.join("\n");
}

/**
 * ═══ STALE-CONTEXT DETECTION ════════════════════════════════════════════════
 *
 * A generation run records the epoch it started under. If the project's epoch has
 * moved, the backend changed mid-run and the run must not continue: continuing
 * would write Neon-targeted code into a Supabase project or the reverse.
 *
 * ⚠️ THIS IS A REFUSAL, NOT A RETRY. Silently restarting would spend the user's
 * credits on work they did not ask for. The caller decides whether to restart.
 */
export type BackendContextStaleness =
  | { stale: false }
  | { stale: true; reason: "provider_changed" | "epoch_changed"; message: string };

export function detectStaleBackendContext(input: {
  startedEpoch: number;
  currentEpoch: number;
  startedProvider: BackendContextProvider;
  currentProvider: BackendContextProvider;
}): BackendContextStaleness {
  if (input.startedProvider !== input.currentProvider) {
    return {
      stale: true,
      reason: "provider_changed",
      message:
        `The project's backend changed from ${input.startedProvider} to ${input.currentProvider} ` +
        "while this run was in progress. The run was stopped so it cannot mix two providers.",
    };
  }
  if (input.startedEpoch !== input.currentEpoch) {
    return {
      stale: true,
      reason: "epoch_changed",
      message:
        "The project's backend selection changed while this run was in progress. " +
        "The run was stopped so it cannot mix two providers.",
    };
  }
  return { stale: false };
}

/**
 * ═══ WHAT A ROLE MAY DO WITH THE BACKEND ════════════════════════════════════
 *
 * Every role receives the same context, but their permitted behaviour differs.
 * Encoding it here means a role cannot be given a tool it should not have, and a
 * test can assert the whole matrix at once.
 */
export const ROLE_BACKEND_PERMISSIONS = {
  planner: "plan_for_selected_only",
  ui_ux: "no_backend_infrastructure",
  coding: "generate_for_selected_only",
  qa: "validate_selected_only",
  security: "check_selected_boundary",
  repair: "never_change_provider",
  deployment: "preserve_selected",
} as const;

export type RoleBackendPermission =
  (typeof ROLE_BACKEND_PERMISSIONS)[keyof typeof ROLE_BACKEND_PERMISSIONS];

/** The extra constraint each role's prompt carries, on top of the shared block. */
export const ROLE_BACKEND_CONSTRAINTS: Record<keyof typeof ROLE_BACKEND_PERMISSIONS, string> = {
  planner:
    "Plan against the selected backend only. Do not propose a different provider, a second database, or any backend migration.",
  ui_ux:
    "Do not invent backend infrastructure. Do not add database setup, connection strings, or provider-specific SDKs to a design.",
  coding:
    "Generate database integration code for the selected provider only. Never write code for the other provider, and never include a credential.",
  qa: "Validate the integration against the selected backend only. A passing check against the other provider is not evidence.",
  security:
    "Check credential and data boundaries for the selected provider only. Never suggest storing a provider credential in client code.",
  repair:
    "Never change, replace or switch the backend provider. If the fix appears to require a different provider, stop and report it instead.",
  deployment:
    "Preserve the selected backend configuration. Never rewrite it, and never deploy a configuration for a provider that is not selected.",
};
