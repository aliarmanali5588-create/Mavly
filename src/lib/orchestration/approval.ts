/**
 * ═══ DEPLOYMENT APPROVAL — A SERVER-ENFORCED, ARTIFACT-BOUND GATE ═══════════
 *
 * A deployment proposal records the EXACT project, target, snapshot and source
 * hash that a human is approving. Approval is a separate, explicit act by an
 * authorized owner, and the deploy path re-checks every field at execution
 * time:
 *
 *   · approved (not merely proposed);
 *   · not expired;
 *   · not consumed by an earlier deploy;
 *   · same project, target, snapshot and source hash;
 *   · the caller still owns the project (checked by the route/RPC, not here).
 *
 * ⚠️ A MODEL CANNOT APPROVE. The deployment agent may only PROPOSE. QA success,
 * a clean security scan and a model-generated recommendation are not approvals.
 *
 * ⚠️ THIS MODULE IS PURE. The database consume RPC is the atomic claim; these
 * functions are the precondition and the human-readable refusal.
 */

export const DEPLOYMENT_TARGETS = ["static", "fullstack"] as const;
export type DeploymentTarget = (typeof DEPLOYMENT_TARGETS)[number];

export type DeploymentProposalStatus =
  | "proposed"
  | "approved"
  | "revoked"
  | "consumed"
  | "expired";

export interface DeploymentProposalRow {
  id: string;
  project_id: string;
  user_id: string;
  workflow_id: string | null;
  run_id: string | null;
  target: DeploymentTarget;
  snapshot_id: string | null;
  source_hash: string;
  runtime_profile: string | null;
  verification_id: string | null;
  status: DeploymentProposalStatus;
  summary: Record<string, unknown>;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface DeploymentApprovalExpectation {
  projectId: string;
  target: DeploymentTarget;
  snapshotId: string | null;
  sourceHash: string;
}

export function isDeploymentTarget(value: unknown): value is DeploymentTarget {
  return value === "static" || value === "fullstack";
}

export function approvalExpiry(nowMs: number, ttlMinutes: number): string {
  const bounded = Math.max(5, Math.min(1_440, Math.floor(ttlMinutes)));
  return new Date(nowMs + bounded * 60_000).toISOString();
}

/**
 * The single precondition used by both the API status projection and the deploy
 * gate. A later deploy cannot reuse an approval for different bytes, and an
 * expired approval is reported as expired rather than silently accepted.
 */
export function approvalRejectionReason(
  row: Pick<
    DeploymentProposalRow,
    | "project_id"
    | "target"
    | "snapshot_id"
    | "source_hash"
    | "status"
    | "approved_by"
    | "approved_at"
    | "expires_at"
    | "consumed_at"
    | "revoked_at"
  > | null,
  expected: DeploymentApprovalExpectation,
  nowMs: number,
): string | null {
  if (!row) return "No deployment approval exists for this request.";
  if (row.project_id !== expected.projectId) {
    return "That approval belongs to a different project.";
  }
  if (row.status === "revoked" || row.revoked_at) {
    return "That deployment approval was revoked.";
  }
  if (row.consumed_at || row.status === "consumed") {
    return "That deployment approval was already used. Create a new proposal.";
  }
  if (!row.approved_at || !row.approved_by || row.status !== "approved") {
    return "The deployment proposal has not been approved by the project owner.";
  }
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return "That deployment approval has expired. Approve a fresh proposal.";
  }
  if (row.target !== expected.target) {
    return "That approval is for a different deployment target.";
  }
  if (row.source_hash !== expected.sourceHash) {
    return "The project source changed after approval. Approve a new deployment proposal.";
  }
  const approvedSnapshot = row.snapshot_id ?? null;
  if (approvedSnapshot !== (expected.snapshotId ?? null)) {
    return "That approval is for a different source snapshot.";
  }
  return null;
}

/** A wire projection. No user id is needed by the workspace; no secret exists here. */
export interface DeploymentProposalView {
  id: string;
  target: DeploymentTarget;
  status: DeploymentProposalStatus;
  snapshotId: string | null;
  sourceHash: string;
  runtimeProfile: string | null;
  verificationId: string | null;
  summary: Record<string, unknown>;
  expiresAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

export function proposalView(
  row: DeploymentProposalRow,
  nowMs = Date.now(),
): DeploymentProposalView {
  const expired =
    row.status !== "consumed" &&
    (row.status === "expired" ||
      (row.status !== "revoked" && Date.parse(row.expires_at) <= nowMs));
  return {
    id: row.id,
    target: row.target,
    status: expired && row.status !== "revoked" ? "expired" : row.status,
    snapshotId: row.snapshot_id,
    sourceHash: row.source_hash,
    runtimeProfile: row.runtime_profile,
    verificationId: row.verification_id,
    summary: row.summary ?? {},
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export const APPROVAL_REQUIRED_CODE = "DEPLOYMENT_APPROVAL_REQUIRED";
export const APPROVAL_REQUIRED_STATUS = 428;

export function approvalRequiredMessage(): string {
  return "Production deployment requires an approved proposal bound to this exact source. Create a proposal, approve it as the project owner, then deploy with its approval id.";
}

export function approvalMismatchMessage(reason: string): string {
  return reason;
}
