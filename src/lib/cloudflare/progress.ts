/**
 * ═══ RECONNECTABLE GENERATION PROGRESS ══════════════════════════════════════
 *
 * Generation continues after the browser disconnects because the durable run row
 * is the source of truth, not an HTTP connection. This module projects that row
 * into a small, stable payload a client can poll and merge after a refresh,
 * a network drop or a closed tab.
 *
 * ⚠️ NOTHING HERE IS OPTIMISTIC. A phase is `completed` only when the stored run
 * says so; a phase Mavly cannot observe (the advisory specialist roles) is
 * reported as `unknown`, never invented. `completed` is never returned while the
 * run still has work left.
 */

export type ProgressPhase =
  | "queued"
  | "planning"
  | "coding"
  | "review"
  | "repair"
  | "verification"
  | "materialization"
  | "completed";

export type ProgressState =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ProgressStep {
  phase: ProgressPhase;
  state: ProgressState;
}

export interface GenerationProgress {
  runId: string;
  status: string;
  phase: ProgressPhase | "failed" | "cancelled";
  terminal: boolean;
  cancellable: boolean;
  steps: ProgressStep[];
  attempt: number;
  maxAttempts: number;
  updatedAt: string | null;
  error: { code: string | null; message: string | null } | null;
}

/** Only the fields this projection reads; the row may carry many more. */
export interface ProgressRunRow {
  id: string;
  status: string;
  stage: string | null;
  finished_at: string | null;
  cancellation_requested_at: string | null;
  last_progress_at: string | null;
  heartbeat_at: string | null;
  job_attempt?: number | null;
  max_job_attempts?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  files_written?: number | null;
  checkpoint_count?: number | null;
  batch_count?: number | null;
}

const PHASES: ProgressPhase[] = [
  "queued",
  "planning",
  "coding",
  "review",
  "repair",
  "verification",
  "materialization",
  "completed",
];

/**
 * Run stage → the phase that is actually active. `validating` covers the plan
 * and manifest step; `generating` covers the file batches; the review/repair/
 * verification phases belong to the opt-in layers and are only marked complete
 * once the run itself is complete.
 */
function activePhase(stage: string | null): ProgressPhase {
  switch (stage) {
    case "queued":
      return "queued";
    case "validating":
      return "planning";
    case "generating":
      return "coding";
    case "retrying":
    case "retry_wait":
      return "coding";
    case "completed":
      return "completed";
    default:
      return "queued";
  }
}

function terminalStatus(status: string, stage: string | null): boolean {
  if (status === "done" || status === "error" || status === "cancelled") return true;
  return stage === "completed" || stage === "failed" || stage === "cancelled";
}

function failed(status: string, stage: string | null): boolean {
  return status === "error" || stage === "failed" || stage === "interrupted";
}

function cancelled(status: string, stage: string | null, requested: boolean): boolean {
  if (status === "cancelled" || stage === "cancelled") return true;
  return requested && !terminalStatus(status, stage);
}

export function runProgress(row: ProgressRunRow): GenerationProgress {
  const stage = row.stage ?? null;
  const done = terminalStatus(row.status, stage);
  const isCancelled = cancelled(row.status, stage, Boolean(row.cancellation_requested_at));
  const isFailed = !isCancelled && failed(row.status, stage);
  const current = isCancelled ? "cancelled" : isFailed ? "failed" : activePhase(stage);
  const currentIndex = PHASES.indexOf(current as ProgressPhase);

  const steps: ProgressStep[] = PHASES.map((phase, index) => {
    if (isCancelled) {
      return { phase, state: index < currentIndex ? "completed" : "cancelled" };
    }
    if (isFailed) {
      return { phase, state: index < currentIndex ? "completed" : "failed" };
    }
    if (current === "completed") return { phase, state: "completed" };
    if (index < currentIndex) return { phase, state: "completed" };
    if (index === currentIndex) return { phase, state: "active" };
    /**
     * The review, repair and verification phases are advanced by separate
     * opt-in queues. Until the run is complete Mavly does not claim they ran.
     */
    return { phase, state: "unknown" };
  });

  return {
    runId: row.id,
    status: isCancelled ? "cancelled" : isFailed ? "error" : row.status,
    phase: current,
    terminal: done || isCancelled || isFailed,
    cancellable:
      !done &&
      !isCancelled &&
      !isFailed &&
      row.cancellation_requested_at === null,
    steps,
    attempt: Math.max(1, Number(row.job_attempt ?? 1) || 1),
    maxAttempts: Math.max(1, Number(row.max_job_attempts ?? 3) || 3),
    updatedAt: row.last_progress_at ?? row.heartbeat_at ?? null,
    error:
      isFailed || isCancelled
        ? {
            code: row.error_code ?? null,
            message: row.error_message ?? null,
          }
        : null,
  };
}
