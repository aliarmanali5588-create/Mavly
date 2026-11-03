import type { BillingPaymentStatus, BillingSubscriptionStatus } from "./types";

const PAYMENT_RANK: Record<BillingPaymentStatus, number> = {
  pending: 0,
  processing: 1,
  authorized: 2,
  paid: 3,
  failed: 1,
  cancelled: 1,
  partially_refunded: 4,
  refunded: 5,
  disputed: 4,
};

export function paymentTransitionAllowed(
  current: BillingPaymentStatus,
  next: BillingPaymentStatus,
): boolean {
  if (current === next) return true;
  if (current === "paid" && ["pending", "processing", "authorized", "failed", "cancelled"].includes(next)) return false;
  if (["refunded", "partially_refunded"].includes(current) && next === "paid") return false;
  return PAYMENT_RANK[next] >= PAYMENT_RANK[current] || ["failed", "cancelled", "disputed"].includes(next);
}

export function normalizeSubscriptionStatus(value: unknown): BillingSubscriptionStatus {
  switch (value) {
    case "active":
    case "past_due":
    case "cancelled":
    case "expired":
    case "failed":
    case "refunded":
      return value;
    default:
      return "pending";
  }
}
