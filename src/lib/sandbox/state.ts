/**
 * ═══ VERIFICATION STATE ═════════════════════════════════════════════════════
 *
 * One vocabulary shared by the database, the worker tick, the status API and
 * the events channel. The public status is deliberately smaller than the
 * internal stage: a user sees `pending` / `running` / a terminal outcome,
 * while the operator can see whether a run is installing or building.
 *
 * ⚠️ `passed` MEANS THE PRODUCTION BUILD EXITED 0. It does not mean the app
 * was deployed, reached the network, or was exercised in a browser.
 */

/** Statuses persisted in `project_verifications.status`. */
export type VerificationStage =
  | "queued"
  | "preparing"
  | "installing"
  | "building"
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
  | "sandbox_create_failed"
  | "sandbox_not_found"
  | "upload_failed"
  | "timeout"
  | "cancelled"
  | "configuration_error"
  | "provider_error"
  | "cleanup_failed"
  | "internal_error";

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
  if (stage === "preparing" || stage === "installing" || stage === "building") {
    return "running";
  }
  return stage;
}

/** The public result. Provider ids are opaque and namespaced by provider. */
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
  };
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/**
 * Every value is a hard bound. The session outlives a single worker tick
 * because the build runs detached, but it never outlives the database deadline
 * that decides when a verification is abandoned. It must cover install
 * (5 min) + build (8 min) plus create and upload, while staying inside the
 * 20-minute verification deadline.
 */
export const VERIFICATION_SESSION_TIMEOUT_MS = 18 * 60 * 1000;
export const VERIFICATION_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const VERIFICATION_BUILD_TIMEOUT_MS = 8 * 60 * 1000;
export const VERIFICATION_CLEANUP_TIMEOUT_MS = 30 * 1000;

/** How long one worker tick may hold a verification lease. */
export const VERIFICATION_LEASE_SECONDS = 120;
/** Grace before an expired lease is recovered by another tick. */
export const VERIFICATION_LEASE_GRACE_SECONDS = 30;
/** Total time from claim to terminal, including every retry. */
export const VERIFICATION_DEADLINE_MS = 20 * 60 * 1000;
export const VERIFICATION_MAX_ATTEMPTS = 2;

/** Caps enforced by the admission RPC, not just in application code. */
export const MAX_ACTIVE_PER_PROJECT = 1;
export const MAX_ACTIVE_PER_USER = 2;
export const MAX_ACTIVE_GLOBAL = 8;

// ── Diagnostics ─────────────────────────────────────────────────────────────

export const MAX_DIAGNOSTIC_LINES = 80;
export const MAX_DIAGNOSTIC_LINE_CHARS = 400;
export const MAX_DIAGNOSTIC_CHARS = 6_000;
