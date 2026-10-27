/**
 * Server-side assembly of the memory/context package for one generation.
 *
 * ⚠️ DISABLED OR UNAVAILABLE MEMORY MUST NOT CHANGE GENERATION. If the feature
 * flag/cohort is off, the caller receives `used: false` and the agent keeps its
 * previous full-file behavior. If only the table is missing, the deterministic
 * facts/file selection still work and the persistent memories are empty; the
 * run never invents context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentFile } from "@/lib/ai/agent";
import { isAgentMemoryProject, readAgentMemoryConfig } from "./config";
import { emitMemoryEvent } from "./events";
import { toProjectMemoryItem } from "./projection";
import {
  deriveRepositoryFacts,
  formatMemoryContext,
  selectContextFiles,
} from "./retrieval";
import { isMemoryFailure, listMemories } from "./store";
import type { ProjectMemoryFact, ProjectMemoryItem } from "./types";

export interface AgentMemoryContext {
  /** False means: use the existing generation behavior unchanged. */
  used: boolean;
  contextFiles: readonly AgentFile[];
  memoryText: string;
  facts: ProjectMemoryFact[];
  memories: ProjectMemoryItem[];
}

function disabled(files: readonly AgentFile[]): AgentMemoryContext {
  return { used: false, contextFiles: files, memoryText: "", facts: [], memories: [] };
}

const MEMORY_READ_TIMEOUT_MS = 5_000;

export async function buildAgentMemoryContext(input: {
  client?: SupabaseClient | null;
  userId: string;
  projectId: string;
  prompt: string;
  files: readonly AgentFile[];
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentMemoryContext> {
  const startedAt = Date.now();
  const config = readAgentMemoryConfig(input.env);
  if (!("config" in config) || !isAgentMemoryProject(input.projectId, input.env)) {
    return disabled(input.files);
  }

  try {
    const facts = deriveRepositoryFacts(input.files);
    const contextFiles = selectContextFiles(input.files, input.prompt);
    let memories: ProjectMemoryItem[] = [];
    let reason: string | null = null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const listed = await Promise.race([
      listMemories({
        client: input.client,
        projectId: input.projectId,
        userId: input.userId,
        activeOnly: true,
        limit: 30,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MEMORY_READ_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (listed === null) {
      reason = "timeout";
      emitMemoryEvent("memory.unavailable", {
        projectId: input.projectId,
        reason: "timeout",
        used: true,
        durationMs: Date.now() - startedAt,
      });
    } else if (isMemoryFailure(listed)) {
      reason = listed.code;
      emitMemoryEvent("memory.unavailable", {
        projectId: input.projectId,
        reason: listed.code,
        used: true,
        durationMs: Date.now() - startedAt,
      });
    } else {
      memories = listed.data.map(toProjectMemoryItem);
    }

    const memoryText = formatMemoryContext({
      facts,
      memories,
      prompt: input.prompt,
      now: input.now,
    });

    emitMemoryEvent("memory.context_built", {
      projectId: input.projectId,
      count: memories.length,
      used: true,
      reason,
      durationMs: Date.now() - startedAt,
    });

    return {
      used: true,
      contextFiles,
      memoryText,
      facts,
      memories,
    };
  } catch (error) {
    // A memory outage must not stop a generation. Fall back to the exact
    // pre-Phase-8 context behavior rather than a partial invention.
    emitMemoryEvent("memory.unavailable", {
      projectId: input.projectId,
      reason: "context_failed",
      used: false,
      durationMs: Date.now() - startedAt,
    });
    console.error(
      "[memory] context assembly failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return disabled(input.files);
  }
}
