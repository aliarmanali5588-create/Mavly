/**
 * Pure projection of a webhook audit row into the owner-visible event model.
 *
 * ⚠️ THE RAW BODY, ITS DIGEST AND THE RPC HASH ARE NOT PART OF THIS VIEW. The
 * owner needs to know which provider event failed and why, not a replayable
 * payload. Unknown database statuses degrade to `failed` rather than being
 * displayed as successful.
 */

import type { ProjectPaymentEvent } from "@/lib/vcaas-types";

export interface PaymentEventRow {
  provider_event_id: string;
  event_type: string;
  status: string;
  error_code: string | null;
  received_at: string;
  processed_at: string | null;
}

const STATUSES = new Set(["received", "processed", "ignored", "failed"]);

export function paymentEventMetadata(row: PaymentEventRow): ProjectPaymentEvent {
  const status = STATUSES.has(row.status)
    ? (row.status as ProjectPaymentEvent["status"])
    : "failed";
  return {
    eventId: String(row.provider_event_id ?? "").slice(0, 128),
    eventType: String(row.event_type ?? "").slice(0, 80),
    status,
    errorCode: row.error_code ? String(row.error_code).slice(0, 40) : null,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}
