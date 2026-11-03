import type { NextRequest } from "next/server";

import { resolveMarketForRequest } from "@/lib/billing/market";
import { currencyForMarket, providerForMarket } from "@/lib/billing/gateway";
import { attachPaymentProvider, createPlatformPayment, markPaymentFailed } from "@/lib/billing/store";
import { dodoConfig, createDodoCheckoutSession } from "@/lib/billing/providers/dodo";
import { createRazorpayOrder, razorpayConfig } from "@/lib/billing/providers/razorpay";
import { BILLING_CATALOG_VERSION } from "@/lib/billing/catalog";
import { emitPaymentEvent } from "@/lib/observability/payments";
import { billingError, billingJson, platformBillingEnabled, recordOf, requireBillingUser, safeIdempotencyKey, safeReturnUrl } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dodoProductIdFor(productId: string): string | null {
  const key = `MAVLY_DODO_PRODUCT_${productId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return (process.env[key] ?? "").trim() || null;
}

export async function POST(request: NextRequest) {
  if (!platformBillingEnabled()) return billingError(503, "BILLING_DISABLED", "Platform billing is not enabled on this deployment.");
  const auth = await requireBillingUser();
  if (!auth.ok) return auth.response;
  const body = recordOf(await request.json().catch(() => null));
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const idempotencyKey = safeIdempotencyKey(body.idempotencyKey);
  if (!productId || !idempotencyKey) return billingError(400, "INVALID_REQUEST", "A productId and idempotencyKey are required.");

  const market = await resolveMarketForRequest(auth.supabase, request.headers);
   if (!market.market || market.conflict) return billingError(409, market.reason === "unsupported_country" ? "UNSUPPORTED_COUNTRY" : market.conflict ? "MARKET_CONFLICT" : "MARKET_UNRESOLVED", "We could not safely resolve your billing market. Verify your billing country before checkout.");
  const provider = providerForMarket(market.market);
  const currency = currencyForMarket(market.market);
   const interval = ["starter-pack", "growth-pack", "power-pack"].includes(productId) ? "one_time" : "monthly";
   const catalogVersion = BILLING_CATALOG_VERSION;
  const created = await createPlatformPayment({ userId: auth.user.id, productId, market: market.market, interval, idempotencyKey, provider, currency, catalogVersion });
  if (!created.ok) return billingError((created as { ok: false; code?: string }).code === "IDEMPOTENCY_CONFLICT" ? 409 : 503, (created as { ok: false; code?: string }).code ?? "BILLING_UNAVAILABLE", (created as { ok: false; error: string }).error);
  const payment = recordOf(created.data.payment);
  const paymentId = typeof payment.id === "string" ? payment.id : null;
  const amountMinor = typeof payment.amount_minor === "number" ? payment.amount_minor : Number(payment.amount_minor);
  if (!paymentId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return billingError(503, "BILLING_UNAVAILABLE", "The billing payment record was not created correctly.");

  if (created.data.status === "existing") {
    const paymentStatus = typeof payment.status === "string" ? payment.status : "pending";
    if (["paid", "refunded", "partially_refunded", "disputed"].includes(paymentStatus)) {
      return billingError(409, "PAYMENT_ALREADY_SETTLED", "This checkout has already been settled.");
    }
    if (provider === "razorpay" && typeof payment.provider_order_id === "string") {
      const config = razorpayConfig();
      if (!config.configured) return billingError(503, "RAZORPAY_NOT_CONFIGURED", "India checkout is not configured on this deployment.");
      return billingJson({ ok: true, data: { paymentId, provider: "razorpay", keyId: config.keyId, orderId: payment.provider_order_id, amountMinor, currency: "INR" } });
    }
    if (provider === "dodo" && typeof payment.provider_session_id === "string") {
      const metadata = recordOf(payment.metadata);
      const checkoutUrl = typeof metadata.checkoutUrl === "string" ? metadata.checkoutUrl : null;
      if (checkoutUrl) return billingJson({ ok: true, data: { paymentId, provider: "dodo", sessionId: payment.provider_session_id, checkoutUrl, currency } });
    }
    return billingError(409, "CHECKOUT_ALREADY_CREATED", "This checkout is already being processed. Wait for provider confirmation before retrying.");
  }

  try {
    if (provider === "razorpay") {
      const config = razorpayConfig();
       if (!config.configured) { await markPaymentFailed(paymentId, "razorpay_not_configured"); return billingError(503, "RAZORPAY_NOT_CONFIGURED", "India checkout is not configured on this deployment."); }
       const order = await createRazorpayOrder({ config, amountMinor, currency: "INR", receipt: `mavly_${paymentId.replaceAll("-", "").slice(0, 32)}`, notes: { mavlyPaymentId: paymentId, productId } });
      const attached = await attachPaymentProvider({ paymentId, providerOrderId: order.id, metadata: { mavlyPaymentId: paymentId, productId } });
       if (!attached.ok) throw new Error("BILLING_PROVIDER_ATTACH_FAILED");
      emitPaymentEvent("payment.order_created", { operation: "order_create", status: "created" });
      return billingJson({ ok: true, data: { paymentId, provider: "razorpay", keyId: config.keyId, orderId: order.id, amountMinor, currency: "INR" } });
    }

    const config = dodoConfig();
      if (!config.configured) { await markPaymentFailed(paymentId, "dodo_not_configured"); return billingError(503, "DODO_NOT_CONFIGURED", "Global checkout is not configured on this deployment."); }
    const providerProductId = dodoProductIdFor(productId) ?? (typeof created.data.providerProductId === "string" ? created.data.providerProductId : null);
      if (!providerProductId) { await markPaymentFailed(paymentId, "dodo_product_not_configured"); return billingError(503, "DODO_PRODUCT_NOT_CONFIGURED", "This Global product has no approved Dodo product mapping."); }
      const returnUrl = safeReturnUrl();
      if (!returnUrl) { await markPaymentFailed(paymentId, "billing_return_url_not_configured"); return billingError(503, "BILLING_RETURN_URL_NOT_CONFIGURED", "A canonical billing return URL is required for Global checkout."); }
       const session = await createDodoCheckoutSession({ config, productId: providerProductId, billingCurrency: currency, email: auth.user.email ?? "", name: typeof auth.user.user_metadata?.name === "string" ? auth.user.user_metadata.name : null, returnUrl, metadata: { mavlyPaymentId: paymentId, productId } });
      const attached = await attachPaymentProvider({ paymentId, providerSessionId: session.session_id, providerPaymentId: session.payment_id ?? undefined, metadata: { mavlyPaymentId: paymentId, productId, ...(session.checkout_url ? { checkoutUrl: session.checkout_url } : {}) } });
     if (!attached.ok) throw new Error("BILLING_PROVIDER_ATTACH_FAILED");
    emitPaymentEvent("payment.order_created", { operation: "order_create", status: "created" });
      return billingJson({ ok: true, data: { paymentId, provider: "dodo", sessionId: session.session_id, checkoutUrl: session.checkout_url, currency } });
   } catch (error) {
     await markPaymentFailed(paymentId, "provider_checkout_failed");
    emitPaymentEvent("payment.order_failed", { operation: "order_create", status: "failed", errorClass: "provider_error" });
    return billingError(502, "PROVIDER_CHECKOUT_FAILED", error instanceof Error ? error.message.split(":")[0] : "The payment provider rejected checkout creation.");
  }
}
