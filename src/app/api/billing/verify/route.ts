import type { NextRequest } from "next/server";

import { readOwnedPayment, processBillingEvent } from "@/lib/billing/store";
import { fetchRazorpayPayment, fetchRazorpaySubscription, razorpayConfig, verifyRazorpayCheckoutSignature, verifyRazorpaySubscriptionSignature } from "@/lib/billing/providers/razorpay";
import { billingError, billingJson, recordOf, requireBillingUser } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const body = recordOf(await request.json().catch(() => null));
  const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const subscriptionId = typeof body.subscriptionId === "string" ? body.subscriptionId : "";
  const providerPaymentId = typeof body.providerPaymentId === "string" ? body.providerPaymentId : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!paymentId || !providerPaymentId || !signature || (!orderId && !subscriptionId)) return billingError(400, "INVALID_REQUEST", "Payment verification fields are required.");
  const owned = await readOwnedPayment(auth.supabase, auth.user.id, paymentId);
  if (
    owned.error ||
    !owned.data ||
    owned.data.provider !== "razorpay" ||
    (orderId && owned.data.provider_order_id !== orderId) ||
    (subscriptionId && owned.data.provider_subscription_id !== subscriptionId)
  ) return billingError(404, "PAYMENT_NOT_FOUND", "That payment could not be found.");
  const config = razorpayConfig();
  if (!config.configured || (orderId ? !verifyRazorpayCheckoutSignature(orderId, providerPaymentId, signature, config.keySecret) : !verifyRazorpaySubscriptionSignature(subscriptionId, providerPaymentId, signature, config.keySecret))) return billingError(400, "INVALID_PAYMENT_SIGNATURE", "The payment signature is invalid.");
  try {
    if (subscriptionId) {
      const subscription = await fetchRazorpaySubscription(config, subscriptionId);
      if (subscription.id !== subscriptionId || !["active", "authenticated"].includes(subscription.status)) return billingError(409, "SUBSCRIPTION_NOT_ACTIVE", "The provider has not activated this subscription.");
      const result = await processBillingEvent({ provider: "razorpay", eventId: `checkout:${paymentId}:${subscriptionId}`, eventType: "subscription.activated", eventHash: `checkout:${paymentId}:${subscriptionId}`, providerSubscriptionId: subscriptionId, providerStatus: "active", periodStart: subscription.current_start ? new Date(subscription.current_start * 1000).toISOString() : undefined, periodEnd: subscription.current_end ? new Date(subscription.current_end * 1000).toISOString() : undefined });
      if (!result.ok) return billingError(503, "SETTLEMENT_FAILED", "The subscription was verified but activation could not be committed.");
      return billingJson({ ok: true, data: { status: result.data.status, paymentId, subscriptionId } });
    }
    const payment = await fetchRazorpayPayment(config, providerPaymentId);
    if (payment.order_id !== orderId || payment.amount !== Number(owned.data.amount_minor) || payment.currency !== owned.data.currency || !payment.captured) return billingError(409, "PAYMENT_NOT_CAPTURED", "The provider has not confirmed this payment.");
    const result = await processBillingEvent({ provider: "razorpay", eventId: `checkout:${paymentId}:${providerPaymentId}`, eventType: "payment.captured", eventHash: `checkout:${paymentId}:${providerPaymentId}`, providerOrderId: orderId, providerPaymentId, amountMinor: payment.amount, currency: payment.currency, providerStatus: "captured", providerSubscriptionId: payment.subscription_id ?? undefined });
    if (!result.ok) return billingError(503, "SETTLEMENT_FAILED", "The payment was verified but settlement could not be committed.");
    return billingJson({ ok: true, data: { status: result.data.status, paymentId } });
  } catch {
    return billingError(502, "PROVIDER_UNAVAILABLE", "The payment provider could not be reached.");
  }
}
