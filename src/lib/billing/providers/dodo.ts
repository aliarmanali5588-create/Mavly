import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TEST_ORIGIN = "https://test.dodopayments.com";
const DEFAULT_LIVE_ORIGIN = "https://live.dodopayments.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface DodoConfig {
  apiKey: string;
  webhookKey: string;
  origin: string;
  configured: boolean;
}

export function dodoConfig(env: Record<string, string | undefined> = process.env): DodoConfig {
  const apiKey = (env.DODO_PAYMENTS_API_KEY ?? "").trim();
  const webhookKey = (env.DODO_PAYMENTS_WEBHOOK_KEY ?? "").trim();
  const mode = (env.DODO_PAYMENTS_MODE ?? "test").trim().toLowerCase();
  const configuredOrigin = (env.DODO_PAYMENTS_BASE_URL ?? "").trim();
  const origin = configuredOrigin || (mode === "live" ? DEFAULT_LIVE_ORIGIN : DEFAULT_TEST_ORIGIN);
  const validOrigin = origin === DEFAULT_TEST_ORIGIN || origin === DEFAULT_LIVE_ORIGIN;
  return { apiKey, webhookKey, origin, configured: !!apiKey && webhookKey.length >= 16 && validOrigin };
}

async function dodoRequest<T>(config: DodoConfig, path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.origin}${path}`, {
      ...init,
      signal: controller.signal,
      redirect: "error",
      headers: { Authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => null)) as T | { message?: string; code?: string } | null;
    if (!response.ok) {
      const detail = body && typeof body === "object" && "message" in body ? body.message : "provider request failed";
      throw new Error(`DODO_${response.status}:${detail}`);
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface DodoCheckoutSession {
  session_id: string;
  checkout_url: string | null;
  payment_id?: string | null;
}

export async function createDodoCheckoutSession(input: {
  config: DodoConfig;
  productId: string;
  billingCurrency?: "INR";
  email: string;
  name?: string | null;
  returnUrl: string;
  metadata: Record<string, string>;
}): Promise<DodoCheckoutSession> {
  return dodoRequest<DodoCheckoutSession>(input.config, "/checkouts", {
    method: "POST",
    body: JSON.stringify({
      product_cart: [{ product_id: input.productId, quantity: 1 }],
      ...(input.billingCurrency ? { billing_currency: input.billingCurrency } : {}),
      feature_flags: { allow_currency_selection: false },
      customer: { email: input.email, ...(input.name ? { name: input.name } : {}) },
      return_url: input.returnUrl,
      metadata: input.metadata,
    }),
  });
}

export async function cancelDodoSubscription(config: DodoConfig, subscriptionId: string, atNextBillingDate: boolean): Promise<Record<string, unknown>> {
  return dodoRequest<Record<string, unknown>>(config, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify(atNextBillingDate ? { cancel_at_next_billing_date: true } : { status: "cancelled" }),
  });
}

export async function createDodoRefund(config: DodoConfig, paymentId: string, amountMinor?: number): Promise<Record<string, unknown>> {
  return dodoRequest<Record<string, unknown>>(config, "/refunds", {
    method: "POST",
    body: JSON.stringify({ payment_id: paymentId, ...(amountMinor ? { items: [{ amount: amountMinor, tax_inclusive: true }] } : {}) }),
  });
}

export async function fetchDodoPayment(config: DodoConfig, paymentId: string): Promise<Record<string, unknown>> {
  return dodoRequest<Record<string, unknown>>(config, `/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
}

function decodeWebhookKey(value: string): Buffer | null {
  const encoded = value.startsWith("whsec_") ? value.slice(6) : value;
  try {
    const decoded = Buffer.from(encoded, "base64");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function verifyDodoWebhook(input: {
  rawBody: string;
  webhookId: string | null;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  nowSeconds?: number;
}): boolean {
  if (!input.webhookId || !input.signature || !input.timestamp) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs((input.nowSeconds ?? Math.floor(Date.now() / 1000)) - timestamp) > 300) return false;
  const key = decodeWebhookKey(input.secret);
  if (!key) return false;
  const signed = `${input.webhookId}.${input.timestamp}.${input.rawBody}`;
  const expected = createHmac("sha256", key).update(signed, "utf8").digest("base64");
  return input.signature.split(/\s+/).some((part) => {
    const value = part.startsWith("v1,") ? part.slice(3) : part;
    try {
      const left = Buffer.from(value, "base64");
      const right = Buffer.from(expected, "base64");
      return left.length === right.length && timingSafeEqual(left, right);
    } catch {
      return false;
    }
  });
}

export function dodoEventHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}
