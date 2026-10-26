/**
 * ═══ REPORTED COST, NEVER ESTIMATED ══════════════════════════════════════════
 *
 * The provider reports a per-attempt cost for some calls and `null` for others.
 * `AgentUsageTotals.costUsd` treats a missing value as zero, which is a fine
 * internal accumulator and a bad accounting number.
 *
 * ⚠️ THIS MODULE IS THE ACCOUNTING BOUNDARY. A total is `known` only when the
 * run made at least one provider attempt and EVERY attempt reported a finite,
 * non-negative cost. Otherwise the total is `null` and `costKnown` is false.
 * Nothing here invents a price, applies a rate card or reads billing data.
 */

export interface AttemptCost {
  costUsd?: number | null;
}

export interface ReportedCost {
  costUsd: number | null;
  known: boolean;
}

export function reportedCostOf(attempts: readonly AttemptCost[]): ReportedCost {
  if (attempts.length === 0) return { costUsd: null, known: false };

  let total = 0;
  for (const attempt of attempts) {
    const cost = attempt?.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      return { costUsd: null, known: false };
    }
    total += cost;
  }

  return { costUsd: Math.round(total * 1_000_000) / 1_000_000, known: true };
}
