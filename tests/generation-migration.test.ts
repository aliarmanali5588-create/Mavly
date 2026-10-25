import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/10_generation_jobs.sql", import.meta.url),
  "utf8",
);

/**
 * Static invariants for the durable job migration. These are text assertions,
 * not a database test: they catch an accidental removal of the controls that
 * make admission safe, without pretending a migration was applied.
 */

test("one unfinished run per project is enforced", () => {
  assert.match(sql, /create unique index if not exists project_runs_one_active_per_project/);
  assert.match(sql, /where finished_at is null/);
});

test("admission is serialized and enforces both limits", () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('mavly:create_generation_job'\)\)/);
  assert.match(sql, /c_global_limit constant integer := 8/);
  assert.match(sql, /c_user_limit constant integer := 2/);
  assert.match(sql, /security definer/);
});

test("ownership is checked before a run is created", () => {
  assert.match(sql, /where p\.project_id = p_project_id and p\.user_id = v_uid/);
  assert.match(sql, /raise exception 'FORBIDDEN' using errcode = '42501'/);
});

test("idempotency is scoped to a project", () => {
  assert.match(
    sql,
    /create unique index if not exists project_runs_project_idempotency_idx[\s\S]*?on public\.project_runs \(project_id, idempotency_key\)/,
  );
});

test("batch checkpoints carry per-path hashes and inherit project ownership", () => {
  assert.match(sql, /path_hashes jsonb not null default '\{\}'::jsonb/);
  assert.match(sql, /create table if not exists public\.project_run_batches/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /project_run_batches_select_own/);
  assert.match(sql, /p\.user_id = \(select auth\.uid\(\)\)/);
});

test("stale runs are recovered and duplicate active rows cannot block the index", () => {
  assert.match(sql, /coalesce\(r\.heartbeat_at, r\.started_at\) < now\(\) - c_stale/);
  assert.match(sql, /DUPLICATE_ACTIVE_RUN/);
});

test("direct run inserts and reactivation bypasses are closed", () => {
  assert.match(sql, /drop policy if exists "project_runs_insert_own" on public\.project_runs/);
  assert.match(sql, /revoke insert on public\.project_runs from anon, authenticated/);
  assert.match(sql, /create trigger project_runs_active_limit/);
  assert.match(sql, /before insert or update of finished_at, stage on public\.project_runs/);
  assert.match(sql, /RATE_LIMITED_USER/);
  assert.match(sql, /perform pg_advisory_xact_lock\(hashtext\('mavly:create_generation_job'\)\)/);
});

test("the RPC is not executable by anonymous callers", () => {
  assert.match(
    sql,
    /revoke all on function public\.create_generation_job\(text, text, text, text\) from anon/,
  );
  assert.match(
    sql,
    /grant execute on function public\.create_generation_job\(text, text, text, text\) to authenticated/,
  );
});
