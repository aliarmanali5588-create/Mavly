/**
 * ═══ CLOUDFLARE GENERATION DISPATCHER ══════════════════════════════════════════════
 *
 * ONE dispatch tick:
 *   1. claim_generation_dispatch → picks N pending rows with FOR UPDATE SKIP LOCKED
 *   2. claim_generation_run_for_workflow → ONE run per attempt, leases it
 *   3. createWorkflows(...) → calls the Cloudflare Workflow Entrypoint once
 *   4. mark_generation_dispatch → records dispatched || failed outcome
 *
 * A crashed run after step 3 leaves the row as "dispatched"; a retry picks the
 * NEXT pending row (due > now()), never a previously dispatched one.
 *
 * The dispatcher NEVER calls the agent pipeline directly. It always hands to
 * the Workflow Entrypoint, which claims the run, executes it and finishes
 * before returning. No independent "fire-and-forget" queue is needed: the
 * durable run row + dispatch outbox are the queue.
 */

import {
  CloudflareEnvProblem,
  CloudflareGenerationConfig,
  parseCloudflareEnv,
  dispatchSecretMatches,
} from "./env";

import { createWorkerClient } from "./supabase";
import { claim_generation_dispatch, claim_generation_run_for_workflow, mark_generation_dispatch } from "../supabase/migrations/66_cloudflare_generation_dispatch";
import { GenerationProgress } from "../progress";
import { ENABLED_ENV } from "./env";

/** Maximum runs per single dispatch tick. Never more than 25 per minute. */
export const MAX_RUNS_PER_TICK = 25;

/** Idempotent Workflow instance creation. Returns the Workflow binding id. */
export async function dispatchGenerationRuns(
  env: CloudflareEnv,
  ctx: { waitUntil: (fn: () => void) => void },
  limit: number = MAX_RUNS_PER_TICK,
): Promise<{
  attempted: number;
  claimed: number;
  dispatched: number;
  errors: Array<{
    runId: string;
    reason: string;
    code: string;
  }>;
}> {
  const config = parseCloudflareEnv(env);

  if (!config.requested) {
    return { attempted: 0, claimed: 0, dispatched: 0, errors: [] };
  }

  if (config.problems.length > 0) {
    return {
      attempted: 0,
      claimed: 0,
      dispatched: 0,
      errors: config.problems.map((problem) => ({
        runId: "config",
        reason: `cloudflare.generation disabled or unavailable: ${problem}`,
        code: "cloudflare_generation_disabled",
      })),
    };
  }

  if (!config.dispatchSecret) {
    return {
      attempted: 0,
      claimed: 0,
      dispatched: 0,
      errors: [{ runId: "config", reason: "missing dispatch secret, dispatcher refuses to create Workflows", code: "missing_dispatch_secret" }],
    };
  }

  /** ****************
   * 1. Claim pending rows
   *****************/

  const dueRows = await claim_generation_dispatch(limit);

  if (dueRows.length === 0) {
    return { attempted: 0, claimed: 0, dispatched: 0, errors: [] };
  }

  /** ****************
   * 2. Claim each run for a Workflow instance
   *****************/

  const claimedRuns: {
    runId: string;
    workflowId: string;
    client: ReturnType<typeof createWorkerClient>;
    leaseExpiresAt: string;
  }[] = [];

  for (const row of dueRows) {
    const runClaim = await claim_generation_run_for_workflow(
      row.run_id,
      row.workflow_id,
      420,
    );

    if (runClaim.status !== "claimed") {
      // Refusal: not a worker-dispatched run, already claimed or terminal.
      continue;
    }

    const client = createWorkerClient({ env });

    if (!client) {
      await mark_generation_dispatch(row.run_id, "failed", "missing service role client");
      continue;
    }

    // Ownership re-verify: the run row already passed the DB filter, but make
    // sure the caller actually owns the project through the service-role client.
    const { data: projectData } = await client
      .from("projects")
      .select("owner_id")
      .eq("id", runClaim.run.project_id)
      .single();

    if (!projectData || projectData.owner_id !== runClaim.user_id) {
      await mark_generation_dispatch(row.run_id, "failed", "ownership_mismatch");
      continue;
    }

    claimedRuns.push({
      runId: row.run_id,
      workflowId: row.workflow_id,
      client,
      leaseExpiresAt: runClaim.lease_expires_at,
    });
  }

  if (claimedRuns.length === 0) {
    return {
      attempted: dueRows.length,
      claimed: 0,
      dispatched: 0,
      errors: [],
    };
  }

  /** ****************
   * 3. Create the Workflow instance for each claimed run
   *****************/

  const createPromises = claimedRuns.map(
    async ({ runId, workflowId, client, leaseExpiresAt }) => {
      try {
        // The worker sends a minimal payload that the Workflow Entrypoint will
        // expand into the full task graph. We do NOT embed the generated source
        // or the entire prompt; the Workflow reads the run row directly.
        const payload = {
          runId,
          leaseExpiresAt,
          dispatchId: workflowId,
        };

        // Hand off to the Cloudflare Workflow Entrypoint. This is an idempotent
        // create: if a Workflow with this instance id already exists, Cloudflare
        // returns the existing binding rather than starting a new execution.
        await ctx.waitUntil(
          env.GENERATION_WORKFLOW.create(
            workflowId,
            payload,
          ),
        );

        await mark_generation_dispatch(runId, "dispatched");
        return { success: true, runId };
      } catch (cause) {
        await mark_generation_dispatch(runId, "failed", (cause as Error).message);
        return { success: false, runId, error: (cause as Error).message };
      }
    },
  );

  const results = await Promise.all(createPromises);

  const dispatched = results.filter((r) => r.success).length;
  const errors = results
    .filter((r) => !r.success)
    .map((r) => ({
      runId: r.runId,
      reason: r.error ?? "workflow_creation_failed",
      code: "workflow_creation_failed",
    }));

  return {
    attempted: claimedRuns.length,
    claimed: claimedRuns.length,
    dispatched,
    errors,
  };
}

/** Fast-path for the Web UI: return the payload from the last dispatch attempt. */
export async function lastDispatchPayload(
  runId: string,
  env: CloudflareEnv,
): Promise<{
  phase: "queued" | "claiming" | "dispatched" | "failed";
  progress: GenerationProgress | null;
  error: string | null;
}> {
  const client = createWorkerClient({ env });
  if (!client) return { phase: "queued", progress: null, error: "no supabase client" };

  const { data: runRow, error } = await client
    .from("project_runs")
    .select(
      `
      id,
      status,
      stage,
      finished_at,
      cancellation_requested_at,
      error_code,
      error_message,
      last_progress_at,
      heartbeat_at,
      job_attempt,
      max_job_attempts,
      projects(owner_id)
    `,
    )
    .eq("id", runId)
    .single();

  if (error || !runRow) return { phase: "queued", progress: null, error: "run not found" };

  const progress = GenerationProgress.runProgress({
    id: runRow.id,
    status: runRow.status ?? "queued",
    stage: runRow.stage ?? null,
    finished_at: runRow.finished_at ?? null,
    cancellation_requested_at: runRow.cancellation_requested_at ?? null,
    last_progress_at: runRow.last_progress_at ?? null,
    heartbeat_at: runRow.heartbeat_at ?? null,
    job_attempt: runRow.job_attempt ?? null,
    max_job_attempts: runRow.max_job_attempts ?? null,
    error_code: runRow.error_code ?? null,
    error_message: runRow.error_message ?? null,
    // Filled from the parent through RLS:
    files_written: runRow.files_written ?? null,
    checkpoint_count: runRow.checkpoint_count ?? null,
    batch_count: runRow.batch_count ?? null,
  });

  let phase: "queued" | "claiming" | "dispatched" | "failed" = "queued";

  // If the dispatch_outbox row exists and is 'dispatched', this run was handed
  // to a Workflow instance. If the run's lease_token is not null a Workflow may
  // currently be running it, but the run row itself is authoritative.
  return {
    phase: "dispatched",
    progress,
    error: null,
  };
}