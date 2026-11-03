import type { NextRequest } from "next/server";

import { normalizeDodoEvent } from "@/lib/billing/events";
import { processBillingEvent } from "@/lib/billing/store";
import { dodoConfig, dodoEventHash, verifyDodoWebhook } from "@/lib/billing/providers/dodo";
import { emitPaymentEvent } from "@/lib/observability/payments";
import { billingError, billingJson } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const config = dodoConfig();
  const eventId = request.headers.get("webhook-id")?.trim();
  if (!config.configured || !verifyDodoWebhook({ rawBody, webhookId: eventId, signature: request.headers.get("webhook-signature"), timestamp: request.headers.get("webhook-timestamp"), secret: config.webhookKey })) {
    emitPaymentEvent("payment.webhook_failed", { operation: "webhook", status: "failed", eventType: "dodo_signature" });
    return billingError(401, "INVALID_WEBHOOK_SIGNATURE", "The webhook signature is invalid.");
  }
  if (!eventId) return billingError(400, "INVALID_WEBHOOK", "The Dodo webhook id is missing.");
  const event = normalizeDodoEvent(rawBody, eventId);
  if (!event) return billingError(400, "INVALID_WEBHOOK", "The Dodo event is malformed.");
  event.eventHash = dodoEventHash(rawBody);
  const result = await processBillingEvent(event as unknown as Record<string, unknown>);
  if (!result.ok) {
    emitPaymentEvent("payment.webhook_failed", { operation: "webhook", status: "failed", eventType: event.eventType, errorClass: "settlement_error" });
    return billingError(503, "WEBHOOK_PROCESSING_FAILED", "The event could not be committed and will be retried.");
  }
   if (result.data.status === "reconciliation_required") {
     return billingError(503, "INR_RATE_REQUIRED", "The event needs an approved INR exchange-rate record before settlement.");
   }
   const status = result.data.status === "duplicate" ? "duplicate" : result.data.status === "ignored" ? "ignored" : "processed";
  emitPaymentEvent(status === "duplicate" ? "payment.webhook_duplicate" : status === "ignored" ? "payment.webhook_ignored" : "payment.webhook_processed", { operation: "webhook", status, eventType: event.eventType, eventStatus: status });
  return billingJson({ ok: true, data: { status } });
}
