/**
 * ═══ STRUCTURED GENERATION EVENTS ════════════════════════════════════════════
 *
 * One JSON object per line, with an allowlisted set of fields. There is no
 * metrics vendor and no database event table: these lines are what the
 * operator's log pipeline receives, and they are the source for the runbook's
 * thresholds.
 *
 * ⚠️ NEVER LOG THE PROMPT, GENERATED CODE, A CREDENTIAL, AN EMAIL OR A PROVIDER
 * RESPONSE BODY. This module is the boundary that enforces that: only known
 * event names and scalar allowlisted fields are emitted, and every string is
 * redacted before it is serialized.
 */

import { isTraceId, isUuid, redactSensitiveText } from "./correlation";

export const GENERATION_EVENTS = [
  "generation.accepted",
  "generation.rejected",
  "generation.claimed",
  "generation.claim_failed",
  "generation.heartbeat_failed",
  "generation.checkpoint",
  "generation.retry_scheduled",
  "generation.lease_recovered",
  "generation.lease_lost",
  "generation.completed",
  "generation.failed",
  "generation.cancelled",
  "generation.dead_letter",
  "generation.worker_empty",
  "generation.worker_unavailable",
  "generation.worker_error",
  "orchestration.skipped",
  "credits.reserved",
  "credits.settled",
  "credits.released",
  "credits.refused",
  "credits.settlement_deferred",
  "credits.usage_recorded",
] as const;

export type GenerationEventName = (typeof GENERATION_EVENTS)[number];

/**
 * Verification lifecycle events. They share this module's allowlist, redaction
 * and transport, so a verification log line can never contain more than a
 * generation line can.
 */
export const VERIFICATION_EVENTS = [
  "verification.enqueued",
  "verification.enqueue_skipped",
  "verification.enqueue_failed",
  "verification.claimed",
  "verification.stage",
  "verification.runtime",
  "verification.health",
  "verification.repair",
  "verification.completed",
  "verification.cleanup",
  "verification.recovered",
  "verification.unavailable",
  "verification.lease_lost",
  "verification.error",
] as const;

export type VerificationEventName = (typeof VERIFICATION_EVENTS)[number];

/** Every field a log line may carry. Anything else is dropped. */
const ALLOWED_FIELDS = new Set([
  "traceId",
  "runId",
  "projectId",
  "workerId",
  "verificationId",
  "snapshotId",
  "provider",
  "stage",
  "status",
  "dispatchMode",
  "attempt",
  "maxAttempts",
  "errorClass",
  "reason",
  "durationMs",
  "queueLagMs",
  "retryAfterSeconds",
  "filesWritten",
  "checkpoints",
  "recovered",
  "cleaned",
  "exitCode",
  "cleanupComplete",
  "model",
  "promptTokens",
  "completionTokens",
  "costUsd",
  "costKnown",
  "runtimePort",
  "healthHttpStatus",
  "repairAttempt",
  "repairStatus",
  "credits",
]);

const NUMERIC_FIELDS = new Set([
  "attempt",
  "maxAttempts",
  "durationMs",
  "queueLagMs",
  "retryAfterSeconds",
  "filesWritten",
  "checkpoints",
  "recovered",
  "cleaned",
  "exitCode",
  "promptTokens",
  "completionTokens",
  "costUsd",
  "runtimePort",
  "healthHttpStatus",
  "repairAttempt",
  "credits",
]);

const BOOLEAN_FIELDS = new Set(["costKnown", "cleanupComplete"]);

type EmitValue = string | number | boolean | null | undefined;

function sanitize(name: string, value: EmitValue): string | number | boolean | null | undefined {
  if (value === undefined || value === null) return undefined;

  if (NUMERIC_FIELDS.has(name)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value * 1_000_000) / 1_000_000;
  }
  if (BOOLEAN_FIELDS.has(name)) {
    return typeof value === "boolean" ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  if (name === "runId") return isUuid(value) ? value : undefined;
  if (name === "verificationId" || name === "snapshotId") {
    return isUuid(value) ? value : undefined;
  }
  if (name === "provider") {
    return value === "vercel" || value === "e2b" ? value : undefined;
  }
  if (name === "traceId") return isTraceId(value) ? value : undefined;
  if (name === "projectId") {
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : undefined;
  }
  if (name === "workerId") {
    return /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : undefined;
  }
  if (
    name === "stage" ||
    name === "status" ||
    name === "dispatchMode" ||
    name === "errorClass" ||
    name === "reason" ||
    name === "repairStatus"
  ) {
    return /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : undefined;
  }
  if (name === "model") {
    return /^[A-Za-z0-9._:/-]{1,120}$/.test(value) ? value : undefined;
  }
  return redactSensitiveText(value, 200) || undefined;
}

export interface GenerationEventFields {
  traceId?: string | null;
  runId?: string | null;
  projectId?: string | null;
  workerId?: string | null;
  stage?: string | null;
  status?: string | null;
  dispatchMode?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  errorClass?: string | null;
  reason?: string | null;
  durationMs?: number | null;
  queueLagMs?: number | null;
  retryAfterSeconds?: number | null;
  filesWritten?: number | null;
  checkpoints?: number | null;
  recovered?: number | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  costKnown?: boolean | null;
  /** Whole credits for a reservation/settlement/release event. */
  credits?: number | null;
}

/**
 * Emit one structured line. Emitting NEVER throws: a logging failure must not
 * fail a generation. Unknown/oversized fields are dropped, not truncated into
 * something misleading.
 */
export function emitGenerationEvent(
  event: GenerationEventName,
  fields: GenerationEventFields = {},
): void {
  if (!(GENERATION_EVENTS as readonly string[]).includes(event)) return;

  const line = serializeEvent(event, fields);
  try {
    if (event === "generation.failed" || event === "generation.dead_letter" || event === "generation.worker_error") {
      console.error(`[generation] ${line}`);
    } else if (event === "generation.retry_scheduled" || event === "generation.lease_lost" || event === "generation.heartbeat_failed") {
      console.warn(`[generation] ${line}`);
    } else {
      console.info(`[generation] ${line}`);
    }
  } catch {
    // A console transport failure is not a generation failure.
  }
}

function serializeEvent(
  event: string,
  fields: object,
): string {
  const body: Record<string, string | number | boolean> = {
    event,
    at: new Date().toISOString(),
  };

  for (const [name, raw] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(name)) continue;
    const value = sanitize(name, raw as EmitValue);
    if (value !== undefined) body[name] = value;
  }

  return JSON.stringify(body);
}

export interface VerificationEventFields {
  traceId?: string | null;
  runId?: string | null;
  projectId?: string | null;
  workerId?: string | null;
  verificationId?: string | null;
  snapshotId?: string | null;
  provider?: string | null;
  stage?: string | null;
  status?: string | null;
  attempt?: number | null;
  maxAttempts?: number | null;
  errorClass?: string | null;
  reason?: string | null;
  durationMs?: number | null;
  recovered?: number | null;
  cleaned?: number | null;
  exitCode?: number | null;
  cleanupComplete?: boolean | null;
  runtimePort?: number | null;
  healthHttpStatus?: number | null;
  repairAttempt?: number | null;
  repairStatus?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  costKnown?: boolean | null;
}

/** Emit one verification lifecycle line under the same allowlist. */
export function emitVerificationEvent(
  event: VerificationEventName,
  fields: VerificationEventFields = {},
): void {
  if (!(VERIFICATION_EVENTS as readonly string[]).includes(event)) return;

  const line = serializeEvent(event, fields);
  try {
    if (event === "verification.error" || event === "verification.enqueue_failed") {
      console.error(`[verification] ${line}`);
    } else if (
      event === "verification.lease_lost" ||
      event === "verification.unavailable" ||
      (event === "verification.cleanup" && fields.status === "failed")
    ) {
      console.warn(`[verification] ${line}`);
    } else {
      console.info(`[verification] ${line}`);
    }
  } catch {
    // A console transport failure is not a verification failure.
  }
}
