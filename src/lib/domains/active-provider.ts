import { readVercelDeploymentConfig } from "@/lib/vercel/config";

import { readDomainConfig } from "./config";
import type { DomainRoutingProvider } from "./provider";
import { vercelDomainRoutingProvider } from "./vercel-provider";

/**
 * ═══ PROVIDER SELECTION ═════════════════════════════════════════════════════
 *
 * Vercel is the only customer frontend hosting and domain routing provider.
 * The AWS (S3 + CloudFront KeyValueStore) routing implementation was removed
 * from this repository. A domain row that still records `aws_cloudfront` is
 * HISTORICAL metadata: this deployment never routes it again, never rewrites
 * that recorded value and never guesses a replacement mapping.
 *
 * The provider fails closed with `needsOperator` when its prerequisites are
 * missing; it never guesses a project or fabricates an active hostname.
 */
export function domainRoutingProvider(): DomainRoutingProvider | null {
  const config = readDomainConfig();
  if (!config.enabled || !config.provisioningEnabled) return null;
  if (!readVercelDeploymentConfig().ok) return null;
  return vercelDomainRoutingProvider;
}
