/**
 * ═══ STRUCTURED PAYMENT EVENTS ══════════════════════════════════════════════
 *
 * One JSON object per line for the payment gateway, webhook receiver and owner
 * integration actions. Same principle as the generation events: only known
 * event names and allowlisted scalar fields are serialized.
 *
 * ⚠️ NEVER LOG A CREDENTIAL, RAW WEBHOOK BODY, SIGNATURE, API KEY, SECRET VALUE,
 * AMOUNT, EMAIL OR PROVIDER PAYLOAD. The allowlist below has no place for them;
 * this module is the boundary that enforces that. Do not add free-form fields.
 */

import { isUuid } from "./correlation";

export const PAYMENT_EVENTS = [
  "payment.order_created",
  "payment.order_failed",
  "payment.verify_succeeded",
  "payment.verify_failed",
  "payment.webhook_processed",
  "payment.webhook_duplicate",
  "payment.webhook_ignored",
  "payment.webhook_failed",
  "payment.rate_limited",
  "payment.gateway_unavailable",
  "payment.integration_saved",
  "payment.integration_disabled",
  "payment.integration_test_failed",
] as const;

export type PaymentEventName = (typeof PAYMENT_EVENTS)[number];

const OPERATIONS = new Set([
  "order_create",
  "payment_verify",
  "webhook",
  "owner",
]);

const STATUSES = new Set([
  "created",
  "failed",
  "succeeded",
  "processed",
  "duplicate",
  "ignored",
  "rate_limited",
  "unavailable",
  "saved",
  "disabled",
  "test_failed",
  "paid",
  "authorized",
  "pending",
  "unknown",
]);

const EVENT_STATUSES = new Set(["processed", "ignored", "failed", "duplicate"]);

export interface PaymentEventFields {
  integrationId?: string | null;
  projectId?: string | null;
  operation?: string | null;
  status?: string | null;
  errorClass?: string | null;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
  durationMs?: number | null;
  eventType?: string | null;
  eventStatus?: string | null;
}

function boundedNumber(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.round(value * 1_000_000) / 1_000_000
    : null;
}

/** Pure serializer, exported so the allowlist/redaction contract is testable. */
export function serializePaymentEvent(
  event: PaymentEventName,
  fields: PaymentEventFields = {},
): string {
  const body: Record<string, string | number> = {
    event,
    at: new Date().toISOString(),
  };

  if (fields.integrationId && isUuid(fields.integrationId)) body.integrationId = fields.integrationId;
  if (
    typeof fields.projectId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(fields.projectId)
  ) {
    body.projectId = fields.projectId;
  }
  if (typeof fields.operation === "string" && OPERATIONS.has(fields.operation)) {
    body.operation = fields.operation;
  }
  if (typeof fields.status === "string" && STATUSES.has(fields.status)) {
    body.status = fields.status;
  }
  if (typeof fields.errorClass === "string" && /^[a-z_]{3,40}$/.test(fields.errorClass)) {
    body.errorClass = fields.errorClass;
  }
  if (typeof fields.eventType === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(fields.eventType)) {
    body.eventType = fields.eventType;
  }
  if (typeof fields.eventStatus === "string" && EVENT_STATUSES.has(fields.eventStatus)) {
    body.eventStatus = fields.eventStatus;
  }

  const httpStatus = boundedNumber(fields.httpStatus, 599);
  if (httpStatus !== null) body.httpStatus = httpStatus;
  const retryAfter = boundedNumber(fields.retryAfterSeconds, 3600);
  if (retryAfter !== null) body.retryAfterSeconds = retryAfter;
  const duration = boundedNumber(fields.durationMs, 3_600_000);
  if (duration !== null) body.durationMs = duration;

  /**
   * Every value above is either a closed-set token, a shape-validated
   * identifier or a bounded number. There is deliberately NO free-form field,
   * so a secret cannot reach the line; running a generic token redactor over
   * the whole JSON would corrupt valid project identifiers instead.
   */
  return JSON.stringify(body);
}

export function emitPaymentEvent(
  event: PaymentEventName,
  fields: PaymentEventFields = {},
): void {
  if (!(PAYMENT_EVENTS as readonly string[]).includes(event)) return;
  const line = serializePaymentEvent(event, fields);
  try {
    if (event === "payment.order_failed" || event === "payment.verify_failed" || event === "payment.webhook_failed" || event === "payment.gateway_unavailable") {
      console.error(`[payments] ${line}`);
    } else if (event === "payment.rate_limited" || event === "payment.integration_test_failed") {
      console.warn(`[payments] ${line}`);
    } else {
      console.info(`[payments] ${line}`);
    }
  } catch {
    // A log transport failure must not fail a payment operation.
  }
}
