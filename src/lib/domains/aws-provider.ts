import { readAwsFrontendHostingConfig } from "@/lib/aws/config";
import {
  activateAwsHostnameMapping,
  removeAwsHostnameMapping,
  verifyAwsPublicHostname,
} from "@/lib/aws/tenant-mapping";

import { readDomainConfig } from "./config";
import {
  providerFailure,
  type DomainActivationInput,
  type DomainProviderOutcome,
  type DomainRemovalInput,
  type DomainRoutingProvider,
} from "./provider";

/**
 * The only routing provider in this repository.
 *
 * What is automatic here:
 *   · a Mavly alias or custom hostname gets an immutable `h:<hostname>` KVS
 *     mapping to the project's active published version;
 *   · activation is reported only after an HTTPS probe on the exact hostname
 *     returns the expected project/version markers.
 *
 * What is NOT automatic, and requires operator approval:
 *   · adding a customer hostname to the CloudFront distribution aliases;
 *   · issuing/reusing an ACM certificate that covers that hostname;
 *   · creating the customer's CNAME/ALIAS DNS record (the customer owns it).
 *
 * The template (`infra/aws-frontend-hosting/template.yaml`) contains the
 * hostname-key lookup, but changing a deployed Function/distribution is an
 * infrastructure operation. Until it is applied, the public probe fails and the
 * domain remains truthful (`provisioning`), never `active`.
 */

function awsConfigured(): boolean {
  const config = readAwsFrontendHostingConfig();
  return config.enabled && config.problem === null;
}

export const awsDomainRoutingProvider: DomainRoutingProvider = {
  id: "aws_cloudfront",

  async provision(input: DomainActivationInput): Promise<DomainProviderOutcome> {
    const domainConfig = readDomainConfig();
    if (!awsConfigured()) {
      return providerFailure(
        "DOMAIN_HOSTING_NOT_CONFIGURED",
        "AWS frontend hosting is not configured on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }
    if (!domainConfig.provisioningEnabled) {
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
    if (input.domainType === "custom" && !domainConfig.routingTarget) {
      return providerFailure(
        "DOMAIN_ROUTING_TARGET_MISSING",
        "The custom-domain routing target is not configured on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }

    try {
      await activateAwsHostnameMapping({
        hostname: input.hostname,
        projectId: input.projectId,
        versionId: input.versionId,
        entryPath: input.entryPath,
        spaFallback: input.spaFallback,
        generation: input.generation,
      });
    } catch (error) {
      return providerFailure(
        "DOMAIN_ROUTE_WRITE_FAILED",
        error instanceof Error ? error.message : "The routing mapping could not be written.",
        { retryable: true },
      );
    }

    const verified = await verifyAwsPublicHostname({
      hostname: input.hostname,
      projectId: input.projectId,
      versionId: input.versionId,
    });
    if (!verified) {
      return providerFailure(
        "DOMAIN_PUBLIC_ROUTE_UNVERIFIED",
        "The hostname does not serve this publication yet. Check DNS, the distribution alias and the HTTPS certificate.",
        { retryable: true, needsOperator: input.domainType === "custom" },
      );
    }

    return {
      ok: true,
      provider: "aws_cloudfront",
      publicVerified: true,
      certificateReference: null,
    };
  },

  async remove(input: DomainRemovalInput): Promise<DomainProviderOutcome> {
    if (!awsConfigured()) {
      return providerFailure(
        "DOMAIN_HOSTING_NOT_CONFIGURED",
        "AWS frontend hosting is not configured on this deployment.",
        { retryable: false, needsOperator: true },
      );
    }
    try {
      await removeAwsHostnameMapping(input.hostname, input.projectId, input.generation);
      return {
        ok: true,
        provider: "aws_cloudfront",
        publicVerified: true,
        certificateReference: null,
      };
    } catch (error) {
      return providerFailure(
        "DOMAIN_ROUTE_REMOVE_FAILED",
        error instanceof Error ? error.message : "The routing mapping could not be removed.",
        { retryable: true },
      );
    }
  },
};

export function domainRoutingProvider(): DomainRoutingProvider | null {
  const config = readDomainConfig();
  if (!config.enabled || !config.provisioningEnabled) return null;
  if (!awsConfigured()) return null;
  return awsDomainRoutingProvider;
}
