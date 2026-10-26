/**
 * ═══ CORRELATION IDS AND LOG-SAFE TEXT ═══════════════════════════════════════
 *
 * A trace id ties one HTTP request, its durable run row and every worker event
 * together without naming a user or a prompt. It is generated server-side and
 * persisted on the run row by migration 16.
 *
 * ⚠️ NOTHING HERE IS A SECRET. A trace id is safe to log, return in an error
 * envelope and store; it must never be derived from an email, a prompt or an
 * access token.
 */

import { randomUUID } from "node:crypto";

const TRACE_ID = /^[a-f0-9]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh, non-secret correlation id (32 lowercase hex characters). */
export function newTraceId(): string {
  return randomUUID().replaceAll("-", "");
}

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Redact the shapes that must never persist or reach a log line, then bound the
 * text. Ordering matters: the token patterns run before the generic URL rule so
 * a credential embedded in a URL is removed rather than merely hidden with the
 * URL.
 */
export function redactSensitiveText(raw: unknown, maxLength = 500): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\s+/g, " ").trim();

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk|gsk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_-]{8,}\b/gi, "[redacted-key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[redacted-token]")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[redacted-email]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[url]");

  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text;
}
