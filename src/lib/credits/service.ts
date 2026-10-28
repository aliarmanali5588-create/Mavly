/**
 * ═══ CREDIT SERVICE ═════════════════════════════════════════════════════════
 *
 * The run pipeline calls these after terminal writes as recovery/observability
 * helpers. Migration 32's trigger is authoritative and applies the reservation
 * transition in the same transaction as the terminal run update. A follow-up
 * failure must not rewrite the generation outcome — but it is never silently discarded:
 *
 *   · a failed settlement emits `credits.settlement_deferred`;
 *   · the durable worker's service-role sweep retries terminal failures;
 *   · the owner's balance read retries successful settlements;
 *   · nothing is charged unless the run row proves success.
 *
 * The trigger avoids modifying migration 16's fenced RPCs. The worker and owner
 * reconciliation RPCs remain recovery paths; settlement only consumes a
 * `reserved` row, and every write is keyed by the reservation id.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitGenerationEvent } from "@/lib/observability/events";
import {
  creditsConfig,
  creditsProblemMessage,
  isProjectInCreditsCohort,
  type CreditsConfig,
} from "./config";
import {
  getCreditAccount,
  isCreditsFailure,
  maintainCreditReservations,
  reconcileOwnerCredits,
  recordAiUsageAttempts,
  releaseGenerationReservation,
  settleGenerationReservation,
  type CreditAccountSnapshot,
  type CreditReconciliation,
} from "./store";

export type CreditSettlementOutcome = "settled" | "released" | "noop" | "failed";

export interface CreditRunContext {
  runId: string;
  projectId?: string | null;
  traceId?: string | null;
  client?: SupabaseClient | null;
}

/**
 * Consume the hold of a completed run. Called only from the completion path,
 * after the fenced `finishRun("done")` succeeded.
 */
export async function settleRunCredits(context: CreditRunContext): Promise<CreditSettlementOutcome> {
  /**
   * ⚠️ NO FLAG, NO RPC. Credits are opt-in, so a deployment that never asked for
   * them cannot hold a reservation and must not call a function that migration
   * 31 may not have created. Setting the flag (even if not yet ready) enables
   * the repair path, because a hold may exist from an earlier, ready configuration.
   */
  const config = creditsConfig();
  if (
    !config.requested ||
    (context.projectId && !isProjectInCreditsCohort(context.projectId, config))
  ) {
    return "noop";
  }

  const result = await settleGenerationReservation(context.runId, context.client);

  if (isCreditsFailure(result)) {
    emitGenerationEvent("credits.settlement_deferred", {
      runId: context.runId,
      projectId: context.projectId,
      reason: result.code,
    });
    return "failed";
  }

  if (result.data.status === "settled") {
    emitGenerationEvent("credits.settled", {
      runId: context.runId,
      projectId: context.projectId,
      credits: result.data.amount,
      status: "settled",
    });
    return "settled";
  }

  return "noop";
}

/**
 * Release the hold of a terminal failed/cancelled run. The RPC refuses an
 * active run or a completed one, so this cannot produce a free generation.
 */
export async function releaseRunCredits(
  context: CreditRunContext & { reason: string },
): Promise<CreditSettlementOutcome> {
  const config = creditsConfig();
  if (
    !config.requested ||
    (context.projectId && !isProjectInCreditsCohort(context.projectId, config))
  ) {
    return "noop";
  }

  const result = await releaseGenerationReservation(
    context.runId,
    context.reason,
  );

  if (isCreditsFailure(result)) {
    emitGenerationEvent("credits.settlement_deferred", {
      runId: context.runId,
      projectId: context.projectId,
      reason: result.code,
    });
    return "failed";
  }

  if (result.data.status === "released") {
    emitGenerationEvent("credits.released", {
      runId: context.runId,
      projectId: context.projectId,
      credits: result.data.amount,
      status: "released",
    });
    return "released";
  }

  return "noop";
}

/** Record the run's per-attempt usage. Safe to repeat. */
export async function recordRunUsage(context: CreditRunContext): Promise<number> {
  const config = creditsConfig();
  if (
    !config.requested ||
    !context.projectId ||
    !isProjectInCreditsCohort(context.projectId, config)
  ) {
    return 0;
  }

  const result = await recordAiUsageAttempts(context.runId, context.client);
  if (isCreditsFailure(result)) {
    emitGenerationEvent("credits.usage_recorded", {
      runId: context.runId,
      projectId: context.projectId,
      reason: result.code,
      status: "failed",
    });
    return 0;
  }
  if (result.data > 0) {
    // `result.data` is a ROW COUNT, not a credit amount: never log it as credits.
    emitGenerationEvent("credits.usage_recorded", {
      runId: context.runId,
      projectId: context.projectId,
      status: "recorded",
    });
  }
  return result.data;
}

/** One durable-worker tick: repair holds and reconcile durable usage attempts. */
export async function maintainCreditsForWorker(
  client: SupabaseClient,
): Promise<CreditReconciliation | null> {
  // A run may hold credits even if the operator disabled the flag after
  // admission. Recovery is therefore independent of the current env flag.
  const result = await maintainCreditReservations(100, client);
  if (isCreditsFailure(result)) {
    // A missing migration is a configuration fact, not a worker crash.
    console.warn(`[credits] worker sweep skipped: ${result.code}`);
    return null;
  }
  return result.data;
}

export interface OwnerCreditSnapshot {
  enabled: boolean;
  ready: boolean;
  currency: "credits";
  balance: number | null;
  reserved: number | null;
  available: number | null;
  generationCost: number | null;
  problem: string | null;
  /** A machine-readable reason for `problem`, used to fail closed in the route. */
  errorCode: string | null;
}

/**
 * The workspace's authoritative credit view.
 *
 * ⚠️ RECONCILIATION RUNS FIRST. A process that died between "run completed" and
 * "credits settled" is repaired here. Failed/cancelled runs are released only
 * by the durable worker, because owner-written run state is not authoritative.
 */
export async function creditSnapshotForOwner(
  client?: SupabaseClient | null,
  config: CreditsConfig = creditsConfig(),
): Promise<OwnerCreditSnapshot> {
  if (!config.requested) {
    return {
      enabled: false,
      ready: false,
      currency: "credits",
      balance: null,
      reserved: null,
      available: null,
      generationCost: null,
      problem: creditsProblemMessage("disabled"),
      errorCode: null,
    };
  }

  if (!config.ready) {
    return {
      enabled: false,
      ready: false,
      currency: "credits",
      balance: null,
      reserved: null,
      available: null,
      generationCost: config.generationCost,
      problem: creditsProblemMessage(config.problems[0] ?? "disabled"),
      errorCode: null,
    };
  }

  // Best effort: a failed repair must not hide the balance that does exist.
  await reconcileOwnerCredits(client);

  const account = await getCreditAccount(client);
  if (isCreditsFailure(account)) {
    return {
      enabled: false,
      ready: true,
      currency: "credits",
      balance: null,
      reserved: null,
      available: null,
      generationCost: config.generationCost,
      problem: account.error,
      errorCode: account.code,
    };
  }

  return snapshotFromAccount(account.data, config);
}

export function snapshotFromAccount(
  account: CreditAccountSnapshot,
  config: CreditsConfig,
): OwnerCreditSnapshot {
  return {
    enabled: true,
    ready: true,
    currency: "credits",
    balance: account.balance,
    reserved: account.reserved,
    available: account.available,
    generationCost: config.generationCost,
    problem: null,
    errorCode: null,
  };
}
