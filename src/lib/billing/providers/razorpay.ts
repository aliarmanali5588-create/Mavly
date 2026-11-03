import { createHmac, timingSafeEqual } from "node:crypto";

import type { BillingPaymentStatus } from "../types";

const RAZORPAY_ORIGIN = "https://api.razorpay.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  configured: boolean;
}

export function razorpayConfig(env: Record<string, string | undefined> = process.env): RazorpayConfig {
  const keyId = (env.MAVLY_RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (env.MAVLY_RAZORPAY_KEY_SECRET ?? "").trim();
  const webhookSecret = (env.MAVLY_RAZORPAY_WEBHOOK_SECRET ?? "").trim();
  return { keyId, keySecret, webhookSecret, configured: !!keyId && !!keySecret && webhookSecret.length >= 16 };
}

function basicAuth(config: RazorpayConfig): string {
  return `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`, "utf8").toString("base64")}`;
}

async function razorpayRequest<T>(config: RazorpayConfig, path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${RAZORPAY_ORIGIN}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: basicAuth(config),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      redirect: "error",
    });
    const body = (await response.json().catch(() => null)) as T | { error?: { description?: string } } | null;
    if (!response.ok) {
      const description = body && typeof body === "object" && "error" in body ? body.error?.description : null;
      throw new Error(`RAZORPAY_${response.status}:${description ?? "provider request failed"}`);
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status?: string;
}

export async function createRazorpayOrder(input: {
  config: RazorpayConfig;
  amountMinor: number;
  currency: "INR";
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  return razorpayRequest<RazorpayOrder>(input.config, "/v1/orders", {
    method: "POST",
    body: JSON.stringify({ amount: input.amountMinor, currency: input.currency, receipt: input.receipt, notes: input.notes }),
  });
}

export interface RazorpaySubscription {
  id: string;
  status: string;
  plan_id?: string;
  current_start?: number | null;
  current_end?: number | null;
  customer_id?: string | null;
}

export async function createRazorpaySubscription(input: {
  config: RazorpayConfig;
  planId: string;
  totalCount: number;
  notes: Record<string, string>;
}): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>(input.config, "/v1/subscriptions", {
    method: "POST",
    body: JSON.stringify({ plan_id: input.planId, total_count: input.totalCount, customer_notify: true, notes: input.notes }),
  });
}

export async function cancelRazorpaySubscription(config: RazorpayConfig, subscriptionId: string, atCycleEnd: boolean): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>(config, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ cancel_at_cycle_end: atCycleEnd }),
  });
}

export interface RazorpayPayment {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  captured?: boolean;
  subscription_id?: string | null;
}

export function paymentStatus(value: string | undefined): BillingPaymentStatus {
  switch (value) {
    case "captured": return "paid";
    case "authorized": return "authorized";
    case "failed": return "failed";
    case "refunded": return "refunded";
    default: return "processing";
  }
}

export async function fetchRazorpayPayment(config: RazorpayConfig, paymentId: string): Promise<RazorpayPayment> {
  return razorpayRequest<RazorpayPayment>(config, `/v1/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
}

export async function fetchRazorpaySubscription(config: RazorpayConfig, subscriptionId: string): Promise<RazorpaySubscription> {
  return razorpayRequest<RazorpaySubscription>(config, `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET" });
}

export interface RazorpayRefund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  payment_id?: string;
}

export async function createRazorpayRefund(config: RazorpayConfig, paymentId: string, amountMinor?: number): Promise<RazorpayRefund> {
  return razorpayRequest<RazorpayRefund>(config, `/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST",
    body: JSON.stringify(amountMinor ? { amount: amountMinor } : {}),
  });
}

function safeHexEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function verifyRazorpayWebhook(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || secret.length < 16) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeHexEqual(signature.trim(), expected);
}

export function verifyRazorpayCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!orderId || !paymentId || keySecret.length < 16) return false;
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`, "utf8").digest("hex");
  return safeHexEqual(signature.trim(), expected);
}

export function verifyRazorpaySubscriptionSignature(subscriptionId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!subscriptionId || !paymentId || keySecret.length < 16) return false;
  const expected = createHmac("sha256", keySecret).update(`${paymentId}|${subscriptionId}`, "utf8").digest("hex");
  return safeHexEqual(signature.trim(), expected);
}
