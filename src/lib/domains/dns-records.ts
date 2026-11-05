/**
 * DNS records for a custom domain, taken from the hosting provider.
 *
 * ⚠️ NOTHING HERE INVENTS A RECORD. Vercel returns the records it actually
 * requires in the project-domain `verification` array; this module only
 * classifies and formats those entries. When the provider returns no records,
 * the result says so — it never falls back to a remembered CNAME/A value.
 *
 * Pure: no network, no environment, no database.
 */

import type { VercelProjectDomain, VercelProjectDomainVerification } from "@/lib/vercel/provider";

import { RECOMMENDED_TTL } from "./instructions";
import type { DomainDnsInstruction, DomainDnsInstructions } from "./types";

const VERIFICATION_TYPES = new Set(["TXT"]);
const ROUTING_TYPES = new Set(["A", "AAAA", "CNAME", "ALIAS", "ANAME"]);

/** The record types the owner UI can render without guessing. */
function normalizeRecordType(raw: string): DomainDnsInstruction["recordType"] | null {
  const value = raw.trim().toUpperCase();
  if (value === "TXT") return "TXT";
  if (value === "CNAME") return "CNAME";
  if (value === "ALIAS") return "ALIAS";
  if (value === "ANAME") return "ANAME";
  if (value === "A") return "A";
  if (value === "AAAA") return "AAAA";
  return null;
}

/**
 * One provider entry → one instruction.
 *
 * `domain` is the FULL record name Vercel expects (`@`, `www.example.com` or
 * `_vercel.example.com`), and `value` is the exact target. Both are copied
 * verbatim; only the record type is normalised. An entry with an unknown type or
 * a missing value is dropped rather than shown as an editable-looking row.
 */
function toInstruction(
  entry: VercelProjectDomainVerification,
): DomainDnsInstruction | null {
  const recordType = normalizeRecordType(entry.type);
  if (!recordType) return null;
  const name = (entry.domain ?? "").trim();
  const value = (entry.value ?? "").trim();
  if (!name || !value) return null;

  return {
    recordType,
    name,
    value,
    // Vercel does not return a TTL for these requirements. The UI labels 300 as
    // Mavly's recommendation instead of presenting it as provider-supplied.
    ttl: RECOMMENDED_TTL,
    purpose: VERIFICATION_TYPES.has(recordType) ? "verification" : "routing",
    required: true,
  };
}

function reasonNote(entry: VercelProjectDomainVerification): string | null {
  const reason = (entry.reason ?? "").trim();
  if (!reason) return null;
  return `Vercel reports: ${reason.replace(/_/g, " ")}.`;
}

/**
 * Build the owner-facing instruction set from the provider's own response.
 *
 * `verified` is the provider's answer, never the UI's. A verified hostname with
 * no returned requirements still lists zero records and says so; an unverified
 * hostname with no requirements is reported as "no records returned yet", which
 * is the actionable truth.
 */
export function dnsInstructionsFromVercelDomain(
  domain: Pick<VercelProjectDomain, "name" | "verified" | "verification">,
): DomainDnsInstructions {
  const hostname = domain.name.trim().toLowerCase();
  const entries = Array.isArray(domain.verification) ? domain.verification : [];

  const verification: DomainDnsInstruction[] = [];
  const routing: DomainDnsInstruction[] = [];
  const notes: string[] = [];

  for (const entry of entries) {
    const instruction = toInstruction(entry);
    if (!instruction) continue;
    if (instruction.purpose === "verification") verification.push(instruction);
    else routing.push(instruction);
  }

  const unknown = entries.filter(
    (entry) =>
      !VERIFICATION_TYPES.has(entry.type.trim().toUpperCase()) &&
      !ROUTING_TYPES.has(entry.type.trim().toUpperCase()),
  );
  if (unknown.length > 0) {
    notes.push(
      "Vercel returned a record type Mavly does not render. Check the domain in the hosting dashboard before editing DNS.",
    );
  }

  if (domain.verified) {
    notes.push("Vercel reports this hostname verified. HTTPS is tracked separately.");
  } else if (verification.length === 0 && routing.length === 0) {
    notes.push(
      "Vercel has not returned DNS requirements for this hostname yet. Use Verify DNS to ask again.",
    );
  } else {
    notes.push(
      "Add these records at your DNS provider, then use Verify DNS. Changes can take a few minutes to propagate.",
    );
  }

  const reasonNotes = entries
    .map(reasonNote)
    .filter((note): note is string => note !== null);
  for (const note of reasonNotes.slice(0, 3)) notes.push(note);

  return {
    hostname,
    configured: true,
    verification,
    routing,
    notes,
    unavailableReason: null,
  };
}
