/**
 * Provider-neutral domain routing adapter.
 *
 * The worker never talks to a hosting provider directly. It calls this
 * interface; Vercel is the only implementation this repository supplies, because
 * the AWS CloudFront routing implementation was removed. A deployment with no
 * usable Vercel configuration fails closed with `needsOperator` instead of
 * pretending a hostname is active.
 */

export interface DomainActivationInput {
  hostname: string;
  projectId: string;
  versionId: string;
  entryPath: string;
  spaFallback: boolean;
  generation: number;
  domainType: "mavly_subdomain" | "custom";
  /** Custom hostnames require an explicit operator/admin approval by default. */
  routingApproved: boolean;
  requireApproval: boolean;
  /**
   * The Vercel project id (or its deterministic name) that owns this project's
   * deployment. Supplied by the domain worker from `project_deployments`; never
   * by a client.
   */
  vercelProjectTarget?: string | null;
}

export interface DomainRemovalInput {
  hostname: string;
  projectId: string;
  generation: number;
  /** See `DomainActivationInput.vercelProjectTarget`. */
  vercelProjectTarget?: string | null;
}

export type DomainProviderOutcome =
  | {
      ok: true;
      provider: "vercel";
      publicVerified: true;
      certificateReference: string | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable: boolean;
      /** A missing operator prerequisite, not a customer mistake. */
      needsOperator: boolean;
    };

export interface DomainRoutingProvider {
  readonly id: "vercel";
  provision(input: DomainActivationInput): Promise<DomainProviderOutcome>;
  remove(input: DomainRemovalInput): Promise<DomainProviderOutcome>;
}

export function providerFailure(
  code: string,
  message: string,
  options: { retryable?: boolean; needsOperator?: boolean } = {},
): DomainProviderOutcome {
  return {
    ok: false,
    code,
    message,
    retryable: options.retryable ?? true,
    needsOperator: options.needsOperator ?? false,
  };
}
