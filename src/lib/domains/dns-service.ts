/**
 * Real DNS requirements for a custom domain, read from the hosting provider.
 *
 * The owner only ever sees records the provider actually returned for THIS
 * project's hostname. Every value is re-derived on the server from trusted rows:
 * the domain row (owner RPC), the deployment target (owner RLS) and the Vercel
 * configuration (server-only). A browser cannot supply a project id, a hostname
 * target or a record.
 */

import { readVercelDeploymentConfig } from "@/lib/vercel/config";
import { getVercelProjectDomain } from "@/lib/vercel/provider";

import { dnsInstructionsFromVercelDomain } from "./dns-records";
import { domainCapability } from "./service";
import { getProjectDomain } from "./store";
import { readOwnerDeploymentTarget } from "./target";
import type { DomainDnsInstructions } from "./types";

export type DomainDnsFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type DomainDnsResult =
  | { ok: true; data: DomainDnsInstructions }
  | DomainDnsFailure;

function failure(status: number, code: string, error: string): DomainDnsFailure {
  return { ok: false, status, code, error };
}

/**
 * `GET …/domains/{id}/dns`.
 *
 * Read-only: it asks Vercel for the hostname's current state and returns the
 * records Vercel requires. It never attaches, verifies or activates anything —
 * those are the queued `provision` job's authority, so a page refresh can never
 * advance a domain's status.
 */
export async function getDomainDnsRecords(
  projectId: string,
  domainId: string,
): Promise<DomainDnsResult> {
  const capability = domainCapability();
  if (!capability.enabled || !capability.customDomainsEnabled) {
    return failure(
      403,
      "DOMAIN_CUSTOM_DISABLED",
      "Custom domains are disabled on this deployment.",
    );
  }

  const row = await getProjectDomain(projectId, domainId);
  if (!row.ok) {
    return failure(
      (row as { ok: false; code: string }).code === "MIGRATION_REQUIRED" ? 503 : 400,
      (row as { ok: false; code: string }).code,
      (row as { ok: false; error: string }).error,
    );
  }

  if (row.data.domainType !== "custom") {
    return failure(
      400,
      "DOMAIN_VERIFY_NOT_APPLICABLE",
      "A Mavly subdomain is managed by Mavly and needs no DNS records from you.",
    );
  }

  const target = await readOwnerDeploymentTarget(projectId);
  if (!target.ok) return failure(400, (target as { ok: false; code: string }).code, (target as { ok: false; error: string }).error);

  if (target.data.provider !== "vercel") {
    return failure(
      409,
      "DOMAIN_DNS_UNAVAILABLE",
      "This project is not hosted on Vercel, so Vercel has no DNS requirements for it.",
    );
  }
  if (!target.data.target) {
    return failure(
      409,
      "DOMAIN_VERCEL_PROJECT_MISSING",
      "Publish this website once before connecting a custom domain. Its Vercel project is created by the first publish.",
    );
  }

  const config = readVercelDeploymentConfig();
  if (!config.ok) {
    return failure(
      503,
      "DOMAIN_HOSTING_NOT_CONFIGURED",
      "Vercel customer hosting is not configured on this deployment.",
    );
  }

  const domain = await getVercelProjectDomain(
    config.config,
    target.data.target,
    row.data.hostname,
  );
  if (!domain.ok) {
    return failure(
      (domain as { ok: false; failure: { status: number; message: string } }).failure.status === 404 ? 409 : 502,
      "DOMAIN_DNS_LOOKUP_FAILED",
      (domain as { ok: false; failure: { status: number; message: string } }).failure.status === 404
        ? "Vercel reports this hostname is not attached to the project yet. Publish again or retry provisioning."
        : (domain as { ok: false; failure: { status: number; message: string } }).failure.message,
    );
  }

  return { ok: true, data: dnsInstructionsFromVercelDomain(domain.data) };
}
