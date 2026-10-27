/**
 * Owner-facing project-memory service.
 *
 * The catch-all has already verified the session and project ownership. Every
 * store call repeats both predicates through the caller's RLS-scoped client.
 *
 * ⚠️ ONLY USER DECISIONS ARE CREATED HERE. Observed failure notes are written by
 * `outcomes.ts` after a terminal run; neither path can promote an AI inference
 * into an approved decision. Memory is contextual text, never authorization.
 */

import { randomUUID } from "node:crypto";

import { isStoreFailure, listFiles } from "@/lib/mavly/store";
import { agentMemoryRefusal, readAgentMemoryConfig } from "./config";
import { emitMemoryEvent } from "./events";
import { toProjectMemoryItem } from "./projection";
import { deriveRepositoryFacts } from "./retrieval";
import {
  countProjectMemories,
  deleteAllProjectMemory,
  deleteMemory,
  insertUserDecision,
  isMemoryFailure,
  listMemories,
  updateUserDecision,
  type MemoryFailure,
  type MemoryRow,
} from "./store";
import {
  MEMORY_LIMITS,
  type ProjectMemoryList,
  type ProjectMemoryItem,
} from "./types";
import {
  dedupeKeyForContent,
  validateCreateMemoryInput,
  validateUpdateMemoryInput,
} from "./validation";

export interface MemoryServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export type MemoryServiceResult<T> =
  | { ok: true; data: T }
  | MemoryServiceFailure;

export function isMemoryServiceFailure<T>(
  result: MemoryServiceResult<T>,
): result is MemoryServiceFailure {
  return result.ok === false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(status: number, code: string, error: string): MemoryServiceFailure {
  return { ok: false, status, code, error };
}

function fromStore(error: MemoryFailure): MemoryServiceFailure {
  switch (error.code) {
    case "migration_required":
      return failure(503, "BACKEND_NOT_CONFIGURED", error.error);
    case "unavailable":
      return failure(503, "BACKEND_NOT_CONFIGURED", error.error);
    case "unauthorized":
      return failure(404, "PROJECT_NOT_FOUND", "Memory not found.");
    case "validation":
      return failure(400, "VALIDATION", error.error);
    case "conflict":
      return failure(409, "VALIDATION", error.error);
    case "not_found":
      return failure(404, "PROJECT_NOT_FOUND", error.error);
    default:
      return failure(500, "UNKNOWN", error.error);
  }
}

/** Feature/cohort gate for every owner endpoint. */
function gate(projectId: string): MemoryServiceFailure | null {
  const config = readAgentMemoryConfig();
  if (!("config" in config)) {
    return failure(503, "BACKEND_NOT_CONFIGURED", agentMemoryRefusal(config.reason));
  }
  if (!config.config.cohort.has(projectId.trim().toLowerCase())) {
    return failure(
      503,
      "BACKEND_NOT_CONFIGURED",
      "Project memory is not enabled for this project.",
    );
  }
  return null;
}

async function factsForProject(projectId: string) {
  const files = await listFiles(projectId);
  if (isStoreFailure(files)) return [];
  return deriveRepositoryFacts(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
}

export async function listProjectMemory(
  projectId: string,
  userId: string,
): Promise<MemoryServiceResult<ProjectMemoryList>> {
  const refused = gate(projectId);
  if (refused) return refused;

  const listed = await listMemories({
    projectId,
    userId,
    activeOnly: false,
    limit: 50,
  });
  if (isMemoryFailure(listed)) return fromStore(listed);

  return {
    ok: true,
    data: {
      facts: await factsForProject(projectId),
      memories: listed.data.map(toProjectMemoryItem),
    },
  };
}

export async function createProjectDecision(
  projectId: string,
  userId: string,
  body: unknown,
): Promise<MemoryServiceResult<ProjectMemoryItem>> {
  const refused = gate(projectId);
  if (refused) return refused;

  const input = validateCreateMemoryInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);

  const count = await countProjectMemories({ projectId, userId });
  if (isMemoryFailure(count)) return fromStore(count);
  if (count.data >= MEMORY_LIMITS.maxItemsPerProject) {
    return failure(
      400,
      "VALIDATION",
      `Project memory is full (${MEMORY_LIMITS.maxItemsPerProject} active records). Archive or delete an item first.`,
    );
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const inserted = await insertUserDecision({
    id,
    projectId,
    userId,
    content: input.value.content,
    dedupeKey:
      input.value.dedupeKey ||
      dedupeKeyForContent("decision", input.value.content),
    now,
  });
  if (isMemoryFailure(inserted)) return fromStore(inserted);

  emitMemoryEvent("memory.recorded", {
    projectId,
    category: "decision",
    count: 1,
  });
  return { ok: true, data: toProjectMemoryItem(inserted.data as MemoryRow) };
}

export async function updateProjectMemory(
  projectId: string,
  userId: string,
  memoryId: string,
  body: unknown,
): Promise<MemoryServiceResult<ProjectMemoryItem>> {
  const refused = gate(projectId);
  if (refused) return refused;
  if (!UUID.test(memoryId)) return failure(404, "PROJECT_NOT_FOUND", "Memory not found.");

  const input = validateUpdateMemoryInput(body);
  if (!input.ok) return failure(400, "VALIDATION", input.error);

  const updated = await updateUserDecision({
    id: memoryId,
    projectId,
    userId,
    revision: input.value.revision,
    ...(input.value.content !== undefined ? { content: input.value.content } : {}),
    ...(input.value.status !== undefined ? { status: input.value.status } : {}),
    now: new Date().toISOString(),
  });
  if (isMemoryFailure(updated)) return fromStore(updated);
  return { ok: true, data: toProjectMemoryItem(updated.data) };
}

export async function deleteProjectMemory(
  projectId: string,
  userId: string,
  memoryId: string,
): Promise<MemoryServiceResult<{ deleted: true }>> {
  const refused = gate(projectId);
  if (refused) return refused;
  if (!UUID.test(memoryId)) return failure(404, "PROJECT_NOT_FOUND", "Memory not found.");

  const deleted = await deleteMemory({ id: memoryId, projectId, userId });
  if (isMemoryFailure(deleted)) return fromStore(deleted);
  return { ok: true, data: deleted.data };
}

/** Clears memory rows only. Project files, snapshots and runs are untouched. */
export async function clearProjectMemory(
  projectId: string,
  userId: string,
  confirm: string | null,
): Promise<MemoryServiceResult<{ deleted: number }>> {
  const refused = gate(projectId);
  if (refused) return refused;
  if (confirm !== "all") {
    return failure(
      400,
      "VALIDATION",
      "Clearing project memory requires the explicit confirm=all marker.",
    );
  }

  const deleted = await deleteAllProjectMemory({ projectId, userId });
  if (isMemoryFailure(deleted)) return fromStore(deleted);
  emitMemoryEvent("memory.recorded", {
    projectId,
    count: deleted.data.deleted,
    reason: "cleared",
  });
  return { ok: true, data: deleted.data };
}
