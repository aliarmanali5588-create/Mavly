import type { NextRequest } from "next/server";

import { resolveMarketForRequest } from "@/lib/billing/market";
import { currencyForMarket, providerForMarket } from "@/lib/billing/gateway";
import { attachPaymentProvider, createPlatformPayment, markPaymentFailed } from "@/lib/billing/store";
import { dodoConfig, createDodoCheckoutSession } from "@/lib/billing/providers/dodo";
import { createRazorpaySubscription, razorpayConfig } from "@/lib/billing/providers/razorpay";
import { BILLING_CATALOG_VERSION } from "@/lib/billing/catalog";
import { billingError, billingJson, platformBillingEnabled, recordOf, requireBillingUser, safeIdempotencyKey, safeReturnUrl } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function providerProductIdFor(prefix: string, productId: string): string | null {
  const key = `${prefix}${productId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return (process.env[key] ?? "").trim() || null;
}

function dodoProductIdFor(productId: string): string | null {
  return providerProductIdFor("MAVLY_DODO_PRODUCT_", productId);
}

function razorpayPlanIdFor(planId: string): string | null {
  return providerProductIdFor("MAVLY_RAZORPAY_PLAN_", planId);
}

export async function POST(request: NextRequest) {
  if (!platformBillingEnabled()) return billingError(503, "BILLING_DISABLED", "Platform billing is not enabled on this deployment.");
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const body = recordOf(await request.json().catch(() => null));
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const idempotencyKey = safeIdempotencyKey(body.idempotencyKey);
   if (!planId || ["starter-pack", "growth-pack", "power-pack"].includes(planId) || !idempotencyKey) return billingError(400, "INVALID_REQUEST", "A subscription plan and idempotencyKey are required.");
  const market = await resolveMarketForRequest(auth.supabase, request.headers);
   if (!market.market || market.conflict) return billingError(409, market.reason === "unsupported_country" ? "UNSUPPORTED_COUNTRY" : market.conflict ? "MARKET_CONFLICT" : "MARKET_UNRESOLVED", "We could not safely resolve your billing market.");
  const provider = providerForMarket(market.market);
  const currency = currencyForMarket(market.market);
    const created = await createPlatformPayment({ userId: auth.user.id, productId: planId, market: market.market, interval: "monthly", idempotencyKey, provider, currency, catalogVersion: BILLING_CATALOG_VERSION });
  if (!created.ok) return billingError(503, (created as { ok: false; code?: string }).code ?? "BILLING_UNAVAILABLE", (created as { ok: false; error: string }).error);
  const payment = recordOf(created.data.payment);
  const paymentId = typeof payment.id === "string" ? payment.id : null;
  if (!paymentId) return billingError(503, "BILLING_UNAVAILABLE", "The pending subscription payment could not be created.");

  if (created.data.status === "existing") {
    const paymentStatus = typeof payment.status === "string" ? payment.status : "pending";
    if (["paid", "refunded", "partially_refunded", "disputed"].includes(paymentStatus)) {
      return billingError(409, "PAYMENT_ALREADY_SETTLED", "This subscription checkout has already been settled.");
    }
    if (provider === "razorpay" && typeof payment.provider_subscription_id === "string") {
      const config = razorpayConfig();
      if (!config.configured) return billingError(503, "RAZORPAY_NOT_CONFIGURED", "India subscriptions are not configured on this deployment.");
      return billingJson({ ok: true, data: { paymentId, provider: "razorpay", keyId: config.keyId, subscriptionId: payment.provider_subscription_id, currency } });
    }
    if (provider === "dodo" && typeof payment.provider_session_id === "string") {
      const metadata = recordOf(payment.metadata);
      const checkoutUrl = typeof metadata.checkoutUrl === "string" ? metadata.checkoutUrl : null;
      if (checkoutUrl) return billingJson({ ok: true, data: { paymentId, provider: "dodo", sessionId: payment.provider_session_id, checkoutUrl, currency } });
    }
    return billingError(409, "CHECKOUT_ALREADY_CREATED", "This subscription checkout is already being processed. Wait for provider confirmation before retrying.");
  }
  try {
    if (provider === "razorpay") {
      const config = razorpayConfig();
       if (!config.configured) { await markPaymentFailed(paymentId, "razorpay_not_configured"); return billingError(503, "RAZORPAY_NOT_CONFIGURED", "India subscriptions are not configured on this deployment."); }
       const providerPlanId = razorpayPlanIdFor(planId) ?? (typeof created.data.providerProductId === "string" ? created.data.providerProductId : null);
       if (!providerPlanId) { await markPaymentFailed(paymentId, "razorpay_plan_not_configured"); return billingError(503, "RAZORPAY_PLAN_NOT_CONFIGURED", "This subscription has no approved Razorpay plan mapping."); }
      const subscription = await createRazorpaySubscription({ config, planId: providerPlanId, totalCount: 120, notes: { mavlyPaymentId: paymentId, planId } });
       const attached = await attachPaymentProvider({ paymentId, providerSubscriptionId: subscription.id, providerCustomerId: subscription.customer_id ?? undefined, metadata: { mavlyPaymentId: paymentId, planId } });
       if (!attached.ok) throw new Error("BILLING_PROVIDER_ATTACH_FAILED");
       return billingJson({ ok: true, data: { paymentId, provider: "razorpay", keyId: config.keyId, subscriptionId: subscription.id, status: subscription.status, currency } });
    }
      const config = dodoConfig();
      if (!config.configured) { await markPaymentFailed(paymentId, "dodo_not_configured"); return billingError(503, "DODO_NOT_CONFIGURED", "Global subscriptions are not configured on this deployment."); }
      const providerProductId = dodoProductIdFor(planId) ?? (typeof created.data.providerProductId === "string" ? created.data.providerProductId : null);
      if (!providerProductId) { await markPaymentFailed(paymentId, "dodo_product_not_configured"); return billingError(503, "DODO_PRODUCT_NOT_CONFIGURED", "This Global plan has no approved Dodo product mapping."); }
      const returnUrl = safeReturnUrl();
      if (!returnUrl) { await markPaymentFailed(paymentId, "billing_return_url_not_configured"); return billingError(503, "BILLING_RETURN_URL_NOT_CONFIGURED", "A canonical billing return URL is required for Global subscriptions."); }
       const session = await createDodoCheckoutSession({ config, productId: providerProductId, billingCurrency: currency, email: auth.user.email ?? "", name: typeof auth.user.user_metadata?.name === "string" ? auth.user.user_metadata.name : null, returnUrl, metadata: { mavlyPaymentId: paymentId, planId } });
      const attached = await attachPaymentProvider({ paymentId, providerSessionId: session.session_id, providerPaymentId: session.payment_id ?? undefined, metadata: { mavlyPaymentId: paymentId, planId, ...(session.checkout_url ? { checkoutUrl: session.checkout_url } : {}) } });
     if (!attached.ok) throw new Error("BILLING_PROVIDER_ATTACH_FAILED");
      return billingJson({ ok: true, data: { paymentId, provider: "dodo", sessionId: session.session_id, checkoutUrl: session.checkout_url, currency } });
   } catch {
     await markPaymentFailed(paymentId, "provider_checkout_failed");
    return billingError(502, "PROVIDER_CHECKOUT_FAILED", "The subscription provider rejected checkout creation.");
  }
}
