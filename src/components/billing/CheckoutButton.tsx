"use client";

import { useState } from "react";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function stableKey(prefix: string, productId: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}:${productId}:${crypto.randomUUID()}`;
  return `${prefix}:${productId}:${Date.now()}`;
}

async function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded."));
    document.head.appendChild(script);
  });
}

export function CheckoutButton({
  productId,
  subscription = false,
  label,
  className,
}: {
  productId: string;
  subscription?: boolean;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setState("loading");
    setError(null);
    try {
      const response = await fetch(subscription ? "/api/billing/subscriptions" : "/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ [subscription ? "planId" : "productId"]: productId, idempotencyKey: stableKey(subscription ? "subscription" : "checkout", productId) }),
      });
      const body = (await response.json()) as { ok?: boolean; data?: Record<string, unknown>; error?: string };
      if (!response.ok || body.ok !== true || !body.data) throw new Error(body.error ?? "Checkout could not be created.");
      const data = body.data;
      if (data.provider === "dodo" && typeof data.checkoutUrl === "string") {
        window.location.assign(data.checkoutUrl);
        return;
      }
      if (data.provider === "razorpay" && typeof data.keyId === "string") {
        await loadRazorpay();
        if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable.");
        const options: Record<string, unknown> = {
          key: data.keyId,
          name: "Mavly",
          description: subscription ? `${productId} subscription` : `${productId} credit pack`,
          theme: { color: "#111111" },
          handler: async (result: Record<string, string>) => {
            const verify = await fetch("/api/billing/verify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(subscription ? {
                paymentId: data.paymentId,
                subscriptionId: data.subscriptionId,
                providerPaymentId: result.razorpay_payment_id,
                signature: result.razorpay_signature,
              } : {
                paymentId: data.paymentId,
                orderId: data.orderId,
                providerPaymentId: result.razorpay_payment_id,
                signature: result.razorpay_signature,
              }),
            });
            if (!verify.ok) throw new Error("Payment was not verified by Mavly.");
            window.location.reload();
          },
          ...(subscription ? { subscription_id: data.subscriptionId } : { order_id: data.orderId, amount: data.amountMinor, currency: data.currency }),
        };
        new window.Razorpay(options).open();
        setState("idle");
        return;
      }
      throw new Error("The provider returned no safe checkout action.");
    } catch (cause) {
      setState("error");
      setError(cause instanceof Error ? cause.message : "Checkout could not be started.");
    }
  }

  return <div className="space-y-1.5"><button type="button" disabled={state === "loading"} onClick={start} className={className ?? "mavly-btn-primary px-4 py-2 text-xs font-semibold disabled:opacity-50"}>{state === "loading" ? "Preparing checkout…" : label}</button>{error && <p className="text-[11px] text-destructive">{error}</p>}</div>;
}
