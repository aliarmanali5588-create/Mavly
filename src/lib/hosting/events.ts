/**
 * ═══ HOSTING EVENTS — STRUCTURED, NON-SENSITIVE, BOUNDED ════════════════════
 *
 * One line per event, with a fixed key order so a log query can rely on it:
 *
 *   [hosting] <event> key=value key=value
 *
 * ⚠️ WHAT MUST NEVER APPEAR HERE: credentials, authorization headers, cookies,
 * file contents, generated source, project secrets, user email addresses. A
 * hostname and a project id are already public identifiers (the hostname is the
 * public address), so they are safe to include and essential for debugging.
 */

export type HostingEvent =
  | "publish_started"
  | "artifact_created"
  | "version_activated"
  | "publish_failed"
  | "unpublish_completed"
  | "unpublish_failed"
  | "tenant_resolved"
  | "tenant_unresolved"
  | "tenant_served"
  | "tenant_error"
  | "versions_pruned"
  | "rate_limited";

/** Values longer than this are truncated: a log line is not a payload. */
const MAX_VALUE = 120;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  const collapsed = text.replace(/[\r\n\t]+/g, " ").slice(0, MAX_VALUE);
  return collapsed || "-";
}

export function logHostingEvent(
  event: HostingEvent,
  fields: Record<string, unknown> = {},
): void {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  const line = `[hosting] ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`;
  if (event.endsWith("_failed") || event === "tenant_error") {
    console.error(line);
  } else if (event === "tenant_unresolved" || event === "rate_limited") {
    console.warn(line);
  } else {
    console.info(line);
  }
}
