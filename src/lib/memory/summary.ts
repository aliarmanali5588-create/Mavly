/**
 * Pure terminal-outcome summaries. No database or provider imports, so the
 * "observed outcome is not a verified root cause" rule is directly testable.
 */

import type { MemoryRunOutcome } from "./types";

const ERROR_CLASS = /^[A-Za-z0-9._:-]{1,80}$/;

export function failureMemoryContent(outcome: MemoryRunOutcome): string {
  const errorClass = ERROR_CLASS.test(outcome.errorClass) ? outcome.errorClass : "UNKNOWN";
  const terminal =
    outcome.status === "dead_letter" ? "was dead-lettered" : "did not complete";
  return `A generation attempt ${terminal} (${errorClass}). Earlier batches may be checkpointed and resumable from the workspace. This is an observed outcome, not a verified root cause or a project-code defect.`;
}

/** True only for terminal outcomes that merit a failure note. */
export function shouldRecordFailure(outcome: Pick<MemoryRunOutcome, "status">): boolean {
  return outcome.status === "failed" || outcome.status === "dead_letter";
}
