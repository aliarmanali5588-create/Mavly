/**
 * ═══ RAZORPAY SERVER ADAPTER ════════════════════════════════════════════════
 *
 * Server-only. The origin is constant and no function accepts a provider URL.
 * Credentials travel only in a Basic authorization header built in this module;
 * they are never logged, returned or embedded in a message.
 *
 * API surface used (Razorpay Orders + Payments, checked 2026-10-27):
 *   POST /v1/orders                 create an order
 *   GET  /v1/orders?count=1         credential check (side-effect free)
 *   GET  /v1/payments/{payment_id}  authoritative payment read
 *
 * Signatures:
 *   checkout: HMAC-SHA256(key_secret, `${order_id}|${payment_id}`) as hex
 *   webhook:  HMAC-SHA256(webhook_secret, exact raw body) as hex
 *
 * ⚠️ ORDER CREATION IS NOT RETRIED. Razorpay has no idempotency-key header for
 * this call, so a blind retry can create two orders. Local idempotency (an
 * `idempotencyKey` unique per integration) is what prevents a duplicate, and
 * GET-only calls are the only ones retried here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { isProviderOrderId, isProviderPaymentId } from "./validation";

export const RAZORPAY_API_ORIGIN = "https://api.razorpay.com";
export const RAZORPAY_REQUEST_TIMEOUT_MS = 15_000;

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  orderId: string | null;
  status: string;
  amount: number;
  currency: string;
  captured: boolean;
}

export type RazorpayFailureCode =
  | "credentials_invalid"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_rejected"
  | "invalid_response"
  | "invalid_input";

export interface RazorpayFailure {
  ok: false;
  code: RazorpayFailureCode;
  /** HTTP status, or 0 for a transport failure. Safe to show to an owner. */
  status: number;
  message: string;
  retryAfterSeconds?: number;
}

export type RazorpayResult<T> = { ok: true; data: T } | RazorpayFailure;

export function isRazorpayFailure<T>(
  result: RazorpayResult<T>,
): result is RazorpayFailure {
  return result.ok === false;
}

export type RazorpayKeyMode = "test" | "live";

export function razorpayKeyMode(keyId: string): RazorpayKeyMode | null {
  const match = /^rzp_(test|live)_/.exec(keyId.trim());
  return match ? (match[1] as RazorpayKeyMode) : null;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function constantTimeHexEquals(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected) || !/^[a-f0-9]{64}$/i.test(actual)) {
    return false;
  }
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function checkoutSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
): string {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}

/** Never throws; a malformed signature is simply false. */
export function verifyCheckoutSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  if (!keySecret || !isProviderOrderId(orderId) || !isProviderPaymentId(paymentId)) {
    return false;
  }
  return constantTimeHexEquals(checkoutSignature(keySecret, orderId, paymentId), signature);
}

/** Verifies the exact raw request body bytes, as Razorpay documents. */
export function verifyWebhookSignature(
  webhookSecret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!webhookSecret || typeof signature !== "string" || !signature.trim()) return false;
  return constantTimeHexEquals(hmacHex(webhookSecret, rawBody), signature.trim());
}

interface RawResponse {
  status: number;
  text: string;
  retryAfter: number | null;
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : null;
}

/**
 * One request with a hard timeout. The Basic header is the only place the secret
 * exists; `message` never includes it and is capped before it can reach a log.
 */
async function request(
  credentials: RazorpayCredentials,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  fetchImpl: typeof fetch,
): Promise<RawResponse | RazorpayFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAZORPAY_REQUEST_TIMEOUT_MS);
  try {
    const authorization = `Basic ${Buffer.from(
      `${credentials.keyId}:${credentials.keySecret}`,
      "utf8",
    ).toString("base64")}`;

    const response = await fetchImpl(`${RAZORPAY_API_ORIGIN}${path}`, {
      method: init.method,
      headers: {
        authorization,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    return {
      status: response.status,
      text: text.slice(0, 20_000),
      retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        code: "provider_timeout",
        status: 0,
        message: "Razorpay did not answer before the request timed out.",
      };
    }
    return {
      ok: false,
      code: "provider_unavailable",
      status: 0,
      message: "Could not reach Razorpay.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚠️ THE PROVIDER BODY IS NOT ECHOED. It can contain account, customer or
 * payment details; the operator gets a stable message and a status, never the
 * upstream payload (and never a secret it might have echoed).
 */
function failureFrom(raw: RawResponse): RazorpayFailure {
  if (raw.status === 401 || raw.status === 403) {
    return {
      ok: false,
      code: "credentials_invalid",
      status: raw.status,
      message: "Razorpay rejected the configured credentials.",
    };
  }
  if (raw.status === 429) {
    return {
      ok: false,
      code: "provider_rate_limited",
      status: 429,
      message: "Razorpay is rate-limiting requests. Retry later.",
      ...(raw.retryAfter ? { retryAfterSeconds: raw.retryAfter } : {}),
    };
  }
  if (raw.status >= 500) {
    return {
      ok: false,
      code: "provider_unavailable",
      status: raw.status,
      message: "Razorpay is temporarily unavailable.",
      ...(raw.retryAfter ? { retryAfterSeconds: raw.retryAfter } : {}),
    };
  }
  return {
    ok: false,
    code: "provider_rejected",
    status: raw.status,
    message: "Razorpay rejected the request.",
  };
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function invalidResponse(): RazorpayFailure {
  return {
    ok: false,
    code: "invalid_response",
    status: 0,
    message: "Razorpay returned an unexpected response.",
  };
}

export interface CreateRazorpayOrderInput {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

export async function createRazorpayOrder(
  credentials: RazorpayCredentials,
  input: CreateRazorpayOrderInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayResult<RazorpayOrder>> {
  const raw = await request(
    credentials,
    "/v1/orders",
    {
      method: "POST",
      body: {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes,
        payment_capture: 1,
      },
    },
    fetchImpl,
  );
  if ("ok" in raw) return raw;
  if (raw.status < 200 || raw.status >= 300) return failureFrom(raw);

  const body = jsonObject(raw.text);
  if (
    !body ||
    !isProviderOrderId(String(body.id ?? "")) ||
    !Number.isSafeInteger(body.amount) ||
    typeof body.currency !== "string"
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    data: {
      id: String(body.id),
      amount: Number(body.amount),
      currency: body.currency.toUpperCase(),
      receipt: typeof body.receipt === "string" ? body.receipt : null,
      status: typeof body.status === "string" ? body.status : "created",
    },
  };
}

export async function fetchRazorpayPayment(
  credentials: RazorpayCredentials,
  paymentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayResult<RazorpayPayment>> {
  if (!isProviderPaymentId(paymentId)) {
    return { ok: false, code: "invalid_input", status: 0, message: "Invalid payment id." };
  }
  const raw = await request(
    credentials,
    `/v1/payments/${encodeURIComponent(paymentId)}`,
    { method: "GET" },
    fetchImpl,
  );
  if ("ok" in raw) return raw;
  if (raw.status < 200 || raw.status >= 300) return failureFrom(raw);

  const body = jsonObject(raw.text);
  if (
    !body ||
    !isProviderPaymentId(String(body.id ?? "")) ||
    !Number.isSafeInteger(body.amount) ||
    typeof body.currency !== "string"
  ) {
    return invalidResponse();
  }
  return {
    ok: true,
    data: {
      id: String(body.id),
      orderId: typeof body.order_id === "string" ? body.order_id : null,
      status: typeof body.status === "string" ? body.status : "unknown",
      amount: Number(body.amount),
      currency: body.currency.toUpperCase(),
      captured: body.captured === true,
    },
  };
}

/**
 * A side-effect-free credential check: listing one order proves the key pair is
 * accepted without creating, capturing or refunding anything.
 */
export async function testRazorpayCredentials(
  credentials: RazorpayCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayResult<{ ok: true }>> {
  const raw = await request(
    credentials,
    "/v1/orders?count=1",
    { method: "GET" },
    fetchImpl,
  );
  if ("ok" in raw) return raw;
  if (raw.status < 200 || raw.status >= 300) return failureFrom(raw);
  return { ok: true, data: { ok: true } };
}
