import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/19_runtime_verification.sql", import.meta.url),
  "utf8",
);
const tick = readFileSync(
  new URL("../src/lib/sandbox/verification.ts", import.meta.url),
  "utf8",
);

/**
 * Static invariants for migration 19 and the tick that uses it. These are text
 * assertions, not a database or provider test: they catch removed fencing,
 * weakened passing rules, a public preview URL or an unbounded repair without
 * pretending any migration or sandbox was run.
 */

test("migration 19 is additive and contains no destructive statement", () => {
  assert.match(sql, /^-- ═+/m);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.equal(/drop table/i.test(sql), false);
  assert.equal(/delete from/i.test(sql), false);
  assert.equal(/truncate/i.test(sql), false);
  assert.equal(/alter table public\.project_runs/i.test(sql), false);
  assert.equal(/drop table public\.project_verifications/i.test(sql), false);
  assert.equal(/drop table public\.project_snapshots/i.test(sql), false);
});

test("the Phase 4 status vocabulary is constrained in the schema", () => {
  assert.match(sql, /add constraint project_verifications_status_check check \(status in \([\s\S]*?'runtime_starting'[\s\S]*?'health_checking'[\s\S]*?'repairing'/);
  assert.match(sql, /constraint project_verifications_runtime_profile_check[\s\S]*?'next-app-router'/);
  assert.match(sql, /constraint project_verifications_runtime_port_check[\s\S]*?between 1024 and 65535/);
  assert.match(sql, /constraint project_verifications_runtime_exit_check[\s\S]*?between -1 and 255/);
  assert.match(sql, /constraint project_verifications_health_http_check[\s\S]*?between 100 and 599/);
  assert.match(sql, /constraint project_verifications_effective_source_hash_check[\s\S]*?\[a-f0-9\]\{64\}/);
});

test("preview is a status with no URL column and no ready state", () => {
  assert.match(sql, /add column if not exists preview_status text not null default 'unavailable'/);
  assert.match(sql, /add column if not exists preview_reason text/);
  assert.match(sql, /preview_status in \('unavailable', 'disabled'\)/);
  assert.equal(/preview_url|preview_domain|preview_token|signed_url/i.test(sql), false);
  assert.match(sql, /No provider URL is ever stored/);
});

test("build, runtime and health are separate recorded facts", () => {
  for (const column of [
    "build_passed boolean",
    "runtime_started boolean",
    "health_passed boolean",
    "runtime_started_at timestamptz",
    "runtime_finished_at timestamptz",
    "health_checked_at timestamptz",
  ]) {
    assert.equal(sql.includes(column), true, column);
  }
});

test("the schema marker reports 19 and the worker requires 19", () => {
  assert.match(
    sql,
    /create or replace function public\.verification_schema_version\(\)[\s\S]*?select 19;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.verification_schema_version\(\) to authenticated, service_role/,
  );
  assert.match(tick, /export const VERIFICATION_SCHEMA_VERSION = 19;/);
});

test("enqueue persists a bounded repair budget and replaces the Phase 3 arity", () => {
  assert.match(
    sql,
    /drop function if exists public\.enqueue_verification\(\s*text, uuid, uuid, text, text, text\s*\);/,
  );
  assert.match(sql, /create or replace function public\.enqueue_verification\([\s\S]*?p_max_repairs integer default 1/);
  assert.match(sql, /v_repairs integer := greatest\(0, least\(coalesce\(p_max_repairs, 1\), c_repair_hard_max\)\)/);
  assert.match(sql, /repair_max_attempts, preview_status/);
  assert.match(
    sql,
    /grant execute on function public\.enqueue_verification\(text, uuid, uuid, text, text, text, integer\) to service_role/,
  );
  assert.match(sql, /revoke all on function public\.enqueue_verification\(text, uuid, uuid, text, text, text, integer\) from authenticated/);
});

test("a claim continues live build or runtime sandboxes and never duplicates one", () => {
  assert.match(sql, /c_deadline interval := interval '26 minutes'/);
  assert.match(
    sql,
    /v\.status in \(\s*'preparing', 'installing', 'building',\s*'runtime_starting', 'health_checking'\s*\)[\s\S]*?v\.sandbox_id is not null/,
  );
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /effective_snapshot_id = coalesce\(v\.effective_snapshot_id, v\.snapshot_id\)/);
});

test("reaching the runtime stage records that the build passed", () => {
  assert.match(
    sql,
    /p_status (?:not )?in \(\s*'preparing', 'installing', 'building', 'runtime_starting', 'health_checking'\s*\)/,
  );
  assert.match(sql, /build_passed = case when p_status = 'runtime_starting' then true else v\.build_passed end/);
  assert.match(sql, /runtime_started_at = case[\s\S]*?p_status in \('runtime_starting', 'health_checking'\)/);
});

test("a sandbox reference is cleared only after provider-confirmed deletion", () => {
  assert.match(sql, /create or replace function public\.clear_verification_sandbox\(/);
  assert.match(sql, /if coalesce\(p_confirmed, false\) is not true then[\s\S]*?'not_confirmed'/);
  assert.match(sql, /and v\.lease_token = p_lease_token[\s\S]*?set sandbox_id = null|set sandbox_id = null,[\s\S]*?and v\.lease_token = p_lease_token/);
  assert.match(
    sql,
    /grant execute on function public\.clear_verification_sandbox\(uuid, uuid, boolean\) to service_role/,
  );
});

test("passed is rejected unless build, runtime and health all succeeded", () => {
  assert.match(sql, /p_status = 'passed' and not \([\s\S]*?p_build_passed is true and p_runtime_started is true and p_health_passed is true[\s\S]*?PASSED_REQUIRES_RUNTIME/);
  assert.match(sql, /repair_status = v\.repair_status/);
  assert.match(sql, /cleanup_complete = \(v\.sandbox_id is null\) or coalesce\(p_cleanup_complete, false\)/);
});

test("completion is idempotent and fenced by the lease", () => {
  assert.match(sql, /create or replace function public\.complete_verification\(/);
  assert.match(sql, /if v_row\.finished_at is not null then[\s\S]*?'already_terminal'/);
  assert.match(sql, /v_row\.lease_token is null or v_row\.lease_token <> p_lease_token/);
  assert.match(
    sql,
    /grant execute on function public\.complete_verification\([\s\S]*?\) to service_role/,
  );
});

test("a repair begins only after the old sandbox is gone, within a clamped budget", () => {
  assert.match(sql, /create or replace function public\.begin_verification_repair\(/);
  assert.match(sql, /if v_row\.sandbox_id is not null then[\s\S]*?'sandbox_present'/);
  assert.match(sql, /v_row\.status not in \('building', 'runtime_starting', 'health_checking'\)/);
  assert.match(sql, /c_hard_max constant integer := 2/);
  assert.match(
    sql,
    /v_max := greatest\(0, least\([\s\S]*?c_hard_max,[\s\S]*?coalesce\(v_row\.repair_max_attempts, 1\),[\s\S]*?coalesce\(p_max_repairs, v_row\.repair_max_attempts, 1\)[\s\S]*?\)\)/,
  );
  assert.match(sql, /if v_row\.repair_attempts >= v_max then[\s\S]*?'exhausted'/);
  assert.match(sql, /on conflict \(verification_id, attempt\) do nothing[\s\S]*?'duplicate'/);
  assert.match(sql, /status = 'repairing',\s*repair_status = 'requested',\s*repair_attempts = v_attempt/);
  assert.match(sql, /repair_attempts between 0 and 2/);
  assert.match(sql, /repair_max_attempts between 0 and 2/);
});

test("the repair table is bounded, unique per attempt and RLS-scoped", () => {
  assert.match(sql, /create table if not exists public\.project_verification_repairs/);
  assert.match(sql, /attempt integer not null check \(attempt between 1 and 2\)/);
  assert.match(sql, /unique \(verification_id, attempt\)/);
  assert.match(sql, /create policy "project_verification_repairs_select_own"/);
  assert.match(sql, /alter table public\.project_verification_repairs enable row level security/);
  assert.match(sql, /revoke all on public\.project_verification_repairs from anon, authenticated/);
  assert.match(sql, /grant all on public\.project_verification_repairs to service_role/);

  const grant = sql.match(
    /grant select \(([\s\S]*?)\) on public\.project_verification_repairs to authenticated/,
  );
  assert.notEqual(grant, null);
  const granted = grant![1];
  assert.equal(/\boriginal_snapshot_id\b/.test(granted), false);
  assert.equal(/\boriginal_hash\b/.test(granted), false);
  assert.match(granted, /repaired_snapshot_id/);
  assert.match(granted, /cost_known/);
});

test("an applied repair points at a new immutable same-run snapshot and requeues", () => {
  assert.match(sql, /create or replace function public\.finish_verification_repair\(/);
  assert.match(sql, /s\.kind = 'repair'/);
  assert.match(sql, /s\.status = 'ready'/);
  assert.match(sql, /s\.source_hash = p_repaired_hash/);
  assert.match(sql, /s\.project_id = v_row\.project_id/);
  assert.match(sql, /s\.run_id = v_row\.run_id/);
  assert.match(sql, /set status = 'queued',\s*effective_snapshot_id = p_repaired_snapshot_id/);
  assert.match(sql, /repair_status = 'applied'/);
  assert.match(sql, /attempt = 0/);
  assert.match(sql, /deadline_at = now\(\) \+ interval '20 minutes'/);
});

test("a failed or rejected repair keeps the original outcome and no snapshot", () => {
  assert.match(
    sql,
    /repaired_snapshot_id = case when p_status = 'applied' then p_repaired_snapshot_id else null end/,
  );
  assert.match(
    sql,
    /repaired_hash = case when p_status = 'applied' then p_repaired_hash else null end/,
  );
  assert.match(sql, /repair_status = p_status,\s*updated_at = now\(\)/);
});

test("repair cost is recorded only when the provider reported it", () => {
  assert.match(
    sql,
    /v_cost numeric := case\s*when coalesce\(p_cost_known, false\) and p_cost_usd is not null and p_cost_usd >= 0\s*then p_cost_usd\s*else null\s*end/,
  );
  assert.match(sql, /cost_known = coalesce\(p_cost_known, false\) and v_cost is not null/);
  assert.match(sql, /cost_usd numeric\(18, 8\) check \(cost_usd is null or cost_usd >= 0\)/);
  assert.match(sql, /no rate card is ever applied/);
});

test("recovery times out, fails interrupted repairs closed and releases live sandboxes", () => {
  assert.match(sql, /create or replace function public\.recover_expired_verification_leases\(/);
  assert.match(sql, /status = 'timed_out'/);
  assert.match(sql, /elsif v_row\.status = 'repairing' then[\s\S]*?error_class = 'repair_failed'/);
  assert.match(sql, /v_outcome := 'repair_failed'/);
  assert.match(
    sql,
    /v_row\.status in \(\s*'preparing', 'installing', 'building', 'runtime_starting', 'health_checking'\s*\)[\s\S]*?v_outcome := 'released'/,
  );
  assert.match(sql, /v_outcome := 'requeued'/);
  assert.equal(sql.includes("delete from public.project_verifications"), false);
});

test("cancellation also fails a pending repair and retains cleanup state", () => {
  assert.match(sql, /create or replace function public\.cancel_verification\(/);
  assert.match(sql, /update public\.project_verification_repairs r[\s\S]*?status = 'failed'[\s\S]*?error_class = 'cancelled'/);
  assert.match(sql, /repair_status = case when v\.repair_status = 'requested' then 'failed' else v\.repair_status end/);
  assert.match(sql, /cleanup_complete = \(v\.sandbox_id is null\)/);
  assert.match(sql, /grant execute on function public\.cancel_verification\(text, uuid\) to authenticated, service_role/);
});

test("authenticated readers still cannot see worker or provider internals", () => {
  const grant = sql.match(
    /grant select \(([\s\S]*?)\) on public\.project_verifications to authenticated/,
  );
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
  for (const phase4 of [
    "build_passed",
    "runtime_started",
    "health_passed",
    "runtime_profile",
    "runtime_port",
    "runtime_exit_code",
    "health_http_status",
    "preview_status",
    "preview_reason",
    "repair_attempts",
    "repair_max_attempts",
    "repair_status",
    "repaired_snapshot_id",
  ]) {
    assert.equal(new RegExp(`\\b${phase4}\\b`).test(granted), true, phase4);
  }
});

test("every new RPC is service-role only except the two owner-facing ones", () => {
  for (const fn of [
    "clear_verification_sandbox",
    "begin_verification_repair",
    "finish_verification_repair",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on function public\\.${fn}\\([^)]*\\) from authenticated`,
      ),
      fn,
    );
  }
  assert.match(
    sql,
    /grant execute on function public\.verification_schema_version\(\) to authenticated, service_role/,
  );
  assert.match(
    sql,
    /grant execute on function public\.cancel_verification\(text, uuid\) to authenticated, service_role/,
  );
});

// ── The tick itself: no preview URL, no second runtime, bounded repair ──────

test("the tick starts the fixed runtime and checks health inside the sandbox", () => {
  assert.match(tick, /detachedRuntimeScript\(bundle\.plan\)/);
  assert.match(tick, /runtimeHealthCommand\(bundle\.plan, VERIFICATION_HEALTH_REQUEST_TIMEOUT_MS\)/);
  assert.match(tick, /adapter\.exec\(session, command\.cmd, command\.args\)/);
  assert.match(tick, /isHealthyHttpStatus\(observation\.status\)/);
});

test("the tick never mints or returns a provider preview URL", () => {
  assert.equal(/\.domain\s*\(|previewUrl|preview_url|signedUrl|signed_url/i.test(tick), false);
  assert.match(tick, /No public preview URL is ever[\s\S]{0,40}minted/);
});

test("a repair destroys first, creates a new snapshot and requeues", () => {
  assert.match(tick, /destroyForTerminal\(adapter, record, session, false\)/);
  assert.match(tick, /clearVerificationSandbox\(/);
  assert.match(tick, /beginVerificationRepair\(/);
  assert.match(tick, /kind: "repair"/);
  assert.match(tick, /hashSource\(merged\)/);
  assert.match(tick, /repairedHash === \(record\.effectiveSourceHash \?\? record\.sourceHash\)/);
  assert.match(tick, /prepareVerification\(merged, repairedHash\)/);
  assert.match(tick, /status: "applied"/);
});

test("the tick does not treat the model as trusted or as a cost oracle", () => {
  assert.match(tick, /parseRepairResponse\(/);
  assert.match(tick, /mergedRepairWithinBounds\(merged\)/);
  assert.match(tick, /costUsd: generated\.costUsd/);
  assert.match(tick, /costKnown: generated\.costKnown/);
  assert.equal(/rate.?card|per.?token|estimateCost/i.test(tick), false);
});
