/**
 * Hostname rules shared by the composer, the API and the worker.
 *
 * Pure: no DNS, no environment, no Supabase. Every write path calls this before
 * a row is created, and the database repeats the structural checks so a direct
 * RPC cannot store a hostname this module would refuse.
 */

import { MAVLY_PUBLIC_DOMAIN } from "@/lib/mavly-hostname";
import { isReservedLabel } from "@/lib/reserved-hostnames";

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAVLY_LABEL = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Internal suffixes that are never a customer-owned public domain. */
const INTERNAL_SUFFIXES = [
  ".local",
  ".localhost",
  ".test",
  ".invalid",
  ".internal",
  ".example",
  ".home",
  ".lan",
  ".corp",
];

/** Domains Mavly itself owns; a customer can never attach them. */
const PLATFORM_SUFFIXES = [".mavly.xyz", ".vercel.app", ".supabase.co"];

export type HostnameProblem =
  | "empty"
  | "too_long"
  | "scheme"
  | "path"
  | "port"
  | "userinfo"
  | "wildcard"
  | "whitespace"
  | "ip"
  | "shape"
  | "label_length"
  | "idn"
  | "internal"
  | "platform"
  | "mavly"
  | "reserved";

export interface HostnameParseResult {
  ok: boolean;
  hostname: string;
  problem: HostnameProblem | null;
}

/**
 * Normalise a typed value to a bare lowercase hostname.
 *
 * This is deliberately strict: whitespace, userinfo, a wildcard, a port or a
 * path is a refusal, not something to strip into a valid value.
 */
export function normalizeHostname(raw: string | null | undefined): HostnameParseResult {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { ok: false, hostname: "", problem: "empty" };
  if (input.length > MAX_HOSTNAME_LENGTH + 32) {
    return { ok: false, hostname: "", problem: "too_long" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    // Accept a scheme only by refusing it here; the UI normalises before submit.
    return { ok: false, hostname: "", problem: "scheme" };
  }
  if (/[\s\\/?#@*]/.test(input)) {
    const problem: HostnameProblem = input.includes("@")
      ? "userinfo"
      : input.includes("*")
        ? "wildcard"
        : /[\s]/.test(input)
          ? "whitespace"
          : input.includes("?") || input.includes("#") || input.includes("/")
            ? "path"
            : "shape";
    return { ok: false, hostname: "", problem };
  }
  if (input.includes(":")) return { ok: false, hostname: "", problem: "port" };

  let hostname = input.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname.endsWith(".")) return { ok: false, hostname: "", problem: "shape" };
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, hostname: "", problem: "too_long" };
  }
  if (hostname.startsWith("xn--") || hostname.includes(".xn--")) {
    return { ok: false, hostname: "", problem: "idn" };
  }
  if (IPV4.test(hostname)) return { ok: false, hostname: "", problem: "ip" };

  const labels = hostname.split(".");
  if (labels.length < 2) return { ok: false, hostname, problem: "shape" };
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH) {
      return { ok: false, hostname, problem: "label_length" };
    }
    if (!LABEL.test(label)) return { ok: false, hostname, problem: "shape" };
    if (label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, hostname, problem: "shape" };
    }
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "")) {
    return { ok: false, hostname, problem: "shape" };
  }
  if (INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, hostname, problem: "internal" };
  }
  if (PLATFORM_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, hostname, problem: "platform" };
  }
  return { ok: true, hostname, problem: null };
}

/** True when the value is a structurally valid public hostname. */
export function isValidPublicHostname(raw: string | null | undefined): boolean {
  return normalizeHostname(raw).ok;
}

/** `shop.example.com` → `example.com`; `example.com` → `example.com`. */
export function registrableRoot(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  return labels.length <= 2 ? labels.join(".") : labels.slice(-2).join(".");
}

/**
 * An apex is a host with exactly two labels in the common case. A multi-label
 * public suffix (`example.co.uk`) is still treated as an apex because we cannot
 * consult the public suffix list here; the DNS instructions explicitly tell the
 * customer to use the record type their provider supports.
 */
export function isApexHostname(hostname: string): boolean {
  return hostname.split(".").length === 2;
}

/** The `www` companion of an apex, or null. */
export function wwwHostname(hostname: string): string | null {
  return isApexHostname(hostname) ? `www.${hostname}` : null;
}

/** A Mavly-managed hostname is exactly `<label>.mavly.xyz`. */
export function isMavlyManagedHostname(hostname: string): boolean {
  return mavlyAliasLabel(hostname) !== null;
}

/** The single label of `<label>.mavly.xyz`, or null. */
export function mavlyAliasLabel(hostname: string): string | null {
  const value = hostname.trim().toLowerCase();
  const suffix = `.${MAVLY_PUBLIC_DOMAIN}`;
  if (!value.endsWith(suffix)) return null;
  const label = value.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return label;
}

export type SubdomainLabelProblem =
  | "empty"
  | "too_long"
  | "shape"
  | "reserved"
  | "idn"
  | "canonical";

/** Validate a human-readable `<label>.mavly.xyz` alias. */
export function validateSubdomainLabel(
  raw: string | null | undefined,
  projectId?: string,
): { ok: boolean; label: string; problem: SubdomainLabelProblem | null } {
  const label = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!label) return { ok: false, label, problem: "empty" };
  if (label.length > MAX_LABEL_LENGTH) return { ok: false, label, problem: "too_long" };
  if (label.startsWith("xn--")) return { ok: false, label, problem: "idn" };
  if (!MAVLY_LABEL.test(label) || label.includes("--")) {
    return { ok: false, label, problem: "shape" };
  }
  if (isReservedLabel(label)) return { ok: false, label, problem: "reserved" };
  if (projectId && label === projectId.trim().toLowerCase()) {
    return { ok: false, label, problem: "canonical" };
  }
  return { ok: true, label, problem: null };
}

/** Human copy for a refused hostname, used by the workspace. */
export function hostnameProblemMessage(problem: HostnameProblem): string {
  switch (problem) {
    case "empty":
      return "Enter a domain such as example.com or shop.example.com.";
    case "too_long":
      return "That hostname is longer than the 253-character DNS limit.";
    case "scheme":
      return "Enter only the hostname. Remove https:// or any other scheme.";
    case "path":
      return "Enter only the hostname. Remove the path, query string or fragment.";
    case "port":
      return "Enter only the hostname. Remove the port number.";
    case "userinfo":
      return "Enter only the hostname. Do not include an email address or username.";
    case "wildcard":
      return "A wildcard domain cannot be attached. Enter the exact hostname you own.";
    case "whitespace":
      return "Remove the spaces from the hostname.";
    case "ip":
      return "Use a domain name, not an IP address.";
    case "label_length":
      return "One part of that hostname is longer than 63 characters.";
    case "idn":
      return "Internationalized (punycode) hostnames are not supported yet.";
    case "internal":
      return "That hostname uses an internal-only suffix and cannot be published.";
    case "platform":
      return "That domain belongs to Mavly or another hosted platform and cannot be attached.";
    case "mavly":
      return "Mavly-managed hostnames are created from the subdomain field, not as a custom domain.";
    case "reserved":
      return "That name is reserved for Mavly infrastructure.";
    case "shape":
      return "That is not a valid public hostname.";
  }
}
