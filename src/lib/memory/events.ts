/**
 * Structured, content-free memory diagnostics.
 *
 * ⚠️ NEVER LOG MEMORY TEXT, A PROMPT, A FILE, A RUN MESSAGE OR A SECRET. This
 * module accepts only a closed event set and scalar identifiers/counts.
 */

import { isUuid } from "@/lib/observability/correlation";

export const MEMORY_EVENTS = [
  "memory.context_built",
  "memory.unavailable",
  "memory.recorded",
  "memory.skipped",
  "memory.invalid",
] as const;

export type MemoryEventName = (typeof MEMORY_EVENTS)[number];

export interface MemoryEventFields {
  projectId?: string | null;
  runId?: string | null;
  category?: "decision" | "failure" | null;
  count?: number | null;
  used?: boolean | null;
  reason?: string | null;
  durationMs?: number | null;
}

function bounded(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? Math.round(value)
    : null;
}

/** Pure serializer, exported for the allowlist/redaction test. */
export function serializeMemoryEvent(
  event: MemoryEventName,
  fields: MemoryEventFields = {},
): string {
  const body: Record<string, string | number | boolean> = {
    event,
    at: new Date().toISOString(),
  };
  if (
    typeof fields.projectId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(fields.projectId)
  ) {
    body.projectId = fields.projectId;
  }
  if (fields.runId && isUuid(fields.runId)) body.runId = fields.runId;
  if (fields.category === "decision" || fields.category === "failure") {
    body.category = fields.category;
  }
  if (typeof fields.reason === "string" && /^[a-z_]{3,40}$/.test(fields.reason)) {
    body.reason = fields.reason;
  }
  if (typeof fields.used === "boolean") body.used = fields.used;
  const count = bounded(fields.count, 1000);
  if (count !== null) body.count = count;
  const duration = bounded(fields.durationMs, 3_600_000);
  if (duration !== null) body.durationMs = duration;
  return JSON.stringify(body);
}

export function emitMemoryEvent(
  event: MemoryEventName,
  fields: MemoryEventFields = {},
): void {
  if (!(MEMORY_EVENTS as readonly string[]).includes(event)) return;
  try {
    const line = serializeMemoryEvent(event, fields);
    if (event === "memory.unavailable" || event === "memory.invalid") {
      console.warn(`[memory] ${line}`);
    } else {
      console.info(`[memory] ${line}`);
    }
  } catch {
    // Memory diagnostics must never fail a generation.
  }
}
