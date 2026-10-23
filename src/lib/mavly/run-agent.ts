/**
 * Background execution for one agent run.
 *
 * The HTTP route creates the run row and returns immediately; `after()` calls
 * this function. It reads the current files as context, asks OpenRouter for a
 * full-stack app, validates the answer, and stores the files and final message.
 * No generated code is executed here.
 *
 * ═══ THE RESTORE POINT ══════════════════════════════════════════════════════
 *
 * Before the agent is allowed to change anything, the CURRENT source state is
 * captured as a durable snapshot — the 'baseline' of this run. That snapshot is
 * what the chat's "Restore Code" action restores, so a run that deletes or
 * mangles a file can be undone from the conversation itself, with no GitHub
 * connection and no external service involved.
 *
 * ⚠️ THE BASELINE IS TAKEN BEFORE THE FIRST WRITE, NOT AFTER. A snapshot of the
 * state the agent produced would restore the damage, not undo it.
 *
 * ⚠️ A RUN THAT CHANGED NOTHING GETS NO BUTTON. The result state is compared
 * with the baseline; when they are identical the run is recorded as a no-change
 * run and no restore action is offered, because there is nothing to undo.
 *
 * ⚠️ A FAILED RUN IS NOT SILENTLY SWALLOWED. If the run failed after changing
 * some files, the resulting partial state is captured as its own recovery point
 * and the error message is linked to the baseline, so the user can go back to
 * the last good state.
 *
 * ⚠️ A SNAPSHOT THAT FAILED TO SAVE IS VISIBLE. The run continues (the work is
 * not thrown away), but a warning is written into the conversation, because a
 * user who believes they can undo a change cannot.
 */

import {
  generateApp,
  isGenerationFailure,
  REQUIRED_CREATE_PATHS,
} from "@/lib/ai/agent";
import {
  finishRun,
  insertMessage,
  isStoreFailure,
  listFiles,
  touchProject,
  writeFiles,
} from "./store";
import {
  createSnapshot,
  diffPaths,
  diffSource,
  isSnapshotFailure,
  type SnapshotFile,
  type SnapshotSummary,
} from "./snapshots";
import { loadFigmaDesignContext } from "@/lib/integrations/figma/service";

export interface RunAgentInput {
  userId: string;
  projectId: string;
  runId: string;
  prompt: string;
  requestedModel?: string | null;
}

export async function runAgent(input: RunAgentInput): Promise<void> {
  try {
    await execute(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fail(input, `The agent run failed unexpectedly: ${message}`);
  }
}

async function execute(input: RunAgentInput): Promise<void> {
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
    await fail(input, design.error);
    return;
  }

  const current = await listFiles(input.projectId);
  if (isStoreFailure(current)) {
    await fail(input, `Could not read the project files: ${current.error}`);
    return;
  }

  const before: SnapshotFile[] = current.data.map((file) => ({
    path: file.path,
    content: file.content,
  }));
  const existingPaths = new Set(before.map((file) => file.path));
  const isComplete = REQUIRED_CREATE_PATHS.every((path) => existingPaths.has(path));
  const mode = isComplete ? "update" : "create";

  /**
   * ⭐ THE BASELINE OF THIS RUN. Taken before the agent runs, so it is the state
   * the user had — the one the "Restore Code" action brings back.
   */
  const baseline = await captureBaseline(input, before);

  const generated = await generateApp({
    prompt: input.prompt,
    mode,
    existingFiles: before,
    requestedModel: input.requestedModel,
    designContext: design.data,
  });

  if (isGenerationFailure(generated)) {
    await fail(input, generated.error, before, baseline);
    return;
  }

  const written = await writeFiles(
    input.userId,
    input.projectId,
    generated.result.files,
    generated.result.deletedPaths,
  );
  if (isStoreFailure(written)) {
    await fail(input, `Could not save the generated files: ${written.error}`, before, baseline);
    return;
  }

  await complete(input, generated.result.message, before, baseline);
}

/**
 * The run finished and the files were written. The result state is captured as
 * its own recovery point, and the message is linked to the baseline so the
 * chat's restore action undoes THIS run.
 */
async function complete(
  input: RunAgentInput,
  message: string,
  before: readonly SnapshotFile[],
  baseline: SnapshotSummary | null,
): Promise<void> {
  const after = await readCurrentFiles(input.projectId);
  const diff = diffSource(before, after);
  const changed = !diff.unchanged;

  if (changed) {
    await captureResult(input, after, diffPaths(diff), "The source this run produced");
  }

  /**
   * ⚠️ THE RESTORE TARGET IS THE BASELINE — the state BEFORE the run. A user
   * who clicks "Restore Code" wants the code they had, not the code the agent
   * just produced.
   */
  await insertMessage(
    input.projectId,
    "agent",
    message,
    "finished",
    changed ? baseline?.id ?? null : null,
  );
  await finishRun(input.runId, "done");
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
): Promise<void> {
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
  await finishRun(input.runId, "error", message);
  await touchProject(input.userId, input.projectId);
}

/** The project's files right now. A read failure is an empty list, not a crash. */
async function readCurrentFiles(projectId: string): Promise<SnapshotFile[]> {
  const current = await listFiles(projectId);
  if (isStoreFailure(current)) return [];
  return current.data.map((file) => ({ path: file.path, content: file.content }));
}

/**
 * Capture the state this run started from.
 *
 * ⚠️ A FAILED SNAPSHOT IS REPORTED IN THE CHAT. The run is not abandoned — the
 * work would be lost — but the user is told, in the conversation, that this
 * particular change cannot be undone from here.
 */
async function captureBaseline(
  input: RunAgentInput,
  files: readonly SnapshotFile[],
): Promise<SnapshotSummary | null> {
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
