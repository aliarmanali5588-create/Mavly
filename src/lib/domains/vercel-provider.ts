import { readVercelDeploymentConfig } from "@/lib/vercel/config";
import {
  addVercelProjectDomain,
  isVercelFailure,
  removeVercelProjectDomain,
  verifyVercelProjectDomain,
} from "@/lib/vercel/provider";

import { readDomainConfig } from "./config";
import {
  providerFailure,
  type DomainActivationInput,
  type DomainProviderOutcome,
  type DomainRemovalInput,
  type DomainRoutingProvider,
} from "./provider";

/**
 * ═══ VERCEL DOMAIN ROUTING ══════════════════════════════════════════════════
 *
 * Replaces the CloudFront KeyValueStore mapping for customer-facing hostnames.
 * A hostname is routed by attaching it to the project's own Vercel project — the
 * same per-project model the publish path already uses for the canonical
 * `<project-id>.mavly.xyz` address. The shared `*.mavly.xyz` wildcard is DNS
 * infrastructure and is never rewritten here.
 *
 * Truthfulness rules:
 *   · ATTACHED IS NOT VERIFIED. Vercel must report the domain verified.
 *   · VERIFIED IS NOT SERVING. A short HTTPS probe must answer before the worker
 *     records `sslStatus = active`; certificate provisioning is asynchronous.
 *   · A missing Vercel project target (the project has not been published yet)
 *     is an actionable refusal, never a guessed project name.
 *
 * Credentials are read from the server-only Vercel configuration. No token,
 * project id or hostname from a client reaches the provider API.
 */

const PUBLIC_PROBE_TIMEOUT_MS = 8_000;

function vercelConfig() {
  const result = readVercelDeploymentConfig();
  return result.ok ? result.config : null;
}

async function publicHttpsProbe(hostname: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${hostname}/`, {
      method: "HEAD",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PUBLIC_PROBE_TIMEOUT_MS),
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

export const vercelDomainRoutingProvider: DomainRoutingProvider = {
  id: "vercel",

  async provision(input: DomainActivationInput): Promise<DomainProviderOutcome> {
    const config = vercelConfig();
    if (!config) {
      return providerFailure(
        "DOMAIN_HOSTING_NOT_CONFIGURED",
        "Vercel customer hosting is not configured on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }
    if (!readDomainConfig().provisioningEnabled) {
      return providerFailure(
        "DOMAIN_PROVISIONING_DISABLED",
        "Domain provisioning is disabled on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }
    if (
      input.domainType === "custom" &&
      input.requireApproval &&
      !input.routingApproved
    ) {
      return providerFailure(
        "DOMAIN_ROUTING_APPROVAL_REQUIRED",
        "An operator must approve this custom hostname before it can be routed.",
        { retryable: false, needsOperator: true },
      );
    }

    const target = input.vercelProjectTarget?.trim();
    if (!target) {
      return providerFailure(
        "DOMAIN_VERCEL_PROJECT_MISSING",
        "This project has no Vercel project yet. Publish the website before provisioning a domain.",
        { retryable: false },
      );
    }

    const added = await addVercelProjectDomain(config, target, input.hostname);
    if (isVercelFailure(added)) {
      return providerFailure("DOMAIN_ATTACH_FAILED", added.failure.message, {
        retryable: added.failure.status === 429 || added.failure.status >= 500,
      });
    }

    let domain = added.data;
    if (!domain.verified) {
      const verified = await verifyVercelProjectDomain(
        config,
        target,
        input.hostname,
      );
      if (isVercelFailure(verified)) {
        return providerFailure("DOMAIN_VERIFICATION_PENDING", verified.failure.message, {
          retryable: true,
        });
      }
      domain = verified.data;
    }

    if (!domain.verified) {
      return providerFailure(
        "DOMAIN_VERIFICATION_PENDING",
        "Vercel has not verified this hostname yet. Check its DNS records and retry.",
        { retryable: true, needsOperator: input.domainType === "custom" },
      );
    }

    if (!(await publicHttpsProbe(input.hostname))) {
      return providerFailure(
        "DOMAIN_SSL_PENDING",
        "The hostname is attached and verified, but HTTPS is not answering yet. Certificate provisioning is asynchronous.",
        { retryable: true },
      );
    }

    return {
      ok: true,
      provider: "vercel",
      publicVerified: true,
      certificateReference: null,
    };
  },

  async remove(input: DomainRemovalInput): Promise<DomainProviderOutcome> {
    const config = vercelConfig();
    if (!config) {
      return providerFailure(
        "DOMAIN_HOSTING_NOT_CONFIGURED",
        "Vercel customer hosting is not configured on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }
    const target = input.vercelProjectTarget?.trim();
    if (!target) {
      return providerFailure(
        "DOMAIN_VERCEL_PROJECT_MISSING",
        "This project has no Vercel project mapping to detach the hostname from.",
        { retryable: false },
      );
    }

    /**
     * A 404 from Vercel means the domain is already detached, which is the desired
     * end state; `removeVercelProjectDomain` maps it to success so a retried
     * removal is idempotent.
     */
    const removed = await removeVercelProjectDomain(config, target, input.hostname);
    if (isVercelFailure(removed)) {
      return providerFailure("DOMAIN_DETACH_FAILED", removed.failure.message, {
        retryable: true,
      });
    }

    return {
      ok: true,
      provider: "vercel",
      publicVerified: true,
      certificateReference: null,
    };
  },
};
