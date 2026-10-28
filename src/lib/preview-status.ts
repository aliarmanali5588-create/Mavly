/**
 * ═══ WHAT THE PREVIEW PANEL MAY HONESTLY CLAIM ══════════════════════════════
 *
 * The workspace used to imply a running development server (`agentServerStatus:
 * "Active"`) and rendered the preview frame whenever a URL existed. Neither is
 * true here: a Mavly preview is a static document saved into `project_files`.
 *
 * This module derives two independent answers from durable state only:
 *
 *   · GENERATION — queued / running / recovering / completed / failed / …
 *   · PREVIEW    — ready / stale / incomplete / unavailable / none
 *
 * "Stale" is the case the old UI could not express: a previous preview.html is
 * still perfectly usable, but the latest generation started after it was saved
 * (or failed before replacing it), so it may not reflect the newest request.
 * Hiding it would throw away working output; calling it current would lie.
 *
 * This module is pure. It accepts plain signals, so the API maps a database row
 * onto them and a unit test can exercise every branch without Supabase.
 */

export type PreviewStatus = "ready" | "stale" | "incomplete" | "unavailable" | "none";

export type GenerationStatus =
  | "idle"
  | "queued"
  | "running"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

/** The file that will actually be served, and when it was last written. */
export interface PreviewEntrySignal {
  path: string;
  /** ISO timestamp from `project_files.updated_at`. */
  updatedAt: string;
}

/** The durable generation signals the preview depends on. */
export interface PreviewRunSignal {
  stage: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface PreviewState {
  status: PreviewStatus;
  /** The served file, when one exists. */
  entryPath: string | null;
  updatedAt: string | null;
  /** The latest run's start, when one exists. */
  runStartedAt: string | null;
  /**
   * True when the saved preview predates the latest run, or when the latest run
   * failed/cancelled after starting. The document itself is still usable.
   */
  stale: boolean;
  /** A concise, user-safe explanation. */
  reason: string | null;
  /** Whether the existing API can offer a resume/retry action. */
  canResume: boolean;
}

export interface PreviewStateInput {
  entry: PreviewEntrySignal | null;
  /**
   * Why a preview cannot exist for this project at all (for example, native
   * Android). Applied when no run is active or failed, so it cannot hide a
   * recoverable generation state.
   */
  unavailableReason?: string | null;
  run: PreviewRunSignal | null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveGenerationState(run: PreviewRunSignal | null): GenerationStatus {
  if (!run) return "idle";

  switch (run.stage) {
    case "queued":
      return "queued";
    case "validating":
    case "generating":
      return "running";
    case "retrying":
    case "retry_wait":
      return "recovering";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      break;
  }

  // Older rows may predate `stage`; fall back to the coarse run status.
  if (run.status === "pending") return "queued";
  if (run.status === "running") return "running";
  if (run.status === "done") return "completed";
  if (run.status === "error") return "failed";
  if (run.status === "cancelled") return "cancelled";
  return "incomplete";
}

export function resolvePreviewState(input: PreviewStateInput): PreviewState {
  const { entry, run } = input;
  const unavailableReason = input.unavailableReason?.trim() || null;
  const generation = resolveGenerationState(run);
  const runStartedAt = run?.startedAt ?? null;

  if (!entry) {
    /**
     * ⚠️ NO FILE IS NEVER "READY". The wording changes with generation so the
     * user knows whether to wait, retry, or send the first prompt.
     *
     * A run that is active or failed is described BEFORE the "this source needs
     * a build" reason, because that reason also matches a project whose run
     * simply has not produced its preview.html yet — and telling that user
     * "your framework needs a build" would hide a recoverable generation
     * failure. The unavailable reason still wins once no run is in flight and
     * the source genuinely cannot be served statically.
     */
    if (generation === "queued" || generation === "running" || generation === "recovering") {
      return {
        status: "incomplete",
        entryPath: null,
        updatedAt: null,
        runStartedAt,
        stale: false,
        reason:
          "Generation is still running. A preview appears once a complete preview.html has been saved.",
        canResume: false,
      };
    }
    if (generation === "failed" || generation === "cancelled") {
      return {
        status: "incomplete",
        entryPath: null,
        updatedAt: null,
        runStartedAt,
        stale: false,
        reason:
          generation === "cancelled"
            ? "The last generation was cancelled before a preview was saved. Send a new prompt to continue."
            : "The last generation did not finish, so there is no usable preview yet. Completed files are saved and the run can be resumed.",
        canResume: generation === "failed",
      };
    }
    if (unavailableReason) {
      return {
        status: "unavailable",
        entryPath: null,
        updatedAt: null,
        runStartedAt,
        stale: false,
        reason: unavailableReason,
        canResume: false,
      };
    }
    if (generation === "completed") {
      return {
        status: "incomplete",
        entryPath: null,
        updatedAt: null,
        runStartedAt,
        stale: false,
        reason:
          "The last generation finished without a usable preview.html. The source files are saved; send a follow-up prompt to update the preview.",
        canResume: false,
      };
    }
    return {
      status: "none",
      entryPath: null,
      updatedAt: null,
      runStartedAt,
      stale: false,
      reason: "No preview yet. Describe the app you want and Mavly will build it.",
      canResume: false,
    };
  }

  const entryTime = parseTime(entry.updatedAt);
  const startTime = parseTime(runStartedAt);
  const startedAfterEntry =
    entryTime !== null && startTime !== null ? startTime > entryTime : false;

  /**
   * A failed/cancelled run never makes its preview "current", even if the run
   * wrote preview.html before failing on another batch. The project may be
   * incomplete, so the honest label is a previous/stale preview.
   */
  if (generation === "failed" || generation === "cancelled") {
    return {
      status: "stale",
      entryPath: entry.path,
      updatedAt: entry.updatedAt,
      runStartedAt,
      stale: true,
      reason:
        generation === "cancelled"
          ? "The last generation was cancelled. This preview is from an earlier version and may not reflect your latest request."
          : "The last generation did not finish. This preview is from an earlier version and may not reflect your latest request.",
      canResume: generation === "failed",
    };
  }

  if (generation === "queued" || generation === "running" || generation === "recovering") {
    if (startedAfterEntry) {
      return {
        status: "stale",
        entryPath: entry.path,
        updatedAt: entry.updatedAt,
        runStartedAt,
        stale: true,
        reason:
          "A newer generation is running. This is the previous preview and updates when the new version saves.",
        canResume: false,
      };
    }
    return {
      status: "ready",
      entryPath: entry.path,
      updatedAt: entry.updatedAt,
      runStartedAt,
      stale: false,
      reason: "Preview saved from the current generation, which is still running.",
      canResume: false,
    };
  }

  /**
   * A completed (or unknown) run does not invalidate a saved preview: a
   * backend-only change legitimately leaves preview.html untouched. Only an
   * active run that started after the entry, or a failed run, is reliably
   * "stale" — both are handled above.
   */
  return {
    status: "ready",
    entryPath: entry.path,
    updatedAt: entry.updatedAt,
    runStartedAt,
    stale: false,
    reason: null,
    canResume: false,
  };
}

/** Whether a run is in a state that can still produce more saved files. */
export function previewIsUpdating(run: PreviewRunSignal | null): boolean {
  const state = resolveGenerationState(run);
  return state === "queued" || state === "running" || state === "recovering";
}

/** Whether a previous preview is being shown while a newer one is in flight. */
export function previewStateForDisplay(input: PreviewStateInput): {
  state: PreviewState;
  generation: GenerationStatus;
  updating: boolean;
  /** Show a "previous preview" strip above the frame. */
  showStaleNotice: boolean;
  /** Show the informative empty state instead of a blank frame. */
  showEmptyState: boolean;
} {
  const state = resolvePreviewState(input);
  const generation = resolveGenerationState(input.run);
  const updating = previewIsUpdating(input.run);
  return {
    state,
    generation,
    updating,
    showStaleNotice: state.status === "stale" && Boolean(input.entry),
    showEmptyState: !input.entry,
  };
}
