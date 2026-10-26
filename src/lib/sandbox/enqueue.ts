/**
 * ═══ VERIFICATION ENQUEUE ═══════════════════════════════════════════════════
 *
 * Called only after a worker generation run finished and its result snapshot
 * was stored. It is deliberately separate from the sandbox orchestration so
 * the generation path does not import the provider SDK.
 *
 * ⚠️ ENQUEUE NEVER FAILS A GENERATION. A missing migration, a rate limit or a
 * store error is reported as a verification event and the run stays completed.
 * Verification is evidence, not part of the generation transaction.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitVerificationEvent } from "@/lib/observability/events";

import { verificationSandboxConfig, type VerificationSandboxConfig } from "./config";
import { enqueueVerification } from "./store";

export interface VerificationEnqueueInput {
  client: SupabaseClient;
  projectId: string;
  runId: string;
  snapshotId: string;
  sourceHash: string;
  traceId: string | null;
}

export type VerificationEnqueueOutcome =
  | "disabled"
  | "outside_cohort"
  | "not_ready"
  | "enqueued"
  | "existing"
  | "rate_limited"
  | "failed";

export async function maybeEnqueueVerification(
  input: VerificationEnqueueInput,
  config: VerificationSandboxConfig = verificationSandboxConfig(),
): Promise<VerificationEnqueueOutcome> {
  if (!config.requested) return "disabled";

  if (!config.ready || !config.provider) {
    emitVerificationEvent("verification.enqueue_skipped", {
      runId: input.runId,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      traceId: input.traceId,
      reason: `config:${config.problems[0] ?? "not_ready"}`.slice(0, 80),
    });
    return "not_ready";
  }

  if (!config.cohort.includes(input.projectId.toLowerCase())) {
    return "outside_cohort";
  }

  try {
    const result = await enqueueVerification(input.client, {
      projectId: input.projectId,
      runId: input.runId,
      snapshotId: input.snapshotId,
      sourceHash: input.sourceHash,
      provider: config.provider,
      traceId: input.traceId,
      maxRepairs: config.repairEnabled ? config.maxRepairs : 0,
    });

    if (!result.ok) {
      emitVerificationEvent("verification.enqueue_failed", {
        runId: input.runId,
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        traceId: input.traceId,
        provider: config.provider,
        reason: "store_error",
      });
      return "failed";
    }

    if (result.status === "rate_limited") {
      emitVerificationEvent("verification.enqueue_skipped", {
        runId: input.runId,
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        traceId: input.traceId,
        provider: config.provider,
        reason: `rate_limited:${result.scope ?? "unknown"}`.slice(0, 80),
      });
      return "rate_limited";
    }

    emitVerificationEvent("verification.enqueued", {
      runId: input.runId,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      verificationId: result.verification?.id ?? null,
      traceId: input.traceId,
      provider: config.provider,
      status: result.status === "existing" ? "existing" : "queued",
    });
    return result.status === "existing" ? "existing" : "enqueued";
  } catch {
    emitVerificationEvent("verification.enqueue_failed", {
      runId: input.runId,
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      traceId: input.traceId,
      provider: config.provider,
      reason: "unhandled",
    });
    return "failed";
  }
}
