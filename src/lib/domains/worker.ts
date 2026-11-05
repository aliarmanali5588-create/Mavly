import type { SupabaseClient } from "@supabase/supabase-js";

import { readDomainConfig } from "./config";
import { DomainDnsError, verifyOwnershipTxt } from "./dns";
import { isValidPublicHostname } from "./hostname";
import { emitDomainEvent } from "./observability";
import { domainRoutingProvider } from "./active-provider";
import {
  claimDomainJob,
  completeDomainJob,
  failDomainJob,
  type ClaimedDomainJob,
} from "./store";
import type { DomainStatus } from "./types";

/**
 * One bounded domain-provisioning tick, advanced by the EXISTING EC2 generation
 * worker. It never runs in a request, never runs on a Mavly host as generated
 * code, and never writes authoritative state directly: every terminal write is
 * the fenced `complete_domain_job` / `fail_domain_job` RPC.
 *
 * The worker performs:
 *   verify   → read the TXT ownership record for a customer hostname
 *   provision→ attach the hostname to the project's Vercel project, then probe it
 *   remove   → detach the hostname from that Vercel project
 *
 * Vercel is the only routing provider; the AWS CloudFront implementation was
 * removed. A row that still records `aws_cloudfront` is historical metadata and
 * is never rewritten here.
 */

export type DomainTickStatus = "empty" | "advanced" | "unavailable" | "error";

export interface DomainTickSummary {
  status: DomainTickStatus;
  action?: "verify" | "provision" | "remove";
  projectId?: string;
  domainId?: string;
  reason?: string;
}

const MAX_FAILURE_MESSAGE = 500;

function fail(
  status: DomainTickStatus,
  reason: string,
  extra: Partial<DomainTickSummary> = {},
): DomainTickSummary {
  return { status, reason, ...extra };
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : "The domain operation failed.").slice(
    0,
    MAX_FAILURE_MESSAGE,
  );
}

function dnsErrorCode(error: unknown): string | null {
  if (error instanceof DomainDnsError) return error.code;
  return null;
}

async function finishFailure(
  client: SupabaseClient,
  claim: ClaimedDomainJob,
  input: {
    status: ClaimedDomainJob["domain"]["status"] | DomainStatus;
    code: string;
    message: string;
    retryable: boolean;
  },
): Promise<DomainTickSummary> {
  const failed = await failDomainJob(client, {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    domainStatus: input.status as never,
    failureCode: input.code,
    failureMessage: input.message,
    retryable: input.retryable,
  });
  emitDomainEvent(input.retryable ? "domain_job_retry" : "domain_job_failed", {
    projectId: claim.projectId,
    domainId: claim.domain.id,
    hostname: claim.domain.hostname,
    action: claim.action,
    code: input.code,
    status: input.status,
    attempt: claim.attemptCount,
  });
  if (!failed.ok) {
    return fail("error", (failed as { ok: false; code: string }).code.toLowerCase(), {
      action: claim.action,
      projectId: claim.projectId,
      domainId: claim.domain.id,
    });
  }
  return {
    status: "advanced",
    action: claim.action,
    projectId: claim.projectId,
    domainId: claim.domain.id,
    reason: input.code.toLowerCase(),
  };
}

async function complete(
  client: SupabaseClient,
  claim: ClaimedDomainJob,
  input: Parameters<typeof completeDomainJob>[1],
): Promise<DomainTickSummary> {
  const completed = await completeDomainJob(client, input);
  if (!completed.ok) {
    // A terminal active-limit refusal is a real customer-state failure, not a
    // transport error: record it and stop retrying.
    if ((completed as { ok: false; code: string }).code === "DOMAIN_ACTIVE_LIMIT_REACHED") {
      return finishFailure(client, claim, {
        status: claim.domain.domainType === "custom" ? "verified" : "pending",
        code: (completed as { ok: false; code: string }).code,
        message: (completed as { ok: false; error: string }).error,
        retryable: false,
      });
    }
    emitDomainEvent("domain_job_failed", {
      projectId: claim.projectId,
      domainId: claim.domain.id,
      hostname: claim.domain.hostname,
      action: claim.action,
      code: (completed as { ok: false; code: string }).code,
    });
    return fail("error", (completed as { ok: false; code: string }).code.toLowerCase(), {
      action: claim.action,
      projectId: claim.projectId,
      domainId: claim.domain.id,
    });
  }
  emitDomainEvent(
    input.outcome === "active"
      ? "domain_active"
      : input.outcome === "removed"
        ? "domain_removed"
        : "domain_verified",
    {
      projectId: claim.projectId,
      domainId: claim.domain.id,
      hostname: claim.domain.hostname,
      action: claim.action,
      status: completed.data.status,
    },
  );
  return {
    status: "advanced",
    action: claim.action,
    projectId: claim.projectId,
    domainId: claim.domain.id,
  };
}

async function handleVerify(
  client: SupabaseClient,
  claim: ClaimedDomainJob,
): Promise<DomainTickSummary> {
  if (claim.domain.domainType !== "custom") {
    return finishFailure(client, claim, {
      status: "pending",
      code: "DOMAIN_VERIFY_NOT_APPLICABLE",
      message: "Mavly-managed aliases do not use TXT ownership verification.",
      retryable: false,
    });
  }
  const token = claim.domain.verificationToken;
  if (!token) {
    return finishFailure(client, claim, {
      status: "verification_required",
      code: "DOMAIN_VERIFICATION_TOKEN_MISSING",
      message: "The verification token is missing. Remove and re-add the domain.",
      retryable: false,
    });
  }

  const config = readDomainConfig();
  try {
    const verified = await verifyOwnershipTxt({
      hostname: claim.domain.hostname,
      token,
      options: { resolvers: config.resolvers, timeoutMs: config.verificationTimeoutMs },
    });
    if (!verified) {
      return finishFailure(client, claim, {
        status: "verification_required",
        code: "DOMAIN_TXT_NOT_FOUND",
        message:
          "The verification TXT record was not found or does not match yet. Add _mavly-verification." +
          claim.domain.hostname +
          " and retry.",
        retryable: false,
      });
    }
  } catch (error) {
    const code = dnsErrorCode(error);
    if (code === "invalid_hostname") {
      return finishFailure(client, claim, {
        status: "misconfigured",
        code: "DOMAIN_HOSTNAME_INVALID",
        message: message(error),
        retryable: false,
      });
    }
    return finishFailure(client, claim, {
      status: "verifying",
      code: `DOMAIN_DNS_${(code ?? "UNAVAILABLE").toUpperCase()}`,
      message: message(error),
      retryable: true,
    });
  }

  return complete(client, claim, {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    outcome: "verified",
    dnsStatus: "pending",
    sslStatus: "not_started",
    publicationStatus: "pending",
    failureCode: null,
    failureMessage: null,
  });
}

/**
 * The Vercel project that owns this Mavly project's deployment, read with the
 * worker's service client. Vercel attaches a hostname to a PROJECT, so the
 * target is never guessed from the hostname and never supplied by a client.
 * Only a `provider = 'vercel'` row is eligible; an AWS-archived row has no
 * Vercel target and must not be routed through Vercel.
 */
async function vercelProjectTarget(
  client: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("project_deployments")
    .select("provider,vercel_project_id,vercel_project_name")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error || !data || data.provider !== "vercel") return null;
  if (typeof data.vercel_project_id === "string" && data.vercel_project_id) {
    return data.vercel_project_id;
  }
  if (typeof data.vercel_project_name === "string" && data.vercel_project_name) {
    return data.vercel_project_name;
  }
  return null;
}

async function handleProvision(
  client: SupabaseClient,
  claim: ClaimedDomainJob,
): Promise<DomainTickSummary> {
  const isCustom = claim.domain.domainType === "custom";
  const fallbackStatus = isCustom ? "verified" : "pending";

  if (!isValidPublicHostname(claim.domain.hostname)) {
    return finishFailure(client, claim, {
      status: "misconfigured",
      code: "DOMAIN_HOSTNAME_INVALID",
      message: "The stored hostname is not a valid public hostname.",
      retryable: false,
    });
  }
  /**
   * ⚠️ RETRYABLE, NOT TERMINAL. A custom domain is registered before the first
   * publish so the owner's choice is never discarded, and the publish that makes
   * it routable can still be in flight (or was refused and will be retried). The
   * bounded job backoff (15 s → 300 s, 10 attempts) waits for the published
   * version instead of dead-lettering a domain the user can still publish.
   */
  if (!claim.publication || !claim.publication.versionId) {
    return finishFailure(client, claim, {
      status: fallbackStatus,
      code: "DOMAIN_PROJECT_NOT_PUBLISHED",
      message: "Publish the project before provisioning this address.",
      retryable: true,
    });
  }

  const provider = domainRoutingProvider();
  if (!provider) {
    return finishFailure(client, claim, {
      status: fallbackStatus,
      code: "DOMAIN_PROVISIONING_DISABLED",
      message: "Domain routing is not configured on this deployment.",
      retryable: false,
    });
  }

  const config = readDomainConfig();
  const outcome = await provider.provision({
    hostname: claim.domain.hostname,
    projectId: claim.projectId,
    versionId: claim.publication.versionId,
    entryPath: claim.publication.entryPath,
    spaFallback: claim.publication.spaFallback,
    generation: Math.max(claim.publication.routingGeneration, claim.routingGeneration),
    domainType: claim.domain.domainType,
    routingApproved: claim.domain.routingApproved,
    requireApproval: config.requireRoutingApproval,
    vercelProjectTarget: await vercelProjectTarget(client, claim.projectId),
  });

  if (!outcome.ok) {
    const sslFailure = /SSL|CERTIFICATE/i.test((outcome as { ok: false; code?: string }).code);
    return finishFailure(client, claim, {
      status: (outcome as { ok: false; needsOperator?: boolean }).needsOperator
        ? fallbackStatus
        : sslFailure
          ? "ssl_failed"
          : "provisioning",
      code: (outcome as { ok: false; code?: string }).code,
      message: (outcome as { ok: false; message?: string }).message,
      retryable: (outcome as { ok: false; retryable?: boolean }).retryable,
    });
  }

  return complete(client, claim, {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    outcome: "active",
    dnsStatus: "ready",
    sslStatus: "active",
    publicationStatus: "active",
    failureCode: null,
    failureMessage: null,
    certificateReference: outcome.certificateReference,
  });
}

async function handleRemove(
  client: SupabaseClient,
  claim: ClaimedDomainJob,
): Promise<DomainTickSummary> {
  // `routing_provider = none` means no mapping was ever written for this row.
  // There is nothing to remove, so the row can be finalised truthfully.
  if (claim.domain.routingProvider === "none" && claim.domain.routingGeneration < 1) {
    return complete(client, claim, {
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      outcome: "removed",
      publicationStatus: "removed",
      failureCode: null,
      failureMessage: null,
    });
  }

  /**
   * ⚠️ THE AWS PROVIDER IS GONE. A row that still records `aws_cloudfront` was
   * mapped through the removed CloudFront KeyValueStore. This deployment cannot
   * remove that mapping, so it must never report the hostname as removed. The
   * row keeps its history and is surfaced as a disabled address needing an
   * operator.
   */
  if (claim.domain.routingProvider === "aws_cloudfront") {
    return finishFailure(client, claim, {
      status: "disabled",
      code: "DOMAIN_ROUTING_PROVIDER_RETIRED",
      message:
        "This address was routed through AWS CloudFront, which Mavly has retired. An operator must remove the old AWS route; Mavly has not reported the address as removed.",
      retryable: false,
    });
  }

  const provider = domainRoutingProvider();
  if (!provider) {
    return finishFailure(client, claim, {
      status: "removing",
      code: "DOMAIN_PROVISIONING_DISABLED",
      message:
        "The routing provider is unavailable, so the existing mapping cannot be removed yet.",
      retryable: true,
    });
  }

  const outcome = await provider.remove({
    hostname: claim.domain.hostname,
    projectId: claim.projectId,
    generation: Math.max(claim.domain.routingGeneration, claim.routingGeneration, 1),
    vercelProjectTarget: await vercelProjectTarget(client, claim.projectId),
  });
  if (!outcome.ok) {
    return finishFailure(client, claim, {
      status: "removing",
      code: (outcome as { ok: false; code?: string }).code,
      message: (outcome as { ok: false; message?: string }).message,
      retryable: (outcome as { ok: false; retryable?: boolean }).retryable,
    });
  }

  return complete(client, claim, {
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    outcome: "removed",
    publicationStatus: "removed",
    failureCode: null,
    failureMessage: null,
  });
}

export async function runDomainProvisioningTick(input: {
  client: SupabaseClient;
}): Promise<DomainTickSummary> {
  const config = readDomainConfig();
  if (!config.enabled) return fail("unavailable", "disabled");
  if (!config.provisioningEnabled) return fail("unavailable", "provisioning_disabled");

  const claimed = await claimDomainJob(input.client);
  if (!claimed.ok) {
    emitDomainEvent("domain_job_failed", { code: (claimed as { ok: false; code: string }).code, reason: "claim_failed" });
    return fail(
      (claimed as { ok: false; code: string }).code === "MIGRATION_REQUIRED" ? "unavailable" : "error",
      (claimed as { ok: false; code: string }).code.toLowerCase(),
    );
  }
  const claim = claimed.data;
  if (!claim) return fail("empty", "no_job");

  const startedAt = Date.now();
  try {
    const summary =
      claim.action === "verify"
        ? await handleVerify(input.client, claim)
        : claim.action === "provision"
          ? await handleProvision(input.client, claim)
          : await handleRemove(input.client, claim);
    emitDomainEvent("domain_routing_synced", {
      projectId: claim.projectId,
      domainId: claim.domain.id,
      hostname: claim.domain.hostname,
      action: claim.action,
      attempt: claim.attemptCount,
      durationMs: Date.now() - startedAt,
    });
    return summary;
  } catch (error) {
    return finishFailure(input.client, claim, {
      status:
        claim.action === "verify"
          ? "verifying"
          : claim.action === "remove"
            ? "removing"
            : claim.domain.domainType === "custom"
              ? "provisioning"
              : "pending",
      code: "DOMAIN_WORKER_ERROR",
      message: message(error),
      retryable: true,
    });
  }
}
