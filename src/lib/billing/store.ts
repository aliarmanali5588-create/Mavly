import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseBillingClient } from "@/lib/supabase/worker";

export interface BillingPaymentRow {
  id: string;
  user_id: string;
  provider: "razorpay" | "dodo";
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_session_id: string | null;
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  product_type: "subscription" | "credit_pack";
  product_id: string;
  amount_minor: number;
  currency: "INR";
  market: "india" | "global";
  catalog_version: string;
  status: string;
}

export async function createPlatformPayment(input: {
  userId: string;
  productId: string;
  market: string;
  interval: string;
  idempotencyKey: string;
  provider: string;
  currency: string;
  catalogVersion: string | null;
}): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: string }> {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_create_payment", {
    p_user_id: input.userId,
    p_product_id: input.productId,
    p_market: input.market,
    p_interval: input.interval,
    p_idempotency_key: input.idempotencyKey,
    p_provider: input.provider,
    p_currency: input.currency,
    p_catalog_version: input.catalogVersion,
  });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export async function attachPaymentProvider(input: {
  paymentId: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerSessionId?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  metadata?: Record<string, string>;
}): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: string }> {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_attach_payment_provider", {
    p_payment_id: input.paymentId,
    p_provider_order_id: input.providerOrderId ?? null,
    p_provider_payment_id: input.providerPaymentId ?? null,
    p_provider_session_id: input.providerSessionId ?? null,
    p_provider_customer_id: input.providerCustomerId ?? null,
    p_provider_subscription_id: input.providerSubscriptionId ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export async function markPaymentFailed(paymentId: string, reason: string) {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false as const, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_mark_payment_failed", {
    p_payment_id: paymentId,
    p_reason: reason.slice(0, 120),
  });
  if (error) return { ok: false as const, error: error.message, code: error.code };
  return { ok: true as const, data: (data ?? {}) as Record<string, unknown> };
}

export async function beginUnusedCreditRefund(input: {
  paymentId: string;
  reason: string;
  idempotencyKey: string;
}) {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false as const, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_begin_unused_refund", {
    p_payment_id: input.paymentId,
    p_reason: input.reason.slice(0, 500),
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) return { ok: false as const, error: error.message, code: error.code };
  return { ok: true as const, data: (data ?? {}) as Record<string, unknown> };
}

export async function completeUnusedCreditRefund(input: {
  refundId: string;
  providerRefundId: string;
  providerAmountMinor: number;
  providerCurrency: string;
}) {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false as const, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_complete_unused_refund", {
    p_refund_id: input.refundId,
    p_provider_refund_id: input.providerRefundId,
    p_provider_amount_minor: input.providerAmountMinor,
    p_provider_currency: input.providerCurrency,
    p_succeeded: true,
  });
  if (error) return { ok: false as const, error: error.message, code: error.code };
  return { ok: true as const, data: (data ?? {}) as Record<string, unknown> };
}

export async function failUnusedCreditRefund(refundId: string) {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false as const, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_complete_unused_refund", {
    p_refund_id: refundId,
    p_provider_refund_id: null,
    p_provider_amount_minor: null,
    p_provider_currency: null,
    p_succeeded: false,
  });
  if (error) return { ok: false as const, error: error.message, code: error.code };
  return { ok: true as const, data: (data ?? {}) as Record<string, unknown> };
}

export async function processBillingEvent(event: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: string }> {
  const client = createSupabaseBillingClient();
  if (!client) return { ok: false, error: "Platform billing is not configured.", code: "BACKEND_NOT_CONFIGURED" };
  const { data, error } = await client.rpc("billing_process_webhook_inr", {
    p_provider: event.provider,
    p_event_id: event.eventId,
    p_event_type: event.eventType,
    p_event_hash: event.eventHash,
    p_provider_order_id: event.providerOrderId ?? null,
    p_provider_payment_id: event.providerPaymentId ?? null,
    p_provider_session_id: event.providerSessionId ?? null,
    p_provider_customer_id: event.providerCustomerId ?? null,
    p_provider_subscription_id: event.providerSubscriptionId ?? null,
    p_amount_minor: event.amountMinor ?? null,
    p_currency: event.currency ?? null,
    p_provider_status: event.providerStatus ?? null,
    p_period_start: event.periodStart ?? null,
    p_period_end: event.periodEnd ?? null,
    p_provider_invoice_id: event.providerInvoiceId ?? null,
    p_metadata: event.metadata ?? {},
  });
  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true, data: (data ?? {}) as Record<string, unknown> };
}

export async function readOwnedPayment(client: SupabaseClient, userId: string, paymentId: string) {
  return client.from("platform_payments").select("*").eq("id", paymentId).eq("user_id", userId).maybeSingle();
}

export async function readOwnedSubscription(client: SupabaseClient, userId: string, subscriptionId: string) {
  return client.from("subscriptions").select("*").eq("id", subscriptionId).eq("user_id", userId).maybeSingle();
}
