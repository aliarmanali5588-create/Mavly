import { createSupabaseBillingClient } from "@/lib/supabase/worker";
import { dodoConfig, fetchDodoPayment } from "./providers/dodo";
import { fetchRazorpayPayment, razorpayConfig } from "./providers/razorpay";

export async function runBillingReconciliationOnce(): Promise<"idle" | "succeeded" | "failed" | "unavailable"> {
  const client = createSupabaseBillingClient();
  if (!client) return "unavailable";
  const claimed = await client.rpc("claim_billing_reconciliation_job", { p_worker_id: "billing-reconciliation-worker" });
  if (claimed.error) return "unavailable";
  const job = claimed.data as Record<string, unknown> | null;
  if (!job || typeof job.id !== "string") return "idle";
  try {
    const paymentId = typeof job.payment_id === "string" ? job.payment_id : null;
    if (!paymentId) throw new Error("payment_missing");
    const { data: payment, error: paymentError } = await client.from("platform_payments").select("*").eq("id", paymentId).maybeSingle();
    if (paymentError || !payment) throw new Error("payment_missing");
    let actualAmount: number | null = null;
    let actualCurrency: string | null = null;
    let actualStatus = "unknown";
    if (payment.provider === "razorpay" && payment.provider_payment_id) {
      const config = razorpayConfig();
      if (!config.configured) throw new Error("razorpay_not_configured");
      const remote = await fetchRazorpayPayment(config, payment.provider_payment_id);
      actualAmount = remote.amount;
      actualCurrency = remote.currency;
      actualStatus = remote.status;
    } else if (payment.provider === "dodo" && payment.provider_payment_id) {
      const config = dodoConfig();
      if (!config.configured) throw new Error("dodo_not_configured");
      const remote = await fetchDodoPayment(config, payment.provider_payment_id);
      actualAmount = typeof remote.total_amount === "number" ? remote.total_amount : typeof remote.amount === "number" ? remote.amount : null;
      actualCurrency = typeof remote.currency === "string" ? remote.currency : null;
      actualStatus = typeof remote.status === "string" ? remote.status : "unknown";
    } else {
      throw new Error("provider_transaction_missing");
    }
    const converted = actualAmount !== null && actualCurrency
      ? await client.rpc("billing_inr_amount_for_provider", {
          p_currency: actualCurrency,
          p_amount_minor: actualAmount,
          p_at: payment.created_at,
        })
      : { data: { ok: false, reason: "provider_amount_missing" }, error: null };
    const conversion = converted.data as Record<string, unknown> | null;
    const actualInrPaise = conversion?.ok === true && Number.isSafeInteger(Number(conversion.amountInrPaise))
      ? Number(conversion.amountInrPaise)
      : null;
    if (actualInrPaise !== Number(payment.amount_inr_paise ?? payment.amount_minor)) {
      await client.from("billing_reconciliation").insert({
        provider: payment.provider,
        provider_transaction_id: payment.provider_payment_id,
        internal_payment_id: payment.id,
        expected_amount_minor: payment.amount_minor,
        actual_amount_minor: actualAmount,
        expected_currency: payment.currency,
        actual_currency: actualCurrency,
        expected_inr_paise: payment.amount_inr_paise ?? payment.amount_minor,
        actual_inr_paise: actualInrPaise,
        discrepancy_type: actualCurrency !== payment.currency
          ? (actualInrPaise === null ? "currency_requires_inr_rate" : "converted_amount_mismatch")
          : "amount_mismatch",
        status: "manual_review",
        details: { providerStatus: actualStatus, inrRateVersion: conversion?.rateVersion ?? null },
      });
    }
    await client.rpc("complete_billing_reconciliation_job", { p_job_id: job.id, p_status: "succeeded" });
    return "succeeded";
  } catch (error) {
    await client.rpc("complete_billing_reconciliation_job", { p_job_id: job.id, p_status: "queued", p_error: error instanceof Error ? error.message.slice(0, 200) : "reconciliation_failed" });
    return "failed";
  }
}
