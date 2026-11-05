/**
 * ═══ CLOUDFLARE GENERATION ERRORS ═════════════════════════════════════════════════
 *
 * Error codes follow the Mavly convention: a short, unique prefix + a
 * human-readable suffix. The client (`vcaas.ts` / Hono) maps these to
 * HTTP status codes and UI messages. All codes are defined once here so
 * the dispatcher, the router and the worker all report the same thing.
 *
 * ⚠️ Codes are NEVER inferred from a string match; a change here must be
 * accompanied by a matching change in the client-side error map (if any).
 * Otherwise the UI reports a different code than the server returned.
 */

export enum CloudflareGenerationError {
  /** Cloudflare generation is not enabled in this environment. */
  GenerationDisabled = "cloudflare_generation_disabled",
  /** The dispatch secret is missing or too short; the dispatcher refuses to run. */
  MissingDispatchSecret = "missing_dispatch_secret",
  /** The dispatch secret presented does not match the expected value. */
  DispatchSecretMismatch = "dispatch_secret_mismatch",
  /** The run was not found or is not in a claimable stage. */
  RunNotFound = "run_not_found",
  /** The run is not a worker-dispatched run. */
  NotWorkerDispatch = "not_worker_dispatch",
  /** The run has already been completed. */
  RunCompleted = "run_completed",
  /** The run is currently claimed by another attempt. */
  LeaseHeld = "lease_held",
  /** The ownership check failed between the dispatcher and the run row. */
  OwnershipMismatch = "ownership_mismatch",
  /** The dispatch could not be claimed (no pending rows). */
  NoPendingDispatch = "no_pending_dispatch",
  /** The Cloudflare Workflow creation failed. */
  WorkflowCreationFailed = "workflow_creation_failed",
  /** The agent pipeline failed (model, budget, E2B, etc.). */
  AgentPipelineFailed = "agent_pipeline_failed",
  /** The dispatch acknowledgement could not be recorded. */
  DispatchAckFailed = "dispatch_ack_failed",
  /** The env configuration is incomplete; problems were reported during parse. */
  IncompleteConfiguration = "incomplete_configuration",
  /** An unexpected internal error occurred. */
  InternalError = "internal_error",
  /** The run is cancelled. */
  RunCancelled = "run_cancelled",
}

/** Human-readable message for each error code. */
export function cloudflareErrorMessage(code: CloudflareGenerationError): string {
  switch (code) {
    case CloudflareGenerationError.GenerationDisabled:
      return "Cloudflare generation is not enabled in this environment.";
    case CloudflareGenerationError.MissingDispatchSecret:
      return "The Cloudflare dispatch secret is missing; the dispatcher refuses to create Workflows.";
    case CloudflareGenerationError.DispatchSecretMismatch:
      return "The dispatch secret presented does not match the expected value.";
    case CloudflareGenerationError.RunNotFound:
      return "The requested run was not found.";
    case CloudflareGenerationError.NotWorkerDispatch:
      return "The run is not a worker-dispatched run; only worker-dispatched runs can be claimed.";
    case CloudflareGenerationError.RunCompleted:
      return "The run has already been completed.";
    case CloudflareGenerationError.LeaseHeld:
      return "The run is currently claimed by another attempt; please try again later.";
    case CloudflareGenerationError.OwnershipMismatch:
      return "Ownership mismatch: the run belongs to a different project.";
    case CloudflareGenerationError.NoPendingDispatch:
      return "There are no pending dispatches to claim at this time.";
    case CloudflareGenerationError.WorkflowCreationFailed:
      return "The Cloudflare Workflow could not be created. Please try again.";
    case CloudflareGenerationError.AgentPipelineFailed:
      return "The generation agent pipeline failed. Check the run logs for details.";
    case CloudflareGenerationError.DispatchAckFailed:
      return "The dispatch acknowledgement could not be recorded.";
    case CloudflareGenerationError.IncompleteConfiguration:
      return "The Cloudflare generation configuration is incomplete. See the problems list.";
    case CloudflareGenerationError.InternalError:
      return "An unexpected internal error occurred.";
    case CloudflareGenerationError.RunCancelled:
      return "The run has been cancelled.";
  }
}

/** Map a Cloudflare generation error code to an HTTP status code. */
export function cloudflareErrorStatus(code: CloudflareGenerationError): number {
  // All client-facing errors are 4xx; server-internal ones are 5xx.
  // Dispatcher/refusal codes are 422 (unprocessable entity) because the caller
  // can fix the configuration. Pipeline failures are 500 because they are
  // runtime-internal.
  switch (code) {
    case CloudflareGenerationError.GenerationDisabled:
    case CloudflareGenerationError.MissingDispatchSecret:
    case CloudflareGenerationError.DispatchSecretMismatch:
    case CloudflareGenerationError.IncompleteConfiguration:
      return 422;
    case CloudflareGenerationError.RunNotFound:
    case CloudflareGenerationError.NotWorkerDispatch:
    case CloudflareGenerationError.RunCompleted:
    case CloudflareGenerationError.NoPendingDispatch:
      return 404;
    case CloudflareGenerationError.LeaseHeld:
    case CloudflareGenerationError.OwnershipMismatch:
      return 409;
    case CloudflareGenerationError.WorkflowCreationFailed:
    case CloudflareGenerationError.AgentPipelineFailed:
    case CloudflareGenerationError.DispatchAckFailed:
    case CloudflareGenerationError.InternalError:
    case CloudflareGenerationError.RunCancelled:
      return 500;
    default:
      return 500;
  }
}