import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Static contracts for the Vercel domain-publishing path.
 *
 * These assertions read source files; they never call Vercel, Supabase or a
 * database, and they do not prove runtime behaviour. They exist so the
 * invariants the product depends on cannot be deleted silently.
 */

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const MIGRATION = read("supabase/migrations/64_vercel_domain_publishing.sql");
const DNS_RECORDS = read("src/lib/domains/dns-records.ts");
const DNS_SERVICE = read("src/lib/domains/dns-service.ts");
const DEPLOYMENTS = read("src/lib/deployments/service.ts");
const API = read("src/lib/mavly/api.ts");
const CLIENT = read("src/lib/vcaas.ts");

test("migration 64 is additive and versioned", () => {
  assert.match(MIGRATION, /vercel_domain_publishing_schema_version/);
  assert.match(MIGRATION, /select 64/);
  assert.match(MIGRATION, /create or replace function public\.activate_vercel_publication/);
  assert.doesNotMatch(MIGRATION, /drop table/i);
  assert.doesNotMatch(MIGRATION, /drop column/i);
  assert.doesNotMatch(MIGRATION, /truncate/i);
});

test("activation is owner-checked and refuses a non-Vercel row", () => {
  assert.match(MIGRATION, /v_project\.user_id <> v_uid/);
  assert.match(MIGRATION, /coalesce\(v_deployment\.provider, 'vercel'\) <> 'vercel'/);
  assert.match(MIGRATION, /grant execute on function public\.activate_vercel_publication\(text, uuid\) to authenticated/);
  assert.doesNotMatch(MIGRATION, /grant execute on function public\.activate_vercel_publication[^;]+anon/);
});

test("routing provider is derived from the deployment, not hardcoded", () => {
  assert.match(MIGRATION, /when 'vercel' then 'vercel'/);
  assert.match(MIGRATION, /new\.routing_provider in \('none', 'aws_cloudfront', 'shared', 'vercel'\)/);
  assert.match(MIGRATION, /d\.routing_provider <> 'manual'/);
});

test("DNS records come from the provider response, never a constant target", () => {
  assert.match(DNS_RECORDS, /entry\.value/);
  assert.match(DNS_RECORDS, /entry\.domain/);
  assert.doesNotMatch(DNS_RECORDS, /cname\.vercel-dns\.com/);
  assert.doesNotMatch(DNS_RECORDS, /76\.76\.21\.21/);
  assert.match(DNS_RECORDS, /Vercel has not returned DNS requirements/);
});

test("the DNS lookup is owner-scoped and never trusts a client target", () => {
  assert.match(DNS_SERVICE, /getProjectDomain\(projectId, domainId\)/);
  assert.match(DNS_SERVICE, /readOwnerDeploymentTarget\(projectId\)/);
  assert.match(DNS_SERVICE, /getVercelProjectDomain\(/);
  assert.doesNotMatch(DNS_SERVICE, /from\(body\)/);
  assert.doesNotMatch(DNS_SERVICE, /vercelProjectTarget\\?/);
});

test("the DNS route and client method exist", () => {
  assert.match(API, /rest\[1\] === "dns"/);
  assert.match(API, /getDomainDnsRecords\(projectId, domainId\)/);
  assert.match(CLIENT, /dnsRecords:/);
  assert.match(CLIENT, /domains\/\$\{encodeURIComponent\(domainId\)\}\/dns/);
});

test("a ready Vercel publish records and activates a published version", () => {
  assert.match(DEPLOYMENTS, /activateVercelPublication/);
  assert.match(DEPLOYMENTS, /createPublishedVersion\(/);
  assert.match(DEPLOYMENTS, /if \(updated\.data\.status === "ready"\)/);
});
