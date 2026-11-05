/**
 * Server-only domain-management configuration.
 *
 * ⚠️ OFF BY DEFAULT. Enabling any part of this subsystem requires the operator to
 * apply migration 62 and (for custom hosting) configure Vercel customer hosting
 * and approve the DNS/routing changes. A missing prerequisite fails closed with a
 * structured reason; it never silently falls back to a different hosting path.
 *
 * The browser never reads this module. Do not import it from a client component.
 */

export type DomainConfigProblem =
  | "disabled"
  | "missing_mavly_base"
  | "invalid_resolver"
  | "invalid_target";

export interface DomainConfig {
  enabled: boolean;
  customDomainsEnabled: boolean;
  subdomainAliasesEnabled: boolean;
  provisioningEnabled: boolean;
  requireRoutingApproval: boolean;
  /** CNAME target for customer subdomains (for example `edge.mavly.xyz`). */
  routingTarget: string | null;
  /** ALIAS/ANAME target for customer apex domains when it differs. */
  apexTarget: string | null;
  /** Trusted DNS-over-HTTPS endpoints. Fixed hostnames, never client supplied. */
  resolvers: readonly string[];
  verificationTimeoutMs: number;
  publicProbeTimeoutMs: number;
  propagationGraceSeconds: number;
  problem: DomainConfigProblem | null;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSEY = new Set(["0", "false", "no", "off"]);

const DEFAULT_RESOLVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
] as const;

const ALLOWED_RESOLVER_HOSTS = new Set([
  "cloudflare-dns.com",
  "dns.google",
  "dns.quad9.net",
]);

function flag(env: Partial<NodeJS.ProcessEnv>, name: string, fallback = false): boolean {
  const value = (env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return TRUTHY.has(value);
}

function target(env: Partial<NodeJS.ProcessEnv>, name: string): string | string[] | null {
  const raw = (env[name] ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;
  // A scheme, path, wildcard, port or credential is never a DNS target.
  if (/[\s/\\@*?#:]/.test(raw)) return [];
  if (raw.length > 253) return [];
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw)) {
    return [];
  }
  return raw;
}

function parseResolvers(env: Partial<NodeJS.ProcessEnv>): string[] | "invalid" {
  const raw = (env.MAVLY_DOMAIN_DNS_RESOLVERS ?? "").trim();
  if (!raw) return [...DEFAULT_RESOLVERS];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > 4) return "invalid";
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return "invalid";
      if (!ALLOWED_RESOLVER_HOSTS.has(url.hostname.toLowerCase())) return "invalid";
      if (url.pathname !== "/dns-query" && url.pathname !== "/resolve") return "invalid";
    } catch {
      return "invalid";
    }
  }
  return values;
}

function numberInRange(
  env: Partial<NodeJS.ProcessEnv>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number((env[name] ?? "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function readDomainConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): DomainConfig {
  const enabled = flag(env, "MAVLY_DOMAIN_MANAGEMENT_ENABLED");
  const customDomainsEnabled = enabled && flag(env, "MAVLY_CUSTOM_DOMAINS_ENABLED");
  const subdomainAliasesEnabled = enabled && flag(env, "MAVLY_SUBDOMAIN_ALIASES_ENABLED");
  const provisioningEnabled = enabled && flag(env, "MAVLY_DOMAIN_PROVISIONING_ENABLED");
  const requireRoutingApproval = !FALSEY.has(
    (env.MAVLY_DOMAIN_ROUTING_REQUIRE_APPROVAL ?? "true").trim().toLowerCase(),
  );

  const rawTarget = target(env, "MAVLY_CUSTOM_DOMAIN_ROUTING_TARGET");
  const rawApex = target(env, "MAVLY_CUSTOM_DOMAIN_APEX_TARGET");
  const resolvers = parseResolvers(env);

  let problem: DomainConfigProblem | null = null;
  if (!enabled) problem = "disabled";
  else if (resolvers === "invalid") problem = "invalid_resolver";
  else if (Array.isArray(rawTarget) || Array.isArray(rawApex)) problem = "invalid_target";

  return {
    enabled,
    customDomainsEnabled: enabled && customDomainsEnabled && problem === null,
    subdomainAliasesEnabled: enabled && subdomainAliasesEnabled && problem === null,
    provisioningEnabled: enabled && provisioningEnabled && problem === null,
    requireRoutingApproval,
    routingTarget: typeof rawTarget === "string" ? rawTarget : null,
    apexTarget: typeof rawApex === "string" ? rawApex : null,
    resolvers: resolvers === "invalid" ? [] : resolvers,
    verificationTimeoutMs: numberInRange(
      env,
      "MAVLY_DOMAIN_VERIFICATION_TIMEOUT_MS",
      8_000,
      1_000,
      30_000,
    ),
    publicProbeTimeoutMs: numberInRange(
      env,
      "MAVLY_DOMAIN_PUBLIC_PROBE_TIMEOUT_MS",
      8_000,
      1_000,
      30_000,
    ),
    propagationGraceSeconds: numberInRange(
      env,
      "MAVLY_DOMAIN_PROPAGATION_GRACE_SECONDS",
      900,
      0,
      86_400,
    ),
    problem,
  };
}

export function isDomainManagementConfigured(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  const config = readDomainConfig(env);
  return config.enabled && config.problem === null;
}

/** A safe, non-secret description for diagnostics and the admin page. */
export function describeDomainConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): {
  enabled: boolean;
  customDomainsEnabled: boolean;
  subdomainAliasesEnabled: boolean;
  provisioningEnabled: boolean;
  requireRoutingApproval: boolean;
  hasRoutingTarget: boolean;
  hasApexTarget: boolean;
  resolverCount: number;
  problem: DomainConfigProblem | null;
} {
  const config = readDomainConfig(env);
  return {
    enabled: config.enabled,
    customDomainsEnabled: config.customDomainsEnabled,
    subdomainAliasesEnabled: config.subdomainAliasesEnabled,
    provisioningEnabled: config.provisioningEnabled,
    requireRoutingApproval: config.requireRoutingApproval,
    hasRoutingTarget: config.routingTarget !== null,
    hasApexTarget: config.apexTarget !== null,
    resolverCount: config.resolvers.length,
    problem: config.problem,
  };
}
