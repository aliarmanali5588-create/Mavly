import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/17_verification_sandbox.sql", import.meta.url),
  "utf8",
);

/**
 * Static invariants for migration 17. These are text assertions, not a database
 * test: they catch removed fencing, grants, preflights or cleanup state without
 * pretending the migration was applied anywhere.
 */

test("verification state is one additive table with no destructive statement", () => {
  assert.match(sql, /create table if not exists public\.project_verifications/);
  assert.equal(/drop table/i.test(sql), false);
  assert.equal(/delete from/i.test(sql), false);
  assert.equal(/truncate/i.test(sql), false);
  assert.equal(/alter table public\.project_runs/i.test(sql), false);
  assert.equal(/alter table public\.project_snapshots/i.test(sql), false);
});

test("one verification per run is enforced by a unique index", () => {
  assert.match(
    sql,
    /create unique index if not exists project_verifications_run_uidx\s+on public\.project_verifications \(run_id\)/,
  );
  assert.match(sql, /on conflict \(run_id\) do nothing/);
});

test("the status vocabulary, attempts and bounds are constrained in the schema", () => {
  assert.match(sql, /check \(status in \([\s\S]*?'queued'[\s\S]*?'unsupported_runtime'[\s\S]*?'infrastructure_error'/);
  assert.match(sql, /constraint project_verifications_attempt_check/);
  assert.match(sql, /constraint project_verifications_source_hash_check/);
  assert.match(sql, /constraint project_verifications_sandbox_id_check/);
  assert.match(sql, /jsonb_array_length\(diagnostics\) <= 80/);
  assert.match(sql, /constraint project_verifications_cleanup_attempts_check/);
});

test("users may read only their own rows and may not write worker state", () => {
  assert.match(sql, /alter table public\.project_verifications enable row level security/);
  assert.match(sql, /create policy "project_verifications_select_own"/);
  assert.match(sql, /using \(exists \([\s\S]*?from public\.projects p[\s\S]*?p\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /revoke all on public\.project_verifications from anon, authenticated/);

  const grant = sql.match(/grant select \(([\s\S]*?)\) on public\.project_verifications to authenticated/);
  assert.notEqual(grant, null);
  const granted = grant![1];
  for (const forbidden of [
    "user_id",
    "sandbox_id",
    "worker_id",
    "lease_token",
    "lease_expires_at",
    "cleanup_attempts",
  ]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(granted),
      false,
      `authenticated may read ${forbidden}`,
    );
  }
  assert.match(granted, /diagnostics/);
  assert.match(granted, /cleanup_complete/);
  assert.match(sql, /grant all on public\.project_verifications to service_role/);
});

test("the schema marker reports 17 and gates the publish preflight", () => {
  assert.match(
    sql,
    /create or replace function public\.verification_schema_version\(\)[\s\S]*?select 17;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.verification_schema_version\(\) to authenticated, service_role/,
  );
});

test("enqueue is service-role only, idempotent and tied to a completed run and snapshot", () => {
  assert.match(sql, /create or replace function public\.enqueue_verification\(/);
  assert.match(sql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(sql, /v_run\.stage <> 'completed' or v_run\.finished_at is null/);
  assert.match(sql, /s\.project_id = p_project_id/);
  assert.match(sql, /s\.run_id = p_run_id/);
  assert.match(sql, /s\.status = 'ready'/);
  assert.match(sql, /v_snapshot\.source_hash <> p_source_hash/);
  assert.match(sql, /'status', 'rate_limited'/);
  assert.match(
    sql,
    /grant execute on function public\.enqueue_verification\(text, uuid, uuid, text, text, text\) to service_role/,
  );
});

test("claim is one SKIP LOCKED, service-role-only, fenced operation", () => {
  assert.match(sql, /create or replace function public\.claim_verification\(/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /v\.status = 'queued' and v\.attempt < v\.max_attempts/);
  assert.match(sql, /v\.sandbox_id is not null/);
  assert.match(sql, /lease_token = gen_random_uuid\(\)/);
  assert.match(sql, /deadline_at = coalesce\(v\.deadline_at, now\(\) \+ c_deadline\)/);
  assert.match(
    sql,
    /grant execute on function public\.claim_verification\(text, integer, text\[\]\) to service_role/,
  );
});

test("stage, renewal and release writes are fenced by the lease token", () => {
  for (const fn of ["note_verification_stage", "renew_verification_lease", "release_verification"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`), fn);
  }
  const fenced = sql.match(/v\.lease_token = p_lease_token/g) ?? [];
  assert.equal(fenced.length >= 3, true);
});

test("completion is idempotent and cleanup never overrides the build outcome", () => {
  assert.match(sql, /create or replace function public\.complete_verification\(/);
  assert.match(sql, /if v_row\.finished_at is not null then[\s\S]*?'already_terminal'/);
  assert.match(sql, /v_row\.lease_token is null or v_row\.lease_token <> p_lease_token/);
  assert.match(
    sql,
    /cleanup_complete = \(v\.sandbox_id is null\) or coalesce\(p_cleanup_complete, false\)/,
  );
  assert.match(sql, /p_status is null or p_status not in \(/);
});

test("recovery expires deadlines, releases live sandboxes and never starts a second one", () => {
  assert.match(sql, /create or replace function public\.recover_expired_verification_leases\(/);
  assert.match(sql, /v_row\.deadline_at < now\(\)/);
  assert.match(sql, /status = 'timed_out'/);
  assert.match(sql, /lease_token = null/);
  assert.match(sql, /v_outcome := 'released'/);
  assert.match(sql, /v_row\.attempt < v_row\.max_attempts and v_row\.sandbox_id is null/);
  assert.match(sql, /status = 'infrastructure_error'/);
  assert.equal(sql.includes("delete from public.project_verifications"), false);
});

test("orphan cleanup is durable, bounded, service-role only and outcome-preserving", () => {
  assert.match(sql, /create or replace function public\.claim_verification_cleanup\(/);
  assert.match(sql, /c_max_attempts constant integer := 5/);
  assert.match(sql, /and v\.cleanup_attempts < c_max_attempts/);
  assert.match(sql, /create or replace function public\.mark_verification_cleanup\(/);
  assert.match(sql, /set cleanup_complete = coalesce\(p_confirmed, false\)/);
  assert.equal(/delete from public\.project_verifications/i.test(sql), false);
});

test("cancellation verifies ownership and retains the sandbox reference", () => {
  assert.match(sql, /create or replace function public\.cancel_verification\(/);
  assert.match(sql, /v_uid uuid := auth\.uid\(\)/);
  assert.match(sql, /p\.project_id = p_project_id and p\.user_id = v_uid/);
  assert.match(sql, /status = 'cancelled'/);
  assert.match(sql, /cleanup_complete = \(v\.sandbox_id is null\)/);
  assert.match(
    sql,
    /grant execute on function public\.cancel_verification\(text, uuid\) to authenticated, service_role/,
  );
});

test("every failure-state helper returns lost rather than claiming success", () => {
  assert.equal(sql.includes("return jsonb_build_object('status', 'lost');"), true);
  assert.equal(sql.includes("return jsonb_build_object('status', 'empty');"), true);
});
