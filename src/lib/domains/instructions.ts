/**
 * Exact DNS instructions, derived from configuration — never invented.
 *
 * Pure. If the operator has not configured a routing target, no CNAME/ALIAS
 * value is printed: the workspace says provisioning is not configured instead of
 * sending a customer to create a record that cannot work.
 */

import { isApexHostname, wwwHostname } from "./hostname";
import type { DomainDnsInstruction, DomainDnsInstructions } from "./types";

export const VERIFICATION_RECORD_PREFIX = "_mavly-verification";
export const VERIFICATION_VALUE_PREFIX = "mavly-domain-verification=";
export const RECOMMENDED_TTL = 300;

export interface DomainInstructionInput {
  hostname: string;
  domainType: "mavly_subdomain" | "custom";
  verificationToken?: string | null;
  /** CNAME target for a non-apex host. */
  routingTarget?: string | null;
  /** ALIAS/ANAME target for an apex, when the operator configures one. */
  apexTarget?: string | null;
}

export function verificationRecordName(hostname: string): string {
  return `${VERIFICATION_RECORD_PREFIX}.${hostname}`;
}

export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`;
}

export function buildDomainInstructions(
  input: DomainInstructionInput,
): DomainDnsInstructions {
  const hostname = input.hostname.trim().toLowerCase();
  const target = (input.routingTarget ?? "").trim().toLowerCase() || null;
  const apexTarget = (input.apexTarget ?? "").trim().toLowerCase() || null;

  if (input.domainType === "mavly_subdomain") {
    return {
      hostname,
      configured: true,
      verification: [],
      routing: [],
      notes: [
        "This is a Mavly-managed address. No DNS records are needed from you.",
        "It becomes available after routing is provisioned for the published project.",
      ],
      unavailableReason: null,
    };
  }

  const verification: DomainDnsInstruction[] = [];
  const routing: DomainDnsInstruction[] = [];
  const notes: string[] = [];

  if (input.verificationToken) {
    verification.push({
      recordType: "TXT",
      name: verificationRecordName(hostname),
      value: verificationRecordValue(input.verificationToken),
      ttl: RECOMMENDED_TTL,
      purpose: "verification",
      required: true,
    });
    notes.push(
      "The TXT record proves you control this hostname. Keep it in place until the domain is Active.",
    );
  }

  const apex = isApexHostname(hostname);
  if (apex) {
    const value = apexTarget ?? target;
    if (value) {
      routing.push({
        recordType: "ALIAS",
        name: "@",
        value,
        ttl: RECOMMENDED_TTL,
        purpose: "routing",
        required: true,
      });
      notes.push(
        "Apex domains cannot use an ordinary CNAME at every DNS provider. Use an ALIAS, ANAME or the provider's CNAME-flattening feature for the record above.",
      );
      notes.push(
        "If your provider does not support apex flattening, point the same target at the www hostname and redirect the bare apex to www.",
      );
      const www = wwwHostname(hostname);
      if (www && target) {
        notes.push(`Alternative: create a CNAME for ${www} to ${target}, then redirect the apex to www.`);
      }
    } else {
      notes.push(
        "A routing target has not been configured by the platform operator, so no CNAME/ALIAS value can be generated yet.",
      );
    }
  } else if (target) {
    routing.push({
      recordType: "CNAME",
      name: hostname,
      value: target,
      ttl: RECOMMENDED_TTL,
      purpose: "routing",
      required: true,
    });
    notes.push(
      "Create this CNAME at your DNS provider. Do not add an A or AAAA record for the same name.",
    );
  } else {
    notes.push(
      "A routing target has not been configured by the platform operator, so no CNAME/ALIAS value can be generated yet.",
    );
  }

  const configured =
    Boolean(input.verificationToken) && Boolean(apex ? (apexTarget ?? target) : target);

  return {
    hostname,
    configured,
    verification,
    routing,
    notes,
    unavailableReason: configured
      ? null
      : "Domain provisioning is not fully configured on this deployment yet. Verification instructions are shown, but the routing target is missing.",
  };
}

/** One-line record summary used by the copy action and tests. */
export function instructionLabel(instruction: DomainDnsInstruction): string {
  const name = instruction.name === "@" ? "root" : instruction.name;
  return `${instruction.recordType} ${name} → ${instruction.value}`;
}
