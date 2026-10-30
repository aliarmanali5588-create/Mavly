/**
 * Execution for one durable agent run.
 *
 * ═══ THE ORDER IS THE GUARANTEE ═════════════════════════════════════════════
 *
 *   1. CLAIM      — the inline path moves `queued` to `validating`; the durable
 *                   worker claims with a fencing lease before this module runs.
 *   2. BASELINE   — the state before the first write is captured once per run.
 *   3. MANIFEST   — the validated plan is persisted so a retry can reuse it.
 *   4. BATCH      — each validated batch is written AND checkpointed in one
 *                   fenced transaction. A later failure preserves earlier work.
 *   5. COMPLETE   — only after every planned file is present and valid.
 *
 * ⚠️ TWO EXECUTION MODES, ONE STATE MACHINE.
 *
 *   · Inline (`after()`) still exists for projects outside the worker cohort.
 *     It claims with `claimed_at` and writes with the caller's session client.
 *   · The worker claims with a random `lease_token` and runs with the verified
 *     service-role client. Every write presents the token, so a worker whose
 *     lease expired cannot finish a run another worker now owns.
 *
 * ⚠️ A FAILED ATTEMPT IS NOT ALWAYS A FAILED JOB. The worker classifies the
 * failure conservatively; only a transient/timeout/rate-limit/persistence
 * failure is retried, within the durable attempt budget. Everything else is
 * terminal immediately. A retry is a new attempt, not an exactly-once
 * guarantee: provider calls already made are never undone.
 *
 * ⚠️ A TRUNCATED RESPONSE IS NEVER WRITTEN. `generateApp` validates a whole
 * batch before handing it here, and the agent discards any response with
 * `finish_reason: "length"`.
 *
 * ⚠️ NO GENERATED CODE IS EXECUTED HERE.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { chatCompletion, isAiConfigured } from "@/lib/ai/provider";
import { resolveRoleModel } from "@/lib/ai/model-roles";
import {
  GENERATION_BUDGET_MS,
  generateApp,
  isGenerationFailure,
  requiredCreatePathsFor,
  sanitizeProjectPath,
  AgentGenerationSetupError,
  type AgentGenerationInput,
  type AgentBatchCheckpoint,
  type AgentGenerationFailure,
  type AgentGenerationResult,
  type AgentManifest,
  type AgentProjectType,
  type AgentProgressEvent,
  type AgentProviderAttempt,
  type AgentUsageTotals,
} from "@/lib/ai/agent";
import {
  MAX_INLINE_RECOVERY_ATTEMPTS,
  MIN_INLINE_RECOVERY_WINDOW_MS,
  remainingRunMs,
  runBudgetFor,
  workerGenerationBudgetMs,
  type RunBudget,
} from "@/lib/ai/budget";
import {
  EMPTY_USAGE,
  addUsage,
  persistedAttempts,
  seededUsage,
} from "@/lib/ai/usage";
import { androidPackageForProject } from "@/lib/android/contract";
import {
  claimRun,
  finishRun,
  getProject,
  getRun,
  heartbeatRun,
  insertMessage,
  isStoreFailure,
  listFiles,
  listRunBatches,
  recordRunBatch,
  scheduleGenerationRetry,
  setRunManifest,
  touchProject,
  writeFiles,
  type RunFinishPatch,
  type RunRow,
} from "./store";
import {
  createSnapshot,
  diffPaths,
  diffSource,
  isSnapshotFailure,
  listSnapshots,
  type SnapshotFile,
  type SnapshotSummary,
} from "./snapshots";
import { verifyCheckpointBatches } from "./checkpoints";
import {
  beginOrchestration,
  markCodingStarted,
  POST_CODING_REVIEW_RESERVE_MS,
  recordCodingCompleted,
  recordCodingFailed,
  runPlanningAgents,
  type CodingReviewOutcome,
  type OrchestrationHandle,
} from "@/lib/orchestration/engine";
import { isProjectInMultiAgentCohort, multiAgentConfig } from "@/lib/orchestration/config";
import { isProjectInRuntimeCohort, runtimeSandboxConfig } from "@/lib/runtime-sandbox/config";
import {
  runtimeEvidenceFromRecord,
  runtimeEvidenceMatchesSource,
  runtimeRepairSummary,
} from "@/lib/runtime-sandbox/evidence";
import { latestRuntimeSandbox } from "@/lib/runtime-sandbox/store";
import { validateImagePlan } from "@/lib/images/manifest";
import {
  IMAGE_STAGE_MAX_MS,
  IMAGE_STAGE_MIN_GENERATION_MS,
  imagePlanningPolicyFor,
  imageStageBudgetMs,
} from "@/lib/images/policy";
import { plannerImageAddendum } from "@/lib/images/prompt";
import { runImageStage, type ImageStageResult } from "@/lib/images/service";
import {
  cancelWorkflowForRun,
  failWorkflowForRun,
} from "@/lib/orchestration/store";
import { subordinateContextBlock } from "@/lib/orchestration/roles";
import { loadFigmaDesignContext } from "@/lib/integrations/figma/service";
import {
  classifyGenerationFailure,
  hasRecoverableTruncationProgress,
  isInlineRecoverable,
  type FailureSignals,
} from "@/lib/generation/state-machine";
import { retryDelaySeconds, WORKER_LEASE_SECONDS } from "@/lib/generation/leases";
import { reportedCostOf } from "@/lib/observability/cost";
import {
  creditsConfig,
  isProjectInCreditsCohort,
} from "@/lib/credits/config";
import {
  beginProviderAttempt,
  completeProviderAttempt,
} from "@/lib/credits/store";
import {
  recordRunUsage,
  releaseRunCredits,
  settleRunCredits,
} from "@/lib/credits/service";
import { emitGenerationEvent, emitVerificationEvent } from "@/lib/observability/events";
import { maybeEnqueueVerification } from "@/lib/sandbox/enqueue";
import { buildAgentMemoryContext } from "@/lib/memory/context";
import { recordRunFailureMemory } from "@/lib/memory/outcomes";
import type { MemoryRunOutcome } from "@/lib/memory/types";
import { managedBackendConfig } from "@/lib/managed-backend/config";
import {
  parseAppDataModel,
  type AppDataModel,
} from "@/lib/managed-backend/model";
import {
  dataApiContractBlock,
  managedBackendReadySummary,
} from "@/lib/managed-backend/prompt";
import { detectBackendRequirement } from "@/lib/managed-backend/requirement";
import {
  managedBackendLifecycle,
  managedBackendStatus,
} from "@/lib/managed-backend/store";
import {
  configureManagedBackend,
  ensureManagedBackend,
} from "@/lib/managed-backend/service";

/**
 * Present only when the durable worker claimed this run. The worker has no user
 * session, so it passes the owner it verified and the service-role client.
 */
export interface WorkerRunContext {
  client: SupabaseClient;
  leaseToken: string;
  jobAttempt: number;
  maxJobAttempts: number;
  workerId: string;
  traceId: string;
}

export interface RunAgentInput {
  userId: string;
  projectId: string;
  runId: string;
  prompt: string;
  requestedModel?: string | null;
  /** True when this is a resume/retry of an interrupted run. */
  resume?: boolean;
  /**
   * Total wall-clock budget for this invocation, including any bounded inline
   * continuation. Defaults to the agent's `GENERATION_BUDGET_MS`; the durable
   * worker leaves it unset because its lease already bounds the invocation.
   */
  budgetMs?: number;
  /** The durable worker context. Absent means the inline `after()` path. */
  worker?: WorkerRunContext;
}

/**
 * A truthful account of what this invocation did. The inline path ignores it;
 * the worker route returns it, so an operator can tell "worked", "scheduled a
 * retry" and "wrote nothing because another owner took over" apart.
 */
export type RunAgentOutcome =
  | { status: "completed"; runId: string }
  | { status: "failed"; runId: string; errorClass: string }
  | {
      status: "retry";
      runId: string;
      errorClass: string;
      retryAfterSeconds: number;
      /**
       * Provider usage this attempt already spent. The inline loop carries it
       * into the continuation so the eventual terminal write reports the whole
       * run; the worker persists it before scheduling and leaves it unset.
       */
      usage?: AgentUsageTotals;
      attempts?: readonly AgentProviderAttempt[];
    }
  | { status: "dead_letter"; runId: string; errorClass: string }
  | { status: "cancelled"; runId: string }
  | { status: "skipped"; runId: string; reason: string };

/** Everything a write needs to prove it still owns the run. */
interface RunGuard {
  claimedAt: string | null;
  leaseToken: string | null;
  client: SupabaseClient | null;
  traceId: string | null;
  workerId: string | null;
  jobAttempt: number;
  maxAttempts: number;
  startedAtMs: number;
  /** The one deadline shared by every pipeline stage of this invocation. */
  budget: RunBudget;
  /** Automatic inline continuations already used (never more than the cap). */
  recoveryAttempts: number;
  /** Persist per-call usage for credit-enabled runs or runs with a live hold. */
  trackProviderUsage: boolean;
  /**
   * ⚠️ PROVIDER USAGE IS CUMULATIVE FOR THE RUN. Migration 16 is explicit: a
   * manual resume resets the job-attempt budget, never the provider counters.
   * These are seeded ONCE from the row this invocation claimed, then extended
   * by every attempt of this invocation that does not write terminal state
   * itself (the inline continuation). They are never re-read mid-invocation, so
   * the same usage cannot be counted twice.
   */
  priorUsage: AgentUsageTotals;
  priorAttempts: readonly AgentProviderAttempt[];
}

interface FailInput {
  message: string;
  before?: readonly SnapshotFile[];
  baseline?: SnapshotSummary | null;
  failure?: AgentGenerationFailure;
  signals?: FailureSignals;
}

function priorRepairContext(
  orchestration: OrchestrationHandle | null,
  manifest: AgentManifest | null,
): string | null {
  if (!orchestration || !manifest) return null;
  const task = orchestration.tasks.find(
    (candidate) =>
      candidate.key === "repair" &&
      candidate.status === "completed" &&
      candidate.output?.role === "repair",
  );
  const rawFixes = task?.output?.data.fixes;
  if (!Array.isArray(rawFixes)) return null;

  const allowedPaths = new Set(manifest.files.map((file) => file.path));
  const fixes: string[] = [];
  for (const entry of rawFixes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fix = entry as Record<string, unknown>;
    if (
      typeof fix.path !== "string" ||
      !allowedPaths.has(fix.path) ||
      (fix.action !== "change" && fix.action !== "add" && fix.action !== "remove") ||
      typeof fix.detail !== "string" ||
      !fix.detail.trim()
    ) {
      continue;
    }
    fixes.push(`- ${fix.path} (${fix.action}): ${fix.detail.trim().slice(0, 500)}`);
    if (fixes.length >= 8) break;
  }
  return fixes.length > 0
    ? `Evidence-linked suggestions from the prior failed attempt:\n${fixes.join("\n")}`
    : null;
}

/**
 * The cumulative counters this invocation starts from.
 *
 * ⚠️ SEEDED ONCE, FROM THE CLAIMED ROW. Re-reading the row later would include
 * this invocation's own terminal write and double-count it.
 */
function carriedUsage(run: RunRow): Pick<RunGuard, "priorUsage" | "priorAttempts"> {
  return {
    priorUsage: seededUsage({
      promptTokens: run.prompt_tokens,
      completionTokens: run.completion_tokens,
      totalTokens: run.total_tokens,
      reasoningTokens: run.reasoning_tokens,
      attemptCount: run.attempt_count,
    }),
    priorAttempts: persistedAttempts(run.provider_attempts),
  };
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentOutcome> {
  if (input.worker) return runWorkerAgent(input, input.worker);
  return runInlineAgent(input);
}

// ── Inline `after()` path ───────────────────────────────────────────────────

async function runInlineAgent(input: RunAgentInput): Promise<RunAgentOutcome> {
  const claimed = await claimRun(input.projectId, input.runId);
  if (isStoreFailure(claimed)) {
    console.error(`[mavly] could not claim run ${input.runId}:`, claimed.error);
    return { status: "skipped", runId: input.runId, reason: "claim_failed" };
  }
  if (!claimed.data) {
    // Another invocation owns this run, or it already reached a terminal state.
    console.warn(`[mavly] run ${input.runId} was already claimed or is not queued`);
    return { status: "skipped", runId: input.runId, reason: "not_queued" };
  }

  const run = claimed.data;
  /**
   * ⚠️ ONE BUDGET FOR CLAIM + RECOVERY. The inline path has no scheduler and no
   * second lease: a continuation must fit inside the SAME wall-clock budget as
   * the original attempt, and only one continuation is allowed.
   */
  const budget = runBudgetFor(
    Date.now(),
    Math.max(30_000, input.budgetMs ?? GENERATION_BUDGET_MS),
  );
  const guard: RunGuard = {
    claimedAt: run.claimed_at ?? run.started_at,
    leaseToken: null,
    client: null,
    traceId: run.trace_id,
    workerId: null,
    jobAttempt: 1,
    maxAttempts: 1 + MAX_INLINE_RECOVERY_ATTEMPTS,
    startedAtMs: budget.startedAtMs,
    budget,
    recoveryAttempts: 0,
    trackProviderUsage: false,
    ...carriedUsage(run),
  };

  /**
   * ⚠️ BOUNDED, NOT AN UNBOUNDED LOOP. At most `MAX_INLINE_RECOVERY_ATTEMPTS`
   * continuations are possible. `fail()` asks for one only for a recoverable
   * class, while the attempt budget is unused, and when a real recovery window
   * remains; otherwise it writes the terminal failure itself.
   */
  let outcome: RunAgentOutcome = {
    status: "skipped",
    runId: input.runId,
    reason: "not_started",
  };
  let currentRun = run;

  for (let attempt = 0; attempt <= MAX_INLINE_RECOVERY_ATTEMPTS; attempt += 1) {
    guard.recoveryAttempts = attempt;
    try {
      outcome = await execute(
        attempt === 0 ? input : { ...input, resume: true },
        currentRun,
        guard,
      );
    } catch (error) {
      if (error instanceof RunSupersededError || error instanceof RunLeaseLostError) {
        // A newer attempt owns this run now; write nothing.
        outcome = { status: "skipped", runId: input.runId, reason: "superseded" };
        break;
      }
      if (error instanceof RunCancelledError) {
        // The user's cancel is already terminal; do not overwrite it. The guarded
        // update below is a no-op when the cancellation landed first.
        const cancelled = await finishRun(input.runId, "cancelled", "The run was cancelled by the user.", {
          stage: "cancelled",
          errorCode: "RUN_CANCELLED",
          ...guardPatch(guard),
        });
        if (cancelled) {
          // ⚠️ A CANCELLED RUN IS NOT CHARGED. The release RPC refuses a
          // completed run, so this cannot be used to escape a legitimate charge.
          await releaseRunCredits({
            runId: input.runId,
            projectId: input.projectId,
            traceId: guard.traceId,
            client: guard.client,
            reason: "Run cancelled before completion",
          });
          await recordRunUsage({
            runId: input.runId,
            projectId: input.projectId,
            traceId: guard.traceId,
            client: guard.client,
          });
        }
        outcome = { status: "cancelled", runId: input.runId };
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      outcome = await fail(input, guard, {
        message: `The agent run failed unexpectedly: ${message}`,
        ...(error instanceof RunStoreError
          ? { signals: { code: "GENERATION_PERSIST_FAILED" } }
          : {}),
      });
    }

    if (outcome.status !== "retry") break;

    /**
     * The `retry` outcome already contains this invocation's cumulative totals.
     * Persist them as absolute run totals before continuing so a process
     * interruption cannot discard the failed attempt; the next invocation will
     * seed from this row, while this guard prevents double-counting locally.
     */
    guard.priorUsage = outcome.usage;
    guard.priorAttempts = outcome.attempts;
    const usagePersisted = await heartbeatRun(
      input.runId,
      {
        attemptCount: outcome.usage.attempts,
        promptTokens: outcome.usage.promptTokens,
        completionTokens: outcome.usage.completionTokens,
        totalTokens: outcome.usage.totalTokens,
        reasoningTokens: outcome.usage.reasoningTokens,
        providerAttempts: outcome.attempts,
        providerRequestId:
          lastProviderRequestId(outcome.attempts) ?? currentRun.provider_request_id,
        expectedClaimedAt: guard.claimedAt ?? undefined,
      },
      guard.client,
    );
    if (!usagePersisted) {
      emitGenerationEvent("generation.heartbeat_failed", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        reason: "inline_recovery_usage_persist_failed",
      });
      outcome = { status: "skipped", runId: input.runId, reason: "recovery_usage_persist_failed" };
      break;
    }

    /**
     * `fail` only asks for this when a real window remains. Re-check anyway so a
     * slow failure path can never start a zero-length continuation, and finish
     * honestly when the retry cannot actually be made.
     */
    const remaining = remainingRunMs(guard.budget, Date.now());
    if (attempt >= MAX_INLINE_RECOVERY_ATTEMPTS || remaining < MIN_INLINE_RECOVERY_WINDOW_MS) {
      guard.recoveryAttempts = MAX_INLINE_RECOVERY_ATTEMPTS;
      outcome = await fail(input, guard, {
        message:
          "The run could not continue within its remaining time budget. Completed batches were saved and the run can be resumed.",
        signals: { code: "GENERATION_TIMEOUT" },
      });
      break;
    }

    /**
     * Re-read before continuing: this is the persisted manifest, checkpoint
     * state and cancellation signal — not the row this invocation claimed.
     */
    const latest = await getRun(input.projectId, input.runId, guard.client);
    if (isStoreFailure(latest)) {
      outcome = { status: "skipped", runId: input.runId, reason: "recovery_unavailable" };
      break;
    }
    if (!latest.data || latest.data.finished_at) {
      outcome = { status: "skipped", runId: input.runId, reason: "already_finished" };
      break;
    }
    if (latest.data.stage === "cancelled" || latest.data.cancellation_requested_at) {
      outcome = { status: "cancelled", runId: input.runId };
      break;
    }

    currentRun = latest.data;
  }

  await recordMemoryForOutcome(input, guard, outcome);
  return outcome;
}

// ── Durable worker path ─────────────────────────────────────────────────────

async function runWorkerAgent(
  input: RunAgentInput,
  worker: WorkerRunContext,
): Promise<RunAgentOutcome> {
  const latest = await getRun(input.projectId, input.runId, worker.client);
  if (isStoreFailure(latest)) {
    emitWorkerError(input, worker, "store_unavailable");
    return { status: "skipped", runId: input.runId, reason: "store_unavailable" };
  }

  const run = latest.data;
  if (!run) return { status: "skipped", runId: input.runId, reason: "run_missing" };
  if (run.dispatch_mode !== "worker") {
    return { status: "skipped", runId: input.runId, reason: "not_worker_dispatched" };
  }
  if (run.finished_at) {
    return run.stage === "cancelled"
      ? { status: "cancelled", runId: input.runId }
      : { status: "skipped", runId: input.runId, reason: "already_finished" };
  }
  if (run.stage === "cancelled" || run.cancellation_requested_at) {
    return { status: "cancelled", runId: input.runId };
  }
  if (run.lease_token !== worker.leaseToken) {
    return { status: "skipped", runId: input.runId, reason: "lease_mismatch" };
  }
  if (
    run.stage !== "validating" &&
    run.stage !== "generating" &&
    run.stage !== "retrying"
  ) {
    return { status: "skipped", runId: input.runId, reason: "not_execution_stage" };
  }

  /**
   * ⚠️ THE SERVICE-ROLE WORKER RE-VERIFIES THE OWNER. `claim_generation_job`
   * returned an owner, but this module never trusts a claim answer as proof.
   * A missing row and a foreign row are the same non-enumerating refusal.
   */
  const project = await getProject(input.userId, input.projectId, worker.client);
  if (isStoreFailure(project)) {
    emitWorkerError(input, worker, "store_unavailable");
    return { status: "skipped", runId: input.runId, reason: "store_unavailable" };
  }
  if (!project.data || project.data.user_id !== input.userId) {
    emitWorkerError(input, worker, "owner_mismatch");
    return { status: "skipped", runId: input.runId, reason: "owner_mismatch" };
  }

  const liveReservation = await worker.client
    .from("credit_reservations")
    .select("id")
    .eq("run_id", input.runId)
    .eq("status", "reserved")
    .maybeSingle();
  if (liveReservation.error) {
    emitWorkerError(input, worker, "credit_reservation_check_failed");
    return {
      status: "skipped",
      runId: input.runId,
      reason: "credit_reservation_check_failed",
    };
  }

  const creditConfig = creditsConfig();
  const guard: RunGuard = {
    claimedAt: run.claimed_at,
    leaseToken: worker.leaseToken,
    client: worker.client,
    traceId: worker.traceId,
    workerId: worker.workerId,
    jobAttempt: worker.jobAttempt,
    maxAttempts: worker.maxJobAttempts,
    startedAtMs: Date.now(),
    /**
     * ⚠️ THE TICK MUST FIT INSIDE THE FUNCTION. The lease (420 s) is a backstop
     * and is deliberately longer than the serverless limit (300 s); the WORK
     * budget is not. It is derived from the function limit minus what this same
     * tick still has to do afterwards — finalization and the post-coding reviews.
     * A budget larger than that is how a tick gets killed after the terminal
     * run write but before the user-facing message.
     */
    budget: runBudgetFor(
      Date.now(),
      Math.max(
        30_000,
        input.budgetMs ?? workerGenerationBudgetMs(POST_CODING_REVIEW_RESERVE_MS),
      ),
    ),
    recoveryAttempts: MAX_INLINE_RECOVERY_ATTEMPTS,
    trackProviderUsage:
      !!liveReservation.data ||
      (creditConfig.requested &&
        isProjectInCreditsCohort(input.projectId, creditConfig)),
    ...carriedUsage(run),
  };

  let outcome: RunAgentOutcome;
  try {
    outcome = await execute(input, run, guard);
  } catch (error) {
    if (error instanceof RunSupersededError || error instanceof RunLeaseLostError) {
      emitGenerationEvent("generation.lease_lost", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        attempt: guard.jobAttempt,
        reason: "fenced_off",
      });
      return { status: "skipped", runId: input.runId, reason: "lease_lost" };
    }
    if (error instanceof RunCancelledError) {
      if (guard.client) {
        try {
          await cancelWorkflowForRun(guard.client, input.projectId, input.runId);
        } catch (workflowError) {
          console.warn(
            `[mavly] run ${input.runId}: could not cancel its workflow:`,
            workflowError instanceof Error ? workflowError.message : String(workflowError),
          );
        }
      }
      return { status: "cancelled", runId: input.runId };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (guard.client) {
      try {
        await failWorkflowForRun(
          guard.client,
          input.projectId,
          input.runId,
          error instanceof RunStoreError ? "GENERATION_PERSIST_FAILED" : "GENERATION_FAILED",
          `The run failed unexpectedly: ${message}`,
        );
      } catch (workflowError) {
        console.warn(
          `[mavly] run ${input.runId}: could not fail its workflow:`,
          workflowError instanceof Error ? workflowError.message : String(workflowError),
        );
      }
    }
    outcome = await fail(input, guard, {
      message: `The agent run failed unexpectedly: ${message}`,
      ...(error instanceof RunStoreError
        ? { signals: { code: "GENERATION_PERSIST_FAILED" } }
        : {}),
    });
  }
  if (outcome.status === "cancelled" && guard.client) {
    try {
      await cancelWorkflowForRun(guard.client, input.projectId, input.runId);
    } catch {
      // The run's cancellation is already terminal; the workflow record is best effort.
    }
  }
  await recordMemoryForOutcome(input, guard, outcome);
  return outcome;
}

/**
 * Best-effort Phase 8 failure note. Success/cancellation/retry are deliberately
 * not recorded; a memory outage never changes the run outcome.
 */
async function recordMemoryForOutcome(
  input: RunAgentInput,
  guard: RunGuard,
  outcome: RunAgentOutcome,
): Promise<void> {
  if (outcome.status !== "failed" && outcome.status !== "dead_letter") return;
  const memoryOutcome: MemoryRunOutcome = {
    runId: input.runId,
    status: outcome.status,
    errorClass: outcome.errorClass,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recordRunFailureMemory({
        client: guard.client,
        userId: input.userId,
        projectId: input.projectId,
        outcome: memoryOutcome,
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3_000);
      }),
    ]);
  } catch {
    // recordRunFailureMemory already swallows/logs; this is a last-resort guard.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emitWorkerError(
  input: RunAgentInput,
  worker: WorkerRunContext,
  reason: string,
): void {
  emitGenerationEvent("generation.worker_error", {
    traceId: worker.traceId,
    runId: input.runId,
    projectId: input.projectId,
    workerId: worker.workerId,
    reason,
  });
}

// ── Ownership errors ────────────────────────────────────────────────────────

class RunCancelledError extends Error {
  constructor() {
    super("RUN_CANCELLED");
    this.name = "RunCancelledError";
  }
}

class RunSupersededError extends Error {
  constructor() {
    super("RUN_SUPERSEDED");
    this.name = "RunSupersededError";
  }
}

class RunLeaseLostError extends Error {
  constructor() {
    super("LEASE_LOST");
    this.name = "RunLeaseLostError";
  }
}

class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

/**
 * Re-read the run before a write and refuse to continue unless THIS invocation
 * still owns it.
 *
 * ⚠️ A STORE FAILURE IS NOT PERMISSION. The old inline path returned on a read
 * error and kept writing; that could overwrite a run another attempt owned.
 * It now throws a retryable persistence failure instead.
 */
async function assertRunOwned(input: RunAgentInput, guard: RunGuard): Promise<void> {
  const latest = await getRun(input.projectId, input.runId, guard.client);
  if (isStoreFailure(latest)) {
    throw new RunStoreError(`Could not re-read the run before a write: ${latest.error}`);
  }
  const current = latest.data;
  if (!current) throw new RunSupersededError();
  if (current.stage === "cancelled" || current.cancellation_requested_at) {
    throw new RunCancelledError();
  }
  if (current.finished_at) throw new RunSupersededError();

  if (guard.leaseToken) {
    if (current.lease_token !== guard.leaseToken) throw new RunLeaseLostError();
    return;
  }
  if (!guard.claimedAt || current.claimed_at !== guard.claimedAt) {
    throw new RunSupersededError();
  }
}

// ── The run itself ──────────────────────────────────────────────────────────

async function execute(
  input: RunAgentInput,
  run: RunRow,
  guard: RunGuard,
): Promise<RunAgentOutcome> {
  const runId = input.runId;
  const client = guard.client;

  const project = await getProject(input.userId, input.projectId, client);
  if (isStoreFailure(project)) {
    return fail(input, guard, {
      message: `Could not verify the project type before generation: ${project.error}`,
      signals: { code: "GENERATION_PERSIST_FAILED" },
    });
  }
  if (!project.data || project.data.user_id !== input.userId) {
    return fail(input, guard, {
      message: "The project could not be verified for this generation run.",
      signals: { code: "GENERATION_PERSIST_FAILED" },
    });
  }
  const projectType: AgentProjectType =
    project.data.project_type === "android" ? "android" : "website";
  const androidPackage =
    projectType === "android" ? androidPackageForProject(input.projectId) : null;

  const alive = await heartbeatRun(
    runId,
    {
      stage: "validating",
      ...(guard.leaseToken
        ? { expectedLeaseToken: guard.leaseToken, leaseSeconds: WORKER_LEASE_SECONDS }
        : { expectedClaimedAt: guard.claimedAt ?? undefined }),
    },
    client,
  );
  if (guard.leaseToken && !alive) throw new RunLeaseLostError();

  await touchProject(input.userId, input.projectId, client);

  /**
   * A Figma link in the prompt is a reference the agent must actually read.
   * Resolve it before anything is written: a missing connection or an expired
   * token is a clear failure, not a reason to invent a design from the URL.
   */
  const design = await loadFigmaDesignContext({
    projectId: input.projectId,
    userId: input.userId,
    prompt: input.prompt,
    client,
  });
  if (design.ok === false) {
    return fail(input, guard, { message: design.error });
  }

  await assertRunOwned(input, guard);

  const current = await listFiles(input.projectId, client);
  if (isStoreFailure(current)) {
    return fail(input, guard, {
      message: `Could not read the project files: ${current.error}`,
      signals: { code: "GENERATION_PERSIST_FAILED" },
    });
  }

  await assertRunOwned(input, guard);

  const before: SnapshotFile[] = current.data.map((file) => ({
    path: file.path,
    content: file.content,
  }));
  const existingPaths = new Set(before.map((file) => file.path));
  const isComplete = requiredCreatePathsFor(projectType, androidPackage).every((path) =>
    existingPaths.has(path),
  );
  const mode = isComplete ? "update" : "create";

  /**
   * ⭐ THE BASELINE OF THIS RUN. Created once, before the first write. On a
   * retry/resume the original baseline is reused; a second one would hide the
   * state the user actually wants to restore to.
   */
  const baseline = await ensureBaseline(input, before, guard.client);

  /**
   * ═══ OPT-IN MULTI-AGENT LAYER (PHASE 10) ═══════════════════════════════════
   *
   * It runs only in durable-worker mode (a confined service-role client exists)
   * and only for an explicit project cohort. Every failure here is swallowed:
   * orchestration observability must never change the run's own outcome. The
   * existing `generateApp` pipeline still writes every file.
   */
  /**
   * ⚠️ QA/SECURITY READ RUNTIME EVIDENCE, THEY DO NOT CREATE IT. The provider
   * reads this project's durable sandbox row only; it never starts, restarts or
   * installs anything, so a review cannot spend provider time or change a run.
   */
  const runtimeConfig = runtimeSandboxConfig();
  const runtimeEvidenceProvider =
    input.worker &&
    guard.client &&
    runtimeConfig.ready &&
    runtimeConfig.qaEvidence &&
    isProjectInRuntimeCohort(input.projectId, runtimeConfig)
      ? async () => {
          const latest = await latestRuntimeSandbox(guard.client as SupabaseClient, input.projectId);
          return latest.ok ? runtimeEvidenceFromRecord(latest.data) : null;
        }
      : undefined;

  let orchestration: OrchestrationHandle | null = null;
  try {
    orchestration = input.worker
      ? await beginOrchestration({
          client: guard.client,
          userId: input.userId,
          projectId: input.projectId,
          runId,
          prompt: input.prompt,
          projectType,
          mode,
          existingFiles: before,
          requestedModel: input.requestedModel,
          leaseToken: input.worker.leaseToken,
          trackProviderUsage: guard.trackProviderUsage,
          runtimeEvidence: runtimeEvidenceProvider,
        })
      : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[mavly] run ${runId}: orchestration setup failed:`, detail);
    /**
     * ⚠️ A SWALLOWED SETUP FAILURE IS A SILENT ZERO-AGENT RUN. The console line
     * is not part of the durable record, so an operator would see a cohort project
     * with no workflow and no reason for it. It stays non-fatal (orchestration is
     * observability, and `generateApp` still writes every file) but it is now
     * reported where the run can be inspected.
     */
    emitGenerationEvent("orchestration.skipped", {
      traceId: guard.traceId,
      runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      reason: "setup_failed",
      dispatchMode: input.worker ? "worker" : "inline",
    });
  }

  /**
   * ⚠️ A COHORT PROJECT ON THE INLINE PATH GETS NO SPECIALIST STAGES. That is
   * deliberate — orchestration needs a confined service-role client for durable
   * metering and workflow persistence — but it must never be silent, because
   * "the seven agents did not run" otherwise looks like a bug. The reason is an
   * operator event, not a substituted stage.
   */
  if (!orchestration && !input.worker) {
    const multiAgent = multiAgentConfig();
    if (isProjectInMultiAgentCohort(input.projectId, multiAgent)) {
      emitGenerationEvent("orchestration.skipped", {
        traceId: guard.traceId,
        runId,
        projectId: input.projectId,
        reason: "orchestration_requires_worker_dispatch",
        dispatchMode: "inline",
      });
    }
  }

  let planContext: string | null = null;
  let designDirectives: string | null = null;
  if (orchestration) {
    try {
      const specialist = await runPlanningAgents(orchestration, before);
      planContext = specialist.planContext;
      designDirectives = specialist.designDirectives;
      await markCodingStarted(orchestration);
    } catch (error) {
      console.warn(
        `[mavly] run ${runId}: planning agents failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  let resumeManifest: AgentManifest | null = parseManifest(run.generation_manifest);
  let completedPaths: string[] = [];
  let nextBatchIndex = 0;

  const batches = await listRunBatches(runId, client);
  if (isStoreFailure(batches)) {
    if (input.resume) {
      return fail(input, guard, {
        message: `Could not verify the saved checkpoints, so the run was not resumed: ${batches.error}`,
        before,
        baseline,
        signals: { code: "GENERATION_PERSIST_FAILED" },
      });
    }
    console.error(`[mavly] checkpoint read failed for run ${runId}:`, batches.error);
  } else {
    const verified = verifyCheckpointBatches(batches.data, before);
    completedPaths = verified.completedPaths;
    nextBatchIndex = verified.nextBatchIndex;
    if (verified.mismatchedPaths.length > 0) {
      // The project changed after these batches were written. Regenerate only
      // those paths; the agent excludes only verified completed work.
      console.warn(
        `[mavly] run ${runId}: ${verified.mismatchedPaths.length} checkpointed path(s) no longer match and will be regenerated`,
      );
    }
  }

  /**
   * A retried/reopened run needs its plan. If the manifest was not persisted
   * (the run died before planning finished), the agent plans again and still
   * skips the verified completed paths.
   */
  if (input.resume && !resumeManifest) {
    console.warn(`[mavly] run ${runId} has no persisted manifest; it will be re-planned`);
  }

  const writtenPaths = new Set<string>(completedPaths);
  let latestProviderRequestId: string | null = null;
  let managedBackendContext: AgentGenerationInput["managedBackendContext"];
  let backendContract: string | null = null;
  let managedBackendSummary: string | null = null;
  let generationInput: AgentGenerationInput | null = null;
  let managedBackendPrepared = false;

  const emitManagedBackendStage = (
    status: string,
    reason: string | null,
  ): void => {
    emitGenerationEvent("managed_backend.stage", {
      traceId: guard.traceId,
      runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      status,
      ...(reason ? { reason } : {}),
    });
  };

  /**
   * ═══ MANAGED BACKEND STAGE ═══════════════════════════════════════════════
   *
   * Runs ONCE per invocation, after the plan is persisted and before the first
   * code batch. A database is created only when the trusted requirement policy
   * says the product needs one AND the planner produced a data model the server
   * validated. A static site never reaches the provisioning call.
   *
   * ⚠️ `ready` IS EARNED IN THIS ORDER: provision → apply + verify schema →
   * configure the data gateway. Any failure stops the run with a sanitized
   * message and leaves the existing database, schema and rows in place.
   */
  const prepareManagedBackend = async (manifest: AgentManifest): Promise<void> => {
    if (managedBackendPrepared) return;
    managedBackendPrepared = true;
    if (projectType !== "website") return;

    const decision = detectBackendRequirement({
      prompt: input.prompt,
      planner: manifest.backendRequirement ?? null,
      projectType,
    });
    const config = managedBackendConfig();

    /**
     * ⚠️ AN UPDATE MUST NOT LOSE AN EXISTING BACKEND CONTRACT.
     *
     * A follow-up prompt like "make the header blue" usually plans no database
     * change. Without this lookup the model would be told the app has no
     * backend and could delete the data layer it built earlier. A READY row's
     * validated model is reused as the contract (and as the migration input when
     * the plan does not carry a new model).
     */
    let existingModel: AppDataModel | null = null;
    let existingGatewayOrigin: string | null = null;
    if (config.requested && input.worker && guard.client) {
      const lifecycle = await managedBackendLifecycle({
        client: guard.client,
        projectId: input.projectId,
        userId: input.userId,
      });
      if (
        lifecycle.ok &&
        lifecycle.data?.status === "ready" &&
        lifecycle.data.dataModel
      ) {
        const parsedExisting = parseAppDataModel(lifecycle.data.dataModel);
        if (parsedExisting.ok) {
          existingModel = parsedExisting.model;
          existingGatewayOrigin = lifecycle.data.gatewayOrigin;
        }
      }
    } else if (config.requested && client) {
      /** Inline runs use the caller's RLS client and the owner-checked RPC. */
      const status = await managedBackendStatus({
        client,
        projectId: input.projectId,
      });
      if (status.ok && status.data?.status === "ready" && status.data.dataModel) {
        const parsedExisting = parseAppDataModel(status.data.dataModel);
        if (parsedExisting.ok) {
          existingModel = parsedExisting.model;
          existingGatewayOrigin = status.data.gatewayOrigin;
        }
      }
    }

    const syncContext = (): void => {
      if (!generationInput) return;
      generationInput.managedBackendContext = managedBackendContext;
      generationInput.backendContract = backendContract;
    };

    if (!decision.required) {
      if (existingModel) {
        const origin = config.gatewayOrigin ?? existingGatewayOrigin;
        if (origin) {
          managedBackendContext = "ready";
          backendContract = dataApiContractBlock({
            origin,
            projectId: input.projectId,
            model: existingModel,
          });
          syncContext();
          managedBackendSummary =
            "This project already has a ready managed backend. The update kept using its verified data API; no new schema was applied.";
          emitManagedBackendStage("reused", null);
          return;
        }
      }
      if (decision.overridden) {
        managedBackendSummary =
          "Mavly treated this request as a static site, so no managed database was created.";
      }
      emitManagedBackendStage(
        "not_required",
        decision.overridden ? "static_site_policy" : null,
      );
      return;
    }

    managedBackendContext = "not_provisioned";
    syncContext();

    /**
     * ⚠️ NO MODEL, NO DATABASE. A prompt that asks for saved records is not
     * permission to create an empty database, and the run must not pretend the
     * app has a backend. An already-ready model is a valid plan input; anything
     * else keeps the app an explicitly labelled prototype.
     */
    const model = manifest.dataModel ?? existingModel;
    if (!model) {
      managedBackendSummary = `This request needs stored data, but the plan did not produce a valid data model (${manifest.dataModelIssue ?? "missing"}). No database was created; the generated app is a labelled prototype, and persistent data, sign-in and per-user records are not live.`;
      emitManagedBackendStage("blocked", "invalid_data_model");
      return;
    }

    const inCohort = config.cohort.includes(input.projectId.toLowerCase());
    if (!config.requested || !inCohort) {
      managedBackendSummary =
        "This request needs stored data, but Mavly's managed database is not enabled for this project. No database was created; the generated app is a labelled prototype and persistent data is not live.";
      emitManagedBackendStage("blocked", "not_enabled_for_project");
      return;
    }

    if (!input.worker) {
      managedBackendSummary =
        "This request needs stored data, but managed provisioning runs only on the durable generation worker. No database was created; the generated app is a labelled prototype and persistent data is not live.";
      emitManagedBackendStage("blocked", "requires_worker_dispatch");
      return;
    }
    /**
     * ⚠️ A BLOCKED BACKEND NEVER DISCARDS THE USER'S WORK.
     *
     * Operator misconfiguration, a provider outage, a refused quota or a
     * schema that failed verification all end the same way: the run continues
     * as an explicitly labelled prototype (`not_provisioned` + `blocked`), the
     * exact sanitized reason is reported, and whatever database/schema already
     * exists is left untouched for a later retry. Only an unexpected exception
     * propagates, because that is a bug in this stage, not a backend decision.
     */
    const blockBackend = (reason: string, detail: string): void => {
      managedBackendContext = "not_provisioned";
      backendContract = null;
      managedBackendSummary = `${detail} The generated app is a labelled prototype: persistent data, per-user records and end-user sign-in are not live. Existing database data was not deleted or changed.`;
      syncContext();
      emitManagedBackendStage("blocked", reason);
    };

    if (!config.ready) {
      blockBackend(
        "platform_configuration_incomplete",
        "Managed database provisioning is enabled for this project but its approved platform configuration is incomplete, so no database was created.",
      );
      return;
    }
    if (!guard.client) {
      blockBackend(
        "worker_client_unavailable",
        "The managed database worker has no authorized Supabase client, so no database was created.",
      );
      return;
    }

    const backend = await ensureManagedBackend({
      client: guard.client,
      userId: input.userId,
      projectId: input.projectId,
      config,
    });
    if (backend.ok === false) {
      blockBackend(
        `provisioning_${backend.code.toLowerCase().slice(0, 48)}`,
        `${backend.error} The managed database is therefore not ready for this run.`,
      );
      return;
    }

    const remaining = remainingRunMs(guard.budget, Date.now());
    const configured = await configureManagedBackend({
      client: guard.client,
      userId: input.userId,
      projectId: input.projectId,
      config,
      model,
      timeBudgetMs: Math.max(5_000, Math.min(60_000, remaining - 20_000)),
    });
    if (configured.ok === false) {
      blockBackend(
        `configuration_${configured.code.toLowerCase().slice(0, 48)}`,
        `${configured.error} The backend is therefore not ready for this run.`,
      );
      return;
    }

    managedBackendContext = "ready";
    backendContract = dataApiContractBlock({
      origin: configured.gatewayOrigin,
      projectId: input.projectId,
      model,
    });
    syncContext();
    managedBackendSummary = managedBackendReadySummary({
      model,
      tableCount: configured.tableCount,
      origin: configured.gatewayOrigin,
      projectId: input.projectId,
    });
    emitManagedBackendStage("ready", null);
  };

  /**
   * The image stage runs ONCE per invocation, between the persisted plan and the
   * first code batch, so the batches can reference real, persisted URLs.
   *
   * ⚠️ IT NEVER FAILS THE GENERATION. A provider, storage or database failure
   * leaves those placements pending with a truthful summary; the website is
   * still built (with placeholders) and the run reports the missing images.
   */
  let imageStageSummary: string | null = null;
  let imageStageAttempted = false;

  const prepareImageStage = async (manifest: AgentManifest): Promise<void> => {
    if (projectType !== "website" || imageStageAttempted) return;
    imageStageAttempted = true;

    if (manifest.imagePlanIssue) {
      imageStageSummary = `The planner proposed an image plan Mavly rejected (${manifest.imagePlanIssue}). No images were generated for this run.`;
      emitGenerationEvent("image.plan", {
        traceId: guard.traceId,
        runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        status: "rejected",
        reason: "planner_plan_invalid",
      });
      return;
    }
    if (!manifest.images || manifest.images.length === 0) return;

    const policy = imagePlanningPolicyFor({
      siteType: manifest.imageSiteType,
      projectId: input.projectId,
      projectType,
      // The image API shares the server-only text-generation key, and
      // `isAiConfigured` is the sanctioned check for it. The provider module is
      // imported only through `@/lib/ai/provider`, never directly from a route
      // or the run engine.
      providerConfigured: isAiConfigured(),
    });
    if (!policy.enabled) {
      imageStageSummary = `Image generation is not enabled for this run (${policy.disabledReason ?? "disabled"}): no images were generated and the plan's imagery is not available.`;
      emitGenerationEvent("image.plan", {
        traceId: guard.traceId,
        runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        status: "disabled",
        reason: policy.disabledReason ?? "disabled",
        imageAssets: manifest.images.length,
      });
      return;
    }

    const validated = validateImagePlan({
      siteType: manifest.imageSiteType,
      images: manifest.images,
    });
    if (!validated.ok) {
      imageStageSummary = `The saved image plan could not be re-validated (${(validated as { error: string }).error}). No images were generated for this run.`;
      return;
    }

    /**
     * ⚠️ THE STAGE HAS ITS OWN SLICE OF THE RUN'S REMAINING BUDGET. It can never
     * spend the batches' time, and when that slice is gone nothing is started.
     */
    const availableMs = Math.max(0, remainingRunMs(guard.budget, Date.now()));
    const stageBudgetMs = imageStageBudgetMs({
      remainingMs: availableMs,
      maxMs: IMAGE_STAGE_MAX_MS,
      minGenerationMs: IMAGE_STAGE_MIN_GENERATION_MS,
    });

    if (stageBudgetMs <= 0) {
      imageStageSummary = `The run's remaining time was too short to generate the ${validated.plan.images.length} planned image(s); no images were generated for this run.`;
      emitGenerationEvent("image.stage", {
        traceId: guard.traceId,
        runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        status: "skipped",
        reason: "insufficient_time",
        imageAssets: validated.plan.images.length,
      });
      return;
    }

    let result: ImageStageResult;
    try {
      result = await runImageStage({
        client,
        projectId: input.projectId,
        runId,
        policy,
        plan: validated.plan,
        deadlineAt: Date.now() + stageBudgetMs,
        assertRunnable: () => assertRunOwned(input, guard),
      });
    } catch (error) {
      console.warn(
        `[mavly] run ${runId}: image stage failed:`,
        error instanceof Error ? error.message : String(error),
      );
      imageStageSummary = `The image stage could not run (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}). The pages use placeholders for the planned imagery.`;
      return;
    }

    const approved = result.counts.approved;
    if (approved > 0) {
      imageStageSummary =
        result.status === "completed"
          ? `${result.counts.ready} approved image${result.counts.ready === 1 ? "" : "s"} generated and saved for this site.`
          : `${result.counts.ready} of ${approved} approved image${approved === 1 ? "" : "s"} are ready` +
            (result.counts.failed > 0 ? `; ${result.counts.failed} failed` : "") +
            (result.counts.pending > 0 ? `; ${result.counts.pending} still pending` : "") +
            (result.counts.deferred > 0 ? `; ${result.counts.deferred} deferred by the image budget` : "") +
            (result.requiredMissing > 0
              ? `; ${result.requiredMissing} REQUIRED image${result.requiredMissing === 1 ? " is" : "s are"} missing`
              : "") +
            ". The pages use placeholders for the rest; they are not reported as ready.";
    } else if (result.counts.deferred > 0) {
      imageStageSummary = `All ${result.counts.deferred} planned image(s) were deferred by the run's image budget; the pages use placeholders.`;
    }

    emitGenerationEvent("image.stage", {
      traceId: guard.traceId,
      runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      status: result.status,
      reason: result.reason ?? undefined,
      model: policy.modelId,
      imageAssets: approved,
      imageReady: result.counts.ready,
      costUsd: result.actualCostUsd ?? undefined,
      costKnown: result.costKnown,
    });

    /**
     * ⚠️ ONLY PERSISTED ASSETS REACH THE PROMPT. A deferred or failed placement
     * is described as unavailable so the coding agent keeps its layout slot
     * instead of inventing a URL.
     */
    if (generationInput) {
      generationInput.imageAssets = result.references;
      generationInput.imagePending = result.pending;
      generationInput.imagePlanCounts = {
        siteType: result.plan?.siteType ?? policy.siteType,
        approved: result.counts.approved,
        deferred: result.counts.deferred,
      };
    }
  };

  const onManifest = async (manifest: AgentManifest): Promise<void> => {
    const saved = await setRunManifest(
      runId,
      manifest,
      guard.claimedAt ?? undefined,
      guard.leaseToken ?? undefined,
      client,
    );
    if (isStoreFailure(saved)) {
      if (saved.code === "CONFLICT") throw new RunLeaseLostError();
      throw new RunStoreError(`Could not save the generation plan: ${saved.error}`);
    }
    resumeManifest = manifest;
    await prepareManagedBackend(manifest);
    await prepareImageStage(manifest);
  };

  const onBatch = async (batch: AgentBatchCheckpoint): Promise<void> => {
    await assertRunOwned(input, guard);

    for (const file of batch.files) writtenPaths.add(file.path);

    /**
     * ⚠️ FILES AND CHECKPOINT ARE ONE TRANSACTION. The old path wrote files
     * first and recorded the checkpoint second, so a crash in between left
     * files that a resume could not trust. The RPC checks the lease before it
     * writes either, so a stale worker writes nothing at all.
     */
    const checkpoint = await recordRunBatch({
      runId,
      projectId: input.projectId,
      batchIndex: batch.batchIndex,
      files: batch.files,
      filesWritten: writtenPaths.size,
      expectedClaimedAt: guard.leaseToken ? undefined : guard.claimedAt ?? undefined,
      leaseToken: guard.leaseToken ?? undefined,
      userId: guard.leaseToken ? input.userId : undefined,
      leaseSeconds: WORKER_LEASE_SECONDS,
      supabase: client,
    });
    if (isStoreFailure(checkpoint)) {
      if (checkpoint.code === "LEASE_LOST" || checkpoint.code === "FORBIDDEN") {
        throw new RunLeaseLostError();
      }
      throw new RunStoreError(`Could not record the batch checkpoint: ${checkpoint.error}`);
    }

    emitGenerationEvent("generation.checkpoint", {
      traceId: guard.traceId,
      runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      attempt: guard.jobAttempt,
      checkpoints: checkpoint.data.batch_index + 1,
      filesWritten: writtenPaths.size,
    });
  };

  const onProgress = async (event: AgentProgressEvent): Promise<void> => {
    const stage =
      event.type === "retrying" || event.type === "shrinking"
        ? ("retrying" as const)
        : event.type === "validating"
          ? ("validating" as const)
          : ("generating" as const);

    const patch: Parameters<typeof heartbeatRun>[1] = { stage };
    if (event.type === "retrying") {
      patch.errorCode =
        event.retryAfterMs !== null ? "PROVIDER_RATE_LIMITED" : "PROVIDER_RETRY";
      patch.retryAfterSeconds =
        event.retryAfterMs !== null ? Math.ceil(event.retryAfterMs / 1_000) : null;
    }
    if (event.type === "shrinking") {
      patch.errorCode =
        event.reason === "truncated"
          ? "GENERATION_TRUNCATED"
          : event.reason === "timeout"
            ? "PROVIDER_TIMEOUT"
            : "GENERATION_COMPACT_RETRY";
    }
    if (guard.leaseToken) {
      patch.expectedLeaseToken = guard.leaseToken;
      patch.leaseSeconds = WORKER_LEASE_SECONDS;
    } else {
      patch.expectedClaimedAt = guard.claimedAt ?? undefined;
    }

    const renewed = await heartbeatRun(runId, patch, client);
    // `emitProgress` in the agent swallows callback errors, so this is a
    // best-effort early stop; the next checkpoint is fenced regardless.
    if (guard.leaseToken && !renewed) throw new RunLeaseLostError();
  };

  if (resumeManifest?.files.some((file) => !completedPaths.includes(file.path))) {
    const resumed = await heartbeatRun(
      runId,
      {
        stage: "generating",
        ...(guard.leaseToken
          ? { expectedLeaseToken: guard.leaseToken, leaseSeconds: WORKER_LEASE_SECONDS }
          : { expectedClaimedAt: guard.claimedAt ?? undefined }),
      },
      client,
    );
    if (guard.leaseToken && !resumed) throw new RunLeaseLostError();
  }

  if (resumeManifest) {
    try {
      await prepareManagedBackend(resumeManifest);
    } catch (error) {
      if (error instanceof AgentGenerationSetupError) {
        return fail(input, guard, {
          message: error.message,
          before,
          baseline,
          signals: { code: error.code },
        });
      }
      throw error;
    }
  }

  /**
   * Phase 8 context is assembled from the CURRENT files plus persisted decisions
   * and observed outcomes. It is optional: `used: false` leaves the pre-Phase-8
   * full-file behavior unchanged, and a memory outage never fails the run.
   */
  const memory = await buildAgentMemoryContext({
    client: guard.client,
    userId: input.userId,
    projectId: input.projectId,
    prompt: input.prompt,
    files: before,
  });

  /**
   * ⚠️ THE AGENT GETS WHAT IS LEFT, NOT A FRESH 240 s. Planning, Figma and the
   * optional specialist calls have already consumed part of the invocation's
   * budget; handing the pipeline the original number would let the run overshoot
   * its own deadline (and, on inline recovery, its single permitted window).
   *
   * ⚠️ THE POST-CODING REVIEW RESERVE IS TAKEN ONCE, NOT TWICE. The worker's
   * whole budget is already built by `workerGenerationBudgetMs(
   * POST_CODING_REVIEW_RESERVE_MS)`, which subtracts the review reserve from the
   * function limit before this point. Subtracting it again here (as an earlier
   * version did) spent a second 50 s of the tick on a reserve that had already
   * been taken, and since generation is the only consumer left, a multi-agent run
   * started its first batch with ~95-160 s instead of ~145-210 s. Generation must
   * simply receive the budget that remains.
   */
  const generationBudgetMs = Math.max(0, remainingRunMs(guard.budget, Date.now()));
  const repairContext = priorRepairContext(orchestration, resumeManifest);
  /**
   * A failed live sandbox is real runtime evidence for the coding context. It is
   * read from the durable session only; this never starts a sandbox, and the
   * block is explicitly subordinate advisory data.
   */
  let runtimeFailureContext: string | null = null;
  if (
    input.worker &&
    guard.client &&
    runtimeConfig.ready &&
    isProjectInRuntimeCohort(input.projectId, runtimeConfig)
  ) {
    const latestRuntime = await latestRuntimeSandbox(guard.client, input.projectId);
    if (latestRuntime.ok) {
      const evidence = runtimeEvidenceFromRecord(latestRuntime.data);
      /** Only a failure recorded for the source this run starts from is relevant. */
      runtimeFailureContext = runtimeEvidenceMatchesSource(evidence, before)
        ? runtimeRepairSummary(evidence)
        : null;
    }
  }
  const generationPlanContext = [
    planContext,
    repairContext
      ? subordinateContextBlock("Prior repair findings", repairContext, 4_000)
      : null,
    runtimeFailureContext
      ? subordinateContextBlock("Live sandbox failure", runtimeFailureContext, 2_500)
      : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
  const codingRoleModel = orchestration
    ? resolveRoleModel({
        role: "coding",
        env: process.env,
        projectId: input.projectId,
      })
    : null;
  if (orchestration && !codingRoleModel) {
    return fail(input, guard, {
      message: "The pinned model for the coding role is not available in the enabled OpenRouter catalog.",
      before,
      baseline,
      signals: { code: "ROLE_MODEL_UNAVAILABLE" },
    });
  }

  /**
   * The PLANNING policy (site type unknown yet) decides whether the planner is
   * asked for images at all; the RUN policy is recomputed after the plan names a
   * site category, because only an authorized large catalog may exceed the
   * standard ceiling.
   */
  const planningPolicy = imagePlanningPolicyFor({
    siteType: "other",
    projectId: input.projectId,
    projectType,
    providerConfigured: isAiConfigured(),
  });

  const nextGenerationInput: AgentGenerationInput = {
    projectId: input.projectId,
    prompt: input.prompt,
    mode,
    projectType,
    androidPackage,
    existingFiles: before,
    budgetMs: generationBudgetMs,
    managedBackendContext,
    ...(backendContract ? { backendContract } : {}),
    ...(memory.used
      ? {
          contextFiles: memory.contextFiles,
          memoryContext: memory.memoryText,
          planning: true,
        }
      : {}),
    requestedModel: codingRoleModel?.id ?? input.requestedModel,
    designContext: design.data,
    /**
     * The planner is asked for a structured image plan only when the feature is
     * enabled for this deployment. The guidance quotes the STANDARD ceiling (the
     * planner cannot know its own site category yet); the real policy is applied
     * after the plan is validated.
     */
    ...(planningPolicy.enabled
      ? { imagePlanning: { addendum: plannerImageAddendum(planningPolicy) } }
      : {}),
    ...(generationPlanContext ? { planContext: generationPlanContext } : {}),
    ...(designDirectives ? { designDirectives } : {}),
    ...(resumeManifest || completedPaths.length > 0 || nextBatchIndex > 0
      ? {
          resume: {
            manifest: resumeManifest,
            completedPaths,
            nextBatchIndex,
          },
        }
      : {}),
    onManifest,
    onBatch,
    onProgress,
  };
  generationInput = nextGenerationInput;
  /**
   * A resumed run reuses its persisted plan, so `onManifest` will not fire for
   * it. The image stage still has to run once here — that is what retries a
   * placement that was pending when the previous attempt ended, while leaving
   * already-ready assets untouched (they are skipped, not regenerated).
   */
  if (resumeManifest) await prepareImageStage(resumeManifest);
  const generated = await generateApp(
    nextGenerationInput,
    {
      // Keep the most recent provider request id for the run summary. Every
      // attempt is also persisted separately by the agent.
      complete: async (model, messages, options) => {
        const result = await chatCompletion(model, messages, options);
        latestProviderRequestId = result.metadata.providerRequestId;
        return result;
      },
      onProviderAttempt: async (event) => {
        if (!guard.trackProviderUsage || !guard.client || !guard.leaseToken) return;
        if (event.type === "dispatching") {
          const inputForStart = {
            attemptId: event.attemptId,
            runId,
            leaseToken: guard.leaseToken,
            userId: input.userId,
            projectId: input.projectId,
            workflowId: null,
            role: "coding",
            taskKey: `generation:${event.phase}`,
            attemptIndex: event.attempt,
            phase: event.phase,
            model: event.model,
          };
          let started = await beginProviderAttempt(inputForStart, guard.client);
          if (started.ok === false) {
            started = await beginProviderAttempt(inputForStart, guard.client);
          }
          if (started.ok === false || started.data !== "started") {
            throw new RunStoreError(
              started.ok === false
                ? `Provider attempt could not be recorded: ${started.code}`
                : "Provider attempt already exists; refusing duplicate dispatch.",
            );
          }
          return;
        }

        const attempt = event.attempt;
        if (!attempt.providerAttemptId) {
          emitGenerationEvent("credits.usage_recorded", {
            traceId: guard.traceId,
            runId,
            projectId: input.projectId,
            reason: "provider_attempt_id_missing",
            status: "deferred",
          });
          return;
        }
        const completed = await completeProviderAttempt(
          {
            attemptId: attempt.providerAttemptId,
            runId,
            model: attempt.model,
            providerRequestId: attempt.providerRequestId,
            status: attempt.status,
            finishReason: attempt.finishReason,
            promptTokens: attempt.promptTokens,
            completionTokens: attempt.completionTokens,
            cachedReadTokens: attempt.cachedReadTokens,
            cachedWriteTokens: attempt.cachedWriteTokens,
            reasoningTokens: attempt.reasoningTokens,
            totalTokens: attempt.totalTokens,
            errorCode: attempt.errorCode,
            retryAfterMs: attempt.retryAfterMs,
            actualCostUsd: attempt.costUsd,
            uncertain:
              attempt.status === null ||
              attempt.errorCode === "TIMEOUT" ||
              attempt.errorCode === "NETWORK" ||
              attempt.errorCode === "UNKNOWN",
          },
          guard.client,
        );
        if (completed.ok === false) {
          emitGenerationEvent("credits.usage_recorded", {
            traceId: guard.traceId,
            runId,
            projectId: input.projectId,
            reason: completed.code,
            status: "deferred",
          });
        }
      },
    },
  );

  if (isGenerationFailure(generated)) {
    if (orchestration) {
      try {
        await recordCodingFailed(orchestration, {
          message: generated.error,
          errorClass: generated.code,
          completedPaths: generated.partial.completedPaths,
          plannedPaths: resumeManifest?.files.map((file) => file.path) ?? [],
          files: before,
        });
      } catch (error) {
        console.warn(
          `[mavly] run ${runId}: could not record the orchestration failure:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return fail(input, guard, {
      message: generated.error,
      before,
      baseline,
      failure: generated,
    });
  }

  await assertRunOwned(input, guard);

  /**
   * The backend outcome is stated separately from the generation outcome. A
   * ready backend, a blocked request and a static site are three different
   * facts, and none of them may read as "CRUD works" when it does not.
   */
  const resultWithBackendBoundary = managedBackendSummary
    ? {
        ...generated.result,
        message: `${generated.result.message}\n\n${managedBackendSummary}`,
      }
    : generated.result;

  if (generated.result.deletedPaths.length > 0) {
    const deleted = await writeFiles(
      input.userId,
      input.projectId,
      [],
      generated.result.deletedPaths,
      client,
    );
    if (isStoreFailure(deleted)) {
      return fail(input, guard, {
        message: `Could not apply the generated deletions: ${deleted.error}`,
        before,
        baseline,
        /**
         * The generation itself SUCCEEDED; only persisting the deletions failed.
         * `failure` carries an `AgentGenerationFailure`, so passing the success
         * outcome here would be a type lie. The code alone classifies this as a
         * retryable persistence failure, matching the other persist-failure
         * sites above.
         */
        signals: { code: "GENERATION_PERSIST_FAILED" },
      });
    }
  }

  /**
   * ⚠️ THE IMAGE OUTCOME IS STATED SEPARATELY FROM THE GENERATION OUTCOME. A
   * partial or deferred image set must never read as a complete website image
   * set, and a failed image must not be hidden behind "built successfully".
   */
  const resultWithImages =
    imageStageSummary === null
      ? resultWithBackendBoundary
      : {
          ...resultWithBackendBoundary,
          message: `${resultWithBackendBoundary.message}\n\n${imageStageSummary}`,
        };

  return complete(
    input,
    guard,
    resultWithImages,
    before,
    baseline,
    writtenPaths.size,
    latestProviderRequestId,
    projectType,
    orchestration,
  );
}

// ── Terminal transitions ────────────────────────────────────────────────────

/**
 * The run finished and the files were written. The result state is captured as
 * its own recovery point, and the message is linked to the baseline so the
 * chat's restore action undoes THIS run.
 *
 * ⚠️ THE TERMINAL WRITE IS LAST AND FENCED. A completion that another attempt
 * or a cancellation won is reported as skipped, never as a success.
 */
async function complete(
  input: RunAgentInput,
  guard: RunGuard,
  result: AgentGenerationResult,
  before: readonly SnapshotFile[],
  baseline: SnapshotSummary | null,
  filesWritten: number,
  latestProviderRequestId: string | null,
  projectType: AgentProjectType,
  orchestration: OrchestrationHandle | null,
): Promise<RunAgentOutcome> {
  await assertRunOwned(input, guard);

  const after = await readCurrentFiles(input.projectId, guard.client);
  const diff = diffSource(before, after);
  const changed = !diff.unchanged;

  let resultSnapshot: SnapshotSummary | null = null;
  if (changed) {
    resultSnapshot = await captureResult(
      input,
      guard.client,
      after,
      diffPaths(diff),
      "The source this run produced",
    );
  }

  /**
   * ⚠️ THE RUN'S TOTAL, NOT THIS INVOCATION'S. `guard.prior*` was seeded ONCE
   * from the claimed row and extended only by work whose usage was not yet
   * persisted (the inline continuation). Adding this invocation's attempts to it
   * reports every provider call the run ever made, without re-reading the row
   * and counting this write twice. Cost is derived from the combined attempt
   * records, so an earlier unreported cost keeps the total unknown rather than
   * silently disappearing.
   */
  const usage = addUsage(guard.priorUsage, result.usage);
  const attempts = [...guard.priorAttempts, ...result.attempts];
  const cost = reportedCostOf(attempts);

  /**
   * ⚠️ THE RESTORE TARGET IS THE BASELINE — the state BEFORE the run. A user
   * who clicks "Restore Code" wants the code they had, not the code the agent
   * just produced.
   */
  const finished = await finishRun(
    input.runId,
    "done",
    undefined,
    {
      ...metadataPatch(usage, attempts, null),
      stage: "completed",
      filesWritten,
      providerRequestId: latestProviderRequestId ?? lastProviderRequestId(attempts),
      reportedCostUsd: cost.costUsd,
      costKnown: cost.known,
      ...guardPatch(guard),
    },
    guard.client,
  );

  if (!finished) {
    // A cancellation, a recovery, or a newer attempt finalized the run first.
    return { status: "skipped", runId: input.runId, reason: "finish_not_applied" };
  }

  /**
   * ⚠️ CREDIT SIDE EFFECTS FOLLOW THE TERMINAL RUN WRITE, NEVER PRECEDE IT.
   * Only the invocation that won the fenced completion may consume the hold.
   * A failure here is reported and repaired by the durable worker sweep or the
   * owner's next balance read; the run itself stays completed.
   */
  await settleRunCredits({
    runId: input.runId,
    projectId: input.projectId,
    traceId: guard.traceId,
    client: guard.client,
  });
  await recordRunUsage({
    runId: input.runId,
    projectId: input.projectId,
    traceId: guard.traceId,
    client: guard.client,
  });

  /**
   * ⚠️ THE REVIEWS ARE POST-RUN, AND THE USER IS TOLD SO. They deliberately run
   * after the terminal run write (moving them earlier would let a review failure
   * refund a delivered generation), so the run cannot be "un-completed" by them.
   * The chat therefore reports the run's own outcome AND the review's outcome as
   * two separate facts, instead of leaving the workspace claiming success while
   * the workflow says failed.
   */
  let reviewOutcome: CodingReviewOutcome | null = null;
  let reviewRecordFailed = false;
  if (orchestration) {
    try {
      reviewOutcome = await recordCodingCompleted(orchestration, {
        allFiles: after,
        changedPaths: diffPaths(diff),
      });
    } catch (error) {
      reviewRecordFailed = true;
      console.warn(
        `[mavly] run ${input.runId}: could not record orchestration completion:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  await insertMessage(
    input.projectId,
    "agent",
    result.message,
    "finished",
    changed ? baseline?.id ?? null : null,
    guard.client,
  );

  const reviewNotice = reviewOutcomeMessage(reviewOutcome, reviewRecordFailed);
  if (reviewNotice) {
    await insertMessage(input.projectId, "agent", reviewNotice, "regular", null, guard.client);
  }

  if (projectType === "android" && changed) {
    await insertMessage(
      input.projectId,
      "agent",
      "The Kotlin/Compose source is saved. This run did not build an APK or AAB; an isolated Android debug build can be requested from the workspace only when it is enabled for this project. Release signing, store publishing and Android hosting are not implemented.",
      "regular",
      null,
      guard.client,
    );
  }

  emitGenerationEvent("generation.completed", {
    traceId: guard.traceId,
    runId: input.runId,
    projectId: input.projectId,
    workerId: guard.workerId,
    attempt: guard.jobAttempt,
    durationMs: Date.now() - guard.startedAtMs,
    filesWritten,
    checkpoints: result.batches,
    model: result.model?.id,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    costUsd: cost.costUsd,
    costKnown: cost.known,
  });

  if (projectType === "website") {
    await handOffVerification(input, guard, resultSnapshot ?? baseline);
  }

  return { status: "completed", runId: input.runId };
}

/**
 * A truthful, user-facing statement about the post-generation reviews.
 *
 * Returns `null` when there was nothing to review (no orchestration) or when
 * every required review passed — the run's own message already covers that.
 */
function reviewOutcomeMessage(
  outcome: CodingReviewOutcome | null,
  recordFailed: boolean,
): string | null {
  if (recordFailed) {
    return "The source was generated and saved, but the post-generation review could not be recorded. The generation outcome is unchanged; see Agents & approvals for the current review state.";
  }
  if (!outcome || outcome.reviewsPassed) return null;

  const reasons = outcome.failedTasks.map((task) => `${task.title}: ${task.summary}`);
  if (outcome.criticalFindings > 0) {
    reasons.unshift(
      `Security review reported ${outcome.criticalFindings} critical finding(s).`,
    );
  }
  const detail = reasons.length > 0 ? ` ${reasons.slice(0, 3).join(" ")}` : "";
  return `The source was generated and saved, but the post-generation review did not pass.${detail} The saved files are unaffected and the generation run is complete. This review does not authorize a deployment: publishing still needs your own approved proposal in Agents & approvals.`;
}

/**
 * Hand the completed source to the durable verification queue.
 *
 * ⚠️ THE COMPARISON POINT IS THE STATE THIS RUN PRODUCED. A changed run hands
 * off its result snapshot; an unchanged run hands off the baseline, which is
 * the same content the run started with. With no usable snapshot there is
 * nothing immutable to verify, so nothing is enqueued.
 *
 * ⚠️ ONLY THE WORKER HAND-OFF EXISTS. Inline runs have no durable worker to
 * advance a verification, so enqueueing one would leave a row that never runs.
 */
async function handOffVerification(
  input: RunAgentInput,
  guard: RunGuard,
  snapshot: SnapshotSummary | null,
): Promise<void> {
  if (!input.worker) return;

  if (!snapshot) {
    emitVerificationEvent("verification.enqueue_skipped", {
      traceId: guard.traceId,
      runId: input.runId,
      projectId: input.projectId,
      reason: "no_snapshot",
    });
    return;
  }

  /**
   * A verification failure of any kind is reported as an event and never
   * changes the run's completed status.
   */
  await maybeEnqueueVerification({
    client: input.worker.client,
    projectId: input.projectId,
    runId: input.runId,
    snapshotId: snapshot.id,
    sourceHash: snapshot.sourceHash,
    traceId: guard.traceId,
  });
}

/**
 * The attempt failed. The worker classifies it, schedules a bounded retry when
 * that can plausibly help, and otherwise writes one terminal failure. The
 * inline path keeps its existing terminal behaviour.
 */
async function fail(
  input: RunAgentInput,
  guard: RunGuard,
  options: FailInput,
): Promise<RunAgentOutcome> {
  const { message, before, baseline, failure, signals } = options;

  const latest = await getRun(input.projectId, input.runId, guard.client);
  if (isStoreFailure(latest)) {
    // Write nothing: we cannot prove we still own the row. If this worker dies,
    // expired-lease recovery advances the job without deleting it.
    emitGenerationEvent("generation.worker_error", {
      traceId: guard.traceId,
      runId: input.runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      reason: "finalize_unavailable",
    });
    return { status: "skipped", runId: input.runId, reason: "finalize_unavailable" };
  }

  const current = latest.data;
  if (!current) return { status: "skipped", runId: input.runId, reason: "run_missing" };
  if (current.stage === "cancelled" || current.cancellation_requested_at) {
    return { status: "cancelled", runId: input.runId };
  }
  if (current.finished_at) {
    return { status: "skipped", runId: input.runId, reason: "already_finished" };
  }
  if (guard.leaseToken && current.lease_token !== guard.leaseToken) {
    return { status: "skipped", runId: input.runId, reason: "lease_lost" };
  }
  if (!guard.leaseToken && guard.claimedAt && current.claimed_at !== guard.claimedAt) {
    return { status: "skipped", runId: input.runId, reason: "superseded" };
  }

  const classification = classifyGenerationFailure({
    code: failure?.code,
    attemptErrorCode: signals?.attemptErrorCode ?? lastAttemptErrorCode(failure?.attempts),
    message,
    retryAfterSeconds:
      signals?.retryAfterSeconds ?? lastAttemptRetryAfterSeconds(failure?.attempts),
    /**
     * ⚠️ WHAT MAKES A TRUNCATION WORTH RETRYING. Verified checkpoints must be
     * skippable AND more than one planned path must remain; a lone oversized
     * file has already exhausted the agent's narrower split/compact attempts.
     */
    hasRecoverableProgress: hasRecoverableTruncationProgress(
      failure?.partial.completedPaths ?? [],
      parseManifest(current.generation_manifest)?.files.map((file) => file.path) ?? [],
    ),
  });

  /**
   * ⚠️ CUMULATIVE, AND COMPUTED ONCE. `guard.prior*` is what the run had before
   * this invocation; `failure` is what THIS invocation spent. The sum is what
   * the terminal write and the retry hand-off must carry. It is derived here
   * instead of re-reading the row so a repeated finalization cannot count the
   * same provider calls twice.
   */
  const usage = failure ? addUsage(guard.priorUsage, failure.usage) : guard.priorUsage;
  const attempts = failure
    ? [...guard.priorAttempts, ...failure.attempts]
    : [...guard.priorAttempts];
  const cost = reportedCostOf(attempts);

  if (classification.errorClass === "cancelled") {
    return { status: "cancelled", runId: input.runId };
  }
  if (classification.errorClass === "lease_lost") {
    return { status: "skipped", runId: input.runId, reason: "lease_lost" };
  }

  /**
   * ── Inline: ONE bounded continuation, no scheduler ────────────────────────
   *
   * The inline `after()` path has no queue to wait on and no lease to renew, so
   * a retry must happen immediately inside the same wall-clock budget. Only the
   * classes that are expected to behave differently on an immediate retry are
   * eligible (timeout, transient, truncation — where checkpoints narrow the
   * work). Rate limits need a wait and persistence failures need a healthy
   * store; both stay terminal here and remain resumable by the user or worker.
   *
   * ⚠️ NOTHING IS WRITTEN BEFORE THIS RETURN. No error message, no terminal
   * state and no "partial source of a failed run" snapshot: the run has not
   * failed yet, it is about to continue.
   */
  if (
    !guard.leaseToken &&
    classification.retryable &&
    isInlineRecoverable(classification.errorClass) &&
    guard.recoveryAttempts < MAX_INLINE_RECOVERY_ATTEMPTS &&
    remainingRunMs(guard.budget, Date.now()) >= MIN_INLINE_RECOVERY_WINDOW_MS
  ) {
    console.warn(
      `[mavly] agent run ${input.runId} will continue once inline (${classification.errorClass}).`,
    );
    emitGenerationEvent("generation.retry_scheduled", {
      traceId: guard.traceId,
      runId: input.runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      attempt: guard.recoveryAttempts + 1,
      maxAttempts: MAX_INLINE_RECOVERY_ATTEMPTS,
      errorClass: classification.errorClass,
      reason: "inline_recovery",
      retryAfterSeconds: 0,
    });
    return {
      status: "retry",
      runId: input.runId,
      errorClass: classification.errorClass,
      retryAfterSeconds: 0,
      /** The loop carries this into the continuation; it is not persisted yet. */
      usage,
      attempts,
    };
  }

  console.error(
    `[mavly] agent run ${input.runId} failed (${classification.errorClass}):`,
    classification.summary,
  );

  let restoreTarget: string | null = null;
  if (before) {
    const after = await readCurrentFiles(input.projectId, guard.client);
    const diff = diffSource(before, after);
    if (!diff.unchanged) {
      await captureResult(
        input,
        guard.client,
        after,
        diffPaths(diff),
        "The partial source of a failed run",
      );
      restoreTarget = baseline?.id ?? null;
    }
  }

  // ── Worker: bounded retry, then dead letter ───────────────────────────────
  if (
    guard.leaseToken &&
    guard.client &&
    classification.retryable &&
    guard.jobAttempt < guard.maxAttempts
  ) {
    const retryAfterSeconds = retryDelaySeconds(guard.jobAttempt);
    /**
     * ⚠️ PERSIST BEFORE THE RETRY IS SCHEDULED. A worker retry is a NEW
     * invocation with a NEW guard, so usage held only in memory would be lost.
     * These are absolute cumulative counters — the next claim seeds from this
     * row — and the attempt records ride along so the eventual cost is still
     * derived from real provider numbers instead of an estimate. A failed write
     * means the lease is no longer ours: do not schedule, let lease recovery
     * advance the job.
     */
    const usagePersisted = await heartbeatRun(
      input.runId,
      {
        attemptCount: usage.attempts,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        providerAttempts: attempts,
        expectedLeaseToken: guard.leaseToken,
        leaseSeconds: WORKER_LEASE_SECONDS,
      },
      guard.client,
    );
    if (!usagePersisted) {
      emitGenerationEvent("generation.worker_error", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        reason: "retry_state_persist_failed",
      });
      return { status: "skipped", runId: input.runId, reason: "retry_state_persist_failed" };
    }

    const scheduled = await scheduleGenerationRetry(guard.client, {
      runId: input.runId,
      leaseToken: guard.leaseToken,
      errorClass: classification.errorClass,
      errorSummary: classification.summary,
      retryAfterSeconds,
    });

    if (isStoreFailure(scheduled)) {
      // The lease is still ours and the run remains unfinished; the next
      // recovery pass or the scheduler can retry it. Never claim a retry here.
      emitGenerationEvent("generation.worker_error", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        reason: "retry_schedule_failed",
      });
      return { status: "skipped", runId: input.runId, reason: "retry_schedule_failed" };
    }

    if (scheduled.data.status === "retry") {
      emitGenerationEvent("generation.retry_scheduled", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        attempt: scheduled.data.attempt,
        maxAttempts: guard.maxAttempts,
        errorClass: classification.errorClass,
        retryAfterSeconds: scheduled.data.retryAfterSeconds,
      });
      return {
        status: "retry",
        runId: input.runId,
        errorClass: classification.errorClass,
        retryAfterSeconds: scheduled.data.retryAfterSeconds,
      };
    }

    if (scheduled.data.status === "dead_letter") {
      const note =
        guard.jobAttempt >= guard.maxAttempts
          ? ` The generation stopped after ${guard.jobAttempt} attempt(s). You can resume this run from the workspace.`
          : "";
      await insertMessage(
        input.projectId,
        "agent",
        `${message}${note}`,
        "error",
        restoreTarget,
        guard.client,
      );
      emitGenerationEvent("generation.dead_letter", {
        traceId: guard.traceId,
        runId: input.runId,
        projectId: input.projectId,
        workerId: guard.workerId,
        attempt: guard.jobAttempt,
        maxAttempts: guard.maxAttempts,
        errorClass: classification.errorClass,
      });
      return {
        status: "dead_letter",
        runId: input.runId,
        errorClass: classification.errorClass,
      };
    }

    return { status: "skipped", runId: input.runId, reason: "lease_lost" };
  }

  /**
   * A retryable failure with no attempt budget left is the real dead-letter
   * path; `schedule_generation_retry` only sees that branch if the guard's
   * attempt count is stale. Record the timestamp so recovery queries and
   * operator alerts agree.
   */
  const exhausted =
    !!guard.leaseToken &&
    classification.retryable &&
    guard.jobAttempt >= guard.maxAttempts;

  // ── Terminal failure ──────────────────────────────────────────────────────
  const finished = await finishRun(
    input.runId,
    "error",
    message,
    {
      /**
       * ⚠️ EVERY TERMINAL FAILURE CARRIES THE PROVIDER ATTEMPTS IT ACTUALLY MADE.
       * Gating this on `failure` silently dropped the attempt records and usage
       * of a run that failed after real provider calls (a checkpoint or
       * persistence failure), which then looked like a free run.
       */
      ...(attempts.length > 0
        ? metadataPatch(usage, attempts, failure?.code ?? null)
        : { stage: "failed" as const }),
      stage: "failed",
      errorClass: classification.errorClass,
      errorSummary: classification.summary,
      reportedCostUsd: cost.costUsd,
      costKnown: cost.known,
      ...(exhausted ? { deadLetter: true } : {}),
      ...guardPatch(guard),
    },
    guard.client,
  );

  if (!finished) {
    return { status: "skipped", runId: input.runId, reason: "finish_not_applied" };
  }

  /**
   * ⚠️ A TERMINAL FAILURE RELEASES ITS HOLD. The RPC re-reads the run row and
   * refuses anything that is not genuinely terminal and unsuccessful, so this
   * call cannot un-charge a completed run.
   */
  await releaseRunCredits({
    runId: input.runId,
    projectId: input.projectId,
    traceId: guard.traceId,
    client: guard.client,
    reason: `Run failed before completion (${classification.errorClass})`,
  });
  await recordRunUsage({
    runId: input.runId,
    projectId: input.projectId,
    traceId: guard.traceId,
    client: guard.client,
  });

  await insertMessage(
    input.projectId,
    "agent",
    message,
    "error",
    restoreTarget,
    guard.client,
  );
  await touchProject(input.userId, input.projectId, guard.client);

  emitGenerationEvent("generation.failed", {
    traceId: guard.traceId,
    runId: input.runId,
    projectId: input.projectId,
    workerId: guard.workerId,
    attempt: guard.jobAttempt,
    maxAttempts: guard.maxAttempts,
    errorClass: classification.errorClass,
    durationMs: Date.now() - guard.startedAtMs,
    filesWritten: writtenCount(before, failure),
    costUsd: cost.costUsd,
    costKnown: cost.known,
  });

  if (exhausted) {
    emitGenerationEvent("generation.dead_letter", {
      traceId: guard.traceId,
      runId: input.runId,
      projectId: input.projectId,
      workerId: guard.workerId,
      attempt: guard.jobAttempt,
      maxAttempts: guard.maxAttempts,
      errorClass: classification.errorClass,
    });
  }

  return { status: "failed", runId: input.runId, errorClass: classification.errorClass };
}

function guardPatch(guard: RunGuard): Partial<RunFinishPatch> {
  if (guard.leaseToken) return { expectedLeaseToken: guard.leaseToken };
  if (guard.claimedAt) return { expectedClaimedAt: guard.claimedAt };
  return {};
}

function metadataPatch(
  usage: AgentUsageTotals,
  attempts: readonly AgentProviderAttempt[],
  errorCode: string | null,
): RunFinishPatch {
  const last =
    [...attempts].reverse().find((attempt) => !!attempt.providerRequestId) ??
    attempts[attempts.length - 1] ??
    null;

  return {
    errorCode,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    attemptCount: usage.attempts,
    providerAttempts: attempts,
    providerRequestId: last?.providerRequestId ?? null,
    modelUsed: last?.model ?? null,
    finishReason: last?.finishReason ?? null,
    retryAfterSeconds:
      last?.retryAfterMs !== null && last?.retryAfterMs !== undefined
        ? Math.ceil(last.retryAfterMs / 1_000)
        : null,
  };
}

function lastProviderRequestId(attempts: readonly AgentProviderAttempt[]): string | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const id = attempts[index]?.providerRequestId;
    if (id) return id;
  }
  return null;
}

function lastAttemptErrorCode(
  attempts: readonly AgentProviderAttempt[] | undefined,
): string | null {
  if (!attempts || attempts.length === 0) return null;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const code = attempts[index]?.errorCode;
    if (code) return code;
  }
  return null;
}

function lastAttemptRetryAfterSeconds(
  attempts: readonly AgentProviderAttempt[] | undefined,
): number | null {
  if (!attempts || attempts.length === 0) return null;
  const retryAfterMs = attempts[attempts.length - 1]?.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
    ? Math.max(0, Math.ceil(retryAfterMs / 1_000))
    : null;
}

function writtenCount(
  before: readonly SnapshotFile[] | undefined,
  failure: AgentGenerationFailure | undefined,
): number {
  // The run row already holds the durable checkpoint count; this event field is
  // informational only. Completed paths are the only verified count available
  // without another read.
  if (before && failure) return failure.partial.completedPaths.length;
  return 0;
}

/** The project's files right now. A read failure is an empty list, not a crash. */
async function readCurrentFiles(
  projectId: string,
  client: SupabaseClient | null,
): Promise<SnapshotFile[]> {
  const current = await listFiles(projectId, client);
  if (isStoreFailure(current)) return [];
  return current.data.map((file) => ({ path: file.path, content: file.content }));
}

/**
 * Capture the state this run started from, unless this run already has one.
 *
 * ⚠️ A FAILED SNAPSHOT IS REPORTED IN THE CHAT. The run is not abandoned — the
 * work would be lost — but the user is told, in the conversation, that this
 * particular change cannot be undone from here.
 */
async function ensureBaseline(
  input: RunAgentInput,
  files: readonly SnapshotFile[],
  client: SupabaseClient | null,
): Promise<SnapshotSummary | null> {
  const existing = await listSnapshots(input.projectId, { limit: 200 }, client);
  if (!isSnapshotFailure(existing)) {
    const baseline = existing.data.find(
      (snapshot) => snapshot.runId === input.runId && snapshot.kind === "baseline",
    );
    if (baseline) return baseline;
  }

  const snapshot = await createSnapshot(
    {
      userId: input.userId,
      projectId: input.projectId,
      kind: "baseline",
      description: `Before this run: ${input.prompt.slice(0, 200)}`,
      files,
      runId: input.runId,
    },
    client,
  );

  if (isSnapshotFailure(snapshot)) {
    await insertMessage(
      input.projectId,
      "agent",
      "Warning: we could not save a recovery point for this run, so this change cannot be undone from the chat.",
      "error",
      null,
      client,
    );
    return null;
  }
  return snapshot.data;
}

/** Capture a source state as a recovery point. */
async function captureResult(
  input: RunAgentInput,
  client: SupabaseClient | null,
  files: readonly SnapshotFile[],
  changedPaths: readonly string[],
  description: string,
): Promise<SnapshotSummary | null> {
  const snapshot = await createSnapshot(
    {
      userId: input.userId,
      projectId: input.projectId,
      kind: "result",
      description,
      files,
      changedPaths,
      runId: input.runId,
    },
    client,
  );

  if (isSnapshotFailure(snapshot)) {
    console.error("[mavly] result snapshot failed:", snapshot.error);
    return null;
  }
  return snapshot.data;
}

function parseManifest(value: unknown): AgentManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.files) || record.files.length === 0) return null;

  const files: AgentManifest["files"] = [];
  for (const entry of record.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const file = entry as Record<string, unknown>;
    const path = sanitizeProjectPath(file.path);
    if (!path) return null;
    const estimated =
      typeof file.estimatedBytes === "number" && Number.isFinite(file.estimatedBytes)
        ? file.estimatedBytes
        : 8_000;
    files.push({ path, estimatedBytes: Math.max(0, Math.floor(estimated)) });
  }

  const deletedPaths: string[] = [];
  if (Array.isArray(record.deletedPaths)) {
    for (const raw of record.deletedPaths) {
      const path = sanitizeProjectPath(raw);
      if (path && !deletedPaths.includes(path)) deletedPaths.push(path);
    }
  }

  const rawBackendRequirement = record.backendRequirement;
  const backendRecord =
    rawBackendRequirement &&
    typeof rawBackendRequirement === "object" &&
    !Array.isArray(rawBackendRequirement)
      ? rawBackendRequirement as Record<string, unknown>
      : null;

  /**
   * ⚠️ THE IMAGE PLAN SURVIVES A RESUME. Without this, a resumed run would
   * silently lose its approved image plan and its pending placements would
   * never be retried. The array is re-validated, never trusted as stored.
   */
  const resumeImages = validateImagePlan({
    siteType: record.imageSiteType,
    images: record.images,
  });

  /**
   * A resumed run must keep the validated data model it was planned with;
   * otherwise the managed-backend stage would block a run that already has a
   * usable plan. It is re-validated, never trusted as stored.
   */
  const resumeModel = parseAppDataModel(record.dataModel);
  const resumeModelFields =
    backendRecord?.requiresDatabase === true && resumeModel.ok
      ? { dataModel: resumeModel.model }
      : backendRecord?.requiresDatabase === true
        ? { dataModelIssue: (resumeModel as { ok: false; error: string }).error }
        : {};

  return {
    message:
      typeof record.message === "string"
        ? record.message.slice(0, 8_000)
        : "Updated the project.",
    ...(resumeImages.ok && resumeImages.plan.images.length > 0
      ? { images: resumeImages.plan.images, imageSiteType: resumeImages.plan.siteType }
      : {}),
    ...(typeof record.plan === "string" && record.plan.trim()
      ? { plan: record.plan.trim().slice(0, 2_000) }
      : {}),
    ...(backendRecord
      ? {
          backendRequirement: {
            requiresDatabase: backendRecord.requiresDatabase === true,
            reason:
              typeof backendRecord.reason === "string"
                ? backendRecord.reason.trim().slice(0, 240)
                : "",
          },
        }
      : {}),
    ...resumeModelFields,
    files,
    deletedPaths,
  };
}
