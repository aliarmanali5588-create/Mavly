import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * ═══ MIGRATION 62 — STATIC CONTRACT ═════════════════════════════════════════
 *
 * The migration cannot be executed here (this repository has no local Supabase
 * harness), so these are static invariants over the SQL text. They pin the
 * properties that would be a security or correctness defect if a later edit
 * removed them: the authority split, the uniqueness guarantees, the owner-only
 * read surface, and the fact that the canonical hostname is never a row.
 */

const SQL = readFileSync(
  new URL("../supabase/migrations/62_domain_management.sql", import.meta.url),
  "utf8",
);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("the migration is additive and never destroys existing data", () => {
  const destructive = [
    /\bdrop\s+table\b/i,
    /\btruncate\b/i,
    /\bdrop\s+schema\b/i,
    /\bdelete\s+from\s+public\.project_deployments\b/i,
    /\bdelete\s+from\s+public\.project_published_versions\b/i,
    /\bdelete\s+from\s+public\.projects\b/i,
    /\balter\s+table\s+public\.project_deployments\s+drop\b/i,
    /\balter\s+table\s+public\.projects\s+drop\b/i,
  ];
  for (const pattern of destructive) {
    assert.equal(pattern.test(SQL), false, `migration must not match ${pattern}`);
  }
  /**
   * The only permitted `drop`s are idempotency guards on objects this migration
   * itself creates or redefines: a function signature it replaces, a policy it
   * is about to recreate, and a trigger it re-attaches. None of them removes
   * data, and none targets an object owned by another migration.
   */
  const drops = SQL.match(/\bdrop\s+(?:function|policy|trigger)\s+[^;]*/gi) ?? [];
  assert.ok(drops.length > 0, "the idempotency guards are present");
  for (const statement of drops) {
    assert.match(
      statement,
      /^drop\s+(?:function if exists public\.|policy if exists project_domain|trigger if exists project_domain)/i,
      `unexpected destructive statement: ${statement}`,
    );
  }
});

test("the migration is wrapped in a single transaction", () => {
  assert.match(SQL.trim(), /^--/);
  assert.ok(/\nbegin;/.test(SQL), "opens a transaction");
  assert.ok(/\ncommit;/.test(SQL), "commits the transaction");
  assert.equal(countOccurrences(SQL, "\nbegin;"), 1);
  assert.equal(countOccurrences(SQL, "\ncommit;"), 1);
  // Nothing may appear after the commit: a trailing statement would run outside
  // the transaction that the prerequisite guard protects.
  assert.equal(SQL.slice(SQL.indexOf("\ncommit;") + "\ncommit;".length).trim(), "");
});

test("every prerequisite is checked before anything is created", () => {
  const guard = SQL.indexOf("DOMAIN_PREREQUISITE_MISSING");
  const firstCreate = SQL.indexOf("create table");
  assert.ok(guard > 0, "the prerequisite guard exists");
  assert.ok(guard < firstCreate, "the guard runs before the first table is created");
  for (const dependency of [
    "public.projects",
    "public.project_deployments",
    "public.project_published_versions",
    "public.subscriptions",
    "public.aws_frontend_fencing_schema_version()",
    "public.current_user_is_admin()",
    "public.admin_audit_log",
  ]) {
    assert.ok(SQL.includes(dependency), `checks ${dependency}`);
  }
});

test("the guard names only what this migration actually reads", () => {
  /**
   * ⚠️ A PREREQUISITE THAT IS NEVER USED IS A BUG, NOT CAUTION. This migration
   * once refused to install without `billing_user_entitlements()` and
   * `aws_hosting_eligibility()`, neither of which any function here calls. The
   * result was a valid deployment being told to apply a migration it did not
   * need. Every guarded object must be referenced by the body.
   */
  const guard = SQL.slice(SQL.indexOf("do $$"), SQL.indexOf("create or replace function public.domain_management_schema_version"));
  const body = SQL.slice(SQL.indexOf("create table if not exists public.domain_plan_limits"));

  // The billing function answers project/published-site ceilings, not domain
  // allowances: `domain_entitlements_for_user` reads `subscriptions` directly.
  assert.equal(
    body.includes("billing_user_entitlements"),
    false,
    "the domain entitlement path must not depend on the billing ceiling function",
  );
  assert.equal(
    body.includes("aws_hosting_eligibility"),
    false,
    "no domain function calls the AWS eligibility function",
  );
  // Assert on the guard *call*, not the bare name: the explanatory comment above
  // the subscriptions check deliberately names both functions.
  assert.equal(guard.includes("to_regprocedure('public.billing_user_entitlements()')"), false);
  assert.equal(guard.includes("to_regprocedure('public.aws_hosting_eligibility(text)')"), false);

  // The one real dependency is guarded, and by table rather than by function.
  assert.ok(guard.includes("to_regclass('public.subscriptions')"));
  assert.ok(body.includes("from public.subscriptions"));
});

test("the schema-version function is checked before it is executed", () => {
  /**
   * `execute 'select public.aws_frontend_fencing_schema_version()'` raises an
   * undefined-function error when migration 56 is absent. The existence check
   * must therefore come first, or the operator gets a stack trace instead of the
   * sentence naming the file to apply.
   */
  const guard = SQL.slice(SQL.indexOf("do $$"), SQL.indexOf("create or replace function public.domain_management_schema_version"));
  const checkAt = guard.indexOf("to_regprocedure('public.aws_frontend_fencing_schema_version()')");
  const executeAt = guard.indexOf("execute 'select public.aws_frontend_fencing_schema_version()'");
  assert.ok(checkAt > 0, "the existence check is present");
  assert.ok(executeAt > 0, "the version read is present");
  assert.ok(checkAt < executeAt, "existence is checked before the function is called");
});

test("the schema marker is 62 and is not executable by anon", () => {
  assert.match(SQL, /domain_management_schema_version[\s\S]{0,300}select 62/);
  assert.match(
    SQL,
    /revoke all on function public\.domain_management_schema_version\(\) from public, anon/,
  );
});

test("hostname uniqueness is enforced for every live row", () => {
  assert.match(
    SQL,
    /create unique index if not exists project_domains_hostname_live_key[\s\S]{0,120}where status <> 'removed'/,
    "a removed row may release its hostname, a live row may not duplicate one",
  );
});

test("at most one primary domain exists per project", () => {
  assert.match(
    SQL,
    /create unique index if not exists project_domains_one_primary_idx[\s\S]{0,120}where is_primary/,
  );
});

test("the canonical project hostname is never stored as a row", () => {
  // The table comment and the custom-domain constraint both encode this.
  assert.match(SQL, /The canonical <project-id>\.mavly\.xyz hostname stays derived/);
  assert.match(
    SQL,
    /constraint project_domains_custom_not_mavly_check check \(\s*domain_type <> 'custom' or hostname not like '%\.mavly\.xyz'/,
    "a custom domain can never be a Mavly hostname",
  );
});

test("stored hostnames must be lowercase, shaped and not an IP", () => {
  assert.match(SQL, /constraint project_domains_hostname_lower_check check \(hostname = lower\(hostname\)\)/);
  assert.match(SQL, /constraint project_domains_hostname_shape_check/);
  assert.match(SQL, /constraint project_domains_hostname_not_ip_check/);
  assert.match(SQL, /constraint project_domains_hostname_length_check/);
});

test("every status column is constrained to the declared vocabulary", () => {
  for (const constraint of [
    "project_domains_type_check",
    "project_domains_status_check",
    "project_domains_dns_check",
    "project_domains_ssl_check",
    "project_domains_publication_check",
    "project_domains_routing_provider_check",
  ]) {
    assert.ok(SQL.includes(constraint), `missing ${constraint}`);
  }
});

test("the verification token hash is shape-checked and never a select grant", () => {
  assert.match(SQL, /constraint project_domains_token_hash_shape check/);
  const grantBlock = SQL.slice(SQL.indexOf("grant select ("), SQL.indexOf(") on public.project_domains to authenticated"));
  assert.equal(
    grantBlock.includes("verification_token_hash"),
    false,
    "the token hash is never a table-select column",
  );
  assert.equal(
    grantBlock.includes("verification_token"),
    false,
    "the raw token is only returned by the owner-checked RPC",
  );
});

test("row level security is enabled on both owner-readable tables", () => {
  assert.match(SQL, /alter table public\.project_domains enable row level security/);
  assert.match(SQL, /alter table public\.project_domain_events enable row level security/);
  assert.match(SQL, /create policy project_domains_owner_read on public\.project_domains/);
  assert.match(SQL, /create policy project_domain_events_owner_read on public\.project_domain_events/);
  // The policy must be scoped to the caller's own projects, not merely to a role.
  assert.match(SQL, /p\.user_id = \(select auth\.uid\(\)\)/);
});

test("the job queue is service-role only", () => {
  assert.match(SQL, /revoke all on public\.project_domain_jobs from public, anon, authenticated/);
  assert.match(SQL, /grant all on public\.project_domain_jobs to service_role/);
});

test("every worker RPC refuses a non-service-role caller", () => {
  for (const fn of ["claim_domain_job", "complete_domain_job", "fail_domain_job"]) {
    const start = SQL.indexOf(`create or replace function public.${fn}`);
    assert.ok(start > 0, `${fn} exists`);
    const body = SQL.slice(start, start + 2500);
    assert.match(
      body,
      /auth\.role\(\) is distinct from 'service_role'/,
      `${fn} must reject a non-service-role caller`,
    );
  }
});

test("worker terminal writes are fenced by the job lease token", () => {
  for (const fn of ["complete_domain_job", "fail_domain_job"]) {
    const start = SQL.indexOf(`create or replace function public.${fn}`);
    const body = SQL.slice(start, start + 3000);
    assert.match(body, /v_job\.lease_token is distinct from p_lease_token/, `${fn} is lease-fenced`);
    assert.match(body, /DOMAIN_LEASE_LOST/, `${fn} reports a lost lease`);
  }
});

test("the active-domain ceiling is re-checked inside the terminal transaction", () => {
  const start = SQL.indexOf("create or replace function public.complete_domain_job");
  const body = SQL.slice(start, start + 6000);
  assert.match(body, /DOMAIN_ACTIVE_LIMIT_REACHED/);
  assert.match(body, /maxActiveDomains/);
});

test("owner write RPCs verify project ownership rather than trusting an id", () => {
  for (const fn of [
    "list_project_domains",
    "get_project_domain",
    "reserve_mavly_subdomain",
    "add_custom_domain",
    "enqueue_domain_action",
    "set_primary_domain",
  ]) {
    const start = SQL.indexOf(`create or replace function public.${fn}`);
    assert.ok(start > 0, `${fn} exists`);
    const body = SQL.slice(start, start + 4000);
    assert.match(body, /DOMAIN_OWNERSHIP_MISMATCH|DOMAIN_PROJECT_NOT_FOUND/, `${fn} checks ownership`);
  }
});

test("the public resolver only serves a fully active row", () => {
  const start = SQL.indexOf("create or replace function public.resolve_public_domain");
  const body = SQL.slice(start, start + 2500);
  for (const condition of [
    "status = 'active'",
    "publication_status = 'active'",
    "dns_status = 'ready'",
    "ssl_status = 'active'",
  ]) {
    assert.ok(body.includes(condition), `resolver requires ${condition}`);
  }
});

test("the public file read repeats the same active gate", () => {
  const start = SQL.indexOf("create or replace function public.read_public_domain_file");
  assert.ok(start > 0, "the domain file read exists");
  const body = SQL.slice(start, start + 1600);
  assert.match(body, /public\.resolve_public_domain\(p_hostname\)/, "re-resolves the hostname");
  assert.match(body, /strpos\(p_path, '\.\.'\) = 0/, "refuses path traversal");
  assert.match(body, /left\(p_path, 1\) <> '\/'/, "refuses an absolute path");
  assert.match(body, /f\.version_id = p_version_id/, "pins the version");
});

test("admin functions require the real admin check and write an audit row", () => {
  const overview = SQL.slice(
    SQL.indexOf("create or replace function public.admin_domain_overview"),
    SQL.indexOf("create or replace function public.admin_approve_domain_routing"),
  );
  assert.match(overview, /if not public\.current_user_is_admin\(\) then/);

  const approveStart = SQL.indexOf("create or replace function public.admin_approve_domain_routing");
  const approve = SQL.slice(approveStart, approveStart + 4000);
  assert.match(approve, /if not public\.current_user_is_admin\(\) then/);
  assert.match(approve, /insert into public\.admin_audit_log/);
  assert.match(approve, /'domain\.routing_approval'/);
});

test("the admin overview is not executable by anon", () => {
  assert.match(
    SQL,
    /revoke all on function public\.admin_domain_overview\(integer, integer, text, text\) from public, anon/,
  );
});

test("plan limits are database-driven and restrictive by default", () => {
  const start = SQL.indexOf("create table if not exists public.domain_plan_limits");
  const body = SQL.slice(start, start + 1200);
  assert.match(body, /max_custom_domains integer not null default 0/);
  assert.match(body, /max_subdomain_aliases integer not null default 0/);
  assert.match(body, /max_active_domains integer not null default 0/);
  assert.match(
    SQL,
    /grant select, insert, update, delete on public\.domain_plan_limits to service_role/,
    "only an operator can change a plan allowance",
  );
});

test("rate limiting is a database function, not a client-side counter", () => {
  assert.match(SQL, /create or replace function public\.consume_domain_rate_limit\(p_action text\)/);
  assert.match(SQL, /create table if not exists public\.domain_rate_windows/);
  assert.match(SQL, /grant execute on function public\.consume_domain_rate_limit\(text\) to authenticated/);
});

test("reserved labels are protected by a database function", () => {
  assert.match(SQL, /create or replace function public\.domain_label_reserved\(text\)/);
  assert.match(SQL, /grant execute on function public\.domain_label_reserved\(text\) to authenticated, service_role/);
});

test("the enqueue RPC refuses a duplicate in-flight job", () => {
  const start = SQL.indexOf("create or replace function public.enqueue_domain_action");
  const body = SQL.slice(start, start + 3000);
  assert.match(body, /DOMAIN_JOB_IN_PROGRESS/);
});

test("a removed row cannot be re-verified or re-provisioned", () => {
  const start = SQL.indexOf("create or replace function public.enqueue_domain_action");
  const body = SQL.slice(start, start + 3000);
  assert.match(body, /DOMAIN_REMOVED/);
});

test("the migration never touches production DNS, CloudFront or certificates", () => {
  /**
   * The migration may NAME a provider in a constraint (`routing_provider in
   * ('none','aws_cloudfront',…)`), but it must not issue an infrastructure
   * mutation. Anything that would change a live distribution, DNS zone or
   * certificate is an operator action, never a migration.
   */
  for (const forbidden of [
    /create\s+distribution/i,
    /change\s+resource\s+record\s+sets/i,
    /request\s+certificate/i,
    /update\s+public\.hosting_platform_settings/i,
    /delete\s+from\s+public\.project_deployments/i,
    /update\s+public\.project_deployments\s+set\s+provider/i,
  ]) {
    assert.equal(forbidden.test(SQL), false, `migration must not match ${forbidden}`);
  }
});
