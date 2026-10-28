/**
 * ═══ PURE CREDIT RULES ══════════════════════════════════════════════════════
 *
 * The database is the authority. These helpers decide what the server may ask
 * it for and how a result is read, so the same rules are unit-testable without
 * a live Postgres or Supabase session.
 *
 * Nothing here performs I/O, reads the environment or invents a number.
 */

export const CREDIT_RESERVATION_STATUSES = ["reserved", "consumed", "released"] as const;
export type CreditReservationStatus = (typeof CREDIT_RESERVATION_STATUSES)[number];

export interface CreditBalance {
  balance: number;
  reserved: number;
  available: number;
}

/** A safe non-negative integer credit value; everything else is unknown. */
export function creditNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/**
 * Derive available credits. Returns null when either value is unknown or the
 * pair violates the account invariant, so the UI never displays a fabricated 0.
 */
export function creditBalance(balance: unknown, reserved: unknown): CreditBalance | null {
  const owned = creditNumber(balance);
  const held = creditNumber(reserved);
  if (owned === null || held === null || held > owned) return null;
  return { balance: owned, reserved: held, available: owned - held };
}

export interface TerminalRunFacts {
  /** The run row is finished (finished_at is set). */
  finishedAt: string | null;
  status: "init" | "done" | "error" | string;
  stage: string | null;
}

/**
 * ⚠️ ONLY A PROVEN SUCCESS CONSUMES CREDITS.
 *
 * Mirrors `settle_generation_reservation`: finished, status `done`, stage
 * `completed`. A cancellation that won the run row can never be charged.
 */
export function canSettleReservation(
  run: TerminalRunFacts,
  reservationStatus: CreditReservationStatus | null,
): boolean {
  return (
    reservationStatus === "reserved" &&
    !!run.finishedAt &&
    run.status === "done" &&
    run.stage === "completed"
  );
}

/**
 * ⚠️ ONLY A TERMINAL FAILURE RELEASES A HOLD.
 *
 * Mirrors `release_generation_reservation`: the run must be finished and not
 * successful. An active run's hold is never released, so a direct client call
 * cannot produce a free generation.
 */
export function canReleaseReservation(
  run: TerminalRunFacts,
  reservationStatus: CreditReservationStatus | null,
): boolean {
  return (
    reservationStatus === "reserved" &&
    !!run.finishedAt &&
    !(run.status === "done" && run.stage === "completed")
  );
}

/** A resumed run gets a new hold only after the previous one was released. */
export function needsFreshReservation(
  reservationStatus: CreditReservationStatus | null,
): boolean {
  return reservationStatus === null || reservationStatus === "released";
}

/**
 * Describe an insufficient-credits refusal as the two integers the caller needs.
 * The server cannot invent "0"; a missing available value stays unknown.
 */
export interface InsufficientCredits {
  available: number | null;
  required: number | null;
}

export function insufficientCreditsFrom(
  available: unknown,
  required: unknown,
): InsufficientCredits {
  return { available: creditNumber(available), required: creditNumber(required) };
}

/** A cancelled/failed run must not be charged even if it wrote partial files. */
export function shouldChargeRun(outcome: "completed" | "failed" | "cancelled"): boolean {
  return outcome === "completed";
}
