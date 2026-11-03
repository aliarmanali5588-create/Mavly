import { createHash } from "node:crypto";

export interface NormalizedBillingEvent {
  provider: "razorpay" | "dodo";
  eventId: string;
  eventType: string;
  eventHash: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerSessionId?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  amountMinor?: number;
  currency?: string;
  providerStatus?: string;
  periodStart?: string;
  periodEnd?: string;
  providerInvoiceId?: string;
  metadata?: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function nested(value: unknown, ...keys: string[]): JsonRecord {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return record(current);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function isoFromUnix(value: unknown): string | undefined {
  const seconds = numberValue(value);
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

export function normalizeRazorpayEvent(rawBody: string, eventId: string): NormalizedBillingEvent | null {
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return null; }
  const root = record(payload);
  const eventType = stringValue(root.event) ?? "";
  if (!/^[a-z][a-z0-9_.]{1,100}$/.test(eventType)) return null;
  const payment = nested(root, "payload", "payment", "entity");
  const order = nested(root, "payload", "order", "entity");
  const subscription = nested(root, "payload", "subscription", "entity");
  const refund = nested(root, "payload", "refund", "entity");
  const source = Object.keys(payment).length ? payment : Object.keys(refund).length ? refund : order;
  const amount = numberValue(source.amount);
  const providerPaymentId = stringValue(payment.id) ?? stringValue(refund.payment_id);
  const providerSubscriptionId = stringValue(subscription.id) ?? stringValue(payment.subscription_id);
  const eventStatus = eventType.includes("refund") ? stringValue(refund.status) : stringValue(payment.status) ?? stringValue(subscription.status) ?? (eventType.includes("captured") || eventType.includes("paid") ? "captured" : undefined);
  return {
    provider: "razorpay",
    eventId,
    eventType,
    eventHash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    providerOrderId: stringValue(payment.order_id) ?? stringValue(order.id),
    providerPaymentId,
    providerCustomerId: stringValue(payment.customer_id) ?? stringValue(subscription.customer_id),
    providerSubscriptionId,
    amountMinor: amount,
    currency: stringValue(source.currency),
    providerStatus: eventStatus,
    periodStart: isoFromUnix(subscription.current_start),
    periodEnd: isoFromUnix(subscription.current_end),
    providerInvoiceId: stringValue(payment.invoice_id),
  };
}

export function normalizeDodoEvent(rawBody: string, eventId: string): NormalizedBillingEvent | null {
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return null; }
  const root = record(payload);
  const eventType = stringValue(root.type) ?? stringValue(root.event_type) ?? "";
  if (!/^[a-z][a-z0-9_.]{1,100}$/.test(eventType)) return null;
  const data = record(root.data ?? root.payload);
  const metadata = record(data.metadata ?? root.metadata);
  const metadataStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) if (typeof value === "string" && key.length <= 60 && value.length <= 200) metadataStrings[key] = value;
  const amount = numberValue(data.total_amount ?? data.amount ?? data.amount_minor);
  const status = stringValue(data.status) ?? (eventType.split(".")[1] ?? undefined);
  return {
    provider: "dodo",
    eventId,
    eventType,
    eventHash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    providerOrderId: stringValue(data.order_id) ?? stringValue(data.payment_link_id),
    providerPaymentId: stringValue(data.payment_id),
    providerSessionId: stringValue(data.checkout_session_id) ?? stringValue(data.session_id),
    providerCustomerId: stringValue(nested(data, "customer", "customer_id")) ?? stringValue(data.customer_id),
    providerSubscriptionId: stringValue(data.subscription_id),
    amountMinor: amount,
    currency: stringValue(data.currency),
    providerStatus: status,
    periodStart: stringValue(data.previous_billing_date) ?? stringValue(data.current_period_start),
    periodEnd: stringValue(data.next_billing_date) ?? stringValue(data.current_period_end),
    providerInvoiceId: stringValue(data.invoice_id),
    metadata: metadataStrings,
  };
}
