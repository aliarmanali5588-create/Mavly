/**
 * ═══ CLAIM VERIFICATION ══════════════════════════════════════════════════════
 *
 * The worker runs with a service-role client, so RLS cannot protect it from a
 * malformed or unexpected RPC answer. This module is the second wall: only a
 * claim with a real UUID run id and lease token, a routable project id, a
 * verified owner and a worker dispatch mode is allowed to execute.
 *
 * ⚠️ THE SERVICE-ROLE WORKER MUST VERIFY OWNERSHIP ITSELF. `claim_generation_job`
 * joins `public.projects` and returns the owner, but this module re-checks that
 * value against a fresh project read before a single file is written.
 */

import { isRoutableProjectSlug } from "@/lib/project-slug";
import { isTraceId, isUuid } from "@/lib/observability/correlation";
import { isGenerationStage, type GenerationStage } from "./state-machine";

export interface ClaimedGenerationJob {
  runId: string;
  projectId: string;
  userId: string;
  prompt: string;
  model: string | null;
  requestedModel: string | null;
  leaseToken: string;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  enqueuedAt: string | null;
  jobAttempt: number;
  maxAttempts: number;
  traceId: string;
  stage: GenerationStage;
  generationManifest: unknown;
}

export type ClaimParseResult =
  | { status: "empty" }
  | { status: "dead_letter"; reason: string }
  | { status: "claimed"; job: ClaimedGenerationJob }
  | { status: "invalid"; reason: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parse the `claim_generation_job` answer. A claim that fails validation is an
 * `invalid` result — the worker does not guess, and does not run a partial row.
 */
export function parseClaimResult(raw: unknown): ClaimParseResult {
  const record = recordOf(raw);
  if (!record) return { status: "invalid", reason: "not_an_object" };

  const status = stringOf(record.status);
  if (status === "empty") return { status: "empty" };
  if (status === "dead_letter") {
    return { status: "dead_letter", reason: stringOf(record.reason) ?? "unknown" };
  }
  if (status !== "claimed") return { status: "invalid", reason: "unknown_status" };

  const run = recordOf(record.run);
  if (!run) return { status: "invalid", reason: "missing_run" };

  const runId = stringOf(run.id);
  const projectId = stringOf(run.project_id);
  const userId = stringOf(record.user_id);
  const leaseToken = stringOf(run.lease_token);
  const traceId = stringOf(run.trace_id);
  const prompt = stringOf(run.prompt);
  const stage = stringOf(run.stage);

  if (!isUuid(runId)) return { status: "invalid", reason: "invalid_run_id" };
  if (!isRoutableProjectSlug(projectId ?? "")) {
    return { status: "invalid", reason: "invalid_project_id" };
  }
  if (!isUuid(userId)) return { status: "invalid", reason: "invalid_user_id" };
  if (!isUuid(leaseToken)) return { status: "invalid", reason: "invalid_lease_token" };
  if (!isTraceId(traceId)) return { status: "invalid", reason: "invalid_trace_id" };
  if (!isGenerationStage(stage) || stage !== "validating") {
    return { status: "invalid", reason: "not_claimed_stage" };
  }
  if (run.dispatch_mode !== "worker") {
    return { status: "invalid", reason: "not_worker_dispatched" };
  }
  if (run.finished_at !== null && run.finished_at !== undefined) {
    return { status: "invalid", reason: "already_finished" };
  }
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 32_000) {
    return { status: "invalid", reason: "invalid_prompt" };
  }

  // PostgREST returns these as JSON numbers. A string is a malformed claim,
  // not something to coerce: the service-role boundary stays strict.
  const jobAttempt = typeof run.job_attempt === "number" ? run.job_attempt : Number.NaN;
  const maxAttempts =
    typeof run.max_job_attempts === "number" ? run.max_job_attempts : Number.NaN;
  if (!Number.isInteger(jobAttempt) || jobAttempt < 1) {
    return { status: "invalid", reason: "invalid_job_attempt" };
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    return { status: "invalid", reason: "invalid_max_attempts" };
  }
  if (jobAttempt > maxAttempts) {
    return { status: "invalid", reason: "attempt_budget_exceeded" };
  }

  return {
    status: "claimed",
    job: {
      runId,
      projectId: projectId as string,
      userId,
      prompt,
      model: stringOf(run.model),
      requestedModel: stringOf(run.model),
      leaseToken,
      leaseExpiresAt: stringOf(run.lease_expires_at),
      claimedAt: stringOf(run.claimed_at),
      enqueuedAt: stringOf(run.enqueued_at),
      jobAttempt,
      maxAttempts,
      traceId,
      stage,
      generationManifest: run.generation_manifest ?? null,
    },
  };
}

export type ProjectVerification =
  | { ok: true }
  | { ok: false; reason: "owner_mismatch" };

/**
 * Re-check the claim against a fresh project row. `ownerId` comes from
 * `public.projects`, never from the request.
 */
export function verifyClaimedProject(input: {
  job: Pick<ClaimedGenerationJob, "projectId" | "userId">;
  ownerId: string | null | undefined;
}): ProjectVerification {
  if (!input.ownerId || input.ownerId !== input.job.userId) {
    return { ok: false, reason: "owner_mismatch" };
  }
  return { ok: true };
}

/** Migration 32 or newer is required before a worker may claim anything. */
export function isWorkerSchemaReady(version: unknown): boolean {
  const parsed = typeof version === "number" ? version : Number(version);
  return Number.isInteger(parsed) && parsed >= 32;
}
