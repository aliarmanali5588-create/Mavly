/**
 * ═══ THE DURABLE GENERATION STATE MACHINE ════════════════════════════════════
 *
 * One `project_runs` row is one job. Its `stage` is the state:
 *
 *   queued ──claim──▶ validating ──▶ generating ──▶ completed
 *      │                   │              │
 *      │                   ├──▶ retrying ─┤
 *      │                   │              ├──▶ retry_wait ──claim──▶ validating
 *      │                   │              │        │
 *      │                   └──────────────┴────────┴──▶ failed (terminal)
 *      ├──cancel────────────────────────────────────────▶ cancelled
 *      └──stale inline──────────────────────────────────▶ interrupted
 *
 * `retry_wait` is READY, not running: the job is accepted and durable, a future
 * `next_attempt_at` gates the next claim, and no worker owns it.
 *
 * ⚠️ THIS MODULE IS PURE. It has no Supabase, Next.js or provider import, so a
 * unit test can prove the transitions and the retry policy without a database.
 * The SQL RPCs enforce the same rules; these helpers keep the TypeScript code
 * from inventing a state the database would reject.
 */

import { redactSensitiveText } from "@/lib/observability/correlation";

export const GENERATION_STAGES = [
  "queued",
  "validating",
  "generating",
  "retrying",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type GenerationStage = (typeof GENERATION_STAGES)[number];

/** A stage a worker or the inline `after()` path may claim. */
export const READY_STAGES = ["queued", "retry_wait"] as const;

/** A stage in which a worker owns (or is about to own) execution. */
export const EXECUTION_STAGES = ["validating", "generating", "retrying"] as const;

export const TERMINAL_STAGES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export function isGenerationStage(value: unknown): value is GenerationStage {
  return typeof value === "string" && (GENERATION_STAGES as readonly string[]).includes(value);
}

export function isReadyStage(stage: GenerationStage | null | undefined): boolean {
  return !!stage && (READY_STAGES as readonly string[]).includes(stage);
}

export function isExecutionStage(stage: GenerationStage | null | undefined): boolean {
  return !!stage && (EXECUTION_STAGES as readonly string[]).includes(stage);
}

export function isTerminalStage(stage: GenerationStage | null | undefined): boolean {
  return !!stage && (TERMINAL_STAGES as readonly string[]).includes(stage);
}

/** Ready or executing: the job is accepted and has not finished. */
export function isUnfinishedStage(stage: GenerationStage | null | undefined): boolean {
  return isReadyStage(stage) || isExecutionStage(stage);
}

/**
 * The public stage vocabulary the existing UI/API contract understands.
 * `retry_wait` is a scheduled retry, so it is reported as `retrying`; the
 * `nextAttemptAt` field carries the additional truth.
 */
export type PublicGenerationStage = Exclude<GenerationStage, "retry_wait">;

export function publicStageOf(stage: GenerationStage): PublicGenerationStage {
  return stage === "retry_wait" ? "retrying" : stage;
}

/**
 * Allowed transitions. This is deliberately exhaustive rather than optimistic:
 * an unknown edge is refused, and a terminal row only leaves through the
 * explicit user-resume transition back to `queued`.
 */
const TRANSITIONS: Record<GenerationStage, readonly GenerationStage[]> = {
  queued: ["validating", "failed", "cancelled", "interrupted"],
  validating: ["generating", "retrying", "retry_wait", "failed", "cancelled"],
  generating: ["retrying", "retry_wait", "completed", "failed", "cancelled", "interrupted"],
  retrying: ["validating", "generating", "retry_wait", "completed", "failed", "cancelled", "interrupted"],
  retry_wait: ["validating", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
  interrupted: ["queued"],
};

export function canTransition(from: GenerationStage, to: GenerationStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export function canResumeStage(stage: GenerationStage): boolean {
  return stage === "failed" || stage === "interrupted";
}

// ── Failure classification ─────────────────────────────────────────────────

export type GenerationErrorClass =
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_transient"
  | "provider_auth"
  | "provider_rejected"
  /** The run's own provider-call ceiling stopped it before another paid call. */
  | "spend_limit"
  | "content_filter"
  | "generation_truncated"
  | "generation_malformed"
  | "generation_incomplete"
  | "unsafe_path"
  | "too_large"
  | "too_many_files"
  | "no_files"
  | "source_contract_invalid"
  | "persistence_failed"
  | "lease_lost"
  | "cancelled"
  | "figma_failed"
  | "internal_error"
  | "unknown";

export interface FailureClassification {
  /** True only when retrying the whole job can plausibly produce a different result. */
  retryable: boolean;
  errorClass: GenerationErrorClass;
  /** Bounded, redacted text. Safe to persist and log. */
  summary: string;
}

/**
 * ═══ WHAT AN INLINE RUN MAY RETRY WITHOUT A SCHEDULER ═══════════════════════
 *
 * The durable worker retries with backoff because it has a queue and a lease.
 * An inline `after()` run has neither: it can only re-enter the pipeline once,
 * immediately, inside the same request budget. Only classes that are expected
 * to behave differently on an immediate retry qualify:
 *
 *   · a provider timeout, because the window is now different;
 *   · a transient provider failure, because it is transient by definition;
 *   · a truncated response, *when verified completed work exists and multiple
 *     planned paths remain*, so the next attempt skips completed work and has
 *     a meaningful multi-file scope left. A lone oversized file has no narrower
 *     request to make, so the classification marks it terminal.
 *
 * Rate limiting is deliberately excluded: it needs a WAIT, and waiting inside
 * the same request spends the budget that remains. Persistence failures are
 * excluded too — the next attempt would hit the same unavailable store — and are
 * retried by the worker path or the user's manual resume instead.
 */
export const INLINE_RECOVERABLE_ERROR_CLASSES: readonly GenerationErrorClass[] = [
  "provider_timeout",
  "provider_transient",
  "generation_truncated",
];

export function isInlineRecoverable(errorClass: GenerationErrorClass): boolean {
  return INLINE_RECOVERABLE_ERROR_CLASSES.includes(errorClass);
}

export interface FailureSignals {
  /** A `AgentGenerationFailureCode` when the agent reported one. */
  code?: string | null;
  /** The most recent provider attempt's `errorCode`. */
  attemptErrorCode?: string | null;
  /** The human-facing message; it is redacted before it is stored or logged. */
  message?: string | null;
  /** A provider's explicit retry hint, when it gave one. */
  retryAfterSeconds?: number | null;
  /**
   * True only when the failed run has verified completed work and more than one
   * planned path remains. With one remaining path, a compact single-file
   * truncation would repeat the same request; absent means "no useful progress".
   */
  hasRecoverableProgress?: boolean;
}

/**
 * Whether a truncation retry can skip verified work and still have a
 * multi-file remainder to generate. A single remaining path has already
 * exhausted the agent's split/compact recovery path and is not worth blindly
 * retrying as a new worker attempt.
 */
export function hasRecoverableTruncationProgress(
  completedPaths: readonly string[],
  plannedPaths: readonly string[],
): boolean {
  const planned = new Set(plannedPaths);
  const completed = new Set(completedPaths.filter((path) => planned.has(path)));
  if (completed.size === 0) return false;

  const remaining = [...planned].filter((path) => !completed.has(path));
  return remaining.length > 1;
}

const TRANSIENT_PATTERNS =
  /(timeout|timed out|rate.?limit|too many requests|429|50[0234]|econnreset|econnrefused|etimedout|eai_again|socket hang up|network|fetch failed|temporarily unavailable|overloaded|try again|connection (?:reset|closed|refused)|deadlock|statement timeout)/i;

const PERMANENT_PATTERNS =
  /(invalid api key|incorrect api key|unauthori[sz]ed|authentication|permission denied|billing|insufficient (?:quota|funds|credits)|content (?:filter|policy)|safety|unsafe|context length|maximum context|too large|too many files|malformed|invalid json|not supported|model .* not found)/i;

const CANCELLED_PATTERNS = /(cancel(?:led|ed)? by the user|RUN_CANCELLED)/i;
const LEASE_PATTERNS = /(lease[_ ]lost|run was superseded|superseded by a newer)/i;

/**
 * Conservative by design: an unrecognised failure is NOT retried. Retrying is
 * reserved for failures the provider itself marked transient, an explicit
 * timeout/rate limit, or a persistence error that may clear.
 *
 * ⚠️ A retry is a NEW job attempt, not an exactly-once guarantee. Provider
 * calls already made are not undone, and a retried run reuses only persisted,
 * verified checkpoints.
 */
export function classifyGenerationFailure(signals: FailureSignals): FailureClassification {
  const code = (signals.code ?? "").trim();
  const attempt = (signals.attemptErrorCode ?? "").toUpperCase();
  const summary = redactSensitiveText(signals.message ?? "", 500);

  if (CANCELLED_PATTERNS.test(code) || CANCELLED_PATTERNS.test(summary)) {
    return { retryable: false, errorClass: "cancelled", summary };
  }
  if (LEASE_PATTERNS.test(code) || LEASE_PATTERNS.test(summary)) {
    return { retryable: false, errorClass: "lease_lost", summary };
  }

  switch (code) {
    case "GENERATION_TIMEOUT":
      return { retryable: true, errorClass: "provider_timeout", summary };
    case "GENERATION_PERSIST_FAILED":
      return { retryable: true, errorClass: "persistence_failed", summary };
    case "GENERATION_SPEND_LIMIT":
      /**
       * Not retryable as a new attempt: the run already spent its ceiling this
       * invocation. It stays resumable by the owner (and by a scheduled worker
       * retry, which starts a fresh ceiling against fewer remaining paths).
       */
      return { retryable: false, errorClass: "spend_limit", summary };
    case "GENERATION_CONTENT_FILTER":
      return { retryable: false, errorClass: "content_filter", summary };
    case "GENERATION_TRUNCATED":
      /**
       * ⚠️ RETRYABLE ONLY WHEN THE RETRY ASKS FOR LESS. A resumed attempt skips
       * verified completed paths and honours the manifest already persisted.
       * Retry only when there is also a multi-file remainder; with no checkpoint
       * or only one unfinished path, the same deterministic single-file
       * truncation would be sent again. Such a truncation is terminal and the
       * run stays resumable by the owner.
       */
      return {
        retryable: signals.hasRecoverableProgress === true,
        errorClass: "generation_truncated",
        summary,
      };
    case "GENERATION_MALFORMED":
      return { retryable: false, errorClass: "generation_malformed", summary };
    case "GENERATION_INCOMPLETE":
      return { retryable: false, errorClass: "generation_incomplete", summary };
    case "GENERATION_UNSAFE_PATH":
      return { retryable: false, errorClass: "unsafe_path", summary };
    case "GENERATION_TOO_LARGE":
      return { retryable: false, errorClass: "too_large", summary };
    case "GENERATION_TOO_MANY_FILES":
      return { retryable: false, errorClass: "too_many_files", summary };
    case "GENERATION_NO_FILES":
      return { retryable: false, errorClass: "no_files", summary };
    case "GENERATION_CONTRACT_INVALID":
      return { retryable: false, errorClass: "source_contract_invalid", summary };
    case "GENERATION_PROVIDER_FAILED":
      return classifyProviderAttempt(attempt, summary, signals.retryAfterSeconds);
    default:
      break;
  }

  if (attempt) {
    const fromAttempt = classifyProviderAttempt(attempt, summary, signals.retryAfterSeconds);
    if (fromAttempt.errorClass !== "unknown") return fromAttempt;
  }

  if (PERMANENT_PATTERNS.test(summary)) {
    return { retryable: false, errorClass: "provider_rejected", summary };
  }
  if (TRANSIENT_PATTERNS.test(summary)) {
    return { retryable: true, errorClass: "provider_transient", summary };
  }
  return { retryable: false, errorClass: "unknown", summary };
}

function classifyProviderAttempt(
  attempt: string,
  summary: string,
  retryAfterSeconds?: number | null,
): FailureClassification {
  switch (attempt) {
    case "RATE_LIMITED":
      return { retryable: true, errorClass: "provider_rate_limited", summary };
    case "TRANSIENT":
    case "NETWORK":
      return { retryable: true, errorClass: "provider_transient", summary };
    case "TIMEOUT":
      return { retryable: true, errorClass: "provider_timeout", summary };
    case "AUTHENTICATION":
      return { retryable: false, errorClass: "provider_auth", summary };
    case "CONTENT_FILTER":
      return { retryable: false, errorClass: "content_filter", summary };
    case "INVALID_REQUEST":
    case "OUTPUT_LIMIT":
      return { retryable: false, errorClass: "provider_rejected", summary };
    case "CONFIGURATION":
    case "EMPTY_COMPLETION":
      return { retryable: false, errorClass: "provider_rejected", summary };
    default:
      break;
  }

  if (PERMANENT_PATTERNS.test(summary)) {
    return { retryable: false, errorClass: "provider_rejected", summary };
  }
  if (TRANSIENT_PATTERNS.test(summary) || (retryAfterSeconds ?? 0) > 0) {
    return { retryable: true, errorClass: "provider_transient", summary };
  }
  return { retryable: false, errorClass: "unknown", summary };
}
