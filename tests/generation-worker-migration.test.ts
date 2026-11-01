import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/16_durable_generation_worker.sql", import.meta.url),
  "utf8",
);

/**
 * Static invariants for migration 16. These are text assertions, not a database
 * test: they catch an accidental removal of the fencing, queue or least-
 * privilege controls without pretending the migration was applied.
 */

const workerColumns = [
  "lease_token",
  "lease_expires_at",
  "job_attempt",
  "max_job_attempts",
  "next_attempt_at",
  "enqueued_at",
  "dispatched_at",
  "cancellation_requested_at",
  "dead_lettered_at",
  "worker_id",
  "trace_id",
  "job_version",
  "last_error_class",
  "last_error_summary",
  "reported_cost_usd",
  "cost_known",
  "dispatch_mode",
];

test("every durable job field is added additively and idempotently", () => {
  for (const column of workerColumns) {
    assert.match(
      sql,
      new RegExp(`add column if not exists ${column}\\b`),
      `missing column ${column}`,
    );
  }
  assert.equal(/drop table/i.test(sql), false);
  assert.equal(/delete from/i.test(sql), false);
  assert.equal(/truncate/i.test(sql), false);
});

test("retry_wait is a legal stage and dispatch modes are constrained", () => {
  assert.match(
    sql,
    /add constraint project_runs_stage_check check \(stage in \([\s\S]*?'retry_wait'/,
  );
  assert.match(
    sql,
    /add constraint project_runs_dispatch_mode_check\s+check \(dispatch_mode in \('inline', 'worker'\)\)/,
  );
  assert.match(sql, /add constraint project_runs_job_attempt_check/);
  assert.match(sql, /add constraint project_runs_max_attempts_check/);
  assert.match(sql, /add constraint project_runs_cost_check/);
});

test("queue, expiry, dead-letter and correlation indexes exist", () => {
  assert.match(
    sql,
    /create index if not exists project_runs_ready_queue_idx\s+on public\.project_runs \(stage, next_attempt_at, enqueued_at\)/,
  );
  assert.match(sql, /create index if not exists project_runs_expired_lease_idx/);
  assert.match(sql, /create index if not exists project_runs_dead_letter_idx/);
  assert.match(sql, /create index if not exists project_runs_trace_idx/);
  assert.match(sql, /create index if not exists project_runs_worker_heartbeat_idx/);
});

test("the authenticated role cannot forge worker-owned state", () => {
  assert.match(sql, /revoke update on public\.project_runs from anon, authenticated/);
  assert.match(sql, /revoke insert on public\.project_runs from anon, authenticated/);

  const grant = sql.match(/grant update \(([\s\S]*?)\) on public\.project_runs to authenticated/);
  assert.notEqual(grant, null);
  const granted = grant![1];
  for (const forbidden of [
    "lease_token",
    "lease_expires_at",
    "job_attempt",
    "max_job_attempts",
    "next_attempt_at",
    "dispatched_at",
    "dead_lettered_at",
    "worker_id",
    "trace_id",
    "job_version",
    "last_error_class",
    "reported_cost_usd",
    "cost_known",
    "dispatch_mode",
  ]) {
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`).test(granted),
      false,
      `authenticated may update ${forbidden}`,
    );
  }
  assert.match(granted, /cancellation_requested_at/);
});

test("the schema marker reports 16 and is readable by the worker", () => {
  assert.match(
    sql,
    /create or replace function public\.generation_worker_schema_version\(\)[\s\S]*?select 16;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.generation_worker_schema_version\(\) to authenticated, service_role/,
  );
});

test("admission gains a dispatch mode without discarding queued work", () => {
  assert.match(
    sql,
    /drop function if exists public\.create_generation_job\(text, text, text, text\)/,
  );
  assert.match(
    sql,
    /create or replace function public\.create_generation_job\([\s\S]*?p_dispatch_mode text default 'inline'/,
  );
  assert.match(sql, /dispatch_mode/);
  assert.match(sql, /stage = 'interrupted'/);
  assert.match(sql, /and r\.dispatch_mode = 'inline'/);
  assert.match(sql, /and r\.lease_token is null/);
});

test("claim is a single SKIP LOCKED, service-role-only, fenced operation", () => {
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /dispatch_mode = 'worker'/);
  assert.match(sql, /stage in \('queued', 'retry_wait'\)/);
  assert.match(sql, /next_attempt_at is null or r\.next_attempt_at <= now\(\)/);
  assert.match(sql, /lease_token = gen_random_uuid\(\)/);
  assert.match(sql, /lease_expires_at = now\(\) \+ make_interval\(secs => v_lease\)/);
  assert.match(sql, /job_attempt = r\.job_attempt \+ 1/);
  assert.match(sql, /job_attempt >= v_run\.max_job_attempts/);
  assert.match(sql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
});

test("parallel worker claims skip locked jobs and assign independent fencing tokens", () => {
  const claimStart = sql.indexOf("create or replace function public.claim_generation_job");
  assert.notEqual(claimStart, -1);
  const claimEnd = sql.indexOf("$$;", sql.indexOf("as $$", claimStart) + 5);
  assert.notEqual(claimEnd, -1);
  const claimFunction = sql.slice(claimStart, claimEnd);

  assert.match(claimFunction, /for update skip locked/);
  assert.match(claimFunction, /limit 1/);
  assert.match(claimFunction, /lease_token = gen_random_uuid\(\)/);
  assert.match(claimFunction, /lease_token is null/);
  assert.match(claimFunction, /lease_expires_at = now\(\) \+ make_interval/);
});

test("worker RPCs are executable only by service_role", () => {
  const serviceOnly = [
    "claim_generation_job(text, integer, text[])",
    "renew_generation_lease(uuid, uuid, integer)",
    "schedule_generation_retry(uuid, uuid, text, text, integer)",
    "recover_expired_generation_leases(integer)",
  ];
  for (const signature of serviceOnly) {
    assert.equal(
      sql.includes(`revoke all on function public.${signature} from anon;`),
      true,
      `${signature} is not revoked from anon`,
    );
    assert.equal(
      sql.includes(`revoke all on function public.${signature} from authenticated;`),
      true,
      `${signature} is not revoked from authenticated`,
    );
    assert.equal(
      sql.includes(`grant execute on function public.${signature} to service_role;`),
      true,
      `${signature} is not granted to service_role`,
    );
  }
});

test("batch persistence is fenced and validates the caller's owner", () => {
  assert.match(
    sql,
    /create or replace function public\.persist_generation_batch\([\s\S]*?p_lease_token uuid/,
  );
  assert.match(sql, /v_run\.lease_token <> p_lease_token/);
  assert.match(sql, /v_is_service boolean := coalesce\(auth\.role\(\), ''\) = 'service_role'/);
  assert.match(sql, /v_uid uuid := auth\.uid\(\)/);
  assert.match(
    sql,
    /grant execute on function public\.persist_generation_batch\([\s\S]*?\) to authenticated, service_role/,
  );
});

test("recovery converts an expired lease into a retry or a dead letter, never a delete", () => {
  assert.match(sql, /lease_expires_at < now\(\)/);
  assert.match(sql, /stage in \('validating', 'generating', 'retrying'\)/);
  assert.match(sql, /15 \* power\(2, greatest\(v_run\.job_attempt - 1, 0\)\)/);
  assert.match(sql, /least\(300,/);
  assert.match(sql, /stage = 'retry_wait'/);
  assert.match(sql, /dead_lettered_at = now\(\)/);
  assert.match(sql, /'status', 'retry'/);
  assert.match(sql, /'status', 'dead_letter'/);
});

test("retry scheduling and resume preserve the attempt budget correctly", () => {
  assert.match(
    sql,
    /create or replace function public\.schedule_generation_retry\([\s\S]*?'status', 'dead_letter'/,
  );
  assert.match(sql, /v_run\.job_attempt >= v_run\.max_job_attempts/);
  assert.match(
    sql,
    /grant execute on function public\.schedule_generation_retry\(uuid, uuid, text, text, integer\) to service_role/,
  );
  assert.match(
    sql,
    /create or replace function public\.resume_generation_job\([\s\S]*?stage in \('failed', 'interrupted'\)/,
  );
  assert.match(sql, /job_attempt = 0/);
  assert.match(sql, /finished_at = null/);
  assert.match(
    sql,
    /grant execute on function public\.resume_generation_job\(text, uuid\) to authenticated/,
  );
  assert.equal(
    sql.includes("grant execute on function public.resume_generation_job(text, uuid) to service_role"),
    false,
  );
});
