import { readDomainConfig } from "./config";
import {
  hostnameProblemMessage,
  isMavlyManagedHostname,
  normalizeHostname,
  validateSubdomainLabel,
} from "./hostname";
import { buildDomainInstructions } from "./instructions";
import { emitDomainEvent } from "./observability";
import { domainRoutingProvider } from "./active-provider";
import {
  addCustomDomainRpc,
  checkSubdomainAvailability,
  consumeDomainRate,
  domainFailure,
  enqueueDomainAction,
  getProjectDomain,
  listProjectDomains,
  mapDomainError,
  reserveMavlySubdomain,
  setPrimaryDomain,
  type DomainStoreResult,
} from "./store";
import { generateVerificationToken, hashVerificationToken } from "./token";
import type {
  DomainCapability,
  DomainDnsInstructions,
  DomainErrorCode,
  ProjectDomainDetail,
  ProjectDomainView,
  ProjectDomainsWithCapability,
  SubdomainAvailability,
} from "./types";

/**
 * Owner-facing domain orchestration.
 *
 * ⚠️ THIS MODULE NEVER WRITES AUTHORITATIVE STATE. It validates input, applies
 * deployment feature gates and rate limits, then calls an owner-checked RPC that
 * only *requests* work. DNS, routing and certificate state are written by the
 * existing worker through service-role RPCs.
 *
 * Reads remain available when the feature is off so an owner can see what is
 * already attached; every write fails closed with an exact reason.
 */

export interface DomainServiceFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  retryAfterSeconds?: number;
}

export type DomainServiceResult<T> =
  | { ok: true; data: T }
  | DomainServiceFailure;

function failure(
  status: number,
  code: DomainErrorCode | string,
  error: string,
  retryAfterSeconds?: number,
): DomainServiceFailure {
  return {
    ok: false,
    status,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

/** Translate a persistence/worker RPC failure into an honest HTTP answer. */
export function domainStoreFailure(
  result: Extract<DomainStoreResult<unknown>, { ok: false }>,
): DomainServiceFailure {
  switch (result.code) {
    case "MIGRATION_REQUIRED":
    case "UNAVAILABLE":
      return failure(503, "BACKEND_NOT_CONFIGURED", result.error);
    case "DOMAIN_PROJECT_NOT_FOUND":
    case "DOMAIN_NOT_FOUND":
      return failure(404, result.code, result.error);
    case "DOMAIN_OWNERSHIP_MISMATCH":
      return failure(403, result.code, result.error);
    case "DOMAIN_RATE_LIMITED":
      return failure(429, result.code, result.error, result.retryAfterSeconds ?? 30);
    case "DOMAIN_HOSTNAME_INVALID":
    case "DOMAIN_HOSTNAME_RESERVED":
    case "DOMAIN_SUBDOMAIN_INVALID":
    case "DOMAIN_SUBDOMAIN_RESERVED":
    case "DOMAIN_SUBDOMAIN_IS_CANONICAL":
    case "DOMAIN_ACTION_INVALID":
    case "DOMAIN_VERIFICATION_TOKEN_INVALID":
      return failure(400, result.code, result.error);
    case "DOMAIN_PLAN_REQUIRED":
      return failure(402, "PLAN_REQUIRED", result.error);
    case "DOMAIN_CUSTOM_LIMIT_REACHED":
    case "DOMAIN_ALIAS_LIMIT_REACHED":
    case "DOMAIN_ACTIVE_LIMIT_REACHED":
    case "DOMAIN_SUBDOMAIN_TAKEN":
    case "DOMAIN_ALREADY_REGISTERED":
    case "DOMAIN_JOB_IN_PROGRESS":
    case "DOMAIN_VERIFY_NOT_APPLICABLE":
    case "DOMAIN_VERIFY_NOT_AVAILABLE":
    case "DOMAIN_PROVISION_NOT_AVAILABLE":
    case "DOMAIN_PRIMARY_CUSTOM_ONLY":
    case "DOMAIN_PRIMARY_REQUIRES_ACTIVE":
    case "DOMAIN_REMOVED":
      return failure(409, result.code, result.error);
    default:
      return failure(500, result.code, result.error);
  }
}

function storeFailure(
  result: { ok: false; code: string; error: string; retryAfterSeconds?: number },
): DomainServiceFailure {
  return domainStoreFailure(result as never);
}

/**
 * The effective capability. `provisioningEnabled` is false when the routing
 * provider itself is unavailable, so the UI never offers a button whose job
 * cannot run.
 */
export function domainCapability(): DomainCapability {
  const config = readDomainConfig();
  const provider = domainRoutingProvider();
  const providerProblem =
    config.enabled && config.provisioningEnabled && !provider
      ? "Domain routing is not configured on this deployment. Configure Vercel customer hosting first."
      : null;

  return {
    enabled: config.enabled && config.problem === null,
    customDomainsEnabled:
      config.customDomainsEnabled && config.problem === null,
    subdomainAliasesEnabled:
      config.subdomainAliasesEnabled &&
      config.problem === null &&
      provider !== null,
    provisioningEnabled: config.provisioningEnabled && provider !== null,
    requireRoutingApproval: config.requireRoutingApproval,
    hasRoutingTarget: config.routingTarget !== null,
    hasApexTarget: config.apexTarget !== null,
    problem:
      config.problem === null
        ? providerProblem
        : config.problem === "disabled"
          ? "Domain management is disabled on this deployment."
          : config.problem === "invalid_resolver"
            ? "The configured DNS resolvers are invalid."
            : "The configured custom-domain routing target is invalid.",
  };
}

function requireManagement(): DomainServiceFailure | null {
  const capability = domainCapability();
  if (!capability.enabled) {
    return failure(
      403,
      "DOMAIN_MANAGEMENT_DISABLED",
      capability.problem ?? "Domain management is disabled on this deployment.",
    );
  }
  return null;
}

function requireCustomDomains(): DomainServiceFailure | null {
  const blocked = requireManagement();
  if (blocked) return blocked;
  if (!domainCapability().customDomainsEnabled) {
    return failure(
      403,
      "DOMAIN_CUSTOM_DISABLED",
      "Custom domains are disabled on this deployment.",
    );
  }
  return null;
}

function requireAliases(): DomainServiceFailure | null {
  const blocked = requireManagement();
  if (blocked) return blocked;
  const capability = domainCapability();
  if (!capability.subdomainAliasesEnabled) {
    return failure(
      403,
      "DOMAIN_ALIASES_DISABLED",
      "Mavly subdomain aliases are disabled on this deployment.",
    );
  }
  return null;
}

function requireProvisioning(): DomainServiceFailure | null {
  const blocked = requireManagement();
  if (blocked) return blocked;
  if (!domainCapability().provisioningEnabled) {
    return failure(
      403,
      "DOMAIN_PROVISIONING_DISABLED",
      "Domain provisioning is not configured on this deployment.",
    );
  }
  return null;
}

async function rateLimit(action: string): Promise<DomainServiceFailure | null> {
  const consumed = await consumeDomainRate(action);
  if (consumed.ok) return null;
  emitDomainEvent("domain_rate_limited", { action });
  return storeFailure(consumed as never);
}

/** DNS instructions for one row, from configuration only. */
export function instructionsForDomain(
  domain: Pick<ProjectDomainView, "hostname" | "domainType" | "verificationToken">,
): DomainDnsInstructions {
  const config = readDomainConfig();
  return buildDomainInstructions({
    hostname: domain.hostname,
    domainType: domain.domainType,
    verificationToken: domain.verificationToken,
    routingTarget: config.routingTarget,
    apexTarget: config.apexTarget,
  });
}

function withInstructions(domain: ProjectDomainView): ProjectDomainDetail {
  return { ...domain, instructions: instructionsForDomain(domain) };
}

export async function getProjectDomains(
  projectId: string,
): Promise<DomainServiceResult<ProjectDomainsWithCapability>> {
  const listed = await listProjectDomains(projectId);
  if (!listed.ok) return storeFailure(listed as never);
  return { ok: true, data: { ...listed.data, capability: domainCapability() } };
}

export async function getProjectDomainDetail(
  projectId: string,
  domainId: string,
): Promise<DomainServiceResult<ProjectDomainDetail>> {
  const result = await getProjectDomain(projectId, domainId);
  if (!result.ok) return storeFailure(result as never);
  return { ok: true, data: withInstructions(result.data) };
}

export async function checkSubdomain(
  label: string,
): Promise<DomainServiceResult<SubdomainAvailability>> {
  const blocked = requireManagement();
  if (blocked) return blocked;

  const validated = validateSubdomainLabel(label);
  if (!validated.ok) {
    return {
      ok: true,
      data: {
        label: validated.label,
        hostname: null,
        available: false,
        reason:
          validated.problem === "reserved"
            ? "reserved"
            : "invalid",
      },
    };
  }

  const limited = await rateLimit("availability");
  if (limited) return limited;

  const result = await checkSubdomainAvailability(validated.label);
  if (!result.ok) return storeFailure(result as never);
  return { ok: true, data: result.data };
}

export async function reserveSubdomain(
  projectId: string,
  label: string,
): Promise<DomainServiceResult<ProjectDomainView>> {
  const blocked = requireAliases() ?? requireProvisioning();
  if (blocked) return blocked;

  const capability = domainCapability();
  if (!capability.hasRoutingTarget) {
    return failure(
      503,
      "DOMAIN_PROVISIONING_DISABLED",
      "A routing target is not configured yet, so an alias cannot be created.",
    );
  }

  const validated = validateSubdomainLabel(label, projectId);
  if (!validated.ok) {
    return failure(
      400,
      validated.problem === "reserved"
        ? "DOMAIN_SUBDOMAIN_RESERVED"
        : validated.problem === "canonical"
          ? "DOMAIN_SUBDOMAIN_IS_CANONICAL"
          : "DOMAIN_SUBDOMAIN_INVALID",
      validated.problem === "reserved"
        ? "That subdomain is reserved for Mavly's own services."
        : validated.problem === "canonical"
          ? "That is already this project's canonical Mavly address."
          : "Choose a lowercase subdomain using letters, numbers and single hyphens.",
    );
  }

  const limited = await rateLimit("reserve_subdomain");
  if (limited) return limited;

  const result = await reserveMavlySubdomain(projectId, validated.label);
  if (!result.ok) return storeFailure(result as never);
  emitDomainEvent("domain_reserved", {
    projectId,
    domainId: result.data.id,
    hostname: result.data.hostname,
    domainType: result.data.domainType,
    status: result.data.status,
  });
  return { ok: true, data: result.data };
}

export async function addCustomDomain(
  projectId: string,
  rawHostname: string,
): Promise<DomainServiceResult<ProjectDomainDetail>> {
  const blocked = requireCustomDomains();
  if (blocked) return blocked;

  const parsed = normalizeHostname(rawHostname);
  if (!parsed.ok) {
    if (parsed.problem === "platform" && isMavlyManagedHostname(rawHostname.trim().toLowerCase())) {
      return failure(
        400,
        "DOMAIN_HOSTNAME_INVALID",
        "Use the Mavly subdomain field for a *.mavly.xyz address.",
      );
    }
    return failure(
      400,
      parsed.problem === "platform" || parsed.problem === "internal"
        ? "DOMAIN_HOSTNAME_RESERVED"
        : "DOMAIN_HOSTNAME_INVALID",
      parsed.problem ? hostnameProblemMessage(parsed.problem) : "That hostname is not valid.",
    );
  }

  const limited = await rateLimit("add_custom_domain");
  if (limited) return limited;

  const token = generateVerificationToken();
  const added = await addCustomDomainRpc({
    projectId,
    hostname: parsed.hostname,
    token,
    tokenHash: hashVerificationToken(token),
  });
  if (!added.ok) return storeFailure(added as never);
  emitDomainEvent("domain_registered", {
    projectId,
    domainId: added.data.id,
    hostname: added.data.hostname,
    domainType: added.data.domainType,
    status: added.data.status,
  });
  return { ok: true, data: withInstructions(added.data) };
}

export async function requestDomainVerification(
  projectId: string,
  domainId: string,
): Promise<DomainServiceResult<{ jobId: string; status: string }>> {
  const blocked = requireCustomDomains();
  if (blocked) return blocked;

  const limited = await rateLimit("verify_domain");
  if (limited) return limited;

  const result = await enqueueDomainAction(domainId, "verify");
  if (!result.ok) return storeFailure(result as never);
  emitDomainEvent("domain_verification_requested", { projectId, domainId });
  return { ok: true, data: result.data };
}

export async function requestDomainProvisioning(
  projectId: string,
  domainId: string,
): Promise<DomainServiceResult<{ jobId: string; status: string }>> {
  const blocked = requireProvisioning();
  if (blocked) return blocked;

  const limited = await rateLimit("retry_provisioning");
  if (limited) return limited;

  const result = await enqueueDomainAction(domainId, "provision");
  if (!result.ok) return storeFailure(result as never);
  emitDomainEvent("domain_provisioning_requested", { projectId, domainId });
  return { ok: true, data: result.data };
}

export async function requestDomainRemoval(
  projectId: string,
  domainId: string,
): Promise<DomainServiceResult<{ jobId: string; status: string }>> {
  const blocked = requireManagement();
  if (blocked) return blocked;

  const limited = await rateLimit("remove_domain");
  if (limited) return limited;

  const result = await enqueueDomainAction(domainId, "remove");
  if (!result.ok) return storeFailure(result as never);
  emitDomainEvent("domain_removal_requested", { projectId, domainId });
  return { ok: true, data: result.data };
}

export async function requestPrimaryDomain(
  projectId: string,
  domainId: string,
): Promise<DomainServiceResult<ProjectDomainView>> {
  const blocked = requireCustomDomains();
  if (blocked) return blocked;

  const result = await setPrimaryDomain(domainId);
  if (!result.ok) return storeFailure(result as never);
  return { ok: true, data: result.data };
}

// Re-export for route handlers that need the raw mapper without importing the
// store module directly.
export { domainFailure, mapDomainError };
