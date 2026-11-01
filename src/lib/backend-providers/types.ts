/**
 * ═══ BACKEND PROVIDER SELECTION ═════════════════════════════════════════════
 *
 * A project has exactly ONE authoritative backend provider. This module is the
 * pure half: the vocabulary, the state machine, and the rules that decide
 * whether a switch is allowed. It performs no I/O, so every rule here is
 * testable without a database.
 *
 * ⚠️ PROVIDER SELECTION AND CONNECTION LIFECYCLE ARE SEPARATE FACTS.
 * `status` describes the connection ("is the credential valid, is the database
 * reachable?"). `active` describes authority ("is this the backend the generated
 * app uses?"). A provider can be `ready` and not `active` — that is a verified
 * alternative the user has not switched to — and the UI must never conflate the
 * two.
 *
 * ⚠️ GITHUB IS NOT A BACKEND PROVIDER. It is source control and lives in its own
 * integration. Nothing here may require or imply a GitHub connection.
 */

export const BACKEND_PROVIDERS = ["mavly_managed_neon", "external_supabase"] as const;
export type BackendProvider = (typeof BACKEND_PROVIDERS)[number];

export function isBackendProvider(value: unknown): value is BackendProvider {
  return typeof value === "string" && (BACKEND_PROVIDERS as readonly string[]).includes(value);
}

export const BACKEND_PROVIDER_LABELS: Record<BackendProvider, string> = {
  mavly_managed_neon: "Mavly managed database",
  external_supabase: "Your own Supabase",
};

/**
 * The eight UI states the brief requires, plus the two terminal-ish states the
 * existing managed-backend lifecycle already produces. `provisioning` is shared
 * vocabulary with `ManagedBackendState`, deliberately: the Database page must
 * not invent a second word for the same fact.
 */
export const BACKEND_CONNECTION_STATES = [
  "not_connected",
  "connecting",
  "provisioning",
  "ready",
  "failed",
  "suspended",
  "disconnecting",
  "reconnection_required",
] as const;
export type BackendConnectionState = (typeof BACKEND_CONNECTION_STATES)[number];

export function isBackendConnectionState(value: unknown): value is BackendConnectionState {
  return (
    typeof value === "string" &&
    (BACKEND_CONNECTION_STATES as readonly string[]).includes(value)
  );
}

export const BACKEND_STATE_LABELS: Record<BackendConnectionState, string> = {
  not_connected: "Not connected",
  connecting: "Connecting",
  provisioning: "Provisioning",
  ready: "Ready",
  failed: "Failed",
  suspended: "Suspended",
  disconnecting: "Disconnecting",
  reconnection_required: "Reconnection required",
};

/** States in which the provider can serve the generated app. */
const SERVING_STATES: ReadonlySet<BackendConnectionState> = new Set(["ready"]);

/** States in which an activation attempt is meaningful. */
const ACTIVATABLE_STATES: ReadonlySet<BackendConnectionState> = new Set([
  "ready",
  "provisioning",
]);

export function isServingState(state: BackendConnectionState): boolean {
  return SERVING_STATES.has(state);
}

export function isActivatableState(state: BackendConnectionState): boolean {
  return ACTIVATABLE_STATES.has(state);
}

/** A provider row as the owner is allowed to see it: metadata only. */
export interface BackendProviderView {
  provider: BackendProvider;
  status: BackendConnectionState;
  active: boolean;
  /** Non-secret provider metadata (project ref, region, host). */
  config: Record<string, unknown>;
  /** Whether a service-role key is stored. NEVER the key itself. */
  hasServiceRoleKey: boolean;
  lastError: string | null;
  verifiedAt: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
}

/**
 * ═══ SWITCH RULES ═══════════════════════════════════════════════════════════
 *
 * The brief requires that switching needs explicit confirmation and that two
 * providers never run at once. Both are expressed here so the API and the UI
 * cannot disagree about when a switch is legal.
 */
export type SwitchRefusal =
  | "same_provider"
  | "target_not_connected"
  | "target_not_ready"
  | "already_active"
  | "confirmation_required";

export interface SwitchDecision {
  allowed: boolean;
  refusal: SwitchRefusal | null;
  /** True when the caller must repeat the request with explicit confirmation. */
  requiresConfirmation: boolean;
  /** What the user is being asked to confirm, in plain language. */
  confirmationMessage: string | null;
}

/**
 * Decide whether `target` may become the active provider.
 *
 * `confirmed` is the user's explicit acknowledgement. It is required whenever an
 * ALREADY ACTIVE provider would be replaced, because that is the only case where
 * a working backend stops being the one the app uses.
 */
export function decideBackendSwitch(input: {
  currentActive: BackendProvider | null;
  target: BackendProvider;
  targetStatus: BackendConnectionState | null;
  confirmed: boolean;
}): SwitchDecision {
  const { currentActive, target, targetStatus, confirmed } = input;

  if (currentActive === target) {
    return {
      allowed: false,
      refusal: "already_active",
      requiresConfirmation: false,
      confirmationMessage: null,
    };
  }

  if (targetStatus === null) {
    return {
      allowed: false,
      refusal: "target_not_connected",
      requiresConfirmation: false,
      confirmationMessage: null,
    };
  }

  if (!isActivatableState(targetStatus)) {
    return {
      allowed: false,
      refusal: "target_not_ready",
      requiresConfirmation: false,
      confirmationMessage: null,
    };
  }

  /**
   * No active provider yet: this is a first choice, not a switch. Nothing is
   * being replaced, so no confirmation is needed.
   */
  if (currentActive === null) {
    return {
      allowed: true,
      refusal: null,
      requiresConfirmation: false,
      confirmationMessage: null,
    };
  }

  const message =
    `Your app currently uses ${BACKEND_PROVIDER_LABELS[currentActive]}. ` +
    `Switching to ${BACKEND_PROVIDER_LABELS[target]} changes which database your app reads and writes. ` +
    `The existing database is not deleted and can be switched back to.`;

  if (!confirmed) {
    return {
      allowed: false,
      refusal: "confirmation_required",
      requiresConfirmation: true,
      confirmationMessage: message,
    };
  }

  return {
    allowed: true,
    refusal: null,
    requiresConfirmation: false,
    confirmationMessage: message,
  };
}

/**
 * ═══ THE PAGE PROJECTION ════════════════════════════════════════════════════
 *
 * What the Database page renders. Derived from stored facts only: the provider
 * rows plus the managed-backend status the workspace already receives.
 */
export interface BackendCenterView {
  /** The provider the generated app actually uses, if any. */
  activeProvider: BackendProvider | null;
  providers: BackendProviderView[];
  /** True when no provider is authoritative yet. */
  needsChoice: boolean;
  /**
   * ⚠️ A managed backend that is `ready` in the lifecycle but has no provider
   * row is a pre-migration-39 project. It is reported as active so the page does
   * not tell an owner their working database is disconnected.
   */
  legacyManagedBackend: boolean;
}

export function buildBackendCenterView(input: {
  providers: BackendProviderView[];
  managedBackendState: string | null;
}): BackendCenterView {
  const providers = [...input.providers].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.provider.localeCompare(b.provider);
  });

  const active = providers.find((entry) => entry.active) ?? null;

  /**
   * A managed backend that reached `ready` before the provider registry existed
   * has no row here. Treating it as "no backend" would be a lie the owner would
   * notice immediately, so it is surfaced as a legacy active provider.
   */
  const legacyManagedBackend =
    active === null &&
    (input.managedBackendState === "ready" || input.managedBackendState === "provisioned");

  return {
    activeProvider: active?.provider ?? (legacyManagedBackend ? "mavly_managed_neon" : null),
    providers,
    needsChoice: active === null && !legacyManagedBackend,
    legacyManagedBackend,
  };
}
