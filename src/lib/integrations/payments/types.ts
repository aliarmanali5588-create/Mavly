/**
 * Provider-neutral payment vocabulary shared by the adapter, the gateway, the
 * webhook receiver and the workspace UI. Pure — safe to import anywhere.
 */

export const PAYMENT_PROVIDERS = ["razorpay"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * `paid` is the only state that means money was captured, and it is reached only
 * from a signature-verified checkout callback or a signature-verified provider
 * event (plus an authoritative provider read for the callback path).
 */
export const PAYMENT_STATUSES = [
  "creating",
  "created",
  "pending",
  "authorized",
  "paid",
  "failed",
  "cancelled",
  "expired",
  "unknown",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRecord {
  id: string;
  integrationId: string;
  projectId: string;
  provider: PaymentProvider;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  receipt: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export type PaymentFailureCode =
  | "invalid_request"
  | "unauthorized"
  | "integration_disabled"
  | "credentials_missing"
  | "credentials_invalid"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_rejected"
  | "order_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "signature_invalid"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export interface PaymentFailure {
  ok: false;
  status: number;
  code: PaymentFailureCode;
  error: string;
  retryAfterSeconds?: number;
}

export type PaymentResult<T> = { ok: true; data: T } | PaymentFailure;

export function isPaymentFailure<T>(
  result: PaymentResult<T>,
): result is PaymentFailure {
  return result.ok === false;
}

/** The minimum a generated application needs to open Razorpay Checkout. */
export interface PaymentCheckoutSession {
  provider: "razorpay";
  /** Publishable provider key id. Never a secret. */
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  receipt: string;
  /** The recorded state. `created` on a fresh order; existing state on a replay. */
  status: PaymentStatus;
  /** True only when the stored key id is a Razorpay test key. */
  testMode: boolean;
}

export interface PaymentStatusView {
  orderId: string;
  paymentId: string | null;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  paid: boolean;
  failureCode: string | null;
}
