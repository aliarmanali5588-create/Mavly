import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ═══ MIGRATION 15 SEPARATES ATTEMPT STATE FROM LIVE STATE ═══════════════════
 *
 * Migration 14 made `project_deployments.status` both the latest attempt and the
 * public serving gate (`d.status = 'ready'`). Starting a republish writes
 * `queued`; a failed one writes `error`. Either made the live site 404.
 *
 * These are STATIC assertions over the new migration. Applying it and exercising
 * the RPCs against a real Supabase project remains a human-run check.
 */

const SQL = readFileSync(
  new URL("../supabase/migrations/15_shared_hosting_attempt_state.sql", import.meta.url),
  "utf8",
);

function functionBody(name: string): string {
  const start = SQL.indexOf(`function public.${name}`);
  assert.ok(start >= 0, `migration defines ${name}`);
  return SQL.slice(start, SQL.indexOf("$$;", start) + 3);
}

test("the install marker identifies migration 15 to the publish preflight", () => {
  assert.match(SQL, /create or replace function public\.shared_hosting_schema_version\(\)/);
  const body = functionBody("shared_hosting_schema_version");
  assert.match(body, /select 15/);
  assert.match(body, /security invoker/);
  assert.doesNotMatch(body, /security definer/);
  assert.match(SQL, /grant execute on function public\.shared_hosting_schema_version\(\) to authenticated/);
  assert.match(SQL, /revoke all on function public\.shared_hosting_schema_version\(\) from anon/);
});

test("the public resolver serves the active version, not the latest attempt", () => {
  const body = functionBody("resolve_published_tenant");

  // The defect: a `ready` gate on the attempt status.
  assert.doesNotMatch(body, /status\s*=\s*'ready'/);
  assert.doesNotMatch(body, /d\.status\s*=\s*'ready'/);

  // The live invariants that must remain.
  assert.match(body, /v\.status\s*=\s*'active'/);
  assert.match(body, /d\.active_version_id\s*=\s*v\.id/);
  assert.match(body, /d\.status\s*<>\s*'unpublished'/);
  assert.match(body, /d\.mavly_hostname\s*=\s*public\.mavly_tenant_hostname\(p_hostname\)/);
  // The address must also be derived from the version's own project id.
  assert.match(body, /d\.mavly_hostname\s*=\s*lower\(v\.project_id\)\s*\|\|\s*'\.mavly\.xyz'/);

  // Public read surface: definer with a fixed search_path, anon allowed.
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public, pg_temp/);
  assert.match(SQL, /grant execute on function public\.resolve_published_tenant\(text\) to anon, authenticated/);
});

test("activation is owner-only, atomic, and never stores verified", () => {
  const body = functionBody("activate_shared_publication");

  assert.match(body, /security invoker/);
  assert.match(body, /set search_path = public, pg_temp/);
  assert.match(body, /p\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(body, /v\.status in \('draft', 'active'\)/);
  assert.match(body, /set status = 'superseded'/);
  assert.match(body, /set status = 'active'/);
  assert.match(body, /active_version_id = p_version_id/);
  assert.match(body, /status = 'ready'/);
  assert.match(body, /mavly_domain_status = 'pending'/);
  // The successful publication, not the attempt, moves the timestamp.
  assert.match(body, /last_published_at = now\(\)/);

  // Verification is the post-commit probe's job.
  assert.doesNotMatch(body, /'verified'/);

  assert.match(SQL, /grant execute on function public\.activate_shared_publication\(text, uuid, text\) to authenticated/);
  assert.match(SQL, /revoke all on function public\.activate_shared_publication\(text, uuid, text\) from anon/);
});

test("activation refuses a hostname that is not this project's Mavly address", () => {
  const body = functionBody("activate_shared_publication");
  assert.match(body, /v_host <> v_project \|\| '\.mavly\.xyz'/);
  assert.match(body, /INVALID_HOSTNAME/);
});

test("the migration is additive: no table, row or version is destroyed", () => {
  assert.doesNotMatch(SQL, /drop\s+table/i);
  assert.doesNotMatch(SQL, /truncate/i);
  assert.doesNotMatch(SQL, /delete\s+from/i);
  assert.doesNotMatch(SQL, /drop\s+column/i);
  assert.doesNotMatch(SQL, /alter\s+table/i);
});

test("the migration keeps an explicit apply order after 14", () => {
  assert.match(SQL, /Apply AFTER 14_shared_hosting\.sql/i);
  assert.doesNotMatch(SQL, /create table/i);
});
