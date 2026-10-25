/**
 * ═══ CHECKPOINT VERIFICATION FOR A RESUMED RUN ══════════════════════════════
 *
 * A checkpoint is only reusable when the project still contains exactly the
 * bytes that batch wrote. The user can edit files between an interruption and a
 * resume, and replaying a stale completion list would then skip files that no
 * longer match their checkpoint.
 *
 * This module is pure: the caller supplies the persisted batch rows and the
 * project's current files. Ownership/RLS and run↔project binding are enforced
 * by the store queries before this runs.
 */

import { createHash } from "node:crypto";

import type { AgentFile } from "@/lib/ai/agent";
import type { RunBatchRow } from "./store";

export function hashFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface VerifiedCheckpoints {
  /** Paths whose content still matches the checkpoint that wrote them. */
  completedPaths: string[];
  /** Checkpoint indexes already persisted; new batches continue after these. */
  nextBatchIndex: number;
  /** Paths that were checkpointed but whose current content differs. */
  mismatchedPaths: string[];
}

export function verifyCheckpointBatches(
  batches: readonly RunBatchRow[],
  currentFiles: readonly AgentFile[],
): VerifiedCheckpoints {
  const currentHashes = new Map<string, string>();
  for (const file of currentFiles) {
    currentHashes.set(file.path, hashFileContent(file.content));
  }

  const completed = new Set<string>();
  const mismatched = new Set<string>();
  let nextBatchIndex = 0;

  const ordered = [...batches].sort((a, b) => a.batch_index - b.batch_index);
  for (const batch of ordered) {
    nextBatchIndex = Math.max(nextBatchIndex, batch.batch_index + 1);
    if (batch.status !== "done") continue;

    for (const path of batch.paths) {
      const expected = batch.path_hashes[path];
      const actual = currentHashes.get(path);
      if (expected && actual && expected === actual) {
        completed.add(path);
        mismatched.delete(path);
      } else {
        mismatched.add(path);
        completed.delete(path);
      }
    }
  }

  return {
    completedPaths: [...completed].sort((a, b) => a.localeCompare(b)),
    nextBatchIndex,
    mismatchedPaths: [...mismatched].sort((a, b) => a.localeCompare(b)),
  };
}
