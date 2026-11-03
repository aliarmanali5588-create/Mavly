import type { NextRequest } from "next/server";

import { requireAdmin, adminError, adminJson } from "@/lib/admin/http";
import { dodoConfig, createDodoRefund } from "@/lib/billing/providers/dodo";
import { createRazorpayRefund, razorpayConfig } from "@/lib/billing/providers/razorpay";
import {
  beginUnusedCreditRefund,
  completeUnusedCreditRefund,
  failUnusedCreditRefund,
  processBillingEvent,
} from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;
  const body = (await request.json().catch(() => null)) as { paymentId?: unknown; amountMinor?: unknown } | null;
  const paymentId = typeof body?.paymentId === "string" ? body.paymentId : "";
  if (!paymentId) return adminError(400, "INVALID_REQUEST", "paymentId is required.");
  const payment = await auth.supabase.rpc("admin_billing_payment_for_refund", { p_payment_id: paymentId });
  if (payment.error || !payment.data) return adminError(payment.error?.code === "P0002" ? 404 : 503, "REFUND_PAYMENT_UNAVAILABLE", "The payment is not available for refund.");
  const row = payment.data as Record<string, unknown>;
  const amountMinor = body?.amountMinor === undefined ? Number(row.amountMinor) : Number(body.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > Number(row.amountMinor)) return adminError(400, "INVALID_REFUND_AMOUNT", "The refund amount is invalid.");
  if (!['paid', 'partially_refunded'].includes(String(row.status))) return adminError(409, "PAYMENT_NOT_REFUNDABLE", "Only a verified paid payment can be refunded.");

  const isCreditPack = row.productType === "credit_pack";
  if (isCreditPack && amountMinor !== Number(row.amountMinor)) {
    return adminError(409, "REFUND_REQUIRES_UNUSED_ENTITLEMENT", "Purchased credit refunds are limited to the full unused entitlement.");
  }

  let refundRecord: Record<string, unknown> | null = null;
  const failPreparedRefund = async () => {
    if (isCreditPack && typeof refundRecord?.id === "string") {
      await failUnusedCreditRefund(refundRecord.id);
    }
  };
  if (isCreditPack) {
    const begun = await beginUnusedCreditRefund({
      paymentId,
      reason: "Administrator-approved unused purchased credit refund",
      idempotencyKey: `admin-refund:${paymentId}`,
    });
    if (!begun.ok) {
      const manual = /MANUAL_REVIEW|NO_LONGER_AVAILABLE|NOT_ELIGIBLE/i.test(begun.error);
      return adminError(manual ? 409 : 503, manual ? "REFUND_REQUIRES_MANUAL_REVIEW" : "REFUND_UNAVAILABLE", manual ? "The purchased credits are no longer fully unused; review this refund manually." : "The refund could not be prepared.");
    }
    const refund = begun.data.refund;
    refundRecord = refund && typeof refund === "object" && !Array.isArray(refund) ? refund as Record<string, unknown> : null;
    if (begun.data.status === "existing") {
      if (refundRecord?.status === "succeeded") return adminJson({ ok: true, data: { refundId: refundRecord.id, status: "succeeded" } });
      return adminError(409, "REFUND_PENDING_RECONCILIATION", "A refund attempt already exists and needs provider reconciliation before retrying.");
    }
  }
  try {
    let refundId = `admin-${paymentId}-${amountMinor}`;
    if (row.provider === "razorpay") {
      const config = razorpayConfig();
      if (!config.configured || typeof row.providerPaymentId !== "string") { await failPreparedRefund(); return adminError(503, "RAZORPAY_NOT_CONFIGURED", "Razorpay refund is not configured."); }
      const refund = await createRazorpayRefund(config, row.providerPaymentId, amountMinor);
      refundId = refund.id;
    } else {
      const config = dodoConfig();
      if (!config.configured || typeof row.providerPaymentId !== "string") { await failPreparedRefund(); return adminError(503, "DODO_NOT_CONFIGURED", "Dodo refund is not configured."); }
      const refund = await createDodoRefund(config, row.providerPaymentId, amountMinor);
      if (typeof refund.refund_id === "string") refundId = refund.refund_id;
    }
    if (isCreditPack) {
      const providerAmount = row.provider === "razorpay"
        ? amountMinor
        : Number((refundRecord && refundRecord.provider_amount_minor) ?? amountMinor);
      const completed = await completeUnusedCreditRefund({
        refundId: String(refundRecord?.id ?? paymentId),
        providerRefundId: refundId,
        providerAmountMinor: Number.isSafeInteger(providerAmount) ? providerAmount : amountMinor,
        providerCurrency: String(row.currency ?? "INR"),
      });
      if (!completed.ok) return adminError(503, "REFUND_SETTLEMENT_FAILED", "The provider refund was created but the credit reversal needs reconciliation.");
      return adminJson({ ok: true, data: { refundId, settlement: completed.data } });
    }
    const settled = await processBillingEvent({
      provider: row.provider,
      eventId: `admin-refund:${refundId}`,
      eventType: "refund.succeeded",
      eventHash: `admin-refund:${refundId}`,
      providerPaymentId: row.providerPaymentId,
      amountMinor,
      currency: row.currency,
      providerStatus: "succeeded",
      metadata: { source: "admin_refund" },
    });
    if (!settled.ok) return adminError(503, "REFUND_SETTLEMENT_FAILED", "The provider refund was created but the credit reversal needs reconciliation.");
    return adminJson({ ok: true, data: { refundId, settlement: settled.data } });
  } catch {
    await failPreparedRefund();
    return adminError(502, "PROVIDER_REFUND_FAILED", "The provider rejected the refund request.");
  }
}
