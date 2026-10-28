/**
 * ═══ THE DEPLOY-TIME APPROVAL GATE ═══════════════════════════════════════════
 *
 * This module is deliberately separate from `approval-service.ts`: the deploy
 * orchestrators import it, and `approval-service.ts` imports the full-stack
 * deployment module to decide the project's target. Keeping the gate here avoids
 * a module cycle between deployment and approval code.
 *
 * ⚠️ THE ARTIFACT IS ALWAYS SERVER-DERIVED. The caller passes the snapshot id and
 * source hash it resolved from current server state; the browser never supplies
 * them. The consume RPC is the atomic claim, so two concurrent deploys cannot
 * both use one approval.
 */

import type { DeploymentTarget } from "./approval";
import { approvalRequiredMessage } from "./approval";
import {
  consumeDeploymentApproval,
  isApprovalStoreFailure,
} from "./approval-store";
import { deploymentApprovalRequiredFor } from "./config";
import type { ApprovalServiceFailure } from "./approval-service-types";

export type ApprovalGateResult =
  | { ok: true; required: boolean }
  | ({ ok: false } & ApprovalServiceFailure);

function fail(status: number, code: string, error: string): ApprovalServiceFailure {
  return { status, code, error };
}

function storeFailureToGate(failure: { code: string; error: string }): ApprovalServiceFailure {
  switch (failure.code) {
    case "migration_required":
    case "unavailable":
      return fail(503, "BACKEND_NOT_CONFIGURED", failure.error);
    case "unauthorized":
      return fail(403, "FORBIDDEN", failure.error);
    case "not_found":
      return fail(404, "NOT_FOUND", failure.error);
    case "expired":
    case "revoked":
    case "consumed":
    case "mismatch":
      return fail(409, "DEPLOYMENT_APPROVAL_INVALID", failure.error);
    case "validation":
      return fail(400, "VALIDATION", failure.error);
    default:
      return fail(500, "UNKNOWN", "Could not complete the deployment-approval operation.");
  }
}

/**
 * Called after the server re-derived the artifact and immediately before any
 * provider mutation. When the gate is not configured this is a no-op, so legacy
 * deployments keep their existing behaviour.
 */
export async function enforceDeploymentApproval(input: {
  projectId: string;
  target: DeploymentTarget;
  snapshotId: string | null;
  sourceHash: string;
  approvalId: string | null;
  nowMs?: number;
}): Promise<ApprovalGateResult> {
  if (!deploymentApprovalRequiredFor(input.projectId)) {
    return { ok: true, required: false };
  }
  if (!input.approvalId) {
    return {
      ok: false,
      ...fail(428, "DEPLOYMENT_APPROVAL_REQUIRED", approvalRequiredMessage()),
    };
  }

  const consumed = await consumeDeploymentApproval({
    approvalId: input.approvalId,
    projectId: input.projectId,
    target: input.target,
    snapshotId: input.snapshotId,
    sourceHash: input.sourceHash,
  });
  if (isApprovalStoreFailure(consumed)) {
    return { ok: false, ...storeFailureToGate(consumed) };
  }
  return { ok: true, required: true };
}
