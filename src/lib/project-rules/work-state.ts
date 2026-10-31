/**
 * ═══ THE PROJECT WORK LOG (`.mavly/.agentwork.md`) ══════════════════════════
 *
 * The initial file is EMPTY. It is written only after generation passes static
 * checks and before the run is finalized. Later successes add one entry. It is
 * never a plan, promise or model claim: the run engine supplies the paths it
 * actually persisted and the static verification it actually performed.
 *
 * Pure, so the formatting and truncation rules can be tested without storage.
 */

import { AGENT_WORK_HEADER, AGENT_WORK_INITIAL_CONTENT } from "./rules";
import type { ChangeClass } from "./scope";

const MAX_WORK_LOG_CHARS = 24_000;
const MAX_CHANGED_PATHS = 40;
const MAX_DELETED_PATHS = 20;

export interface WorkLogVerification {
  status: string;
  summary: string;
}

export interface WorkLogInput {
  runId: string;
  prompt: string;
  changeClass: ChangeClass;
  summary: string;
  changedPaths: readonly string[];
  deletedPaths: readonly string[];
  verification: WorkLogVerification;
  /** True when this run added the global selection rule to the stylesheet. */
  selectionRuleEnsured: boolean;
  /** The stylesheet that already contained the rule, when none was added. */
  selectionRulePath?: string | null;
  /** Set when the backend could not persist the rule. */
  selectionRuleError?: string | null;
  /** Injected for deterministic tests. Defaults to the current time. */
  now?: Date;
}

export function initialWorkStateContent(): string {
  return AGENT_WORK_INITIAL_CONTENT;
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function pathList(paths: readonly string[], limit: number): string {
  const safe = [...new Set(paths)]
    .filter((path) => typeof path === "string" && path.length > 0)
    .slice(0, limit)
    .map((path) => `\`${path}\``);
  if (safe.length === 0) return "none";
  return safe.join(", ");
}

export function buildWorkLogEntry(input: WorkLogInput): string {
  const at = (input.now ?? new Date()).toISOString();
  const request = oneLine(input.prompt, 200);
  const verification = oneLine(input.verification.summary, 400);
  const selection = input.selectionRuleError
    ? `could not be applied (${oneLine(input.selectionRuleError, 200)})`
    : input.selectionRuleEnsured
      ? "added the global black/white `::selection` rule"
      : input.selectionRulePath
        ? `already present in \`${input.selectionRulePath}\``
        : "no global stylesheet was found; the rule was not added";
  return [
    `## ${at} — ${oneLine(input.prompt, 120) || "Project update"}`,
    "",
    `- Change class: ${input.changeClass}`,
    `- Request: ${request || "(empty)"}`,
    `- Result: ${oneLine(input.summary, 600) || "The run completed."}`,
    `- Files changed (${input.changedPaths.length}): ${pathList(input.changedPaths, MAX_CHANGED_PATHS)}`,
    `- Files removed (${input.deletedPaths.length}): ${pathList(input.deletedPaths, MAX_DELETED_PATHS)}`,
    `- Global selection styling: ${selection}`,
    `- Verification: ${input.verification.status}; ${verification}`,
    `- Run: ${input.runId}`,
    "",
  ].join("\n");
}

function trimTail(content: string): string {
  if (content.length <= MAX_WORK_LOG_CHARS) return content;
  const keep = content.slice(0, MAX_WORK_LOG_CHARS);
  const lastEntry = keep.lastIndexOf("\n## ");
  const trimmed = lastEntry > 0 ? keep.slice(0, lastEntry) : keep;
  return `${trimmed}\n\n_…older entries trimmed to keep this file bounded…_\n`;
}

/**
 * Put the newest entry first, preserving earlier history. The first write adds
 * the header; an empty file becomes a header plus one honest entry.
 */
export function mergeWorkState(existing: string, entry: string): string {
  const current = typeof existing === "string" ? existing : "";
  if (!current.trim()) {
    return trimTail(`${AGENT_WORK_HEADER}\n${entry}`);
  }

  if (current.trimStart().startsWith("# Agent work log")) {
    const split = current.indexOf("\n## ");
    if (split === -1) {
      return trimTail(`${current.trimEnd()}\n\n${entry}`);
    }
    const head = current.slice(0, split).trimEnd();
    const history = current.slice(split + 1); // keeps the leading "## "
    return trimTail(`${head}\n\n${entry}\n${history}`);
  }

  // A file written before the header existed is preserved, not discarded.
  return trimTail(`${AGENT_WORK_HEADER}\n${entry}\n## Earlier work\n\n${current.trim()}\n`);
}
