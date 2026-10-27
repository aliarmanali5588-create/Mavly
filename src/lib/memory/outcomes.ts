/**
 * Record a TERMINAL, OBSERVED generation failure as future context.
 *
 * ⚠️ NEVER STORE THE RAW ERROR, PROMPT, MODEL OUTPUT OR PROVIDER BODY. The note
 * contains only the run status and its bounded error class. It explicitly says
 * the root cause is not verified, so a provider outage can never become a
 * "project code is broken" memory.
 * ⚠️ SUCCESS AND CANCELLATION ARE NOT STORED. Retries/leases already own the
 * recovery path; duplicating them in memory would add noise and stale claims.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isAgentMemoryProject, readAgentMemoryConfig } from "./config";
import { emitMemoryEvent } from "./events";
import {
  isMemoryFailure,
  recordRunFailureMemoryForOwner,
  upsertFailureMemory,
} from "./store";
import { failureMemoryContent, shouldRecordFailure } from "./summary";
import { MEMORY_LIMITS, type MemoryRunOutcome } from "./types";
import { memoryContentRejectionReason } from "./validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordRunFailureMemory(input: {
  client?: SupabaseClient | null;
  userId: string;
  projectId: string;
  outcome: MemoryRunOutcome;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const config = readAgentMemoryConfig(input.env);
  if (!("config" in config) || !isAgentMemoryProject(input.projectId, input.env)) return;
  if (!shouldRecordFailure(input.outcome)) return;
  if (!UUID.test(input.outcome.runId)) return;

  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + MEMORY_LIMITS.failureRetentionDays * 86_400_000,
  ).toISOString();
  const content = failureMemoryContent(input.outcome);
  if (memoryContentRejectionReason(content) !== null) {
    emitMemoryEvent("memory.invalid", {
      projectId: input.projectId,
      runId: input.outcome.runId,
      category: "failure",
      reason: "content_rejected",
    });
    return;
  }

  try {
    /**
     * Inline generation has only the owner's session; the table policy forbids a
     * client-created failure. The owner RPC derives the note from the terminal
     * run row. The worker has the confined service client and writes directly.
     */
    const recorded = input.client
      ? await upsertFailureMemory({
          client: input.client,
          projectId: input.projectId,
          userId: input.userId,
          runId: input.outcome.runId,
          content,
          expiresAt,
          now: now.toISOString(),
        })
      : await recordRunFailureMemoryForOwner({
          projectId: input.projectId,
          runId: input.outcome.runId,
        });
    if (isMemoryFailure(recorded)) {
      emitMemoryEvent("memory.unavailable", {
        projectId: input.projectId,
        runId: input.outcome.runId,
        category: "failure",
        reason: recorded.code,
      });
      return;
    }
    emitMemoryEvent("memory.recorded", {
      projectId: input.projectId,
      runId: input.outcome.runId,
      category: "failure",
      count: 1,
    });
  } catch {
    // Memory is optional context; a write failure must not change the run outcome.
    emitMemoryEvent("memory.unavailable", {
      projectId: input.projectId,
      runId: input.outcome.runId,
      category: "failure",
      reason: "record_failed",
    });
  }
}
