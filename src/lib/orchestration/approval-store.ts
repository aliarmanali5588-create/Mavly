/**
 * ═══ DEPLOYMENT PROPOSALS AND APPROVALS (OWNER-SCOPED RPCS) ════════════════
 *
 * Every read and write here uses the CALLER'S RLS client. The tables have no
 * authenticated INSERT/UPDATE grant: the SECURITY DEFINER RPCs in migration 29
 * check auth.uid() ownership, and the consume RPC is the single atomic claim
 * that makes duplicate deploy requests safe.
 *
 * ⚠️ The approval id is not a capability by itself. The consume RPC re-checks the
 * project, target, snapshot and source hash supplied by the deploy path, and the
 * deploy path re-derives them from the current server state.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  DeploymentProposalRow,
  DeploymentProposalStatus,
  DeploymentTarget,
} from "./approval";

export type ApprovalStoreCode =
  | "unavailable"
  | "migration_required"
  | "unauthorized"
  | "not_found"
  | "validation"
  | "expired"
  | "revoked"
  | "consumed"
  | "mismatch"
  | "error";

export interface ApprovalStoreFailure {
  ok: false;
  code: ApprovalStoreCode;
  error: string;
}

export type ApprovalStoreResult<T> = { ok: true; data: T } | ApprovalStoreFailure;

export function isApprovalStoreFailure<T>(
  result: ApprovalStoreResult<T>,
): result is ApprovalStoreFailure {
  return result.ok === false;
}

function failure(code: ApprovalStoreCode, error: string): ApprovalStoreFailure {
  return { ok: false, code, error };
}

function mapError(scope: string, error: { code?: string; message?: string } | null): ApprovalStoreFailure {
  const code = error?.code ?? "unknown";
  console.warn(`[orchestration] ${scope} failed (${code})`);
  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    (error?.message ?? "").toLowerCase().includes("could not find the function")
  ) {
    return failure(
      "migration_required",
      "Deployment approvals are not installed. Apply supabase/migrations/29_multi_agent_orchestration.sql.",
    );
  }
  if (code === "28000" || code === "42501") {
    return failure("unauthorized", "This project is not authorized for that approval.");
  }
  return failure("error", "Could not complete the deployment-approval operation.");
}

async function resolveClient(client?: SupabaseClient | null): Promise<SupabaseClient | null> {
  return client ?? (await createSupabaseServerClient());
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROPOSAL_COLUMNS =
  "id,project_id,user_id,workflow_id,run_id,target,snapshot_id,source_hash,runtime_profile,verification_id,status,summary,approved_by,approved_at,expires_at,consumed_at,revoked_at,created_at";

function proposalFromRow(row: Record<string, unknown>): DeploymentProposalRow {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    user_id: String(row.user_id),
    workflow_id: typeof row.workflow_id === "string" ? row.workflow_id : null,
    run_id: typeof row.run_id === "string" ? row.run_id : null,
    target: row.target as DeploymentTarget,
    snapshot_id: typeof row.snapshot_id === "string" ? row.snapshot_id : null,
    source_hash: String(row.source_hash),
    runtime_profile: typeof row.runtime_profile === "string" ? row.runtime_profile : null,
    verification_id: typeof row.verification_id === "string" ? row.verification_id : null,
    status: row.status as DeploymentProposalStatus,
    summary: record(row.summary) ?? {},
    approved_by: typeof row.approved_by === "string" ? row.approved_by : null,
    approved_at: typeof row.approved_at === "string" ? row.approved_at : null,
    expires_at: String(row.expires_at),
    consumed_at: typeof row.consumed_at === "string" ? row.consumed_at : null,
    revoked_at: typeof row.revoked_at === "string" ? row.revoked_at : null,
    created_at: String(row.created_at),
  };
}

export interface CreateProposalInput {
  projectId: string;
  target: DeploymentTarget;
  snapshotId: string | null;
  sourceHash: string;
  runtimeProfile: string | null;
  verificationId: string | null;
  workflowId: string | null;
  runId: string | null;
  summary: Record<string, unknown>;
  expiresAt: string;
}

export async function createDeploymentProposal(
  input: CreateProposalInput,
  client?: SupabaseClient | null,
): Promise<ApprovalStoreResult<DeploymentProposalRow>> {
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("create_deployment_proposal", {
    p_project_id: input.projectId,
    p_target: input.target,
    p_snapshot_id: input.snapshotId,
    p_source_hash: input.sourceHash,
    p_runtime_profile: input.runtimeProfile,
    p_verification_id: input.verificationId,
    p_workflow_id: input.workflowId,
    p_run_id: input.runId,
    p_summary: input.summary,
    p_expires_at: input.expiresAt,
  });
  if (error) return mapError("create proposal", error);

  const payload = record(data);
  const row = record(payload?.proposal);
  if (payload?.ok !== true || !row) {
    return failure(
      "validation",
      typeof payload?.error === "string" ? payload.error : "The deployment proposal was refused.",
    );
  }
  return { ok: true, data: proposalFromRow(row) };
}

export async function approveDeploymentProposal(
  proposalId: string,
  client?: SupabaseClient | null,
): Promise<ApprovalStoreResult<DeploymentProposalRow>> {
  if (!UUID.test(proposalId)) return failure("not_found", "No such deployment proposal exists.");
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("approve_deployment_proposal", {
    p_proposal_id: proposalId,
  });
  if (error) return mapError("approve proposal", error);
  const payload = record(data);
  const row = record(payload?.proposal);
  if (payload?.ok !== true || !row) {
    const code = typeof payload?.code === "string" ? payload.code : "validation";
    return failure(
      approvalCode(code),
      typeof payload?.error === "string" ? payload.error : "The approval was refused.",
    );
  }
  return { ok: true, data: proposalFromRow(row) };
}

export async function revokeDeploymentProposal(
  proposalId: string,
  reason: string | null,
  client?: SupabaseClient | null,
): Promise<ApprovalStoreResult<DeploymentProposalRow>> {
  if (!UUID.test(proposalId)) return failure("not_found", "No such deployment proposal exists.");
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("revoke_deployment_proposal", {
    p_proposal_id: proposalId,
    p_reason: reason?.slice(0, 500) ?? null,
  });
  if (error) return mapError("revoke proposal", error);
  const payload = record(data);
  const row = record(payload?.proposal);
  if (payload?.ok !== true || !row) {
    return failure(
      approvalCode(typeof payload?.code === "string" ? payload.code : "validation"),
      typeof payload?.error === "string" ? payload.error : "The revocation was refused.",
    );
  }
  return { ok: true, data: proposalFromRow(row) };
}

export interface ConsumeApprovalInput {
  approvalId: string;
  projectId: string;
  target: DeploymentTarget;
  snapshotId: string | null;
  sourceHash: string;
}

export async function consumeDeploymentApproval(
  input: ConsumeApprovalInput,
  client?: SupabaseClient | null,
): Promise<ApprovalStoreResult<{ consumedAt: string }>> {
  if (!UUID.test(input.approvalId)) {
    return failure("not_found", "No such deployment approval exists.");
  }
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase.rpc("consume_deployment_approval", {
    p_approval_id: input.approvalId,
    p_project_id: input.projectId,
    p_target: input.target,
    p_snapshot_id: input.snapshotId,
    p_source_hash: input.sourceHash,
  });
  if (error) return mapError("consume approval", error);

  const payload = record(data);
  if (payload?.ok !== true) {
    const code = typeof payload?.code === "string" ? payload.code : "validation";
    return failure(
      approvalCode(code),
      typeof payload?.error === "string"
        ? payload.error
        : "The deployment approval was refused.",
    );
  }
  return {
    ok: true,
    data: { consumedAt: typeof payload.consumedAt === "string" ? payload.consumedAt : new Date().toISOString() },
  };
}

function approvalCode(value: string): ApprovalStoreCode {
  switch (value) {
    case "not_found":
    case "unauthorized":
    case "expired":
    case "revoked":
    case "consumed":
    case "mismatch":
    case "validation":
    case "migration_required":
    case "unavailable":
      return value;
    default:
      return "error";
  }
}

export async function listDeploymentProposals(
  projectId: string,
  client?: SupabaseClient | null,
  limit = 20,
): Promise<ApprovalStoreResult<DeploymentProposalRow[]>> {
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("deployment_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(50, limit)));
  if (error) return mapError("list proposals", error);
  return {
    ok: true,
    data: (data ?? []).map((row) => proposalFromRow(row as Record<string, unknown>)),
  };
}

export async function getDeploymentProposal(
  projectId: string,
  proposalId: string,
  client?: SupabaseClient | null,
): Promise<ApprovalStoreResult<DeploymentProposalRow | null>> {
  if (!UUID.test(proposalId)) return failure("not_found", "No such deployment proposal exists.");
  const supabase = await resolveClient(client);
  if (!supabase) return failure("unavailable", "Supabase is not configured.");

  const { data, error } = await supabase
    .from("deployment_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("project_id", projectId)
    .eq("id", proposalId)
    .maybeSingle();
  if (error) return mapError("read proposal", error);
  return {
    ok: true,
    data: data ? proposalFromRow(data as Record<string, unknown>) : null,
  };
}
