/**
 * ═══ TENANT HOST PARSING — THE ONLY WAY TO IDENTIFY A PUBLISHED SITE ════════
 *
 * A published site is addressed as `<project-id>.mavly.xyz`. This module turns
 * one raw `Host`-style value into a tenant identity, or refuses it.
 *
 * ⚠️ NOTHING ELSE MAY NAME A TENANT. The request path, query string, body,
 * cookie and arbitrary headers are all attacker-controlled on a public origin;
 * the serving route therefore accepts a project/version ONLY from the value this
 * parser validates. `parseTenantHost` never consults the network or the
 * database, so it can be tested exhaustively and cannot be tricked by a
 * header it did not look at.
 *
 * Deliberate policies (all covered by `tests/tenant-host.test.ts`):
 *
 *   · CASE           — the hostname is lowercased before validation. DNS is
 *                      case-insensitive; a stored hostname is always lowercase.
 *   · PORT           — `:443` / `:8080` is stripped only when it is a plain
 *                      decimal port at the end. Anything else containing `:`
 *                      (IPv6, userinfo) is refused.
 *   · TRAILING DOT   — exactly one trailing dot is removed (`foo.mavly.xyz.`).
 *                      Two or more are malformed and refused.
 *   · SHAPE          — exactly one label beneath `mavly.xyz`. `a.b.mavly.xyz`
 *                      and `mavly.xyz` itself are refused: only the configured
 *                      base domain's immediate children are tenants.
 *   · LABEL          — same structural rule as a routable project id: a
 *                      lowercase letter, then `[a-z0-9-]`, no `--`, no trailing
 *                      `-`, at most 63 characters.
 *   · IDN            — `xn--` labels are refused. Mavly does not publish
 *                      internationalized hostnames, and accepting the punycode
 *                      form would silently widen the namespace.
 *   · RESERVED       — Mavly's own hosts (`www`, `api`, `admin`, …) are never
 *                      tenants; see `src/lib/reserved-hostnames.ts`.
 *   · UNKNOWN SUFFIX — any other domain is not a tenant.
 */

import { MAVLY_PUBLIC_DOMAIN } from "./mavly-hostname";
import { isReservedLabel } from "./reserved-hostnames";

export interface TenantHost {
  /** Canonical `label.mavly.xyz` — what the database stores and matches. */
  hostname: string;
  /** The single tenant label, already validated and reserved-checked. */
  label: string;
}

/** 63 is the DNS label limit; a project id is never longer (routable guard). */
const MAX_LABEL_LENGTH = 63;
const MAX_HOST_LENGTH = 253;
const LABEL_PATTERN = /^[a-z]([a-z0-9]|-(?!-))*(?<!-)$/;

/**
 * Normalise the raw request host and extract a tenant, or return `null`.
 *
 * `null` is the only failure value: callers must answer 404/400, never "serve
 * the default site".
 */
export function parseTenantHost(rawHost: string | null | undefined): TenantHost | null {
  if (typeof rawHost !== "string") return null;

  let host = rawHost.trim();
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  // Whitespace, path, userinfo and wildcard characters can never be part of the
  // request authority we accept. Refusing them here keeps the later parsing
  // simple and means a malformed value cannot be normalised into a valid one.
  if (/[\s/\\@*?#]/.test(host)) return null;

  // ── port ──────────────────────────────────────────────────────────────────
  // IPv6 authorities are bracketed and contain several colons; the app never
  // publishes one, so refuse rather than guess which part is the port.
  const firstColon = host.indexOf(":");
  if (firstColon !== -1) {
    const port = host.slice(firstColon + 1);
    if (host.indexOf(":", firstColon + 1) !== -1) return null;
    if (!/^\d{1,5}$/.test(port)) return null;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) return null;
    host = host.slice(0, firstColon);
  }

  host = host.toLowerCase();

  // ── trailing dot (exactly one) ────────────────────────────────────────────
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.endsWith(".")) return null;

  // ── exactly one label beneath the configured domain ───────────────────────
  const suffix = `.${MAVLY_PUBLIC_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;

  if (label.length > MAX_LABEL_LENGTH) return null;
  if (label.startsWith("xn--")) return null;
  if (!LABEL_PATTERN.test(label)) return null;
  if (isReservedLabel(label)) return null;

  return { hostname: `${label}.${MAVLY_PUBLIC_DOMAIN}`, label };
}

/** Convenience for publish-time validation: the canonical host or `null`. */
export function canonicalTenantHostname(rawHost: string | null | undefined): string | null {
  return parseTenantHost(rawHost)?.hostname ?? null;
}

/**
 * True when a request path is a Next.js internal asset request. Tenant requests
 * for these are passed through untouched: a published static site is not a
 * Next.js application, and the app's own build assets must keep working.
 */
export function isNextInternalPath(pathname: string): boolean {
  return pathname === "/_next" || pathname.startsWith("/_next/");
}
