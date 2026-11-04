/**
 * Pure entitlement evaluation.
 *
 * ⚠️ THE DATABASE IS AUTHORITATIVE. These functions exist so the workspace can
 * explain a refusal and so the tests can pin the rule; every write RPC repeats
 * the check inside its transaction. The browser never sends a limit, plan or
 * usage count.
 */

import type { DomainEntitlements } from "./types";

export type DomainEntitlementReason =
  | "allowed"
  | "plan_required"
  | "custom_limit_reached"
  | "alias_limit_reached"
  | "active_limit_reached";

export interface DomainEntitlementDecision {
  allowed: boolean;
  reason: DomainEntitlementReason;
  remaining: number;
}

function finiteCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function normalizeDomainEntitlements(input: unknown): DomainEntitlements {
  const record =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    planId: typeof record.planId === "string" ? record.planId : "free",
    maxCustomDomains: finiteCount(record.maxCustomDomains),
    maxSubdomainAliases: finiteCount(record.maxSubdomainAliases),
    maxActiveDomains: finiteCount(record.maxActiveDomains),
    customDomainsUsed: finiteCount(record.customDomainsUsed),
    subdomainAliasesUsed: finiteCount(record.subdomainAliasesUsed),
    activeDomainsUsed: finiteCount(record.activeDomainsUsed),
  };
}

/** May this account add one more customer-owned hostname? */
export function canAddCustomDomain(
  entitlements: DomainEntitlements,
): DomainEntitlementDecision {
  if (entitlements.maxCustomDomains <= 0) {
    return { allowed: false, reason: "plan_required", remaining: 0 };
  }
  const remaining = entitlements.maxCustomDomains - entitlements.customDomainsUsed;
  if (remaining <= 0) {
    return { allowed: false, reason: "custom_limit_reached", remaining: 0 };
  }
  return { allowed: true, reason: "allowed", remaining };
}

/** May this account reserve one more human-readable Mavly alias? */
export function canAddSubdomainAlias(
  entitlements: DomainEntitlements,
): DomainEntitlementDecision {
  if (entitlements.maxSubdomainAliases <= 0) {
    return { allowed: false, reason: "plan_required", remaining: 0 };
  }
  const remaining =
    entitlements.maxSubdomainAliases - entitlements.subdomainAliasesUsed;
  if (remaining <= 0) {
    return { allowed: false, reason: "alias_limit_reached", remaining: 0 };
  }
  return { allowed: true, reason: "allowed", remaining };
}

/** May one more domain become actively served? */
export function canActivateAnotherDomain(
  entitlements: DomainEntitlements,
): DomainEntitlementDecision {
  if (entitlements.maxActiveDomains <= 0) {
    return { allowed: false, reason: "plan_required", remaining: 0 };
  }
  const remaining = entitlements.maxActiveDomains - entitlements.activeDomainsUsed;
  if (remaining <= 0) {
    return { allowed: false, reason: "active_limit_reached", remaining: 0 };
  }
  return { allowed: true, reason: "allowed", remaining };
}

export function domainEntitlementMessage(reason: DomainEntitlementReason): string {
  switch (reason) {
    case "allowed":
      return "";
    case "plan_required":
      return "Custom domains are not included in your current plan.";
    case "custom_limit_reached":
      return "You have reached the custom-domain limit for your plan.";
    case "alias_limit_reached":
      return "You have reached the Mavly subdomain limit for your plan.";
    case "active_limit_reached":
      return "You have reached the number of simultaneously active domains for your plan.";
  }
}
