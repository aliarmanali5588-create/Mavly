/**
 * ═══ PAYMENT STATE MACHINE — PURE AND DELIBERATELY ASYMMETRIC ═══════════════
 *
 * `paid` means the provider says money was captured. It is the only state the
 * application may fulfil an order from, and it is reached only after a verified
 * signature (checkout) or a verified webhook, never from a redirect or a
 * client-supplied claim.
 *
 * ⚠️ `paid` NEVER REGRESSES. A duplicate or out-of-order `payment.failed` must
 * not turn a captured payment back into a failure.
 * ⚠️ A LATE `paid` IS ACCEPTED FROM ANY STATE. A real capture after a recorded
 * failure or expiry is evidence; refusing it would strand a customer's money.
 * Only a signed provider event can produce that transition.
 */

import type { PaymentStatus } from "./types";

const TERMINAL = new Set<PaymentStatus>(["paid"]);

const ALLOWED: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  creating: new Set(["created", "failed", "paid"]),
  created: new Set([
    "pending",
    "authorized",
    "paid",
    "failed",
    "cancelled",
    "expired",
  ]),
  pending: new Set(["authorized", "paid", "failed", "cancelled", "expired"]),
  authorized: new Set(["paid", "failed", "expired"]),
  failed: new Set(["paid", "pending", "expired"]),
  cancelled: new Set(["paid"]),
  expired: new Set(["paid"]),
  unknown: new Set(["pending", "authorized", "paid", "failed", "cancelled", "expired"]),
  paid: new Set(),
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].has(to);
}

/**
 * The provider status that may be written. Returns null when the transition is
 * not permitted, so the caller keeps the current row instead of downgrading it.
 */
export function nextStatus(
  current: PaymentStatus,
  candidate: PaymentStatus,
): PaymentStatus | null {
  return canTransition(current, candidate) ? candidate : null;
}

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.has(status);
}

/** Only a captured payment may fulfil an order. */
export function mayFulfil(status: PaymentStatus): boolean {
  return status === "paid";
}

/** Map a Razorpay payment entity status onto Mavly's vocabulary. */
export function statusFromProviderPayment(
  status: string | null | undefined,
  captured?: boolean,
): PaymentStatus {
  const value = (status ?? "").trim().toLowerCase();
  if (captured === true || value === "captured") return "paid";
  switch (value) {
    case "authorized":
      return "authorized";
    case "failed":
      return "failed";
    case "refunded":
      // The payment was captured before the refund; there is no refund state in
      // this build, so `paid` is the truthful capture fact.
      return "paid";
    case "created":
      return "pending";
    default:
      return "unknown";
  }
}

/** Map a Razorpay order status onto Mavly's vocabulary. */
export function statusFromProviderOrder(status: string | null | undefined): PaymentStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "paid":
      return "paid";
    case "attempted":
      return "pending";
    case "created":
      return "created";
    default:
      return "unknown";
  }
}
