import { isApexHostname, isValidPublicHostname } from "./hostname";
import { txtValueMatches } from "./token";

/**
 * Server-only DNS inspection over DNS-over-HTTPS.
 *
 * ⚠️ TRUSTED RESOLVERS, FIXED ORIGINS. The hostname is validated by our own
 * rules and then placed in a URLSearchParams value; no caller supplies a URL,
 * resolver or record type. Responses are bounded and redirects are refused.
 */

export type DomainDnsFailure =
  | "invalid_hostname"
  | "resolver_unavailable"
  | "resolver_error"
  | "timeout"
  | "response_too_large";

export class DomainDnsError extends Error {
  readonly code: DomainDnsFailure;

  constructor(code: DomainDnsFailure, message: string) {
    super(message);
    this.name = "DomainDnsError";
    this.code = code;
  }
}

export interface DnsQueryOptions {
  resolvers: readonly string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 64 * 1024;
const TYPE_TXT = 16;
const TYPE_CNAME = 5;
const TYPE_A = 1;
const TYPE_AAAA = 28;

interface DohAnswer {
  name?: unknown;
  type?: unknown;
  TTL?: unknown;
  data?: unknown;
}

interface DohResponse {
  Status?: unknown;
  Answer?: unknown;
}

async function query(
  name: string,
  type: "TXT" | "CNAME" | "A" | "AAAA",
  options: DnsQueryOptions,
): Promise<DohAnswer[]> {
  if (!isValidPublicHostname(name)) {
    throw new DomainDnsError("invalid_hostname", "The hostname is not valid.");
  }
  if (options.resolvers.length === 0) {
    throw new DomainDnsError("resolver_unavailable", "No DNS resolver is configured.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: DomainDnsError | null = null;

  for (const resolver of options.resolvers) {
    try {
      const url = new URL(resolver);
      url.searchParams.set("name", name);
      url.searchParams.set("type", type);
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        lastError = new DomainDnsError(
          "resolver_error",
          `DNS resolver answered ${response.status}.`,
        );
        continue;
      }
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) {
        lastError = new DomainDnsError(
          "response_too_large",
          "The DNS resolver response was too large.",
        );
        continue;
      }
      const body = JSON.parse(text) as DohResponse;
      if (typeof body.Status === "number" && body.Status !== 0 && body.Status !== 3) {
        lastError = new DomainDnsError("resolver_error", "The DNS query failed.");
        continue;
      }
      if (!Array.isArray(body.Answer)) return [];
      return body.Answer.filter(
        (answer): answer is DohAnswer =>
          Boolean(answer) && typeof answer === "object",
      );
    } catch (error) {
      if (error instanceof DomainDnsError) {
        lastError = error;
        continue;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        lastError = new DomainDnsError("timeout", "The DNS query timed out.");
      } else {
        lastError = new DomainDnsError("resolver_unavailable", "The DNS resolver could not be reached.");
      }
    }
  }

  throw lastError ?? new DomainDnsError("resolver_unavailable", "No DNS resolver answered.");
}

function stringsForType(answers: readonly DohAnswer[], type: number): string[] {
  const values: string[] = [];
  for (const answer of answers) {
    if (answer.type !== type) continue;
    if (typeof answer.data !== "string") continue;
    const value = answer.data.trim();
    if (!value) continue;
    values.push(value);
  }
  return values;
}

export interface DnsInspection {
  ok: boolean;
  code: DomainDnsFailure | "verified" | "not_found" | "mismatch";
  txtRecords: string[];
  cnameRecords: string[];
  resolvedAddresses: string[];
}

/** Inspect the TXT ownership record and the routing record in one pass. */
export async function inspectCustomDomainDns(input: {
  hostname: string;
  token: string;
  target: string | null;
  options: DnsQueryOptions;
}): Promise<DnsInspection> {
  const { hostname, token, target, options } = input;
  if (!isValidPublicHostname(hostname)) {
    return {
      ok: false,
      code: "invalid_hostname",
      txtRecords: [],
      cnameRecords: [],
      resolvedAddresses: [],
    };
  }

  const txtAnswers = await query(`_mavly-verification.${hostname}`, "TXT", options);
  const txtRecords = stringsForType(txtAnswers, TYPE_TXT);
  if (!txtValueMatches(txtRecords, token)) {
    return {
      ok: false,
      code: txtRecords.length === 0 ? "not_found" : "mismatch",
      txtRecords,
      cnameRecords: [],
      resolvedAddresses: [],
    };
  }

  if (!target) {
    // Ownership is proven, but routing cannot be judged without a target.
    return { ok: true, code: "verified", txtRecords, cnameRecords: [], resolvedAddresses: [] };
  }

  const cnameAnswers = await query(hostname, "CNAME", options);
  const cnameRecords = stringsForType(cnameAnswers, TYPE_CNAME).map((value) =>
    value.toLowerCase().replace(/\.$/, ""),
  );

  let resolvedAddresses: string[] = [];
  if (isApexHostname(hostname)) {
    // Apex flattening resolves to the target's A/AAAA addresses.
    const a = await query(hostname, "A", options);
    const aaaa = await query(hostname, "AAAA", options);
    resolvedAddresses = [
      ...stringsForType(a, TYPE_A),
      ...stringsForType(aaaa, TYPE_AAAA),
    ];
    const targetA = await query(target, "A", options).catch(() => [] as DohAnswer[]);
    const targetAaaa = await query(target, "AAAA", options).catch(() => [] as DohAnswer[]);
    const targetAddresses = new Set([
      ...stringsForType(targetA, TYPE_A),
      ...stringsForType(targetAaaa, TYPE_AAAA),
    ]);
    const matches = resolvedAddresses.some((address) => targetAddresses.has(address));
    return {
      ok: matches,
      code: matches ? "verified" : "mismatch",
      txtRecords,
      cnameRecords,
      resolvedAddresses,
    };
  }

  const direct = cnameRecords.some(
    (record) => record === target || record.endsWith(`.${target}`),
  );
  return {
    ok: direct,
    code: direct ? "verified" : "mismatch",
    txtRecords,
    cnameRecords,
    resolvedAddresses,
  };
}

/** Resolve only the TXT ownership record (used by the focused re-check). */
export async function verifyOwnershipTxt(input: {
  hostname: string;
  token: string;
  options: DnsQueryOptions;
}): Promise<boolean> {
  const answers = await query(
    `_mavly-verification.${input.hostname}`,
    "TXT",
    input.options,
  );
  return txtValueMatches(stringsForType(answers, TYPE_TXT), input.token);
}

/** Diagnostics for the operator; safe to show, contains no token. */
export function describeDnsInspection(inspection: DnsInspection): string {
  if (inspection.ok) return "DNS records look correct.";
  switch (inspection.code) {
    case "not_found":
      return "The verification TXT record was not found yet.";
    case "mismatch":
      return "A record exists but does not match the expected value.";
    case "invalid_hostname":
      return "The hostname is invalid.";
    case "timeout":
      return "The DNS lookup timed out. It will be retried.";
    case "resolver_unavailable":
      return "No trusted DNS resolver could be reached.";
    case "resolver_error":
      return "The DNS resolver rejected the query.";
    case "response_too_large":
      return "The DNS response was too large.";
    default:
      return "DNS is not ready yet.";
  }
}
