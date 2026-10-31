/**
 * ═══ RESTORING A SOURCE STATE ═══════════════════════════════════════════════
 *
 * A restore replaces the project's source with the exact state a snapshot holds:
 * files the snapshot has are written, files the project has and the snapshot
 * does not are removed, and files in both are overwritten with the snapshot's
 * content.
 *
 * ⚠️ A RESTORE IS ITSELF RECOVERABLE. Before anything is written, the CURRENT
 * state is captured as a 'pre_restore' snapshot. A user who undoes a restore by
 * accident can restore the pre-restore point and get their work back.
 *
 * ⚠️ A STALE RESTORE IS REFUSED. The caller may pass the source hash it was
 * looking at; if the project has changed since, the restore is rejected with
 * `source_conflict` instead of overwriting work that appeared in the meantime.
 *
 * ⚠️ NOTHING ELSE IS TOUCHED. Only `project_files` changes: the conversation,
 * the runs, the metadata and the GitHub connection stay exactly as they were.
 * Restoring never pushes to GitHub and never deploys.
 */

import {
  createSnapshot,
  diffPaths,
  diffSource,
  getSnapshot,
  hashSource,
  isSnapshotFailure,
  markSnapshotRestored,
  type SnapshotFile,
  type SnapshotResult,
} from "./snapshots";
import { getProject, isStoreFailure, listFiles, writeFiles } from "./store";
import { isAgentControlPath } from "@/lib/project-rules/rules";

export interface RestoreInput {
  userId: string;
  projectId: string;
  snapshotId: string;
  /** The source hash the caller saw when it asked to restore. */
  expectedSourceHash?: string | null;
  /** A short description of why the restore is happening. */
  description?: string;
}

export interface RestoreOutcome {
  snapshotId: string;
  /** The snapshot that holds the pre-restore state. */
  recoverySnapshotId: string;
  added: string[];
  modified: string[];
  removed: string[];
  /** The hash of the source after the restore. */
  sourceHash: string;
  fileCount: number;
}

/**
 * Restore a snapshot over the project.
 *
 * The order matters: the pre-restore snapshot is written BEFORE the project
 * files change, so there is always a point to come back to, even if the write
 * half way through fails.
 */
export async function restoreSnapshot(
  input: RestoreInput,
): Promise<SnapshotResult<RestoreOutcome>> {
  const project = await getProject(input.userId, input.projectId);
  if (isStoreFailure(project)) {
    return { ok: false, error: "Could not load the project", code: "store_unavailable" };
  }
  if (!project.data) {
    return { ok: false, error: "Project not found", code: "snapshot_missing" };
  }
  const preserveControlFiles = project.data.project_type === "website";

  const target = await getSnapshot(input.projectId, input.snapshotId);
  if (isSnapshotFailure(target)) return target;

  if (target.data.status !== "ready") {
    return {
      ok: false,
      error: "That recovery point could not be saved completely and cannot be restored.",
      code: "snapshot_not_ready",
    };
  }

  const current = await listFiles(input.projectId);
  if (isStoreFailure(current)) {
    return { ok: false, error: "Could not read the project files", code: "store_unavailable" };
  }

  const currentFiles: SnapshotFile[] = current.data.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  // A stale restore is refused: the project changed since the caller looked.
  if (input.expectedSourceHash) {
    const actual = hashSource(currentFiles);
    if (actual !== input.expectedSourceHash) {
      return {
        ok: false,
        error:
          "This project changed since you opened the recovery point. Reload and try again so nothing is overwritten.",
        code: "source_conflict",
      };
    }
  }

  /**
   * ⚠️ THE CONTROL FILES ARE NOT PART OF A RESTORE. `.mavly/` is server-owned:
   * restoring an older source state must not delete the rules or roll the
   * bounded work history backwards. Older snapshots taken before the control
   * files existed therefore restore the source without removing them.
   */
  const isControl = (file: SnapshotFile) =>
    preserveControlFiles && isAgentControlPath(file.path);
  const currentSource = currentFiles.filter((file) => !isControl(file));
  const targetSource = target.data.files.filter((file) => !isControl(file));
  const currentControl = currentFiles.filter(isControl);
  // Snapshot contents can never create or replace a website control file.
  const controlFiles = new Map(currentControl.map((file) => [file.path, file] as const));

  const diff = diffSource(currentSource, targetSource);

  // The recovery point for the state we are about to replace.
  const recovery = await createSnapshot({
    userId: input.userId,
    projectId: input.projectId,
    kind: "pre_restore",
    description:
      input.description?.slice(0, 400) ||
      `Before restoring the recovery point from ${target.data.createdAt}`,
    files: currentFiles,
    changedPaths: diffPaths(diff),
    restoreOfSnapshotId: target.data.id,
  });
  if (isSnapshotFailure(recovery)) {
    // Without the recovery point the restore would be a one-way door. Refuse it.
    return {
      ok: false,
      error:
        "We could not save the current state, so the restore was stopped. Nothing was changed.",
      code: "store_unavailable",
    };
  }

  const targetPaths = new Set(targetSource.map((file) => file.path));
  const removedPaths = currentSource
    .map((file) => file.path)
    .filter((path) => !targetPaths.has(path));

  const written = await writeFiles(
    input.userId,
    input.projectId,
    targetSource,
    removedPaths,
  );
  if (isStoreFailure(written)) {
    return {
      ok: false,
      error: "Could not write the restored files",
      code: "store_unavailable",
    };
  }

  await markSnapshotRestored(target.data.id);

  return {
    ok: true,
    data: {
      snapshotId: target.data.id,
      recoverySnapshotId: recovery.data.id,
      added: diff.added,
      modified: diff.modified,
      removed: diff.removed,
      /**
       * Current control files were deliberately preserved, so the resulting hash is
       * the target source plus the control files that are still on disk — not
       * the older snapshot's own `.mavly` content.
       */
      sourceHash: hashSource([...targetSource, ...controlFiles.values()]),
      fileCount: targetSource.length + controlFiles.size,
    },
  };
}
