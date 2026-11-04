/**
 * Provider-neutral domain routing adapter.
 *
 * The worker never talks to a hosting provider directly. It calls this
 * interface; the AWS implementation is the only one this repository supplies.
 * A deployment with no approved provider fails closed with `needsOperator`
 * instead of pretending a hostname is active.
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
}

export interface DomainRemovalInput {
  hostname: string;
  projectId: string;
  generation: number;
}

export type DomainProviderOutcome =
  | {
      ok: true;
      provider: "aws_cloudfront";
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
  readonly id: "aws_cloudfront";
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
