/**
 * Request validation for the payments integration. Pure: no provider call, no
 * environment read, no secret echoed in an error message.
 */

import { findPaymentIntegration } from "@/lib/integrations/contracts";

export type Validation<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: string; value?: never };

const CURRENCY = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const RECEIPT = /^[A-Za-z0-9._:-]{1,40}$/;
const PROVIDER_ORDER = /^order_[A-Za-z0-9]{6,64}$/;
const PROVIDER_PAYMENT = /^pay_[A-Za-z0-9]{6,64}$/;
const HEX_SIGNATURE = /^[a-f0-9]{64}$/i;
const NOTE_KEY = /^[A-Za-z0-9_-]{1,40}$/;

export const MIN_PAYMENT_AMOUNT_MINOR = 1;
/** Razorpay's documented order amount ceiling is ₹50,000,000, i.e. 5e9 minor units. */
export const MAX_PAYMENT_AMOUNT_MINOR = 5_000_000_000;

export interface CreateOrderInput {
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  receipt: string | null;
  notes: Record<string, string>;
}

export interface VerifyPaymentInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface PaymentCredentialsInput {
  provider: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  enabled: boolean;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeCurrency(raw: unknown): Validation<string> {
  const value = raw === undefined || raw === null ? "INR" : String(raw).trim().toUpperCase();
  if (!CURRENCY.test(value)) {
    return { ok: false, error: "Currency must be a three-letter ISO code." };
  }
  return { ok: true, value };
}

/** Razorpay amount is an integer in the currency's minor unit. */
export function validateAmountMinor(raw: unknown): Validation<number> {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return { ok: false, error: "Amount must be an integer in minor units." };
  }
  if (raw < MIN_PAYMENT_AMOUNT_MINOR || raw > MAX_PAYMENT_AMOUNT_MINOR) {
    return { ok: false, error: "Amount is outside the supported range." };
  }
  return { ok: true, value: raw };
}

export function validateIdempotencyKey(raw: unknown): Validation<string> {
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY.test(raw.trim())) {
    return {
      ok: false,
      error: "idempotencyKey must be 8-128 characters: letters, numbers, dot, colon, underscore or dash.",
    };
  }
  return { ok: true, value: raw.trim() };
}

function validateNotes(raw: unknown): Validation<Record<string, string>> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "notes must be an object of short string values." };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 10) {
    return { ok: false, error: "notes supports at most 10 entries." };
  }
  const notes: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!NOTE_KEY.test(key)) {
      return { ok: false, error: "A notes key has an unsupported name." };
    }
    if (typeof value !== "string" || value.length > 256) {
      return { ok: false, error: "A notes value must be a string under 256 characters." };
    }
    notes[key] = value;
  }
  if (JSON.stringify(notes).length > 4_000) {
    return { ok: false, error: "notes is too large." };
  }
  return { ok: true, value: notes };
}

export function validateCreateOrderInput(body: unknown): Validation<CreateOrderInput> {
  const record = recordOf(body);
  const amount = validateAmountMinor(record.amount ?? record.amountMinor);
  if (!amount.ok) return { ok: false, error: amount.error };

  const currency = normalizeCurrency(record.currency);
  if (!currency.ok) return { ok: false, error: currency.error };

  const idempotency = validateIdempotencyKey(record.idempotencyKey);
  if (!idempotency.ok) return { ok: false, error: idempotency.error };

  const notes = validateNotes(record.notes);
  if (!notes.ok) return { ok: false, error: notes.error };

  let receipt: string | null = null;
  if (record.receipt !== undefined && record.receipt !== null) {
    if (typeof record.receipt !== "string" || !RECEIPT.test(record.receipt.trim())) {
      return { ok: false, error: "receipt must be 1-40 characters: letters, numbers, dot, colon, underscore or dash." };
    }
    receipt = record.receipt.trim();
  }

  return {
    ok: true,
    value: {
      amountMinor: amount.value,
      currency: currency.value,
      idempotencyKey: idempotency.value,
      receipt,
      notes: notes.value,
    },
  };
}

export function validateVerifyPaymentInput(body: unknown): Validation<VerifyPaymentInput> {
  const record = recordOf(body);
  const orderId = typeof record.orderId === "string" ? record.orderId.trim() : "";
  const paymentId = typeof record.paymentId === "string" ? record.paymentId.trim() : "";
  const signature = typeof record.signature === "string" ? record.signature.trim() : "";

  if (!PROVIDER_ORDER.test(orderId)) {
    return { ok: false, error: "A valid Razorpay order id is required." };
  }
  if (!PROVIDER_PAYMENT.test(paymentId)) {
    return { ok: false, error: "A valid Razorpay payment id is required." };
  }
  if (!HEX_SIGNATURE.test(signature)) {
    return { ok: false, error: "A valid payment signature is required." };
  }
  return { ok: true, value: { orderId, paymentId, signature } };
}

export function validatePaymentCredentialsInput(body: unknown): Validation<PaymentCredentialsInput> {
  const record = recordOf(body);
  const provider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : "";
  const definition = findPaymentIntegration(provider);
  if (!definition) {
    return { ok: false, error: `Unsupported payment provider. Supported: ${"razorpay"}.` };
  }

  const keyId = typeof record.keyId === "string" ? record.keyId.trim() : "";
  const keySecret = typeof record.keySecret === "string" ? record.keySecret : "";
  const webhookSecret =
    typeof record.webhookSecret === "string" ? record.webhookSecret : "";

  const field = (key: string) => definition.credentialFields.find((entry) => entry.key === key)!;
  const checks: [string, string][] = [
    [keyId, "keyId"],
    [keySecret, "keySecret"],
    [webhookSecret, "webhookSecret"],
  ];
  const names = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
  for (let index = 0; index < checks.length; index += 1) {
    const [value, label] = checks[index];
    const spec = field(names[index]);
    if (!value || value.length > spec.maxLength || !new RegExp(spec.pattern).test(value)) {
      return { ok: false, error: `A valid ${label} is required.` };
    }
  }

  return {
    ok: true,
    value: {
      provider,
      keyId,
      keySecret,
      webhookSecret,
      // ⚠️ Saving is not enabling. A caller must ask explicitly, and the
      // workspace confirms separately before enabling LIVE keys.
      enabled: record.enabled === true,
    },
  };
}

export function isProviderOrderId(value: string): boolean {
  return PROVIDER_ORDER.test(value);
}

export function isProviderPaymentId(value: string): boolean {
  return PROVIDER_PAYMENT.test(value);
}
