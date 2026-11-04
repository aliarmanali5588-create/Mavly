import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isApexHostname,
  isMavlyManagedHostname,
  isValidPublicHostname,
  mavlyAliasLabel,
  normalizeHostname,
  validateSubdomainLabel,
  wwwHostname,
} from "../src/lib/domains/hostname";
import {
  RECOMMENDED_TTL,
  VERIFICATION_RECORD_PREFIX,
  VERIFICATION_VALUE_PREFIX,
  buildDomainInstructions,
  verificationRecordName,
  verificationRecordValue,
} from "../src/lib/domains/instructions";
import {
  generateVerificationToken,
  hashVerificationToken,
  normalizeTxtValue,
  tokenHashMatches,
  txtValueMatches,
} from "../src/lib/domains/token";
import {
  canActivateAnotherDomain,
  canAddCustomDomain,
  canAddSubdomainAlias,
  normalizeDomainEntitlements,
} from "../src/lib/domains/entitlements";
import { isDomainActive, isDomainSettling } from "../src/lib/domains/status";
import { readDomainConfig } from "../src/lib/domains/config";
import {
  DOMAIN_ERROR_CODES,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
} from "../src/lib/domains/types";

/**
 * ═══ DOMAIN VOCABULARY, HOSTNAMES, TOKENS, INSTRUCTIONS ═════════════════════
 *
 * These are the pure modules every write path calls before a row exists and the
 * worker calls before it touches DNS. They are pinned here because a regression
 * in any of them is a security regression: a hostname that normalises into
 * something it was not, or a token comparison that stops being exact.
 */

// ── hostname normalisation ──────────────────────────────────────────────────

test("a plain hostname normalises to lowercase and keeps its shape", () => {
  assert.deepEqual(normalizeHostname("Example.COM"), { ok: true, hostname: "example.com", problem: null });
  assert.deepEqual(normalizeHostname("  shop.Example.com  "), {
    ok: true,
    hostname: "shop.example.com",
    problem: null,
  });
});

test("exactly one trailing dot is removed and two are refused", () => {
  assert.equal(normalizeHostname("example.com.").hostname, "example.com");
  assert.equal(normalizeHostname("example.com..").ok, false);
});

test("a scheme, path, port, userinfo or wildcard is refused, never stripped", () => {
  const cases: Array<[string, string]> = [
    ["https://example.com", "scheme"],
    ["example.com/path", "path"],
    ["example.com:443", "port"],
    ["user@example.com", "userinfo"],
    ["*.example.com", "wildcard"],
    ["exa mple.com", "whitespace"],
  ];
  for (const [input, problem] of cases) {
    const result = normalizeHostname(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.problem, problem, input);
  }
});

test("an IP address is not a hostname", () => {
  assert.equal(normalizeHostname("192.168.1.1").problem, "ip");
  assert.equal(normalizeHostname("1.2.3.4").ok, false);
});

test("a punycode label is refused rather than silently widening the namespace", () => {
  assert.equal(normalizeHostname("xn--80ak6aa92e.com").problem, "idn");
  assert.equal(normalizeHostname("shop.xn--80ak6aa92e.com").problem, "idn");
});

test("internal and platform suffixes are refused", () => {
  for (const host of [
    "example.local",
    "example.test",
    "example.invalid",
    "example.internal",
    "example.example",
    "shop.mavly.xyz",
    "app.vercel.app",
    "project.supabase.co",
  ]) {
    assert.equal(normalizeHostname(host).ok, false, host);
  }
});

test("a single label, an empty label and a numeric TLD are refused", () => {
  assert.equal(normalizeHostname("localhost").ok, false);
  assert.equal(normalizeHostname("example..com").ok, false);
  assert.equal(normalizeHostname("example.123").ok, false);
});

test("a label longer than 63 characters is refused", () => {
  const long = "a".repeat(64);
  assert.equal(normalizeHostname(`${long}.example.com`).ok, false);
});

test("apex and www helpers agree with the label count", () => {
  assert.equal(isApexHostname("example.com"), true);
  assert.equal(isApexHostname("shop.example.com"), false);
  assert.equal(wwwHostname("example.com"), "www.example.com");
  assert.equal(wwwHostname("shop.example.com"), null);
});

test("a Mavly-managed hostname is exactly one label under the base domain", () => {
  assert.equal(isMavlyManagedHostname("my-store.mavly.xyz"), true);
  assert.equal(mavlyAliasLabel("my-store.mavly.xyz"), "my-store");
  assert.equal(isMavlyManagedHostname("a.b.mavly.xyz"), false);
  assert.equal(isMavlyManagedHostname("mavly.xyz"), false);
  assert.equal(isMavlyManagedHostname("my-store.example.com"), false);
});

test("isValidPublicHostname agrees with normalizeHostname", () => {
  assert.equal(isValidPublicHostname("shop.example.com"), true);
  assert.equal(isValidPublicHostname("shop.mavly.xyz"), false);
  assert.equal(isValidPublicHostname(""), false);
  assert.equal(isValidPublicHostname(null), false);
});

// ── subdomain labels ────────────────────────────────────────────────────────

test("a valid alias label is accepted", () => {
  for (const label of ["my-store", "portfolio", "a1", "my-portfolio-2026"]) {
    const result = validateSubdomainLabel(label);
    assert.equal(result.ok, true, label);
    assert.equal(result.label, label);
  }
});

test("an alias label is lowercased before validation", () => {
  assert.equal(validateSubdomainLabel("My-Store").label, "my-store");
});

test("a reserved alias label is refused", () => {
  const result = validateSubdomainLabel("www");
  assert.equal(result.ok, false);
  assert.equal(result.problem, "reserved");
});

test("a double hyphen, leading hyphen, trailing hyphen or underscore is refused", () => {
  for (const label of ["my--store", "-store", "store-", "my_store", "my store"]) {
    assert.equal(validateSubdomainLabel(label).ok, false, label);
  }
});

test("a label equal to the project id is refused as canonical", () => {
  const result = validateSubdomainLabel("proj-alpha", "proj-alpha");
  assert.equal(result.ok, false);
  assert.equal(result.problem, "canonical");
});

test("an empty or overlong alias label is refused", () => {
  assert.equal(validateSubdomainLabel("").problem, "empty");
  assert.equal(validateSubdomainLabel("a".repeat(64)).problem, "too_long");
});

test("a punycode alias label is refused", () => {
  assert.equal(validateSubdomainLabel("xn--abc").problem, "idn");
});

// ── verification tokens ─────────────────────────────────────────────────────

test("a verification token is random, url-safe and long enough", () => {
  const first = generateVerificationToken();
  const second = generateVerificationToken();
  assert.notEqual(first, second);
  assert.ok(first.length >= 40, "32 random bytes in base64url");
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test("the stored hash is a hex sha-256 of the token", () => {
  const token = generateVerificationToken();
  const hash = hashVerificationToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, hashVerificationToken(token));
  assert.notEqual(hash, hashVerificationToken(generateVerificationToken()));
});

test("tokenHashMatches accepts only the matching token", () => {
  const token = generateVerificationToken();
  const hash = hashVerificationToken(token);
  assert.equal(tokenHashMatches(token, hash), true);
  assert.equal(tokenHashMatches(token, hash.toUpperCase()), true);
  assert.equal(tokenHashMatches(generateVerificationToken(), hash), false);
  assert.equal(tokenHashMatches(token, hashVerificationToken("other")), false);
});

test("a TXT answer split into quoted chunks is concatenated before comparison", () => {
  assert.equal(normalizeTxtValue('"abc" "def"'), "abcdef");
  assert.equal(normalizeTxtValue("plain-value"), "plain-value");
  assert.equal(normalizeTxtValue('"only-one"'), "only-one");
});

test("txtValueMatches requires the exact prefixed value, not a substring", () => {
  const token = "abc123";
  const expected = `${VERIFICATION_VALUE_PREFIX}${token}`;
  assert.equal(txtValueMatches([expected], token), true);
  assert.equal(txtValueMatches([`"${expected}"`], token), true);
  assert.equal(txtValueMatches([`${expected}-extra`], token), false);
  assert.equal(txtValueMatches([`prefix-${expected}`], token), false);
  assert.equal(txtValueMatches([], token), false);
});

test("the verification record name and value use the documented shape", () => {
  assert.equal(verificationRecordName("example.com"), `_mavly-verification.example.com`);
  assert.equal(VERIFICATION_RECORD_PREFIX, "_mavly-verification");
  assert.equal(verificationRecordValue("tok"), `mavly-domain-verification=tok`);
});

// ── DNS instructions ────────────────────────────────────────────────────────

test("a Mavly alias needs no customer DNS records", () => {
  const instructions = buildDomainInstructions({
    hostname: "my-store.mavly.xyz",
    domainType: "mavly_subdomain",
    verificationToken: null,
    routingTarget: "edge.mavly.xyz",
  });
  assert.equal(instructions.configured, true);
  assert.deepEqual(instructions.verification, []);
  assert.deepEqual(instructions.routing, []);
  assert.equal(instructions.unavailableReason, null);
});

test("a custom subdomain gets a TXT verification record and a CNAME", () => {
  const instructions = buildDomainInstructions({
    hostname: "shop.example.com",
    domainType: "custom",
    verificationToken: "tok-123",
    routingTarget: "edge.mavly.xyz",
  });
  assert.equal(instructions.configured, true);
  assert.equal(instructions.verification.length, 1);
  assert.equal(instructions.verification[0].recordType, "TXT");
  assert.equal(instructions.verification[0].name, "_mavly-verification.shop.example.com");
  assert.equal(instructions.verification[0].value, "mavly-domain-verification=tok-123");
  assert.equal(instructions.verification[0].ttl, RECOMMENDED_TTL);

  assert.equal(instructions.routing.length, 1);
  assert.equal(instructions.routing[0].recordType, "CNAME");
  assert.equal(instructions.routing[0].name, "shop.example.com");
  assert.equal(instructions.routing[0].value, "edge.mavly.xyz");
});

test("an apex domain is never given a plain CNAME", () => {
  const instructions = buildDomainInstructions({
    hostname: "example.com",
    domainType: "custom",
    verificationToken: "tok-123",
    routingTarget: "edge.mavly.xyz",
  });
  assert.equal(instructions.routing.length, 1);
  assert.equal(instructions.routing[0].recordType, "ALIAS");
  assert.equal(instructions.routing[0].name, "@");
  assert.ok(
    instructions.notes.some((note) => note.includes("ALIAS, ANAME")),
    "the customer is told apex CNAMEs are not universal",
  );
});

test("a missing routing target prints no record and says so", () => {
  const instructions = buildDomainInstructions({
    hostname: "shop.example.com",
    domainType: "custom",
    verificationToken: "tok-123",
    routingTarget: null,
    apexTarget: null,
  });
  assert.equal(instructions.configured, false);
  assert.equal(instructions.routing.length, 0);
  assert.ok(instructions.unavailableReason);
  assert.ok(instructions.notes.some((note) => note.includes("has not been configured")));
});

test("a missing verification token prints no TXT record", () => {
  const instructions = buildDomainInstructions({
    hostname: "shop.example.com",
    domainType: "custom",
    verificationToken: null,
    routingTarget: "edge.mavly.xyz",
  });
  assert.equal(instructions.verification.length, 0);
  assert.equal(instructions.configured, false);
});

test("an apex target overrides the general routing target", () => {
  const instructions = buildDomainInstructions({
    hostname: "example.com",
    domainType: "custom",
    verificationToken: "tok",
    routingTarget: "edge.mavly.xyz",
    apexTarget: "apex.mavly.xyz",
  });
  assert.equal(instructions.routing[0].value, "apex.mavly.xyz");
});

// ── entitlements ────────────────────────────────────────────────────────────

test("a free plan with zero allowances refuses every dimension", () => {
  const entitlements = normalizeDomainEntitlements({
    planId: "free",
    maxCustomDomains: 0,
    maxSubdomainAliases: 0,
    maxActiveDomains: 0,
  });
  assert.equal(canAddCustomDomain(entitlements).reason, "plan_required");
  assert.equal(canAddSubdomainAlias(entitlements).reason, "plan_required");
  assert.equal(canActivateAnotherDomain(entitlements).reason, "plan_required");
});

test("an exhausted allowance reports the specific limit", () => {
  const entitlements = normalizeDomainEntitlements({
    planId: "pro",
    maxCustomDomains: 2,
    customDomainsUsed: 2,
    maxSubdomainAliases: 1,
    subdomainAliasesUsed: 1,
    maxActiveDomains: 3,
    activeDomainsUsed: 3,
  });
  assert.equal(canAddCustomDomain(entitlements).reason, "custom_limit_reached");
  assert.equal(canAddSubdomainAlias(entitlements).reason, "alias_limit_reached");
  assert.equal(canActivateAnotherDomain(entitlements).reason, "active_limit_reached");
});

test("a remaining allowance is allowed with a correct remainder", () => {
  const entitlements = normalizeDomainEntitlements({
    planId: "pro",
    maxCustomDomains: 3,
    customDomainsUsed: 1,
    maxSubdomainAliases: 2,
    subdomainAliasesUsed: 0,
    maxActiveDomains: 5,
    activeDomainsUsed: 2,
  });
  assert.deepEqual(canAddCustomDomain(entitlements), { allowed: true, reason: "allowed", remaining: 2 });
  assert.deepEqual(canAddSubdomainAlias(entitlements), { allowed: true, reason: "allowed", remaining: 2 });
  assert.deepEqual(canActivateAnotherDomain(entitlements), { allowed: true, reason: "allowed", remaining: 3 });
});

test("malformed entitlement input normalises to a restrictive free plan", () => {
  const entitlements = normalizeDomainEntitlements({ maxCustomDomains: "not-a-number", maxActiveDomains: -5 });
  assert.equal(entitlements.planId, "free");
  assert.equal(entitlements.maxCustomDomains, 0);
  assert.equal(entitlements.maxActiveDomains, 0);
  assert.equal(normalizeDomainEntitlements(null).planId, "free");
});

test("a usage count above the limit never reports a negative remainder", () => {
  const entitlements = normalizeDomainEntitlements({
    maxCustomDomains: 1,
    customDomainsUsed: 9,
  });
  assert.equal(canAddCustomDomain(entitlements).remaining, 0);
});

// ── status vocabulary ───────────────────────────────────────────────────────

test("only `active` counts as serving", () => {
  assert.equal(isDomainActive("active"), true);
  for (const status of DOMAIN_STATUSES) {
    if (status === "active") continue;
    assert.equal(isDomainActive(status), false, status);
  }
});

test("settling statuses are exactly the ones worth polling", () => {
  const settling = DOMAIN_STATUSES.filter(isDomainSettling);
  assert.deepEqual(settling.sort(), [
    "pending",
    "provisioning",
    "removing",
    "ssl_pending",
    "verified",
    "verifying",
  ]);
  // A terminal state must never keep the UI polling forever.
  for (const terminal of ["active", "misconfigured", "ssl_failed", "disabled", "removed"] as const) {
    assert.equal(isDomainSettling(terminal), false, terminal);
  }
});

test("the declared vocabulary matches what the UI and database accept", () => {
  assert.deepEqual([...DOMAIN_TYPES], ["mavly_subdomain", "custom"]);
  assert.equal(DOMAIN_STATUSES.length, 12);
  assert.ok(DOMAIN_ERROR_CODES.includes("DOMAIN_SUBDOMAIN_TAKEN"));
  assert.ok(DOMAIN_ERROR_CODES.includes("DOMAIN_RATE_LIMITED"));
});

// ── configuration ───────────────────────────────────────────────────────────

test("domain management is off by default", () => {
  const config = readDomainConfig({} as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.equal(config.customDomainsEnabled, false);
  assert.equal(config.subdomainAliasesEnabled, false);
  assert.equal(config.provisioningEnabled, false);
  assert.equal(config.problem, "disabled");
});

test("enabling the parent flag alone does not enable a sub-capability", () => {
  const config = readDomainConfig({
    MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.customDomainsEnabled, false);
  assert.equal(config.subdomainAliasesEnabled, false);
  assert.equal(config.provisioningEnabled, false);
});

test("a sub-capability requires the parent flag", () => {
  const config = readDomainConfig({
    MAVLY_CUSTOM_DOMAINS_ENABLED: "true",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.equal(config.customDomainsEnabled, false);
});

test("a malformed routing target fails the whole feature closed", () => {
  const config = readDomainConfig({
    MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true",
    MAVLY_CUSTOM_DOMAINS_ENABLED: "true",
    MAVLY_CUSTOM_DOMAIN_ROUTING_TARGET: "https://edge.mavly.xyz/path",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.problem, "invalid_target");
  assert.equal(config.customDomainsEnabled, false);
});

test("an untrusted resolver host is refused", () => {
  const config = readDomainConfig({
    MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true",
    MAVLY_DOMAIN_DNS_RESOLVERS: "https://evil.example/dns-query",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.problem, "invalid_resolver");
  assert.deepEqual(config.resolvers, []);
});

test("a plain http resolver is refused", () => {
  const config = readDomainConfig({
    MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true",
    MAVLY_DOMAIN_DNS_RESOLVERS: "http://cloudflare-dns.com/dns-query",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.problem, "invalid_resolver");
});

test("a valid configuration reports no problem", () => {
  const config = readDomainConfig({
    MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true",
    MAVLY_CUSTOM_DOMAINS_ENABLED: "true",
    MAVLY_SUBDOMAIN_ALIASES_ENABLED: "true",
    MAVLY_DOMAIN_PROVISIONING_ENABLED: "true",
    MAVLY_CUSTOM_DOMAIN_ROUTING_TARGET: "edge.mavly.xyz",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.problem, null);
  assert.equal(config.customDomainsEnabled, true);
  assert.equal(config.subdomainAliasesEnabled, true);
  assert.equal(config.provisioningEnabled, true);
  assert.equal(config.routingTarget, "edge.mavly.xyz");
});

test("routing approval defaults to required and only an explicit false disables it", () => {
  const base = { MAVLY_DOMAIN_MANAGEMENT_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;
  assert.equal(readDomainConfig(base).requireRoutingApproval, true);
  assert.equal(
    readDomainConfig({ ...base, MAVLY_DOMAIN_ROUTING_REQUIRE_APPROVAL: "yes" } as unknown as NodeJS.ProcessEnv)
      .requireRoutingApproval,
    true,
  );
  assert.equal(
    readDomainConfig({ ...base, MAVLY_DOMAIN_ROUTING_REQUIRE_APPROVAL: "false" } as unknown as NodeJS.ProcessEnv)
      .requireRoutingApproval,
    false,
  );
});
