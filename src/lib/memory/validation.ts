/**
 * Request and secret-shape validation for project memory.
 *
 * ⚠️ MEMORY IS NOT A SECRET STORE. Content that looks like a credential, a
 * private key, a connection string, a JWT, a payment key or an email is refused
 * rather than silently redacted into a misleading half-fact.
 *
 * Pure except for the deterministic SHA-256 dedupe key; no database access.
 */

import { createHash } from "node:crypto";

import { MEMORY_LIMITS } from "./types";

export type Validation<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: string; value?: never };

const DEDUPE_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|rk|pk|gsk|ghp|gho|ghu|ghs)_[A-Za-z0-9_-]{8,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\brzp_(?:live|test)_[A-Za-z0-9]{6,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|private[_ -]?key)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/,
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/,
];

/**
 * Why this content cannot be stored as memory, or null. The reason never echoes
 * the submitted text.
 */
export function memoryContentRejectionReason(value: unknown): string | null {
  if (typeof value !== "string") return "Memory content must be text.";
  const content = value.trim();
  if (!content) return "Memory content is required.";
  if (content.length > MEMORY_LIMITS.maxContentChars) {
    return `Memory content must be at most ${MEMORY_LIMITS.maxContentChars} characters.`;
  }
  if (CONTROL_CHARS.test(content)) {
    return "Memory content contains unsupported control characters.";
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return "Memory cannot store secrets, credentials, connection strings or personal contact data. Describe the decision without the value.";
  }
  return null;
}

export function validateMemoryContent(raw: unknown): Validation<string> {
  const reason = memoryContentRejectionReason(raw);
  return reason ? { ok: false, error: reason } : { ok: true, value: (raw as string).trim() };
}

export function validateDedupeKey(raw: unknown): Validation<string> {
  if (typeof raw !== "string" || !DEDUPE_KEY.test(raw.trim())) {
    return {
      ok: false,
      error: "A topic key must be 1-120 characters: letters, numbers, dot, colon, underscore or dash.",
    };
  }
  return { ok: true, value: raw.trim() };
}

/** Deterministic dedupe key when the user does not name a topic. */
export function dedupeKeyForContent(category: string, content: string): string {
  return `topic:${createHash("sha256").update(`${category}\u0000${content}`, "utf8").digest("hex")}`;
}

export interface CreateMemoryInput {
  content: string;
  dedupeKey: string;
}

export function validateCreateMemoryInput(body: unknown): Validation<CreateMemoryInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid memory request." };
  }
  const record = body as Record<string, unknown>;
  if (record.category !== "decision") {
    return { ok: false, error: "Only an explicit user decision can be created from the workspace." };
  }

  const content = validateMemoryContent(record.content);
  if (!content.ok) return { ok: false, error: content.error };

  const dedupeKey =
    record.dedupeKey === undefined || record.dedupeKey === null || record.dedupeKey === ""
      ? { ok: true as const, value: dedupeKeyForContent("decision", content.value) }
      : validateDedupeKey(record.dedupeKey);
  if (!dedupeKey.ok) return { ok: false, error: dedupeKey.error };

  return { ok: true, value: { content: content.value, dedupeKey: dedupeKey.value } };
}

export interface UpdateMemoryInput {
  revision: number;
  content?: string;
  status?: "active" | "archived";
}

export function validateUpdateMemoryInput(body: unknown): Validation<UpdateMemoryInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid memory update." };
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    record.revision > 1_000_000
  ) {
    return { ok: false, error: "A valid memory revision is required." };
  }

  let content: string | undefined;
  if (record.content !== undefined) {
    const validated = validateMemoryContent(record.content);
    if (!validated.ok) return { ok: false, error: validated.error };
    content = validated.value;
  }

  let status: "active" | "archived" | undefined;
  if (record.status !== undefined) {
    if (record.status !== "active" && record.status !== "archived") {
      return { ok: false, error: "Memory status must be active or archived." };
    }
    status = record.status;
  }

  if (content === undefined && status === undefined) {
    return { ok: false, error: "Provide new memory content or a status." };
  }

  return {
    ok: true,
    value: {
      revision: record.revision,
      ...(content !== undefined ? { content } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
}
