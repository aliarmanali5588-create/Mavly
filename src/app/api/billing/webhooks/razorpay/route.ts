import type { NextRequest } from "next/server";

import { normalizeRazorpayEvent } from "@/lib/billing/events";
import { processBillingEvent } from "@/lib/billing/store";
import { razorpayConfig, verifyRazorpayWebhook } from "@/lib/billing/providers/razorpay";
import { emitPaymentEvent } from "@/lib/observability/payments";
import { billingError, billingJson } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const config = razorpayConfig();
  const signature = request.headers.get("x-razorpay-signature");
  if (!config.configured || !verifyRazorpayWebhook(rawBody, signature, config.webhookSecret)) {
    emitPaymentEvent("payment.webhook_failed", { operation: "webhook", status: "failed", eventType: "razorpay_signature" });
    return billingError(401, "INVALID_WEBHOOK_SIGNATURE", "The webhook signature is invalid.");
  }
  const eventId = request.headers.get("x-razorpay-event-id")?.trim();
  if (!eventId) return billingError(400, "INVALID_WEBHOOK", "The Razorpay event id is missing.");
  const event = normalizeRazorpayEvent(rawBody, eventId);
  if (!event) return billingError(400, "INVALID_WEBHOOK", "The Razorpay event is malformed.");
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
