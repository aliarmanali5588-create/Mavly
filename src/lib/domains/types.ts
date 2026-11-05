/**
 * Client-safe domain vocabulary.
 *
 * ⚠️ NOTHING HERE READS ENVIRONMENT OR TOUCHES A PROVIDER. The workspace renders
 * exactly the state the server returned; there is no derived "active" badge, no
 * optimistic success and no client-side limit calculation.
 */

export const DOMAIN_TYPES = ["mavly_subdomain", "custom"] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const DOMAIN_STATUSES = [
  "pending",
  "verification_required",
  "verifying",
  "verified",
  "provisioning",
  "active",
  "misconfigured",
  "ssl_pending",
  "ssl_failed",
  "disabled",
  "removing",
  "removed",
] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_DNS_STATUSES = [
  "unchecked",
  "pending",
  "ready",
  "misconfigured",
  "error",
] as const;
export type DomainDnsStatus = (typeof DOMAIN_DNS_STATUSES)[number];

export const DOMAIN_SSL_STATUSES = [
  "not_started",
  "pending",
  "provisioning",
  "active",
  "failed",
  "expired",
] as const;
export type DomainSslStatus = (typeof DOMAIN_SSL_STATUSES)[number];

export const DOMAIN_PUBLICATION_STATUSES = [
  "pending",
  "provisioning",
  "active",
  "failed",
  "removed",
] as const;
export type DomainPublicationStatus = (typeof DOMAIN_PUBLICATION_STATUSES)[number];

/**
 * `aws_cloudfront` is HISTORICAL metadata: the AWS routing implementation was
 * removed, so this deployment never writes it again and cannot add or remove
 * such a route. It stays in the vocabulary so an archived row is displayed
 * truthfully instead of being re-labelled.
 */
export const DOMAIN_ROUTING_PROVIDERS = [
  "none",
  "aws_cloudfront",
  "shared",
  "vercel",
  "manual",
] as const;
export type DomainRoutingProvider = (typeof DOMAIN_ROUTING_PROVIDERS)[number];

export interface ProjectDomainView {
  id: string;
  projectId: string;
  hostname: string;
  domainType: DomainType;
  status: DomainStatus;
  dnsStatus: DomainDnsStatus;
  sslStatus: DomainSslStatus;
  publicationStatus: DomainPublicationStatus;
  isPrimary: boolean;
  routingProvider: DomainRoutingProvider;
  verificationRecordName: string | null;
  /** Returned only to the owning session, and only while the row is not removed. */
  verificationToken: string | null;
  certificateReference: string | null;
  lastVerifiedAt: string | null;
  lastCheckedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  routingApprovedAt: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

export interface DomainEntitlements {
  planId: string;
  maxCustomDomains: number;
  maxSubdomainAliases: number;
  maxActiveDomains: number;
  customDomainsUsed: number;
  subdomainAliasesUsed: number;
  activeDomainsUsed: number;
}

export interface ProjectDomainsView {
  projectId: string;
  canonicalHostname: string;
  canonicalStatus: "not_published" | "pending" | "published" | "failed" | string;
  canonicalProvider: string | null;
  domains: ProjectDomainView[];
  entitlements: DomainEntitlements;
}

/** The owner read model plus the effective server capability. */
export interface ProjectDomainsWithCapability extends ProjectDomainsView {
  capability: DomainCapability;
}

export interface SubdomainAvailability {
  label: string;
  hostname: string | null;
  available: boolean;
  reason: "available" | "invalid" | "reserved" | "taken";
}

export interface DomainDnsInstruction {
  /** `A`/`AAAA` appear only when the hosting provider actually requires them. */
  recordType: "TXT" | "CNAME" | "ALIAS" | "ANAME" | "A" | "AAAA";
  name: string;
  value: string;
  ttl: number;
  purpose: "verification" | "routing";
  required: boolean;
}

export interface DomainDnsInstructions {
  hostname: string;
  configured: boolean;
  verification: DomainDnsInstruction[];
  routing: DomainDnsInstruction[];
  notes: string[];
  /** Set when the operator has not configured a hosting target yet. */
  unavailableReason: string | null;
}

/** Owner-facing capability. It never includes a secret or a routing target. */
export interface DomainCapability {
  enabled: boolean;
  customDomainsEnabled: boolean;
  subdomainAliasesEnabled: boolean;
  provisioningEnabled: boolean;
  requireRoutingApproval: boolean;
  hasRoutingTarget: boolean;
  hasApexTarget: boolean;
  /** Exact operator-facing reason when a prerequisite is missing. */
  problem: string | null;
}

export interface ProjectDomainDetail extends ProjectDomainView {
  instructions: DomainDnsInstructions;
}

export type DomainAction = "verify" | "provision" | "remove";

export interface DomainActionAccepted {
  jobId: string;
  action: DomainAction;
  status: DomainStatus;
}

export const DOMAIN_ERROR_CODES = [
  "DOMAIN_MANAGEMENT_DISABLED",
  "DOMAIN_CUSTOM_DISABLED",
  "DOMAIN_ALIASES_DISABLED",
  "DOMAIN_PROVISIONING_DISABLED",
  "DOMAIN_PROJECT_NOT_FOUND",
  "DOMAIN_OWNERSHIP_MISMATCH",
  "DOMAIN_NOT_FOUND",
  "DOMAIN_HOSTNAME_INVALID",
  "DOMAIN_HOSTNAME_RESERVED",
  "DOMAIN_SUBDOMAIN_INVALID",
  "DOMAIN_SUBDOMAIN_RESERVED",
  "DOMAIN_SUBDOMAIN_TAKEN",
  "DOMAIN_SUBDOMAIN_IS_CANONICAL",
  "DOMAIN_ALREADY_REGISTERED",
  "DOMAIN_PLAN_REQUIRED",
  "DOMAIN_CUSTOM_LIMIT_REACHED",
  "DOMAIN_ALIAS_LIMIT_REACHED",
  "DOMAIN_ACTIVE_LIMIT_REACHED",
  "DOMAIN_VERIFY_NOT_APPLICABLE",
  "DOMAIN_VERIFY_NOT_AVAILABLE",
  "DOMAIN_PROVISION_NOT_AVAILABLE",
  "DOMAIN_JOB_IN_PROGRESS",
  "DOMAIN_RATE_LIMITED",
  "DOMAIN_PRIMARY_CUSTOM_ONLY",
  "DOMAIN_PRIMARY_REQUIRES_ACTIVE",
  "DOMAIN_REMOVED",
  "DOMAIN_ACTION_INVALID",
  "DOMAIN_VERIFICATION_TOKEN_INVALID",
  "MIGRATION_REQUIRED",
  "UNAVAILABLE",
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
