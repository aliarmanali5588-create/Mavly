/**
 * Background execution for one durable agent run.
 *
 * ═══ THE ORDER IS THE GUARANTEE ═════════════════════════════════════════════
 *
 *   1. CLAIM      — one caller moves the queued row to `validating`.
 *   2. BASELINE   — the state before the first write is captured once per run.
 *   3. MANIFEST   — the validated plan is persisted so a resume can reuse it.
 *   4. BATCH      — each validated batch is written, then checkpointed with
 *                   per-path hashes. A later failure preserves earlier batches.
 *   5. COMPLETE   — only after every planned file is present and valid.
 *
 * ⚠️ A TRUNCATED RESPONSE IS NEVER WRITTEN. `generateApp` validates a whole
 * batch before handing it here, and the agent discards any response with
 * `finish_reason: "length"`.
 *
 * ⚠️ A RESUME REUSES THE SAME RUN. The resume RPC reopens the interrupted row;
 * a new run row is not created, so the job identity, baseline and checkpoints
 * stay bound together.
 *
 * ⚠️ NO GENERATED CODE IS EXECUTED HERE.
 */

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
  getRun,
  heartbeatRun,
  insertMessage,
  isStoreFailure,
  listFiles,
  listRunBatches,
  recordRunBatch,
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

export interface RunAgentInput {
  userId: string;
  projectId: string;
  runId: string;
  prompt: string;
  requestedModel?: string | null;
  /** True when this is a resume of an interrupted/failed run. */
  resume?: boolean;
}

export async function runAgent(input: RunAgentInput): Promise<void> {
  const claimed = await claimRun(input.projectId, input.runId);
  if (isStoreFailure(claimed)) {
    console.error(`[mavly] could not claim run ${input.runId}:`, claimed.error);
    return;
  }
  if (!claimed.data) {
    // Another invocation owns this run, or it already reached a terminal state.
    console.warn(`[mavly] run ${input.runId} was already claimed or is not queued`);
    return;
  }

  const claimToken = claimed.data.claimed_at ?? claimed.data.started_at;

  try {
    await execute(input, claimed.data, claimToken);
  } catch (error) {
    if (error instanceof RunSupersededError) {
      // A resume claimed this run after this worker's lease went stale. The new
      // worker owns the run now; write nothing.
      return;
    }
    if (error instanceof RunCancelledError) {
      // `agent/cancel` already moved the row to `cancelled`; do not overwrite
      // that with a generic failure, and do not write any further batches.
      await finishRun(input.runId, "cancelled", "The run was cancelled by the user.", {
        stage: "cancelled",
        errorCode: "RUN_CANCELLED",
        expectedClaimedAt: claimToken,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await fail(input, `The agent run failed unexpectedly: ${message}`, undefined, undefined, undefined, claimToken);
  }
}

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

async function assertRunOwned(
  projectId: string,
  runId: string,
  claimToken: string,
): Promise<void> {
  const latest = await getRun(projectId, runId);
  if (isStoreFailure(latest)) {
    console.warn(`[mavly] could not re-read run ${runId} before a write:`, latest.error);
    return;
  }
  const current = latest.data;
  if (!current || current.claimed_at !== claimToken) {
    throw new RunSupersededError();
  }
  if (current.stage === "cancelled" || current.finished_at) {
    throw new RunCancelledError();
  }
}

async function execute(input: RunAgentInput, run: RunRow, claimToken: string): Promise<void> {
  const runId = input.runId;
  await heartbeatRun(runId, { stage: "validating", expectedClaimedAt: claimToken });
  await touchProject(input.userId, input.projectId);

  /**
   * A Figma link in the prompt is a reference the agent must actually read.
   * Resolve it before anything is written: a missing connection or an expired
   * token is a clear failure, not a reason to invent a design from the URL.
   */
  const design = await loadFigmaDesignContext({
    projectId: input.projectId,
    userId: input.userId,
    prompt: input.prompt,
  });
  if (design.ok === false) {
    await fail(input, design.error, undefined, undefined, undefined, claimToken);
    return;
  }

  await assertRunOwned(input.projectId, runId, claimToken);

  const current = await listFiles(input.projectId);
  if (isStoreFailure(current)) {
    await fail(input, `Could not read the project files: ${current.error}`, undefined, undefined, undefined, claimToken);
    return;
  }

  await assertRunOwned(input.projectId, runId, claimToken);

  const before: SnapshotFile[] = current.data.map((file) => ({
    path: file.path,
    content: file.content,
  }));
  const existingPaths = new Set(before.map((file) => file.path));
  const isComplete = REQUIRED_CREATE_PATHS.every((path) => existingPaths.has(path));
  const mode = isComplete ? "update" : "create";

  /**
   * ⭐ THE BASELINE OF THIS RUN. Created once, before the first write. On a
   * resume the original baseline is reused; a second one would hide the state
   * the user actually wants to restore to.
   */
  const baseline = await ensureBaseline(input, before);

  let resumeManifest: AgentManifest | null = parseManifest(run.generation_manifest);
  let completedPaths: string[] = [];
  let nextBatchIndex = 0;

  const batches = await listRunBatches(runId);
  if (isStoreFailure(batches)) {
    if (input.resume) {
      await fail(
        input,
        `Could not verify the saved checkpoints, so the run was not resumed: ${batches.error}`,
        before,
        baseline,
        undefined,
        claimToken,
      );
      return;
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
   * A resumed run needs its plan. If the manifest was not persisted (the run
   * died before planning finished), the agent plans again and still skips the
   * verified completed paths.
   */
  if (input.resume && !resumeManifest) {
    console.warn(`[mavly] run ${runId} has no persisted manifest; it will be re-planned`);
  }

  const writtenPaths = new Set<string>(completedPaths);
  let latestProviderRequestId: string | null = null;

  const onManifest = async (manifest: AgentManifest): Promise<void> => {
    const saved = await setRunManifest(runId, manifest, claimToken);
    if (isStoreFailure(saved)) {
      throw new Error(`Could not save the generation plan: ${saved.error}`);
    }
    resumeManifest = manifest;
  };

  const onBatch = async (batch: AgentBatchCheckpoint): Promise<void> => {
    await assertRunOwned(input.projectId, runId, claimToken);
    const written = await writeFiles(
      input.userId,
      input.projectId,
      batch.files,
      [],
    );
    if (isStoreFailure(written)) {
      throw new Error(`Could not save a generated batch: ${written.error}`);
    }

    for (const file of batch.files) writtenPaths.add(file.path);

    const checkpoint = await recordRunBatch({
      runId,
      projectId: input.projectId,
      batchIndex: batch.batchIndex,
      files: batch.files,
      filesWritten: writtenPaths.size,
      expectedClaimedAt: claimToken,
    });
    if (isStoreFailure(checkpoint)) {
      // The files are already written, but without a checkpoint a resume
      // cannot know they are complete. Failing here is honest; a retry will
      // rewrite the same idempotent paths and create the checkpoint.
      throw new Error(`Could not record the batch checkpoint: ${checkpoint.error}`);
    }
    await heartbeatRun(runId, { stage: "generating", expectedClaimedAt: claimToken });
  };

  const onProgress = async (event: AgentProgressEvent): Promise<void> => {
    if (event.type === "retrying") {
      await heartbeatRun(runId, {
        stage: "retrying",
        errorCode: event.retryAfterMs !== null ? "PROVIDER_RATE_LIMITED" : "PROVIDER_RETRY",
        retryAfterSeconds:
          event.retryAfterMs !== null ? Math.ceil(event.retryAfterMs / 1_000) : null,
        expectedClaimedAt: claimToken,
      });
      return;
    }
    if (event.type === "shrinking") {
      await heartbeatRun(runId, {
        stage: "retrying",
        errorCode: event.reason === "truncated" ? "GENERATION_TRUNCATED" : "GENERATION_COMPACT_RETRY",
        expectedClaimedAt: claimToken,
      });
      return;
    }
    if (event.type === "validating") {
      await heartbeatRun(runId, { stage: "validating", expectedClaimedAt: claimToken });
      return;
    }
    await heartbeatRun(runId, { stage: "generating", expectedClaimedAt: claimToken });
  };

  await heartbeatRun(runId, { stage: "generating", expectedClaimedAt: claimToken });

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
    await fail(input, generated.error, before, baseline, generated, claimToken);
    return;
  }

  await assertRunOwned(input.projectId, runId, claimToken);

  if (generated.result.deletedPaths.length > 0) {
    const deleted = await writeFiles(
      input.userId,
      input.projectId,
      [],
      generated.result.deletedPaths,
    );
    if (isStoreFailure(deleted)) {
      await fail(
        input,
        `Could not apply the generated deletions: ${deleted.error}`,
        before,
        baseline,
        undefined,
        claimToken,
      );
      return;
    }
  }

  await complete(
    input,
    generated.result,
    before,
    baseline,
    writtenPaths.size,
    latestProviderRequestId,
    claimToken,
  );
}

/**
 * The run finished and the files were written. The result state is captured as
 * its own recovery point, and the message is linked to the baseline so the
 * chat's restore action undoes THIS run.
 */
async function complete(
  input: RunAgentInput,
  result: AgentGenerationResult,
  before: readonly SnapshotFile[],
  baseline: SnapshotSummary | null,
  filesWritten: number,
  latestProviderRequestId: string | null,
  claimToken: string,
): Promise<void> {
  await assertRunOwned(input.projectId, input.runId, claimToken);
  const after = await readCurrentFiles(input.projectId);
  const diff = diffSource(before, after);
  const changed = !diff.unchanged;

  if (changed) {
    await captureResult(input, after, diffPaths(diff), "The source this run produced");
  }

  await assertRunOwned(input.projectId, input.runId, claimToken);

  /**
   * ⚠️ THE RESTORE TARGET IS THE BASELINE — the state BEFORE the run. A user
   * who clicks "Restore Code" wants the code they had, not the code the agent
   * just produced.
   */
  await insertMessage(
    input.projectId,
    "agent",
    result.message,
    "finished",
    changed ? baseline?.id ?? null : null,
  );
  await finishRun(input.runId, "done", undefined, {
    ...metadataPatch(result.usage, result.attempts, null),
    stage: "completed",
    filesWritten,
    providerRequestId: latestProviderRequestId ?? lastProviderRequestId(result.attempts),
    expectedClaimedAt: claimToken,
  });
}

/**
 * The run failed. If it failed after changing some files, the partial state is
 * captured as a recovery point and the error message points at the baseline.
 */
async function fail(
  input: RunAgentInput,
  message: string,
  before?: readonly SnapshotFile[],
  baseline?: SnapshotSummary | null,
  failure?: AgentGenerationFailure,
  claimToken?: string,
): Promise<void> {
  const latest = await getRun(input.projectId, input.runId);
  if (isStoreFailure(latest)) {
    // Continue: the terminal write below is claim-guarded and will no-op if
    // the run was superseded or cancelled.
  } else if (
    !latest.data ||
    (claimToken && latest.data.claimed_at !== claimToken) ||
    latest.data.stage === "cancelled" ||
    latest.data.finished_at
  ) {
    return;
  }

  console.error(`[mavly] agent run ${input.runId} failed:`, message);

  let restoreTarget: string | null = null;

  if (before) {
    const after = await readCurrentFiles(input.projectId);
    const diff = diffSource(before, after);
    if (!diff.unchanged) {
      await captureResult(input, after, diffPaths(diff), "The partial source of a failed run");
      restoreTarget = baseline?.id ?? null;
    }
  }

  await insertMessage(input.projectId, "agent", message, "error", restoreTarget);
  await finishRun(input.runId, "error", message, {
    ...(failure
      ? metadataPatch(failure.usage, failure.attempts, failure.code)
      : { stage: "failed" as const }),
    stage: "failed",
    ...(claimToken ? { expectedClaimedAt: claimToken } : {}),
  });
  await touchProject(input.userId, input.projectId);
}

function metadataPatch(
  usage: AgentUsageTotals,
  attempts: readonly AgentProviderAttempt[],
  errorCode: string | null,
): RunFinishPatch {
  const last = [...attempts].reverse().find((attempt) => !!attempt.providerRequestId) ??
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

/** The project's files right now. A read failure is an empty list, not a crash. */
async function readCurrentFiles(projectId: string): Promise<SnapshotFile[]> {
  const current = await listFiles(projectId);
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
): Promise<SnapshotSummary | null> {
  const existing = await listSnapshots(input.projectId, { limit: 200 });
  if (!isSnapshotFailure(existing)) {
    const baseline = existing.data.find(
      (snapshot) => snapshot.runId === input.runId && snapshot.kind === "baseline",
    );
    if (baseline) return baseline;
  }

  const snapshot = await createSnapshot({
    userId: input.userId,
    projectId: input.projectId,
    kind: "baseline",
    description: `Before this run: ${input.prompt.slice(0, 200)}`,
    files,
    runId: input.runId,
  });

  if (isSnapshotFailure(snapshot)) {
    await insertMessage(
      input.projectId,
      "agent",
      "Warning: we could not save a recovery point for this run, so this change cannot be undone from the chat.",
      "error",
    );
    return null;
  }
  return snapshot.data;
}

/** Capture a source state as a recovery point. */
async function captureResult(
  input: RunAgentInput,
  files: readonly SnapshotFile[],
  changedPaths: readonly string[],
  description: string,
): Promise<void> {
  const snapshot = await createSnapshot({
    userId: input.userId,
    projectId: input.projectId,
    kind: "result",
    description,
    files,
    changedPaths,
    runId: input.runId,
  });

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
    const estimated = typeof file.estimatedBytes === "number" && Number.isFinite(file.estimatedBytes)
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
    message: typeof record.message === "string" ? record.message.slice(0, 8_000) : "Updated the project.",
    files,
    deletedPaths,
  };
}
