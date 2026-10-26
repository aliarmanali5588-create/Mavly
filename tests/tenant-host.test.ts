import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalTenantHostname, isNextInternalPath, parseTenantHost } from "../src/lib/tenant-host";
import { RESERVED_HOST_LABELS, isReservedLabel } from "../src/lib/reserved-hostnames";
import { MAVLY_PUBLIC_DOMAIN } from "../src/lib/mavly-hostname";

/**
 * ═══ THE HOST IS THE TENANT IDENTITY ════════════════════════════════════════
 *
 * `parseTenantHost` is the only function allowed to decide "which site is
 * this?" for public traffic. Every case below is a way a request could try to
 * look like a tenant when it is not one.
 */

test("a valid tenant host resolves to one canonical hostname", () => {
  assert.equal(MAVLY_PUBLIC_DOMAIN, "mavly.xyz");
  assert.deepEqual(parseTenantHost("meri-ek-car-ki.mavly.xyz"), {
    hostname: "meri-ek-car-ki.mavly.xyz",
    label: "meri-ek-car-ki",
  });
});

test("case, a single trailing dot and a plain port are normalised", () => {
  assert.equal(canonicalTenantHostname("MERI-EK-CAR-KI.MAVLY.XYZ"), "meri-ek-car-ki.mavly.xyz");
  assert.equal(canonicalTenantHostname("meri-ek-car-ki.mavly.xyz."), "meri-ek-car-ki.mavly.xyz");
  assert.equal(canonicalTenantHostname("meri-ek-car-ki.mavly.xyz:443"), "meri-ek-car-ki.mavly.xyz");
  assert.equal(canonicalTenantHostname("meri-ek-car-ki.mavly.xyz:3000"), "meri-ek-car-ki.mavly.xyz");
});

test("an unexpected domain is never a tenant", () => {
  for (const host of [
    "mavly.xyz",
    "www.mavly.xyz",
    "mavly.xyz.evil.com",
    "meri-ek-car-ki.mavly.xyz.evil.com",
    "meri-ek-car-ki.example.com",
    "meri-ek-car-ki.mavly.xy",
    "meri-ek-car-ki.notmavly.xyz",
    "localhost:3000",
    "127.0.0.1",
    "",
  ]) {
    assert.equal(parseTenantHost(host), null, host);
  }
});

test("only ONE label beneath the base domain is a tenant", () => {
  assert.equal(parseTenantHost("a.b.mavly.xyz"), null);
  assert.equal(parseTenantHost("meri-ek-car-ki.eu.mavly.xyz"), null);
  assert.equal(parseTenantHost(".mavly.xyz"), null);
  assert.equal(parseTenantHost("meri-ek-car-ki..mavly.xyz"), null);
});

test("malformed authorities are refused rather than normalised", () => {
  for (const host of [
    "meri ek.mavly.xyz",
    "meri_ek.mavly.xyz",
    "-meri.mavly.xyz",
    "meri-.mavly.xyz",
    "meri--ek.mavly.xyz",
    "meri/ek.mavly.xyz",
    "meri\\ek.mavly.xyz",
    "meri@ek.mavly.xyz",
    "*.mavly.xyz",
    "meri?.mavly.xyz",
    "meri#ek.mavly.xyz",
    "meri:ek.mavly.xyz",
    "meri:notaport.mavly.xyz",
    "meri:99999.mavly.xyz",
    "[::1]",
    "meri.mavly.xyz..",
  ]) {
    assert.equal(parseTenantHost(host), null, host);
  }
});

test("an overlong label is refused", () => {
  const label = `a${"b".repeat(63)}`;
  assert.equal(parseTenantHost(`${label}.mavly.xyz`), null);
  // Exactly 63 characters is the DNS limit and stays valid.
  const max = `a${"b".repeat(62)}`;
  assert.equal(parseTenantHost(`${max}.mavly.xyz`)?.label.length, 63);
});

test("internationalised (punycode) tenants are unsupported", () => {
  assert.equal(parseTenantHost("xn--bcher-kva.mavly.xyz"), null);
  assert.equal(parseTenantHost("bücher.mavly.xyz"), null);
});

test("every reserved label is refused, case-insensitively", () => {
  for (const label of RESERVED_HOST_LABELS) {
    assert.equal(parseTenantHost(`${label}.mavly.xyz`), null, label);
    assert.equal(parseTenantHost(`${label.toUpperCase()}.mavly.xyz`), null, label);
    assert.equal(isReservedLabel(label), true, label);
  }
  assert.equal(isReservedLabel("meri-ek-car-ki"), false);
});

test("a null or non-string host is refused", () => {
  assert.equal(parseTenantHost(null), null);
  assert.equal(parseTenantHost(undefined), null);
  // @ts-expect-error deliberately wrong type: the parser must not coerce it.
  assert.equal(parseTenantHost(42), null);
});

test("Next build paths are passed through, not treated as tenant content", () => {
  assert.equal(isNextInternalPath("/_next"), true);
  assert.equal(isNextInternalPath("/_next/static/chunk.js"), true);
  assert.equal(isNextInternalPath("/_nextish"), false);
  assert.equal(isNextInternalPath("/"), false);
});
