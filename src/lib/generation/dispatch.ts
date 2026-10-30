/**
 * ═══ SHOULD THIS INLINE RUN BE HANDED TO THE DURABLE WORKER? ════════════════
 *
 * The inline `after()` path has one wall-clock budget and one automatic
 * continuation. A large project can exhaust it with verified checkpoints still
 * queued. Handing that run to the durable worker is the correct answer — but
 * only under conditions that keep it safe and useful, and those conditions are
 * exactly what this module decides:
 *
 *   · a worker attempt already owns the queue, so only an INLINE run may hand off;
 *   · only a RETRYABLE failure is a scheduling problem. A rejected, unsafe or
 *     content-filtered generation would fail identically on the worker;
 *   · the caller must still hold its inline claim (`claimed_at`), because the
 *     hand-off is a write to a run this invocation may no longer own;
 *   · this deployment must actually dispatch this project to the worker.
 *     ⚠️ THIS IS THE LOAD-BEARING CHECK. Cohort membership lives in the server
 *     environment, not the database, and the worker claims with
 *     `p_project_ids = cohort`. Handing off a project outside the cohort parks a
 *     live run on a queue no worker will ever read.
 *
 * Pure: no database, no environment, no clock. `run-agent.ts` supplies the facts
 * and performs the fenced write.
 */

export type HandoffRefusal =
  | "worker_attempt_owns_run"
  | "no_inline_claim"
  | "not_retryable"
  | "worker_not_configured_for_project";

export type HandoffDecision =
  | { handoff: true }
  | { handoff: false; reason: HandoffRefusal };

export interface HandoffDecisionInput {
  /** `claim` fencing token: present only when a worker attempt owns this run. */
  leaseToken: string | null;
  /** The inline claim this invocation currently holds. */
  claimedAt: string | null;
  /** Whether the failure classification can plausibly behave differently later. */
  retryable: boolean;
  /** Whether `dispatchModeForProject` says the worker owns new work here. */
  workerOwnsProject: boolean;
}

export function handoffDecision(input: HandoffDecisionInput): HandoffDecision {
  if (input.leaseToken) return { handoff: false, reason: "worker_attempt_owns_run" };
  if (!input.claimedAt) return { handoff: false, reason: "no_inline_claim" };
  if (!input.retryable) return { handoff: false, reason: "not_retryable" };
  if (!input.workerOwnsProject) {
    return { handoff: false, reason: "worker_not_configured_for_project" };
  }
  return { handoff: true };
}
