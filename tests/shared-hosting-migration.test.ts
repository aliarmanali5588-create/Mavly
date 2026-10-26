import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RESERVED_HOST_LABELS } from "../src/lib/reserved-hostnames";

/**
 * ═══ THE PUBLIC SURFACE MUST STAY SMALL ═════════════════════════════════════
 *
 * Migration 14 is the only place the tenant runtime can read data. These tests
 * pin the properties that make that safe:
 *
 *   · the published tables have RLS and NO anon privileges;
 *   · the two public functions are SECURITY DEFINER with a fixed search_path;
 *   · execution is granted to `anon` only for those functions;
 *   · the reserved-label list matches the application's list.
 *
 * ⚠️ THESE ARE STATIC ASSERTIONS, NOT A DATABASE TEST. Applying the migration and
 * exercising the RPCs against a real Supabase project is a human-run check
 * (documented in MAVLY_SHARED_HOSTING.md).
 */

const SQL = readFileSync(
  new URL("../supabase/migrations/14_shared_hosting.sql", import.meta.url),
  "utf8",
);

test("the published tables exist and are owner-scoped with RLS", () => {
  assert.match(SQL, /create table if not exists public\.project_published_versions/);
  assert.match(SQL, /create table if not exists public\.project_published_files/);
  assert.match(
    SQL,
    /alter table public\.project_published_versions enable row level security/,
  );
  assert.match(
    SQL,
    /alter table public\.project_published_files enable row level security/,
  );
  assert.match(SQL, /create policy "project_published_versions_select_own"/);
  assert.match(SQL, /create policy "project_published_files_insert_own"/);
});

test("anon has no table privilege on published artifacts", () => {
  assert.match(SQL, /revoke all on public\.project_published_versions from anon/);
  assert.match(SQL, /revoke all on public\.project_published_files from anon/);
  assert.doesNotMatch(
    SQL,
    /grant\s+(?:select|insert|update|delete)[^;]*on public\.project_published_[a-z_]+\s+to\s+anon/i,
  );
  // Logged-in owners keep normal access (RLS still restricts rows).
  assert.match(
    SQL,
    /grant select, insert, delete on public\.project_published_files to authenticated/,
  );
});

test("the public lookup is SECURITY DEFINER with a fixed search_path", () => {
  assert.match(SQL, /function public\.resolve_published_tenant\(p_hostname text\)/);
  assert.match(SQL, /function public\.read_published_file\(/);
  assert.equal((SQL.match(/security definer/g) ?? []).length, 2);
  assert.equal(
    (SQL.match(/set search_path = public, pg_temp/g) ?? []).length >= 4,
    true,
  );
  assert.match(
    SQL,
    /revoke all on function public\.resolve_published_tenant\(text\) from public/,
  );
  assert.match(
    SQL,
    /grant execute on function public\.resolve_published_tenant\(text\) to anon, authenticated/,
  );
  assert.match(
    SQL,
    /grant execute on function public\.read_published_file\(text, uuid, text\) to anon, authenticated/,
  );
  assert.doesNotMatch(SQL, /grant[^;]*to\s+service_role/i);
  assert.doesNotMatch(SQL, /grant[^;]*on public\.project_published[a-z_]*[^;]*to\s+anon/i);
});

test("the resolver can only return a READY, ACTIVE, verified mapping", () => {
  assert.match(SQL, /v\.status = 'active'/);
  assert.match(SQL, /d\.status = 'ready'/);
  assert.match(SQL, /d\.active_version_id = v\.id/);
  assert.match(SQL, /d\.mavly_hostname = public\.mavly_tenant_hostname\(p_hostname\)/);
  // The file read is pinned to the resolved ACTIVE version, not a caller id.
  assert.match(SQL, /join tenant t on t\.version_id = f\.version_id/);
  assert.match(SQL, /and f\.version_id = p_version_id/);
});

test("at most one active version per project is enforced", () => {
  assert.match(SQL, /create unique index if not exists project_published_versions_active_key/);
  assert.match(SQL, /where status = 'active'/);
  assert.match(SQL, /function public\.activate_published_version/);
  assert.match(SQL, /function public\.deactivate_published_version/);
});

test("the hosting provider check now includes shared", () => {
  assert.match(SQL, /check \(provider in \('vercel', 'shared'\)\)/);
  assert.match(SQL, /add column if not exists active_version_id uuid/);
});

test("the reserved-label constraint is additive and does not validate old rows", () => {
  assert.match(SQL, /project_deployments_mavly_hostname_reserved_check/);
  assert.match(SQL, /\) not valid;/);
});

test("every reserved application label is present in the SQL list", () => {
  for (const label of RESERVED_HOST_LABELS) {
    assert.equal(
      SQL.includes(`'${label}'`),
      true,
      `reserved label missing from migration 14: ${label}`,
    );
  }
});

test("the SQL hostname helper rejects ports, deeper names and punycode", () => {
  assert.match(SQL, /strpos\(p_hostname, ':'\) > 0 then null/);
  assert.match(SQL, /host = split_part\(host, '\.', 1\) \|\| '\.mavly\.xyz'/);
  assert.match(SQL, /label not like 'xn--%'/);
  assert.match(SQL, /label not like '%--%'/);
});
