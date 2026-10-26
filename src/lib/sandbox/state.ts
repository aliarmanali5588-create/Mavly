/**
 * ═══ VERIFICATION STATE ═════════════════════════════════════════════════════
 *
 * One vocabulary shared by the database, the worker tick, the status API and
 * the events channel. The public status is deliberately smaller than the
 * internal stage: a user sees `pending` / `running` / a terminal outcome,
 * while the operator can see whether a run is installing, building, starting
 * the runtime or checking its health.
 *
 * ⚠️ `passed` MEANS THREE SEPARATE THINGS SUCCEEDED, IN ORDER:
 *
 *   1. the production build exited 0 inside the microVM;
 *   2. `next start` was launched under the validated runtime plan;
 *   3. a sandbox-local HTTP request to 127.0.0.1 returned a 2xx/3xx status.
 *
 * It does NOT mean the application is correct, that a browser rendered it,
 * that a preview is reachable, or that anything was deployed. A build that
 * passes and a runtime that fails is `failed`, never `passed`.
 */

/** Statuses persisted in `project_verifications.status`. */
export type VerificationStage =
  | "queued"
  | "preparing"
  | "installing"
  | "building"
  | "runtime_starting"
  | "health_checking"
  | "repairing"
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unsupported_runtime"
  | "configuration_error"
  | "infrastructure_error";

/** The status shown to a user. */
export type VerificationStatus =
  | "not_started"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unsupported_runtime"
  | "configuration_error"
  | "infrastructure_error";

export type VerificationProvider = "vercel" | "e2b";

/**
 * A bounded, allowlisted reason. Free-form provider or command output never
 * becomes the error class; it only becomes sanitized diagnostics.
 */
export type VerificationErrorClass =
  | "unsupported_runtime"
  | "invalid_manifest"
  | "invalid_lockfile"
  | "snapshot_mismatch"
  | "validation_failed"
  | "install_failed"
  | "dependency_resolution_failed"
  | "build_failed"
  | "runtime_start_failed"
  | "runtime_port_unavailable"
  | "runtime_exited"
  | "health_check_failed"
  | "repair_failed"
  | "repair_unavailable"
  | "sandbox_create_failed"
  | "sandbox_not_found"
  | "upload_failed"
  | "timeout"
  | "cancelled"
  | "configuration_error"
  | "provider_error"
  | "cleanup_failed"
  | "internal_error";

/**
 * The only failures a bounded AI repair may attempt. Dependency resolution,
 * install, timeouts, configuration, infrastructure and unsupported runtimes
 * are deliberately absent: they are environmental or policy problems, and
 * asking a model to edit source would not fix them truthfully.
 */
export const REPAIRABLE_ERROR_CLASSES: readonly VerificationErrorClass[] = [
  "build_failed",
  "runtime_start_failed",
  "health_check_failed",
];

export function isRepairableErrorClass(
  errorClass: VerificationErrorClass | null | undefined,
): boolean {
  return !!errorClass && REPAIRABLE_ERROR_CLASSES.includes(errorClass);
}

export const TERMINAL_STAGES: readonly VerificationStage[] = [
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "unsupported_runtime",
  "configuration_error",
  "infrastructure_error",
];

export function isTerminalStage(stage: VerificationStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function publicVerificationStatus(stage: VerificationStage): VerificationStatus {
  if (stage === "queued") return "pending";
  if (
    stage === "preparing" ||
    stage === "installing" ||
    stage === "building" ||
    stage === "runtime_starting" ||
    stage === "health_checking" ||
    stage === "repairing"
  ) {
    return "running";
  }
  return stage;
}

/** The status persisted by the repair lifecycle. */
export type VerificationRepairStatus =
  | "none"
  | "requested"
  | "applied"
  | "failed"
  | "rejected"
  | "ineligible";

/**
 * ⚠️ PREVIEW IS UNAVAILABLE ON PURPOSE. The provider can mint a public,
 * unauthenticated URL for a sandbox port, and Mavly has no authenticated proxy
 * in front of it. Returning that URL would publish generated code to anyone
 * who learns it, so this phase returns a status contract with no URL at all.
 * A future phase may add `ready` only together with a real proxy.
 */
export type VerificationPreviewStatus = "unavailable" | "disabled";

export const PREVIEW_UNAVAILABLE_REASON =
  "No authenticated preview proxy is configured for this deployment.";

export interface VerificationPreview {
  status: VerificationPreviewStatus;
  reason: string;
  /** True only when access is mediated by an authenticated proxy. Always false today. */
  authenticated: false;
}

export interface VerificationRepairSummary {
  status: VerificationRepairStatus;
  attempts: number;
  maxAttempts: number;
  /** The immutable snapshot produced by the last applied repair, if any. */
  snapshotId: string | null;
}

export function unavailablePreview(): VerificationPreview {
  return {
    status: "unavailable",
    reason: PREVIEW_UNAVAILABLE_REASON,
    authenticated: false,
  };
}

/**
 * The public result. Provider ids are opaque and namespaced by provider.
 *
 * The three runtime booleans are tri-state on purpose: `null` means the stage
 * was never reached, so a pending or build-failed verification cannot be read
 * as a runtime failure.
 */
export interface VerificationResult {
  id: string;
  projectId: string;
  runId: string;
  snapshotId: string;
  attempt: number;
  maxAttempts: number;
  stage: VerificationStage;
  status: VerificationStatus;
  provider: VerificationProvider | null;
  resourceRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  enqueuedAt: string | null;
  /** When the current stage began. Drives the per-stage timeouts. */
  stageStartedAt: string | null;
  exitCode: number | null;
  errorClass: VerificationErrorClass | null;
  summary: string | null;
  diagnostics: string[];
  diagnosticsTruncated: boolean;
  cleanupComplete: boolean;
  partial: boolean;
  correlationId: string | null;

  // ── Phase 4: build, runtime, health, preview and repair ──────────────────
  /** `true` only when the production build exited 0. `null` = not reached. */
  buildPassed: boolean | null;
  /** `true` only when a healthy HTTP response proved the runtime was serving. */
  runtimeStarted: boolean | null;
  /** `true` only when the sandbox-local request returned a 2xx/3xx status. */
  healthPassed: boolean | null;
  /** The validated profile; never a raw generated script. */
  runtimeProfile: string | null;
  /** The fixed loopback port the runtime was started on. */
  runtimePort: number | null;
  runtimeExitCode: number | null;
  healthHttpStatus: number | null;
  /** Whether a health request was actually attempted (even if it never answered). */
  healthChecked: boolean;
  /** When the worker began the runtime stage. Not proof that it served. */
  runtimeStartedAt: string | null;
  runtimeFinishedAt: string | null;
  healthCheckedAt: string | null;
  preview: VerificationPreview;
  repair: VerificationRepairSummary;
}

/** A run that is not represented yet. Never fabricated as "running". */
export function notStartedVerification(runId: string, projectId: string): VerificationResult {
  return {
    id: "",
    projectId,
    runId,
    snapshotId: "",
    attempt: 0,
    maxAttempts: 0,
    stage: "queued",
    status: "not_started",
    provider: null,
    resourceRef: null,
    startedAt: null,
    finishedAt: null,
    enqueuedAt: null,
    stageStartedAt: null,
    exitCode: null,
    errorClass: null,
    summary: null,
    diagnostics: [],
    diagnosticsTruncated: false,
    cleanupComplete: false,
    partial: false,
    correlationId: null,
    buildPassed: null,
    runtimeStarted: null,
    healthPassed: null,
    runtimeProfile: null,
    runtimePort: null,
    runtimeExitCode: null,
    healthHttpStatus: null,
    healthChecked: false,
    runtimeStartedAt: null,
    runtimeFinishedAt: null,
    healthCheckedAt: null,
    preview: unavailablePreview(),
    repair: { status: "none", attempts: 0, maxAttempts: 0, snapshotId: null },
  };
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/**
 * Every value is a hard bound. The session outlives a single worker tick
 * because the build and runtime run detached, but it never outlives the
 * database deadline that decides when a verification is abandoned. It covers
 * install (5 min) + build (8 min) + runtime start (4 min) + a health check,
 * plus create/upload, while staying inside the 26-minute deadline.
 */
export const VERIFICATION_SESSION_TIMEOUT_MS = 22 * 60 * 1000;
export const VERIFICATION_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const VERIFICATION_BUILD_TIMEOUT_MS = 8 * 60 * 1000;
export const VERIFICATION_RUNTIME_TIMEOUT_MS = 4 * 60 * 1000;
export const VERIFICATION_HEALTH_TIMEOUT_MS = 60 * 1000;
/** One sandbox-local HTTP request, not the whole readiness window. */
export const VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS = 5 * 1000;
export const VERIFICATION_CLEANUP_TIMEOUT_MS = 30 * 1000;

/** How long one worker tick may hold a verification lease. */
export const VERIFICATION_LEASE_SECONDS = 120;
/** Grace before an expired lease is recovered by another tick. */
export const VERIFICATION_LEASE_GRACE_SECONDS = 30;
/** Total time from claim to terminal, including every retry. */
export const VERIFICATION_DEADLINE_MS = 26 * 60 * 1000;
export const VERIFICATION_MAX_ATTEMPTS = 2;

// ── Bounded AI repair ──────────────────────────────────────────────────────

/**
 * One repair by default and never more than two, whatever configuration says.
 * A repair creates a new immutable snapshot and is never applied to the
 * user's project; it only lets verification try the corrected source once.
 */
export const VERIFICATION_DEFAULT_MAX_REPAIRS = 1;
export const VERIFICATION_HARD_MAX_REPAIRS = 2;
/** The database adds at most this much time per applied repair. */
export const VERIFICATION_REPAIR_DEADLINE_EXTENSION_MS = 20 * 60 * 1000;
export const REPAIR_AI_TIMEOUT_MS = 90 * 1000;
export const REPAIR_MAX_OUTPUT_TOKENS = 8_000;
/** Files the model may replace in one attempt. */
export const REPAIR_MAX_FILES = 5;
/** Files of context sent to the model. */
export const REPAIR_MAX_CONTEXT_FILES = 12;
export const REPAIR_MAX_CONTEXT_BYTES = 24_000;
/** Diagnostic characters included in the repair prompt. */
export const REPAIR_MAX_DIAGNOSTIC_CHARS = 4_000;

export function clampMaxRepairs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return VERIFICATION_DEFAULT_MAX_REPAIRS;
  }
  return Math.max(0, Math.min(VERIFICATION_HARD_MAX_REPAIRS, Math.trunc(value)));
}

/** Caps enforced by the admission RPC, not just in application code. */
export const MAX_ACTIVE_PER_PROJECT = 1;
export const MAX_ACTIVE_PER_USER = 2;
export const MAX_ACTIVE_GLOBAL = 8;

// ── Diagnostics ─────────────────────────────────────────────────────────────

export const MAX_DIAGNOSTIC_LINES = 80;
export const MAX_DIAGNOSTIC_LINE_CHARS = 400;
export const MAX_DIAGNOSTIC_CHARS = 6_000;
