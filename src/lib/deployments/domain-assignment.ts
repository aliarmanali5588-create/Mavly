/**
 * ═══ MAVLY DOMAIN ATTACHMENT — SHARED BY STATIC AND FULL-STACK PUBLISHING ═══
 *
 * Both publish paths attach the same provider-independent public address:
 * `<project-id>.mavly.xyz`. The address is always derived server-side from the
 * immutable project id; a browser never supplies a hostname.
 *
 * ⚠️ ATTACHED IS NOT VERIFIED. Only `verified: true` may make a deployment
 * reachable at the Mavly address. A pending DNS/certificate challenge is
 * reported as `pending` and retried by the status path, never as success.
 *
 * This module was extracted from `service.ts` unchanged so the Phase 5
 * orchestration can reuse it without a circular import.
 */

import {
  addVercelProjectDomain,
  getVercelProjectDomain,
  isVercelFailure,
  verifyVercelProjectDomain,
  type VercelProjectDomain,
} from "@/lib/vercel/provider";
import type { VercelDeploymentConfig } from "@/lib/vercel/config";

import { updateDeploymentRow, isDeploymentStoreFailure } from "./store";
import { publicDeploymentFailure } from "./vercel-failure";

const DOMAIN_ERROR_MAX = 500;

export interface DeploymentServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export type DomainAssignmentResult =
  | { ok: true; data: DomainAssignment }
  | DeploymentServiceFailure;

export interface DomainAssignment {
  status: "pending" | "verified" | "error";
  error: string | null;
}

function fail(
  status: number,
  code: string,
  error: string,
  retryAfterSeconds?: number,
): DeploymentServiceFailure {
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

function fromVercel(failure: Parameters<typeof publicDeploymentFailure>[0]): DeploymentServiceFailure {
  const mapped = publicDeploymentFailure(failure, "publish");
  return fail(mapped.status, mapped.code, mapped.error, mapped.retryAfterSeconds);
}

/**
 * Attach the project's Mavly hostname to its Vercel project and ask Vercel to
 * verify it. A domain that is merely attached is not ready.
 */
export async function assignMavlyDomain(
  config: VercelDeploymentConfig,
  vercelProjectId: string,
  hostname: string,
): Promise<DomainAssignmentResult> {
  const added = await addVercelProjectDomain(config, vercelProjectId, hostname);
  let domain: VercelProjectDomain;

  if (isVercelFailure(added)) {
    /**
     * Vercel reports an existing project-domain as a validation/conflict error.
     * Re-read it from THIS project before deciding: a domain attached to another
     * Vercel project must never be adopted.
     */
    if (added.failure.status === 400 || added.failure.status === 409) {
      const existing = await getVercelProjectDomain(config, vercelProjectId, hostname);
      if (isVercelFailure(existing)) {
        if (existing.failure.status === 404) {
          return fail(
            409,
            "DOMAIN_CONFLICT",
            `The Mavly address ${hostname} is already assigned to another deployment.`,
          );
        }
        return fromVercel(existing.failure);
      }
      domain = existing.data;
    } else {
      return fromVercel(added.failure);
    }
  } else {
    domain = added.data;
  }

  if (!domain.verified) {
    const checked = await verifyVercelProjectDomain(config, vercelProjectId, hostname);
    if (isVercelFailure(checked)) {
      if (checked.failure.status === 404) {
        return fail(
          502,
          "DOMAIN_NOT_FOUND",
          `Vercel could not find the Mavly address ${hostname} after assigning it.`,
        );
      }
      if (checked.failure.status === 401 || checked.failure.status === 403) {
        return fromVercel(checked.failure);
      }
      // A pending DNS/certificate challenge is not a failed publish. Status
      // checks will retry verification without ever reporting success early.
      return { ok: true, data: { status: "pending", error: null } };
    }
    domain = checked.data;
  }

  return {
    ok: true,
    data: { status: domain.verified ? "verified" : "pending", error: null },
  };
}

/** Record a domain assignment failure on the project's deployment mapping. */
export async function recordDomainFailure(
  projectId: string,
  hostname: string,
  failure: { code: string; error: string },
): Promise<void> {
  const normalizedCode = failure.code.toLowerCase();
  const errorCode = (
    normalizedCode.startsWith("domain") ? failure.code : `domain_${failure.code}`
  ).slice(0, 120);
  const updated = await updateDeploymentRow(projectId, {
    status: "error",
    error_code: errorCode,
    error_message: failure.error.slice(0, DOMAIN_ERROR_MAX),
    mavly_hostname: hostname,
    mavly_domain_status: "error",
    mavly_domain_error: failure.error.slice(0, DOMAIN_ERROR_MAX),
    mavly_domain_checked_at: new Date().toISOString(),
  });
  if (isDeploymentStoreFailure(updated)) {
    console.error("[deployments] could not record domain failure:", updated.error);
  }
}
