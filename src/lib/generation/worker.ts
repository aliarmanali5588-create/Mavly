/**
 * ═══ ONE WORKER TICK: RECOVER, CLAIM, EXECUTE, RENEW ═════════════════════════
 *
 * This module is the durable worker's orchestration boundary. It performs one
 * bounded unit of work per invocation:
 *
 *   1. PREFLIGHT  — the worker must be configured and migration 16 installed.
 *   2. RECOVER    — expired leases become bounded retries or dead letters.
 *   3. CLAIM      — one ready job, atomically, with `FOR UPDATE SKIP LOCKED`.
 *   4. VERIFY     — re-read the project and re-check its owner and cohort.
 *   5. EXECUTE    — `runAgent` with the lease token and service-role client.
 *   6. RENEW      — a timer keeps the lease alive during long provider calls.
 *
 * ⚠️ THE SERVICE-ROLE CLIENT IS CONFINED TO THIS MODULE AND THE ROUTE. The
 * worker re-verifies ownership itself; a claim answer is never treated as
 * proof. RLS is unchanged for every user-facing path.
 *
 * ⚠️ ONE JOB PER TICK. The existing admission cap (2 per user, 8 global
 * unfinished runs) is the concurrency control. A loop here would multiply the
 * work an invocation performs and make the route's wall-clock budget
 * unpredictable; the scheduler's parallelism is the scale knob.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { runAgent } from "@/lib/mavly/run-agent";
import {
  claimWorkerJob,
  generationWorkerSchemaVersion,
  getProject,
  insertMessage,
  isStoreFailure,
  recoverExpiredGenerationLeases,
  renewWorkerLease,
  scheduleGenerationRetry,
} from "@/lib/mavly/store";
import { createSupabaseWorkerClient } from "@/lib/supabase/worker";
import { emitGenerationEvent, emitVerificationEvent } from "@/lib/observability/events";
import { runVerificationTick } from "@/lib/sandbox/verification";
import {
  LEASE_RENEW_INTERVAL_MS,
  WORKER_LEASE_SECONDS,
} from "./leases";
import {
  isWorkerSchemaReady,
  parseClaimResult,
  verifyClaimedProject,
  type ClaimedGenerationJob,
} from "./verification";
import {
  generationWorkerConfig,
  type GenerationWorkerConfig,
} from "./worker-config";

export type WorkerTickStatus =
  | "completed"
  | "failed"
  | "retry"
  | "dead_letter"
  | "cancelled"
  | "skipped"
  | "empty"
  | "unavailable"
  | "error";

export interface WorkerTickResult {
  status: WorkerTickStatus;
  runId?: string;
  errorClass?: string;
  retryAfterSeconds?: number;
  reason?: string;
  recovered?: number;
  /** Present only when this tick advanced the verification queue instead. */
  verification?: WorkerVerificationSummary;
}

export interface WorkerVerificationSummary {
  status: string;
  verificationId?: string;
  outcome?: string;
  reason?: string;
  recovered?: number;
  cleaned?: number;
}

export interface WorkerTickOptions {
  config?: GenerationWorkerConfig;
  /** Injectable for tests; production uses the service-role client. */
  client?: SupabaseClient | null;
}

export async function runGenerationWorkerOnce(
  options: WorkerTickOptions = {},
): Promise<WorkerTickResult> {
  const config = options.config ?? generationWorkerConfig();
  if (!config.requested) {
    return { status: "unavailable", reason: "disabled" };
  }
  if (!config.ready || !config.secret) {
    emitGenerationEvent("generation.worker_unavailable", {
      workerId: config.workerId,
      reason: config.problems[0] ?? "misconfigured",
    });
    return { status: "unavailable", reason: "misconfigured" };
  }

  const client = options.client ?? createSupabaseWorkerClient();
  if (!client) {
    emitGenerationEvent("generation.worker_unavailable", {
      workerId: config.workerId,
      reason: "missing_service_role",
    });
    return { status: "unavailable", reason: "missing_service_role" };
  }

  /**
   * ⚠️ PREFLIGHT BEFORE ANY WRITE. A worker against a database without
   * migration 16 must not claim, execute or fabricate a status.
   */
  const schemaVersion = await generationWorkerSchemaVersion(client);
  if (!isWorkerSchemaReady(schemaVersion)) {
    emitGenerationEvent("generation.worker_unavailable", {
      workerId: config.workerId,
      reason: "schema_outdated",
    });
    return { status: "unavailable", reason: "schema_outdated" };
  }

  const recovered = await recoverExpired(client, config);

  const claim = await claimWorkerJob(client, {
    workerId: config.workerId,
    leaseSeconds: WORKER_LEASE_SECONDS,
    projectIds: config.cohort,
  });
  if (isStoreFailure(claim)) {
    emitGenerationEvent("generation.worker_error", {
      workerId: config.workerId,
      reason: claim.code === "MIGRATION_REQUIRED" ? "schema_outdated" : "claim_failed",
    });
    return { status: "error", reason: "claim_failed", recovered };
  }

  const parsed = parseClaimResult(claim.data);
  if (parsed.status === "empty") {
    emitGenerationEvent("generation.worker_empty", {
      workerId: config.workerId,
      recovered,
    });
    /**
     * No generation job is ready, so this invocation advances at most one
     * verification. Running it only here keeps Phase 2's claim order intact;
     * a busy generation queue delays verification, it never preempts it.
     */
    const verification = await runVerificationSafely(client, config.workerId);
    return {
      status: "empty",
      recovered,
      ...(verification ? { verification } : {}),
    };
  }
  if (parsed.status === "dead_letter") {
    emitGenerationEvent("generation.dead_letter", {
      workerId: config.workerId,
      reason: parsed.reason,
    });
    return { status: "dead_letter", reason: parsed.reason, recovered };
  }
  if (parsed.status === "invalid") {
    emitGenerationEvent("generation.claim_failed", {
      workerId: config.workerId,
      reason: parsed.reason,
    });
    return { status: "error", reason: parsed.reason, recovered };
  }

  const job = parsed.job;

  /**
   * ⚠️ A CLAIM IS NOT PROOF OF OWNERSHIP. Re-read the project with the service
   * client and refuse to execute unless the claim's owner is still the owner
   * and this deployment's cohort still covers the project.
   */
  const project = await getProject(job.userId, job.projectId, client);
  if (isStoreFailure(project)) {
    emitGenerationEvent("generation.worker_error", {
      traceId: job.traceId,
      runId: job.runId,
      projectId: job.projectId,
      workerId: config.workerId,
      reason: "store_unavailable",
    });
    return { status: "error", reason: "store_unavailable", recovered };
  }

  const verification = verifyClaimedProject({
    job,
    ownerId: project.data?.user_id ?? null,
    cohort: config.cohort,
  });
  /**
   * `=== false`, not `!verification.ok`: with this project's
   * `strictNullChecks: false`, the truthiness form does not narrow the union, so
   * `verification.reason` below would be a type error. The explicit literal
   * comparison narrows (the same pattern as `design.ok === false` above).
   */
  if (verification.ok === false) {
    await abandonClaim(client, job, config, verification.reason);
    return { status: "skipped", runId: job.runId, reason: verification.reason, recovered };
  }

  emitGenerationEvent("generation.claimed", {
    traceId: job.traceId,
    runId: job.runId,
    projectId: job.projectId,
    workerId: config.workerId,
    attempt: job.jobAttempt,
    maxAttempts: job.maxAttempts,
    model: job.model,
    queueLagMs: queueLagMs(job),
  });

  const renewal = startLeaseRenewal(client, job, config);

  let outcome;
  try {
    outcome = await runAgent({
      userId: job.userId,
      projectId: job.projectId,
      runId: job.runId,
      prompt: job.prompt,
      requestedModel: job.requestedModel,
      resume: job.jobAttempt > 1,
      worker: {
        client,
        leaseToken: job.leaseToken,
        jobAttempt: job.jobAttempt,
        maxJobAttempts: job.maxAttempts,
        workerId: config.workerId,
        traceId: job.traceId,
      },
    });
  } finally {
    renewal.stop();
  }

  return {
    status: outcome.status,
    runId: outcome.runId,
    ...(outcome.status === "failed" || outcome.status === "dead_letter"
      ? { errorClass: outcome.errorClass }
      : {}),
    ...(outcome.status === "retry"
      ? { retryAfterSeconds: outcome.retryAfterSeconds }
      : {}),
    ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
    recovered,
  };
}

/**
 * Advance the verification queue, if it is configured at all. A verification
 * failure is never a generation failure, and never changes this tick's status.
 */
async function runVerificationSafely(
  client: SupabaseClient,
  workerId: string,
): Promise<WorkerVerificationSummary | null> {
  try {
    const tick = await runVerificationTick({ client, workerId });
    if (tick.status === "unavailable" && tick.reason === "disabled") return null;
    return {
      status: tick.status,
      ...(tick.verificationId ? { verificationId: tick.verificationId } : {}),
      ...(tick.outcome ? { outcome: tick.outcome } : {}),
      ...(tick.reason ? { reason: tick.reason } : {}),
      ...(tick.recovered !== undefined ? { recovered: tick.recovered } : {}),
      ...(tick.cleaned !== undefined ? { cleaned: tick.cleaned } : {}),
    };
  } catch {
    emitVerificationEvent("verification.error", { workerId, reason: "unhandled_tick" });
    return { status: "error", reason: "unhandled" };
  }
}

/**
 * The claimed project could not be verified. The claim is ours, so release it
 * through the normal bounded-retry path: the lease is cleared without deleting
 * accepted work, and the attempt budget eventually dead-letters an anomaly that
 * cannot be fixed by retrying.
 */
async function abandonClaim(
  client: SupabaseClient,
  job: ClaimedGenerationJob,
  config: GenerationWorkerConfig,
  reason: string,
): Promise<void> {
  emitGenerationEvent("generation.claim_failed", {
    traceId: job.traceId,
    runId: job.runId,
    projectId: job.projectId,
    workerId: config.workerId,
    reason,
  });

  const summary =
    reason === "owner_mismatch"
      ? "The project owner changed while the job was queued."
      : "The project is no longer in the generation-worker cohort.";

  const scheduled = await scheduleGenerationRetry(client, {
    runId: job.runId,
    leaseToken: job.leaseToken,
    errorClass: reason,
    errorSummary: summary,
    retryAfterSeconds: 5,
  });

  if (isStoreFailure(scheduled) || scheduled.data.status !== "dead_letter") return;

  await insertMessage(
    job.projectId,
    "agent",
    "The generation stopped because this job could no longer be executed. You can resume it from the workspace.",
    "error",
    null,
    client,
  );
}

function startLeaseRenewal(
  client: SupabaseClient,
  job: ClaimedGenerationJob,
  config: GenerationWorkerConfig,
): { stop: () => void } {
  let stopped = false;
  let inFlight = false;
  let lost = false;

  const timer = setInterval(() => {
    if (stopped || inFlight || lost) return;
    inFlight = true;
    void renewWorkerLease(client, job.runId, job.leaseToken, WORKER_LEASE_SECONDS)
      .then((renewed) => {
        if (renewed || stopped) return;
        lost = true;
        emitGenerationEvent("generation.lease_lost", {
          traceId: job.traceId,
          runId: job.runId,
          projectId: job.projectId,
          workerId: config.workerId,
          attempt: job.jobAttempt,
          reason: "renewal_rejected",
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, LEASE_RENEW_INTERVAL_MS);

  // A serverless invocation may end before the interval does; an unref'd timer
  // never keeps the process alive on its own.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function recoverExpired(
  client: SupabaseClient,
  config: GenerationWorkerConfig,
): Promise<number> {
  const recovered = await recoverExpiredGenerationLeases(client, 5);
  if (isStoreFailure(recovered)) {
    emitGenerationEvent("generation.worker_error", {
      workerId: config.workerId,
      reason: "recovery_failed",
    });
    return 0;
  }

  const record =
    recovered.data && typeof recovered.data === "object" && !Array.isArray(recovered.data)
      ? (recovered.data as Record<string, unknown>)
      : {};
  const entries = Array.isArray(record.recovered) ? record.recovered : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    emitGenerationEvent("generation.lease_recovered", {
      runId: typeof row.runId === "string" ? row.runId : null,
      workerId: config.workerId,
      status: typeof row.status === "string" ? row.status : null,
      attempt: typeof row.attempt === "number" ? row.attempt : null,
      retryAfterSeconds:
        typeof row.retryInSeconds === "number" ? row.retryInSeconds : null,
    });
  }

  return entries.length;
}

function queueLagMs(job: ClaimedGenerationJob): number | null {
  if (!job.claimedAt || !job.enqueuedAt) return null;
  const claimed = Date.parse(job.claimedAt);
  const enqueued = Date.parse(job.enqueuedAt);
  if (!Number.isFinite(claimed) || !Number.isFinite(enqueued)) return null;
  return Math.max(0, claimed - enqueued);
}
