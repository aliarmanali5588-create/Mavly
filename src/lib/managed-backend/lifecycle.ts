/**
 * ═══ MANAGED BACKEND LIFECYCLE — WHAT "READY" IS ALLOWED TO MEAN ════════════
 *
 * `provisioned` is not `ready`. A Neon project with a working `select 1` proves
 * only that a database exists. A generated application's backend is `ready`
 * only when all of the following are separately true:
 *
 *   · the database connection was verified (provisioned);
 *   · the validated data model was compiled and applied, and the resulting
 *     schema was read back and matched (schema);
 *   · the data gateway has its server-only origin + RPC proof configured, which
 *     is what a generated app actually calls instead of holding credentials.
 *
 * Anything short of that stays distinguishable, and the public projection says
 * exactly which capabilities are absent. Nothing in this file can promote a
 * backend on its own: the database RPCs enforce the same rule in SQL.
 *
 * Pure: no I/O, no clock, no environment.
 */

export type ManagedBackendState =
  /** No database is needed for this project. No registry row exists. */
  | "not_required"
  /** A database is needed but the operator prerequisites are incomplete. */
  | "pending_approval"
  | "provisioning"
  /** Neon project created and the connection verified. No schema yet. */
  | "provisioned"
  | "configuring"
  /** Database + verified schema + a configured data gateway. */
  | "ready"
  | "failed"
  /** The provider may have acted; reconcile before retrying. */
  | "outcome_unknown"
  | "cleanup_pending";

export const MANAGED_BACKEND_STATES: readonly ManagedBackendState[] = [
  "not_required",
  "pending_approval",
  "provisioning",
  "provisioned",
  "configuring",
  "ready",
  "failed",
  "outcome_unknown",
  "cleanup_pending",
];

/**
 * The only legal lifecycle moves. A jump straight from `provisioning` to
 * `ready` is refused here and in migration 35's transition check: schema
 * application and gateway configuration are real steps, not bookkeeping.
 */
const TRANSITIONS: Record<ManagedBackendState, readonly ManagedBackendState[]> = {
  not_required: ["pending_approval"],
  pending_approval: ["provisioning", "failed"],
  provisioning: ["provisioned", "failed", "outcome_unknown", "cleanup_pending"],
  provisioned: ["configuring", "failed", "cleanup_pending"],
  configuring: ["ready", "failed", "provisioned"],
  ready: ["configuring", "failed", "cleanup_pending"],
  failed: ["configuring", "provisioning", "cleanup_pending"],
  outcome_unknown: ["configuring", "provisioning", "failed", "cleanup_pending"],
  cleanup_pending: ["failed"],
};

export function canTransitionManagedBackend(
  from: ManagedBackendState,
  to: ManagedBackendState,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ManagedBackendFacts {
  state: ManagedBackendState;
  /** A registry row exists with a verified connection. */
  connectionVerified: boolean;
  /** Migration ledger applied AND the expected schema was read back. */
  schemaVerified: boolean;
  /** A validated data model is registered for the project. */
  modelRegistered: boolean;
  /** Mavly's data gateway origin and server-only proof are configured. */
  gatewayConfigured: boolean;
  /** The model asked for end-user accounts inside the generated app. */
  authenticationRequired: boolean;
  /** Number of data tables the model declares. */
  tableCount: number;
}

export interface ManagedBackendCapabilities {
  /** A Neon project exists and Mavly can connect to it. */
  database: boolean;
  /** Tables were created by the versioned runner and verified. */
  schema: boolean;
  /** A generated app can reach its data through Mavly's gateway. */
  dataApi: boolean;
  /** End-user registration/session endpoints are usable. */
  authentication: boolean;
  /** The generated UI may claim persistent CRUD. */
  persistentCrud: boolean;
}

/**
 * Capability projection. Every flag is derived from an independent fact, so a
 * database without a schema can never read as "CRUD works".
 */
export function managedBackendCapabilities(
  facts: ManagedBackendFacts,
): ManagedBackendCapabilities {
  const ready = facts.state === "ready";
  const dataApi = ready && facts.schemaVerified && facts.gatewayConfigured;
  return {
    database: facts.connectionVerified,
    schema: facts.schemaVerified,
    dataApi,
    authentication: dataApi && facts.authenticationRequired,
    persistentCrud: dataApi && facts.tableCount > 0,
  };
}

/** A short, owner-facing sentence per state. Never a success claim. */
export function managedBackendStateLabel(state: ManagedBackendState): string {
  switch (state) {
    case "not_required":
      return "No managed database is required for this project.";
    case "pending_approval":
      return "A managed database is required, but Mavly's Neon provisioning is not approved or configured on this deployment.";
    case "provisioning":
      return "Mavly is creating the managed database.";
    case "provisioned":
      return "The managed database exists and its connection was verified. The application schema has not been applied.";
    case "configuring":
      return "Mavly is applying the application schema and configuring the data gateway.";
    case "ready":
      return "The managed database, its verified schema and the data gateway are configured.";
    case "failed":
      return "The managed database could not be configured. Existing resources were preserved.";
    case "outcome_unknown":
      return "Mavly could not confirm whether the database was created. It will reconcile before retrying.";
    case "cleanup_pending":
      return "The managed database is scheduled for an owner-approved cleanup. No data has been deleted.";
  }
}

/** The precise next action for an operator or owner, or null when ready. */
export function managedBackendNextAction(
  facts: ManagedBackendFacts,
): string | null {
  if (facts.state === "ready") return null;
  if (facts.state === "pending_approval") {
    return "Complete the Neon Agent Plan approval and server-side configuration, then retry generation.";
  }
  if (facts.state === "provisioned" || facts.state === "configuring") {
    return "Retry the generation to finish schema application and data gateway configuration.";
  }
  if (facts.state === "outcome_unknown") {
    return "Reconcile the Neon project by its Mavly-derived name before retrying; no duplicate create will be issued.";
  }
  if (facts.state === "failed") {
    return "Review the recorded failure step, fix the cause, then retry generation. Existing database resources are kept.";
  }
  if (facts.state === "cleanup_pending") {
    return "An operator must confirm the cleanup before any Neon resource is deleted.";
  }
  return "Retry the generation.";
}

/** The database status values migration 35 accepts. */
export const PERSISTED_MANAGED_BACKEND_STATES: readonly ManagedBackendState[] = [
  "provisioning",
  "provisioned",
  "configuring",
  "ready",
  "failed",
  "outcome_unknown",
  "cleanup_pending",
];

export function isPersistedManagedBackendState(
  value: unknown,
): value is ManagedBackendState {
  return (
    typeof value === "string" &&
    (PERSISTED_MANAGED_BACKEND_STATES as readonly string[]).includes(value)
  );
}
