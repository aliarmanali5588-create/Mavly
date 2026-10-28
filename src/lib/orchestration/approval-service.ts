/**
 * ═══ DEPLOYMENT APPROVAL SERVICE ════════════════════════════════════════════
 *
 * Phase 10's server-side contract:
 *
 *   1. the server DERIVES the artifact (verified snapshot + hash, or the exact
 *      static file set and its hash) — the browser never supplies a hash;
 *   2. the owner explicitly approves that exact proposal;
 *   3. the deploy path re-derives the artifact and atomically consumes the
 *      approval, refusing expired/revoked/reused/mismatched approvals.
 *
 * ⚠️ No model and no QA result approves anything. The deployment agent may only
 * request that a proposal be shown to the owner.
 */

import { isFullstackDeploymentRow } from "@/lib/deployments/fullstack";
import { isFullstackHostingRequested } from "@/lib/hosting/fullstack-config";
import { resolveVerifiedSource } from "@/lib/hosting/fullstack-source";
import { getProject, isStoreFailure, listFiles } from "@/lib/mavly/store";
import { hashSource } from "@/lib/mavly/snapshots";
import { resolveStaticPreview, staticPublishFiles } from "@/lib/static-site";

import {
  approvalExpiry,
  isDeploymentTarget,
  proposalView,
  type DeploymentProposalView,
  type DeploymentTarget,
} from "./approval";
import type { ApprovalServiceFailure } from "./approval-service-types";
import {
  approveDeploymentProposal,
  createDeploymentProposal,
  getDeploymentProposal,
  isApprovalStoreFailure,
  listDeploymentProposals,
  revokeDeploymentProposal,
} from "./approval-store";
import { deploymentApprovalConfig, deploymentApprovalRequiredFor } from "./config";

export type ApprovalServiceResult<T> =
  | { ok: true; data: T }
  | ({ ok: false } & ApprovalServiceFailure);

export function isApprovalServiceFailure<T>(
  result: ApprovalServiceResult<T>,
): result is { ok: false } & ApprovalServiceFailure {
  return result.ok === false;
}

function fail(status: number, code: string, error: string): ApprovalServiceFailure {
  return { status, code, error };
}

function storeFailureToService(failure: {
  code: string;
  error: string;
}): ApprovalServiceFailure {
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

interface OwnedProject {
  projectId: string;
}

async function verifyOwnership(
  userId: string,
  projectId: string,
): Promise<ApprovalServiceFailure | OwnedProject> {
  const project = await getProject(userId, projectId);
  if (isStoreFailure(project)) {
    return fail(500, "UNKNOWN", "Could not verify this project.");
  }
  if (!project.data || project.data.user_id !== userId) {
    return fail(403, "FORBIDDEN", "You don't have access to this project.");
  }
  return { projectId };
}

async function resolvedTarget(projectId: string): Promise<DeploymentTarget> {
  if (isFullstackHostingRequested(projectId) || (await isFullstackDeploymentRow(projectId))) {
    return "fullstack";
  }
  return "static";
}

export interface ProposalRequest {
  snapshotId?: string | null;
  target?: unknown;
}

/**
 * Derive and record a proposal. It is NOT an approval and NOT a deployment.
 */
export async function proposeDeployment(
  userId: string,
  projectId: string,
  body: ProposalRequest,
  nowMs = Date.now(),
): Promise<ApprovalServiceResult<{ proposal: DeploymentProposalView; approvalRequired: boolean }>> {
  const owned = await verifyOwnership(userId, projectId);
  if ("status" in owned) return { ok: false, ...owned };

  const target = await resolvedTarget(projectId);
  if (body.target !== undefined && body.target !== target) {
    if (body.target === "static" && target === "fullstack") {
      return {
        ok: false,
        ...fail(
          409,
          "VALIDATION",
          "This project is configured for full-stack hosting; a static publish would drop its server routes.",
        ),
      };
    }
    return {
      ok: false,
      ...fail(400, "VALIDATION", `This project's deployment target is ${target}.`),
    };
  }
  if (body.target !== undefined && !isDeploymentTarget(body.target)) {
    return { ok: false, ...fail(400, "VALIDATION", "Unknown deployment target.") };
  }

  const expiresAt = approvalExpiry(nowMs, deploymentApprovalConfig().ttlMinutes);

  if (target === "fullstack") {
    const source = await resolveVerifiedSource(projectId, body.snapshotId ?? null);
    if ("error" in source) {
      return {
        ok: false,
        ...fail(
          source.code === "migration_required" || source.code === "unavailable" ? 503 : 409,
          source.code === "migration_required" ? "MIGRATION_REQUIRED" : "VERIFICATION_REQUIRED",
          source.error,
        ),
      };
    }
    const summary = {
      target,
      verification: "passed",
      verificationId: source.source.verificationId,
      runtimeProfile: source.source.runtimeProfile,
      fileCount: source.source.files.length,
      risks: [
        "The provider builds and runs the generated server code in its own runtime.",
        "Approval is bound to this snapshot and source hash; a later edit invalidates it.",
      ],
    };
    const created = await createDeploymentProposal({
      projectId,
      target,
      snapshotId: source.source.snapshotId,
      sourceHash: source.source.sourceHash,
      runtimeProfile: source.source.runtimeProfile,
      verificationId: source.source.verificationId,
      workflowId: null,
      runId: null,
      summary,
      expiresAt,
    });
    if (isApprovalStoreFailure(created)) {
      return { ok: false, ...storeFailureToService(created) };
    }
    return {
      ok: true,
      data: {
        proposal: proposalView(created.data, nowMs),
        approvalRequired: deploymentApprovalRequiredFor(projectId),
      },
    };
  }

  const files = await listFiles(projectId);
  if (isStoreFailure(files)) {
    return { ok: false, ...fail(500, "UNKNOWN", "Could not read the project source.") };
  }
  const resolved = resolveStaticPreview(
    files.data.map((file) => ({ path: file.path, content: file.content })),
  );
  if (!resolved.site) {
    return { ok: false, ...fail(400, "VALIDATION", resolved.reason) };
  }
  const publishFiles = staticPublishFiles(
    files.data.map((file) => ({ path: file.path, content: file.content })),
    resolved.site,
  );
  if (publishFiles.length === 0) {
    return { ok: false, ...fail(400, "VALIDATION", "This project has no static files to publish.") };
  }
  const sourceHash = hashSource(publishFiles);
  const totalBytes = publishFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  const summary = {
    target,
    entryPoint: resolved.site.entryPath,
    fileCount: publishFiles.length,
    totalBytes,
    verification: "not_applicable",
    risks: [
      "Static publication uploads the exact files listed in this proposal; no build or runtime check is performed.",
      "Approval is bound to this file set's source hash; a later edit invalidates it.",
    ],
  };
  const created = await createDeploymentProposal({
    projectId,
    target,
    snapshotId: null,
    sourceHash,
    runtimeProfile: null,
    verificationId: null,
    workflowId: null,
    runId: null,
    summary,
    expiresAt,
  });
  if (isApprovalStoreFailure(created)) {
    return { ok: false, ...storeFailureToService(created) };
  }
  return {
    ok: true,
    data: {
      proposal: proposalView(created.data, nowMs),
      approvalRequired: deploymentApprovalRequiredFor(projectId),
    },
  };
}

export async function approveProposal(
  userId: string,
  projectId: string,
  proposalId: string,
  nowMs = Date.now(),
): Promise<ApprovalServiceResult<DeploymentProposalView>> {
  const owned = await verifyOwnership(userId, projectId);
  if ("status" in owned) return { ok: false, ...owned };

  const result = await approveDeploymentProposal(proposalId);
  if (isApprovalStoreFailure(result)) {
    return { ok: false, ...storeFailureToService(result) };
  }
  return { ok: true, data: proposalView(result.data, nowMs) };
}

export async function revokeProposal(
  userId: string,
  projectId: string,
  proposalId: string,
  reason: string | null,
  nowMs = Date.now(),
): Promise<ApprovalServiceResult<DeploymentProposalView>> {
  const owned = await verifyOwnership(userId, projectId);
  if ("status" in owned) return { ok: false, ...owned };

  const result = await revokeDeploymentProposal(proposalId, reason);
  if (isApprovalStoreFailure(result)) {
    return { ok: false, ...storeFailureToService(result) };
  }
  return { ok: true, data: proposalView(result.data, nowMs) };
}

export async function listProposals(
  userId: string,
  projectId: string,
  nowMs = Date.now(),
): Promise<ApprovalServiceResult<{ approvalRequired: boolean; proposals: DeploymentProposalView[] }>> {
  const owned = await verifyOwnership(userId, projectId);
  if ("status" in owned) return { ok: false, ...owned };

  const result = await listDeploymentProposals(projectId);
  if (isApprovalStoreFailure(result)) {
    return { ok: false, ...storeFailureToService(result) };
  }
  return {
    ok: true,
    data: {
      approvalRequired: deploymentApprovalRequiredFor(projectId),
      proposals: result.data.map((row) => proposalView(row, nowMs)),
    },
  };
}

export async function getProposal(
  userId: string,
  projectId: string,
  proposalId: string,
  nowMs = Date.now(),
): Promise<ApprovalServiceResult<DeploymentProposalView>> {
  const owned = await verifyOwnership(userId, projectId);
  if ("status" in owned) return { ok: false, ...owned };

  const result = await getDeploymentProposal(projectId, proposalId);
  if (isApprovalStoreFailure(result)) {
    return { ok: false, ...storeFailureToService(result) };
  }
  if (!result.data) return { ok: false, ...fail(404, "NOT_FOUND", "No such deployment proposal exists.") };
  return { ok: true, data: proposalView(result.data, nowMs) };
}

/**
 * Kept as a re-export so callers that already import the approval service do not
 * need a second import path. The implementation lives in `approval-gate.ts` to
 * keep the deploy modules free of an import cycle.
 */
export {
  enforceDeploymentApproval,
  type ApprovalGateResult,
} from "./approval-gate";
