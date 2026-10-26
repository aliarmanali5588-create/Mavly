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

import { chatCompletion } from "@/lib/ai/provider";
import {
  generateApp,
  isGenerationFailure,
  REQUIRED_CREATE_PATHS,
  sanitizeProjectPath,
  type AgentBatchCheckpoint,
  type AgentGenerationFailure,
  type AgentGenerationResult,
  type AgentManifest,
  type AgentProgressEvent,
  type AgentProviderAttempt,
  type AgentUsageTotals,
} from "@/lib/ai/agent";
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
import { loadFigmaDesignContext } from "@/lib/integrations/figma/service";
import {
  classifyGenerationFailure,
  type FailureSignals,
} from "@/lib/generation/state-machine";
import { retryDelaySeconds, WORKER_LEASE_SECONDS } from "@/lib/generation/leases";
import { reportedCostOf } from "@/lib/observability/cost";
import { emitGenerationEvent } from "@/lib/observability/events";

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
  | { status: "retry"; runId: string; errorClass: string; retryAfterSeconds: number }
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
}

interface FailInput {
  message: string;
  before?: readonly SnapshotFile[];
  baseline?: SnapshotSummary | null;
  failure?: AgentGenerationFailure;
  signals?: FailureSignals;
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
  const guard: RunGuard = {
    claimedAt: run.claimed_at ?? run.started_at,
    leaseToken: null,
    client: null,
    traceId: run.trace_id,
    workerId: null,
    jobAttempt: 1,
    maxAttempts: 1,
    startedAtMs: Date.now(),
  };

  try {
    return await execute(input, run, guard);
  } catch (error) {
    if (error instanceof RunSupersededError || error instanceof RunLeaseLostError) {
      // A newer attempt owns this run now; write nothing.
      return { status: "skipped", runId: input.runId, reason: "superseded" };
    }
    if (error instanceof RunCancelledError) {
      // The user's cancel is already terminal; do not overwrite it. The guarded
      // update below is a no-op when the cancellation landed first.
      await finishRun(input.runId, "cancelled", "The run was cancelled by the user.", {
        stage: "cancelled",
        errorCode: "RUN_CANCELLED",
        ...guardPatch(guard),
      });
      return { status: "cancelled", runId: input.runId };
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(input, guard, {
      message: `The agent run failed unexpectedly: ${message}`,
      ...(error instanceof RunStoreError
        ? { signals: { code: "GENERATION_PERSIST_FAILED" } }
        : {}),
    });
  }
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

  const guard: RunGuard = {
    claimedAt: run.claimed_at,
    leaseToken: worker.leaseToken,
    client: worker.client,
    traceId: worker.traceId,
    workerId: worker.workerId,
    jobAttempt: worker.jobAttempt,
    maxAttempts: worker.maxJobAttempts,
    startedAtMs: Date.now(),
  };

  try {
    return await execute(input, run, guard);
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
      return { status: "cancelled", runId: input.runId };
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(input, guard, {
      message: `The agent run failed unexpectedly: ${message}`,
      ...(error instanceof RunStoreError
        ? { signals: { code: "GENERATION_PERSIST_FAILED" } }
        : {}),
    });
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
  const isComplete = REQUIRED_CREATE_PATHS.every((path) => existingPaths.has(path));
  const mode = isComplete ? "update" : "create";

  /**
   * ⭐ THE BASELINE OF THIS RUN. Created once, before the first write. On a
   * retry/resume the original baseline is reused; a second one would hide the
   * state the user actually wants to restore to.
   */
  const baseline = await ensureBaseline(input, before, guard.client);

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
        event.reason === "truncated" ? "GENERATION_TRUNCATED" : "GENERATION_COMPACT_RETRY";
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

  const generated = await generateApp(
    {
      prompt: input.prompt,
      mode,
      existingFiles: before,
      requestedModel: input.requestedModel,
      designContext: design.data,
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
    },
    {
      // Keep the most recent provider request id for the run summary. Every
      // attempt is also persisted separately by the agent.
      complete: async (model, messages, options) => {
        const result = await chatCompletion(model, messages, options);
        latestProviderRequestId = result.metadata.providerRequestId;
        return result;
      },
    },
  );

  if (isGenerationFailure(generated)) {
    return fail(input, guard, {
      message: generated.error,
      before,
      baseline,
      failure: generated,
    });
  }

  await assertRunOwned(input, guard);

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

  return complete(
    input,
    guard,
    generated.result,
    before,
    baseline,
    writtenPaths.size,
    latestProviderRequestId,
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
): Promise<RunAgentOutcome> {
  await assertRunOwned(input, guard);

  const after = await readCurrentFiles(input.projectId, guard.client);
  const diff = diffSource(before, after);
  const changed = !diff.unchanged;

  if (changed) {
    await captureResult(
      input,
      guard.client,
      after,
      diffPaths(diff),
      "The source this run produced",
    );
  }

  const cost = reportedCostOf(result.attempts);

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
      ...metadataPatch(result.usage, result.attempts, null),
      stage: "completed",
      filesWritten,
      providerRequestId: latestProviderRequestId ?? lastProviderRequestId(result.attempts),
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

  await insertMessage(
    input.projectId,
    "agent",
    result.message,
    "finished",
    changed ? baseline?.id ?? null : null,
    guard.client,
  );

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

  return { status: "completed", runId: input.runId };
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
  });

  if (classification.errorClass === "cancelled") {
    return { status: "cancelled", runId: input.runId };
  }
  if (classification.errorClass === "lease_lost") {
    return { status: "skipped", runId: input.runId, reason: "lease_lost" };
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

  const cost = failure
    ? reportedCostOf(failure.attempts)
    : { costUsd: null, known: false };

  // ── Worker: bounded retry, then dead letter ───────────────────────────────
  if (
    guard.leaseToken &&
    guard.client &&
    classification.retryable &&
    guard.jobAttempt < guard.maxAttempts
  ) {
    const retryAfterSeconds = retryDelaySeconds(guard.jobAttempt);
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
      ...(failure
        ? metadataPatch(failure.usage, failure.attempts, failure.code)
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
): Promise<void> {
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
  }
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

  return {
    message:
      typeof record.message === "string"
        ? record.message.slice(0, 8_000)
        : "Updated the project.",
    files,
    deletedPaths,
  };
}
