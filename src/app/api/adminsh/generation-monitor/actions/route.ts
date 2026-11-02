import type { NextRequest } from "next/server";

import { adminError, adminJson, requireAdmin } from "@/lib/admin/http";
import { createSupabaseWorkerClient } from "@/lib/supabase/worker";

export const dynamic = "force-dynamic";

/**
 * ═══ GENERATION MONITOR — REAL ACTIONS ══════════════════════════════════════
 *
 * Two actions, both of which do the thing rather than appear to:
 *
 *   retry   → `admin_retry_generation_run`, which mirrors the owner-initiated
 *             resume: same advisory lock, same column reset, same
 *             "terminal failed/interrupted only" rule. It refuses a
 *             credit-enforced project, because resuming one holds credits from
 *             the owner's balance and that is not an administrator's decision.
 *
 *   cancel  → the SAME terminal transition the owner's `agent/stop` performs,
 *             reached through `finish_credit_generation_run` for a worker run
 *             (which releases the credit hold atomically) or a fenced terminal
 *             write for an inline run. It never claims a cancellation the
 *             database did not accept.
 *
 * ⚠️ CANCELLING DOES NOT STOP A REQUEST ALREADY IN FLIGHT. The provider call
 * cannot be recalled; the run keeps none of its output and is fenced out of its
 * next checkpoint. The response says exactly that instead of implying the work
 * stopped instantly.
 *
 * ⚠️ THE SERVICE-ROLE CLIENT IS USED ONLY FOR THE CANCEL TRANSITION, and only
 * because `finish_credit_generation_run` is service-role-only by design. It is
 * created server-side, never sent to the browser, and the caller has already
 * been proven an administrator by `requireAdmin()`.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActionBody {
  runId?: unknown;
  action?: unknown;
  reason?: unknown;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return adminError(400, "INVALID_REQUEST", "The request body is not valid JSON.");
  }

  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!UUID_PATTERN.test(runId)) {
    return adminError(400, "INVALID_RUN_ID", "A valid run id is required.");
  }

  const action = body.action;
  if (action !== "retry" && action !== "cancel") {
    return adminError(400, "INVALID_ACTION", "The action must be 'retry' or 'cancel'.");
  }

  const rawReason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (rawReason.length > 500) {
    return adminError(400, "INVALID_REQUEST", "The reason must be 500 characters or fewer.");
  }

  // ── Retry ─────────────────────────────────────────────────────────────────
  if (action === "retry") {
    const { data, error } = await auth.supabase.rpc("admin_retry_generation_run", {
      p_run_id: runId,
    });

    if (error) {
      const missing = error.code === "PGRST202" || error.code === "42883";
      return adminError(
        503,
        missing ? "GENERATION_SCHEMA_MISSING" : "RETRY_FAILED",
        missing
          ? "The retry function is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
          : "The run could not be re-queued."
      );
    }

    const result = (data ?? {}) as {
      status?: string;
      reason?: string;
      message?: string;
      stage?: string;
    };

    if (result.status === "resumed") {
      return adminJson({
        ok: true,
        data: {
          status: "resumed",
          stage: result.stage ?? "queued",
          message:
            "Run re-queued. The durable worker will claim it; this does not mean it has started yet.",
        },
      });
    }

    if (result.status === "not_found") {
      return adminError(404, "RUN_NOT_FOUND", "That run does not exist.");
    }

    /**
     * A refusal is a real answer, not a failure to hide. The database explains
     * why (still running, not failed, credit-enforced, another run active) and
     * that explanation is what the operator needs.
     */
    return adminError(
      409,
      "RUN_NOT_RESUMABLE",
      result.message ??
        (result.reason === "credit_project"
          ? "This project enforces credits; the owner must resume it from their workspace."
          : "That run cannot be re-queued in its current state.")
    );
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  /**
   * Read the run first so the transition is applied to a run that is genuinely
   * open, and so the owner and dispatch mode come from the database rather than
   * from the request.
   */
  const { data: runData, error: runError } = await auth.supabase.rpc("admin_generation_detail", {
    p_run_id: runId,
  });

  if (runError) {
    const missing = runError.code === "PGRST202" || runError.code === "42883";
    return adminError(
      503,
      missing ? "GENERATION_SCHEMA_MISSING" : "CANCEL_FAILED",
      missing
        ? "The generation detail function is not installed. Apply supabase/migrations/50_admin_console_backend.sql."
        : "That run could not be read."
    );
  }

  const run = runData as {
    id?: string;
    projectId?: string;
    ownerEmail?: string | null;
    finishedAt?: string | null;
    cancellationRequestedAt?: string | null;
    dispatchMode?: string;
    stage?: string;
  } | null;

  if (!run || !run.projectId) {
    return adminError(404, "RUN_NOT_FOUND", "That run does not exist.");
  }
  if (run.finishedAt) {
    return adminError(409, "RUN_NOT_ACTIVE", "That run already finished; there is nothing to cancel.");
  }
  if (run.cancellationRequestedAt) {
    return adminError(
      409,
      "CANCEL_ALREADY_REQUESTED",
      "A cancellation was already requested for this run. The worker applies it at its next checkpoint."
    );
  }

  /**
   * The owner is required by the credit terminal path, which is scoped to
   * (user, project, run). It is read from the project row, never from the body.
   */
  const { data: ownerData, error: ownerError } = await auth.supabase
    .from("projects")
    .select("user_id")
    .eq("project_id", run.projectId)
    .maybeSingle();

  if (ownerError || !ownerData?.user_id) {
    return adminError(
      503,
      "CANCEL_FAILED",
      "The run's owner could not be resolved, so the cancellation was not attempted."
    );
  }

  const worker = createSupabaseWorkerClient();
  if (!worker) {
    return adminError(
      503,
      "CANCEL_UNAVAILABLE",
      "Server-side worker credentials are not configured, so a cancellation cannot be applied safely."
    );
  }

  const isWorkerRun = run.dispatchMode === "worker";

  if (isWorkerRun) {
    /**
     * The credit-aware terminal path releases the hold atomically with the
     * terminal write. It returns the resulting status; anything other than
     * `cancelled` means the run was not cancelled and must not be reported as
     * such.
     */
    const { data: finishData, error: finishError } = await worker.rpc(
      "finish_credit_generation_run",
      {
        p_user_id: ownerData.user_id,
        p_project_id: run.projectId,
        p_run_id: runId,
        p_status: "cancelled",
        p_stage: "cancelled",
        p_error_code: "RUN_CANCELLED",
        p_error_message: "The run was cancelled by an administrator.",
        p_reason: rawReason === "" ? "Run cancelled by an administrator" : rawReason,
      }
    );

    if (finishError) {
      console.error("[adminsh] admin cancel failed", { code: finishError.code ?? "unknown" });
      return adminError(503, "CANCEL_FAILED", "The cancellation could not be applied.");
    }

    const outcome = (finishData ?? {}) as { status?: string };

    if (outcome.status === "not_credit_project") {
      /**
       * The project is not credit-enforced, so the credit path declines and the
       * fenced terminal write below is the correct transition.
       */
    } else if (outcome.status === "cancelled") {
      const audited = await recordCancellation(auth.user, runId, run.projectId, rawReason);
      return adminJson({
        ok: true,
        data: {
          status: "cancelled",
          audited,
          message: audited
            ? "Run cancelled. A provider request already in flight cannot be recalled; the run keeps none of its output."
            : "Run cancelled, but the audit entry could not be written. The cancellation stands; the missing trail is reported here rather than hidden.",
        },
      });
    } else {
      return adminError(
        409,
        "RUN_NOT_ACTIVE",
        "The run finished or changed state before the cancellation landed."
      );
    }
  }

  /**
   * Inline run (or a non-credit worker project): a fenced terminal write. The
   * `finished_at is null` guard is the fence — if the run closed in the
   * meantime, nothing is written and the caller is told so.
   */
  const { data: updated, error: updateError } = await worker
    .from("project_runs")
    .update({
      status: "error",
      stage: "cancelled",
      finished_at: new Date().toISOString(),
      cancellation_requested_at: new Date().toISOString(),
      error_code: "RUN_CANCELLED",
      error_message: "The run was cancelled by an administrator.",
      lease_token: null,
      lease_expires_at: null,
    })
    .eq("id", runId)
    .is("finished_at", null)
    .select("id");

  if (updateError) {
    console.error("[adminsh] admin cancel write failed", { code: updateError.code ?? "unknown" });
    return adminError(503, "CANCEL_FAILED", "The cancellation could not be applied.");
  }

  if (!updated || updated.length === 0) {
    return adminError(
      409,
      "RUN_NOT_ACTIVE",
      "The run finished before the cancellation landed, so nothing was changed."
    );
  }

  const audited = await recordCancellation(auth.user, runId, run.projectId, rawReason);

  return adminJson({
    ok: true,
    data: {
      status: "cancelled",
      audited,
      message: audited
        ? "Run cancelled. A provider request already in flight cannot be recalled; the run keeps none of its output."
        : "Run cancelled, but the audit entry could not be written. The cancellation stands; the missing trail is reported here rather than hidden.",
    },
  });
}

/**
 * Record the administrative action.
 *
 * ⚠️ A FAILED AUDIT WRITE DOES NOT UNDO THE CANCELLATION, and it is not hidden:
 * the operator is told the change was applied but not recorded, because a clean
 * success whose trail does not exist is a lie the auditor will find later.
 */
async function recordCancellation(
  actor: { id: string; email: string | null },
  runId: string,
  projectId: string,
  reason: string
): Promise<boolean> {
  const worker = createSupabaseWorkerClient();
  if (!worker) return false;

  const { error } = await worker.from("admin_audit_log").insert({
    actor_user_id: actor.id,
    actor_email: actor.email,
    action: "generation.cancelled",
    target_type: "generation_run",
    target_id: runId,
    outcome: "success",
    metadata: {
      projectId,
      reason: reason === "" ? null : reason,
    },
  });

  if (error) {
    console.error("[adminsh] cancel audit write failed", { code: error.code ?? "unknown" });
    return false;
  }
  return true;
}
