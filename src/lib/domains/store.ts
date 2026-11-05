import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingDatabaseObject } from "@/lib/hosting/migration-requirement";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { normalizeDomainEntitlements } from "./entitlements";
import type {
  DomainAction,
  DomainActionAccepted,
  DomainDnsStatus,
  DomainEntitlements,
  DomainPublicationStatus,
  DomainRoutingProvider,
  DomainSslStatus,
  DomainStatus,
  DomainType,
  ProjectDomainView,
  ProjectDomainsView,
  SubdomainAvailability,
} from "./types";

export type DomainStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; retryAfterSeconds?: number };

const MIGRATION_MESSAGE =
  "Apply supabase/migrations/62_domain_management.sql before using domain management.";

const KNOWN_ERRORS: Record<string, string> = {
  DOMAIN_PROJECT_NOT_FOUND: "DOMAIN_PROJECT_NOT_FOUND",
  DOMAIN_OWNERSHIP_MISMATCH: "DOMAIN_OWNERSHIP_MISMATCH",
  DOMAIN_NOT_FOUND: "DOMAIN_NOT_FOUND",
  DOMAIN_HOSTNAME_INVALID: "DOMAIN_HOSTNAME_INVALID",
  DOMAIN_HOSTNAME_RESERVED: "DOMAIN_HOSTNAME_RESERVED",
  DOMAIN_SUBDOMAIN_INVALID: "DOMAIN_SUBDOMAIN_INVALID",
  DOMAIN_SUBDOMAIN_RESERVED: "DOMAIN_SUBDOMAIN_RESERVED",
  DOMAIN_SUBDOMAIN_TAKEN: "DOMAIN_SUBDOMAIN_TAKEN",
  DOMAIN_SUBDOMAIN_IS_CANONICAL: "DOMAIN_SUBDOMAIN_IS_CANONICAL",
  DOMAIN_ALREADY_REGISTERED: "DOMAIN_ALREADY_REGISTERED",
  DOMAIN_PLAN_REQUIRED: "DOMAIN_PLAN_REQUIRED",
  DOMAIN_CUSTOM_LIMIT_REACHED: "DOMAIN_CUSTOM_LIMIT_REACHED",
  DOMAIN_ALIAS_LIMIT_REACHED: "DOMAIN_ALIAS_LIMIT_REACHED",
  DOMAIN_ACTIVE_LIMIT_REACHED: "DOMAIN_ACTIVE_LIMIT_REACHED",
  DOMAIN_VERIFY_NOT_APPLICABLE: "DOMAIN_VERIFY_NOT_APPLICABLE",
  DOMAIN_VERIFY_NOT_AVAILABLE: "DOMAIN_VERIFY_NOT_AVAILABLE",
  DOMAIN_PROVISION_NOT_AVAILABLE: "DOMAIN_PROVISION_NOT_AVAILABLE",
  DOMAIN_JOB_IN_PROGRESS: "DOMAIN_JOB_IN_PROGRESS",
  DOMAIN_PRIMARY_CUSTOM_ONLY: "DOMAIN_PRIMARY_CUSTOM_ONLY",
  DOMAIN_PRIMARY_REQUIRES_ACTIVE: "DOMAIN_PRIMARY_REQUIRES_ACTIVE",
  DOMAIN_REMOVED: "DOMAIN_REMOVED",
  DOMAIN_ACTION_INVALID: "DOMAIN_ACTION_INVALID",
  DOMAIN_VERIFICATION_TOKEN_INVALID: "DOMAIN_VERIFICATION_TOKEN_INVALID",
  DOMAIN_RATE_ACTION_INVALID: "DOMAIN_ACTION_INVALID",
  DOMAIN_NOT_CONFIGURED: "DOMAIN_MANAGEMENT_DISABLED",
  DOMAIN_OUTCOME_INVALID: "DOMAIN_ACTION_INVALID",
  DOMAIN_STATUS_INVALID: "DOMAIN_ACTION_INVALID",
  DOMAIN_LEASE_LOST: "DOMAIN_JOB_IN_PROGRESS",
  DOMAIN_WORKER_ONLY: "DOMAIN_ACTION_INVALID",
};

export function domainFailure(
  code: string,
  error: string,
  retryAfterSeconds?: number,
): DomainStoreResult<never> {
  return {
    ok: false,
    code,
    error,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

const DOMAIN_SCHEMA_OBJECTS = [
  "domain_management_schema_version",
  "domain_entitlements",
  "project_domains",
  "project_domain_events",
  "project_domain_jobs",
  "list_project_domains",
  "get_project_domain",
  "check_subdomain_availability",
  "reserve_mavly_subdomain",
  "add_custom_domain",
  "enqueue_domain_action",
  "set_primary_domain",
  "consume_domain_rate_limit",
] as const;

/** Domain-owned objects only; an unrelated missing relation is not a migration. */
function isMissingDomainObject(error: { code?: string | null; message?: string | null }): boolean {
  const message = (error.message ?? "").toLowerCase();
  const code = (error.code ?? "").toUpperCase();
  if (isMissingDatabaseObject({ code, message })) return true;
  if (
    code !== "42P01" &&
    code !== "42703" &&
    code !== "42883" &&
    code !== "PGRST202" &&
    code !== "PGRST204" &&
    code !== "PGRST205"
  ) {
    return false;
  }
  return DOMAIN_SCHEMA_OBJECTS.some((name) => message.includes(name));
}

export function mapDomainError(error: {
  code?: string | null;
  message?: string | null;
}): DomainStoreResult<never> {
  const message = error.message ?? "Domain operation failed.";
  if (isMissingDomainObject({ code: error.code ?? undefined, message })) {
    return domainFailure("MIGRATION_REQUIRED", MIGRATION_MESSAGE);
  }
  const token = Object.keys(KNOWN_ERRORS).find((key) => message.includes(key));
  if (token) return domainFailure(KNOWN_ERRORS[token], friendlyDomainError(token));
  if (message.includes("DOMAIN_RATE")) {
    return domainFailure("DOMAIN_RATE_LIMITED", "Too many domain requests. Wait a moment and try again.");
  }
  if (message.includes("domain_management_schema_version")) {
    return domainFailure("MIGRATION_REQUIRED", MIGRATION_MESSAGE);
  }
  return domainFailure(error.code ?? "DOMAIN_OPERATION_FAILED", message.slice(0, 300));
}

export function friendlyDomainError(code: string): string {
  switch (code) {
    case "DOMAIN_PROJECT_NOT_FOUND":
      return "That project could not be found.";
    case "DOMAIN_OWNERSHIP_MISMATCH":
      return "You do not own that project.";
    case "DOMAIN_NOT_FOUND":
      return "That domain is not attached to this project.";
    case "DOMAIN_HOSTNAME_INVALID":
      return "That is not a valid public hostname.";
    case "DOMAIN_HOSTNAME_RESERVED":
      return "That hostname uses a reserved internal suffix.";
    case "DOMAIN_SUBDOMAIN_INVALID":
      return "Choose a lowercase subdomain using letters, numbers and single hyphens.";
    case "DOMAIN_SUBDOMAIN_RESERVED":
      return "That subdomain is reserved for Mavly's own services.";
    case "DOMAIN_SUBDOMAIN_TAKEN":
      return "That subdomain is already in use.";
    case "DOMAIN_SUBDOMAIN_IS_CANONICAL":
      return "That is already this project's canonical Mavly address.";
    case "DOMAIN_ALREADY_REGISTERED":
      return "That hostname is already attached to a Mavly project.";
    case "DOMAIN_PLAN_REQUIRED":
      return "Custom domains are not included in your current plan.";
    case "DOMAIN_CUSTOM_LIMIT_REACHED":
      return "You have reached the custom-domain limit for your plan.";
    case "DOMAIN_ALIAS_LIMIT_REACHED":
      return "You have reached the Mavly subdomain limit for your plan.";
    case "DOMAIN_ACTIVE_LIMIT_REACHED":
      return "You have reached the number of simultaneously active domains for your plan.";
    case "DOMAIN_VERIFY_NOT_APPLICABLE":
      return "Mavly-managed subdomains do not need DNS ownership verification.";
    case "DOMAIN_VERIFY_NOT_AVAILABLE":
      return "This domain is not in a state that can be verified right now.";
    case "DOMAIN_PROVISION_NOT_AVAILABLE":
      return "This domain is not ready for provisioning yet.";
    case "DOMAIN_JOB_IN_PROGRESS":
      return "A domain operation is already running for this address.";
    case "DOMAIN_PRIMARY_CUSTOM_ONLY":
      return "Only a custom domain can be marked primary.";
    case "DOMAIN_PRIMARY_REQUIRES_ACTIVE":
      return "A domain must be active before it can be primary.";
    case "DOMAIN_REMOVED":
      return "That domain has already been removed.";
    case "DOMAIN_ACTION_INVALID":
      return "That domain action is not supported.";
    case "DOMAIN_RATE_LIMITED":
      return "Too many domain requests. Wait a moment and try again.";
    default:
      return "The domain operation could not be completed.";
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeDomainView(value: unknown): ProjectDomainView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.projectId !== "string") return null;
  if (typeof row.hostname !== "string") return null;
  return {
    id: row.id,
    projectId: row.projectId,
    hostname: row.hostname,
    domainType: (str(row.domainType) ?? "custom") as DomainType,
    status: (str(row.status) ?? "pending") as DomainStatus,
    dnsStatus: (str(row.dnsStatus) ?? "unchecked") as DomainDnsStatus,
    sslStatus: (str(row.sslStatus) ?? "not_started") as DomainSslStatus,
    publicationStatus: (str(row.publicationStatus) ?? "pending") as DomainPublicationStatus,
    isPrimary: row.isPrimary === true,
    routingProvider: (str(row.routingProvider) ?? "none") as DomainRoutingProvider,
    verificationRecordName: str(row.verificationRecordName),
    verificationToken: str(row.verificationToken),
    certificateReference: str(row.certificateReference),
    lastVerifiedAt: str(row.lastVerifiedAt),
    lastCheckedAt: str(row.lastCheckedAt),
    failureCode: str(row.failureCode),
    failureMessage: str(row.failureMessage),
    retryCount: num(row.retryCount),
    nextRetryAt: str(row.nextRetryAt),
    routingApprovedAt: str(row.routingApprovedAt),
    createdAt: str(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: str(row.updatedAt) ?? new Date(0).toISOString(),
    removedAt: str(row.removedAt),
  };
}

export function normalizeProjectDomains(value: unknown): ProjectDomainsView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const domains = Array.isArray(record.domains)
    ? record.domains.map(normalizeDomainView).filter((row): row is ProjectDomainView => row !== null)
    : [];
  return {
    projectId: str(record.projectId) ?? "",
    canonicalHostname: str(record.canonicalHostname) ?? "",
    canonicalStatus: str(record.canonicalStatus) ?? "not_published",
    canonicalProvider: str(record.canonicalProvider),
    domains,
    entitlements: normalizeDomainEntitlements(record.entitlements),
  };
}

function clientOrFailure(
  client: SupabaseClient | undefined,
): Promise<SupabaseClient | null> {
  if (client) return Promise.resolve(client);
  return createSupabaseServerClient();
}

export async function readDomainSchemaVersion(
  client?: SupabaseClient,
): Promise<DomainStoreResult<number>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("domain_management_schema_version");
  if (error) return mapDomainError(error);
  const version = typeof data === "number" ? data : Number(data);
  return Number.isSafeInteger(version)
    ? { ok: true, data: version }
    : domainFailure("DOMAIN_OPERATION_FAILED", "The domain schema marker is invalid.");
}

export async function listProjectDomains(
  projectId: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<ProjectDomainsView>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("list_project_domains", {
    p_project_id: projectId,
  });
  if (error) return mapDomainError(error);
  const view = normalizeProjectDomains(data);
  if (!view) return domainFailure("DOMAIN_OPERATION_FAILED", "The domain list response was invalid.");
  return { ok: true, data: view };
}

export async function checkSubdomainAvailability(
  label: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<SubdomainAvailability>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("check_subdomain_availability", {
    p_label: label,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!record) return domainFailure("DOMAIN_OPERATION_FAILED", "The availability response was invalid.");
  const reason = str(record.reason);
  return {
    ok: true,
    data: {
      label: str(record.label) ?? label.trim().toLowerCase(),
      hostname: str(record.hostname),
      available: record.available === true,
      reason:
        reason === "invalid" || reason === "reserved" || reason === "taken"
          ? reason
          : "available",
    },
  };
}

export async function reserveMavlySubdomain(
  projectId: string,
  label: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<ProjectDomainView>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("reserve_mavly_subdomain", {
    p_project_id: projectId,
    p_label: label,
  });
  if (error) return mapDomainError(error);
  const view = normalizeDomainView(data);
  return view
    ? { ok: true, data: view }
    : domainFailure("DOMAIN_OPERATION_FAILED", "The reserved subdomain response was invalid.");
}

export async function addCustomDomainRpc(input: {
  projectId: string;
  hostname: string;
  token: string;
  tokenHash: string;
  client?: SupabaseClient;
}): Promise<DomainStoreResult<ProjectDomainView>> {
  const supabase = await clientOrFailure(input.client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("add_custom_domain", {
    p_project_id: input.projectId,
    p_hostname: input.hostname,
    p_token: input.token,
    p_token_hash: input.tokenHash,
  });
  if (error) return mapDomainError(error);
  const view = normalizeDomainView(data);
  return view
    ? { ok: true, data: view }
    : domainFailure("DOMAIN_OPERATION_FAILED", "The custom domain response was invalid.");
}

export async function getProjectDomain(
  projectId: string,
  domainId: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<ProjectDomainView>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("get_project_domain", {
    p_project_id: projectId,
    p_domain_id: domainId,
  });
  if (error) return mapDomainError(error);
  const view = normalizeDomainView(data);
  return view
    ? { ok: true, data: view }
    : domainFailure("DOMAIN_OPERATION_FAILED", "The domain response was invalid.");
}

export async function enqueueDomainAction(
  domainId: string,
  action: DomainAction,
  client?: SupabaseClient,
): Promise<DomainStoreResult<DomainActionAccepted>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("enqueue_domain_action", {
    p_domain_id: domainId,
    p_action: action,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!record || typeof record.jobId !== "string") {
    return domainFailure("DOMAIN_OPERATION_FAILED", "The domain job response was invalid.");
  }
  return {
    ok: true,
    data: {
      jobId: record.jobId,
      action,
      status: (str(record.status) ?? "pending") as DomainStatus,
    },
  };
}

export async function setPrimaryDomain(
  domainId: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<ProjectDomainView>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("set_primary_domain", {
    p_domain_id: domainId,
  });
  if (error) return mapDomainError(error);
  const view = normalizeDomainView(data);
  return view
    ? { ok: true, data: view }
    : domainFailure("DOMAIN_OPERATION_FAILED", "The primary-domain response was invalid.");
}

export async function consumeDomainRate(
  action: string,
  client?: SupabaseClient,
): Promise<DomainStoreResult<{ allowed: boolean; retryAfterSeconds: number }>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("consume_domain_rate_limit", {
    p_action: action,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const allowed = record?.allowed === true;
  const retryAfterSeconds = num(record?.retryAfterSeconds);
  if (!allowed) {
    return domainFailure(
      "DOMAIN_RATE_LIMITED",
      "Too many domain requests. Wait a moment and try again.",
      Math.max(1, retryAfterSeconds || 30),
    );
  }
  return { ok: true, data: { allowed, retryAfterSeconds } };
}

export async function readDomainEntitlements(
  client?: SupabaseClient,
): Promise<DomainStoreResult<DomainEntitlements>> {
  const supabase = await clientOrFailure(client);
  if (!supabase) return domainFailure("UNAVAILABLE", "Supabase is not configured.");
  const { data, error } = await supabase.rpc("domain_entitlements");
  if (error) return mapDomainError(error);
  return { ok: true, data: normalizeDomainEntitlements(data) };
}

// ── Worker-only (service role) ──────────────────────────────────────────────

export interface ClaimedDomainJob {
  jobId: string;
  action: DomainAction;
  projectId: string;
  userId: string;
  leaseToken: string;
  attemptCount: number;
  /** The project's current routing generation (0 when none). */
  routingGeneration: number;
  domain: {
    id: string;
    hostname: string;
    domainType: DomainType;
    status: DomainStatus;
    verificationToken: string | null;
    routingGeneration: number;
    routingProvider: DomainRoutingProvider;
    routingApproved: boolean;
  };
  publication: {
    versionId: string;
    entryPath: string;
    spaFallback: boolean;
    provider: string;
    status: string;
    mavlyHostname: string | null;
    routingGeneration: number;
  } | null;
}

export async function claimDomainJob(
  client: SupabaseClient,
): Promise<DomainStoreResult<ClaimedDomainJob | null>> {
  const { data, error } = await client.rpc("claim_domain_job");
  if (error) return mapDomainError(error);
  if (data === null) return { ok: true, data: null };
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (!record || record.status !== "claimed") return { ok: true, data: null };
  const domain = record.domain && typeof record.domain === "object"
    ? (record.domain as Record<string, unknown>)
    : null;
  const publication = record.publication && typeof record.publication === "object"
    ? (record.publication as Record<string, unknown>)
    : null;
  if (
    typeof record.jobId !== "string" ||
    typeof record.leaseToken !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.userId !== "string" ||
    !domain ||
    typeof domain.id !== "string" ||
    typeof domain.hostname !== "string"
  ) {
    return domainFailure("DOMAIN_OPERATION_FAILED", "The domain job claim was invalid.");
  }
  return {
    ok: true,
    data: {
      jobId: record.jobId,
      action: record.action as DomainAction,
      projectId: record.projectId,
      userId: record.userId,
      leaseToken: record.leaseToken,
      attemptCount: num(record.attemptCount),
      routingGeneration: num(record.routingGeneration),
      domain: {
        id: domain.id,
        hostname: domain.hostname,
        domainType: (str(domain.domainType) ?? "custom") as DomainType,
        status: (str(domain.status) ?? "pending") as DomainStatus,
        verificationToken: str(domain.verificationToken),
        routingGeneration: num(domain.routingGeneration),
        routingProvider: (str(domain.routingProvider) ?? "none") as DomainRoutingProvider,
        routingApproved: domain.routingApproved === true,
      },
      publication: publication
        ? {
            versionId: str(publication.versionId) ?? "",
            entryPath: str(publication.entryPath) ?? "index.html",
            spaFallback: publication.spaFallback === true,
            provider: str(publication.provider) ?? "vercel",
            status: str(publication.status) ?? "queued",
            mavlyHostname: str(publication.mavlyHostname),
            routingGeneration: num(publication.routingGeneration),
          }
        : null,
    },
  };
}

export async function completeDomainJob(
  client: SupabaseClient,
  input: {
    jobId: string;
    leaseToken: string;
    outcome: "verified" | "active" | "removed";
    dnsStatus?: DomainDnsStatus;
    sslStatus?: DomainSslStatus;
    publicationStatus?: DomainPublicationStatus;
    failureCode?: string | null;
    failureMessage?: string | null;
    certificateReference?: string | null;
  },
): Promise<DomainStoreResult<{ status: string; domainId: string }>> {
  const { data, error } = await client.rpc("complete_domain_job", {
    p_job_id: input.jobId,
    p_lease_token: input.leaseToken,
    p_outcome: input.outcome,
    p_dns_status: input.dnsStatus ?? null,
    p_ssl_status: input.sslStatus ?? null,
    p_publication_status: input.publicationStatus ?? null,
    p_failure_code: input.failureCode ?? null,
    p_failure_message: input.failureMessage ?? null,
    p_certificate_reference: input.certificateReference ?? null,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  return {
    ok: true,
    data: {
      status: str(record?.status) ?? "unknown",
      domainId: str(record?.domainId) ?? "",
    },
  };
}

export async function failDomainJob(
  client: SupabaseClient,
  input: {
    jobId: string;
    leaseToken: string;
    domainStatus: "verifying" | "provisioning" | "misconfigured" | "ssl_failed" | "ssl_pending" | "pending" | "verification_required" | "verified" | "removing" | "active";
    failureCode: string;
    failureMessage: string;
    /** False stops the queue immediately; true keeps the bounded retry budget. */
    retryable?: boolean;
  },
): Promise<DomainStoreResult<{ status: string; domainId: string }>> {
  const { data, error } = await client.rpc("fail_domain_job", {
    p_job_id: input.jobId,
    p_lease_token: input.leaseToken,
    p_domain_status: input.domainStatus,
    p_failure_code: input.failureCode.slice(0, 80),
    p_failure_message: input.failureMessage.slice(0, 500),
    p_retryable: input.retryable ?? true,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  return {
    ok: true,
    data: {
      status: str(record?.status) ?? "unknown",
      domainId: str(record?.domainId) ?? "",
    },
  };
}

// ── Worker-only route synchronization (service role) ────────────────────────

export interface ProjectDomainRoute {
  id: string;
  hostname: string;
  domainType: DomainType;
  status: DomainStatus;
  publicationStatus: DomainPublicationStatus;
  routingProvider: DomainRoutingProvider;
  routingGeneration: number;
}

export async function listProjectDomainRoutes(
  client: SupabaseClient,
  projectId: string,
): Promise<DomainStoreResult<ProjectDomainRoute[]>> {
  const { data, error } = await client.rpc("list_project_domain_routes", {
    p_project_id: projectId,
  });
  if (error) return mapDomainError(error);
  if (!Array.isArray(data)) {
    return domainFailure("DOMAIN_OPERATION_FAILED", "The domain route list was invalid.");
  }
  const routes = data
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      id: str(row.id) ?? "",
      hostname: str(row.hostname) ?? "",
      domainType: (str(row.domainType) ?? "custom") as DomainType,
      status: (str(row.status) ?? "pending") as DomainStatus,
      publicationStatus: (str(row.publicationStatus) ?? "pending") as DomainPublicationStatus,
      routingProvider: (str(row.routingProvider) ?? "none") as DomainRoutingProvider,
      routingGeneration: num(row.routingGeneration),
    }))
    .filter((row) => row.id && row.hostname);
  return { ok: true, data: routes };
}

export async function enqueueProjectDomainRoutes(
  client: SupabaseClient,
  projectId: string,
): Promise<DomainStoreResult<number>> {
  const { data, error } = await client.rpc("enqueue_project_domain_routes", {
    p_project_id: projectId,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  return { ok: true, data: num(record?.enqueued) };
}

export async function suspendProjectDomainRoutes(
  client: SupabaseClient,
  projectId: string,
): Promise<DomainStoreResult<number>> {
  const { data, error } = await client.rpc("suspend_project_domain_routes", {
    p_project_id: projectId,
  });
  if (error) return mapDomainError(error);
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  return { ok: true, data: num(record?.suspended) };
}
