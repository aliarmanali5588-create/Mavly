-- Mavly — durable generation worker: queue state, leases, fencing and recovery
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Migration 10 made one `project_runs` row one durable job and added an atomic
-- admission gate. Execution still happened inside the HTTP request's `after()`
-- hook, so a terminated serverless invocation left the row unfinished and only
-- a user-initiated resume could continue it.
--
-- This migration adds the storage half of an autonomous worker:
--
--   QUEUE           The job row is the queue message. Admission and enqueue are
--                   the same INSERT, so no separate outbox is needed and there
--                   is no window in which an accepted job is not queued.
--   CLAIM           `claim_generation_job` selects one ready job with
--                   `FOR UPDATE SKIP LOCKED`, verifies the owning project, and
--                   writes a random lease token. The token is the fencing
--                   token for every later write.
--   LEASE           While a worker owns a job, it must renew `lease_expires_at`.
--                   `recover_expired_generation_leases` turns an expired lease
--                   into a bounded retry or a terminal dead letter. A stale
--                   worker's writes are rejected because its token no longer
--                   matches (or the run is finished).
--   RETRY           `schedule_generation_retry` records a sanitized error class
--                   and summary, sets `retry_wait`, and never deletes accepted
--                   work. Attempts are bounded by `max_job_attempts`.
--   CHECKPOINT      `persist_generation_batch` writes the generated files and
--                   the checkpoint in ONE transaction under the lease guard.
--                   The old write-then-checkpoint sequence could crash between
--                   the two and leave files without a resumable checkpoint.
--   CORRELATION     Every new run gets a non-secret trace id. It is returned to
--                   the worker and used in structured events.
--
-- ═══ SECURITY ════════════════════════════════════════════════════════════════
--
-- The worker executes with a SERVER-ONLY service-role Supabase client. This is
-- the one intentional service-role exception in Mavly, confined to
-- `src/lib/supabase/worker.ts` and the generation worker, and it does not relax
-- any RLS policy:
--
--   · The worker RPCs are executable ONLY by `service_role`. They are revoked
--     from PUBLIC, anon and authenticated.
--   · `claim_generation_job` joins `public.projects` and returns the owner. The
--     worker re-verifies that owner before running anything.
--   · `persist_generation_batch` accepts either an authenticated caller (which
--     must own the project, checked with `auth.uid()`) or `service_role` (which
--     must pass the owner id it just verified). It never trusts a client-supplied
--     owner for an authenticated call.
--   · User-facing updates remain RLS-scoped. Sensitive worker columns are
--     removed from the authenticated UPDATE grant; only the columns the existing
--     user path writes remain writable.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and idempotent. Apply BEFORE deploying the worker-capable code.
-- Existing code keeps working: it only writes columns that remain granted, and
-- `retry_wait` is an additional stage value. Nothing is deleted.
--
-- The worker feature is off unless `MAVLY_GENERATION_WORKER_ENABLED` and an
-- explicit project cohort are configured in the server environment. See
-- `docs/runbooks/generation-worker.md`.

begin;

-- ── 1. Durable queue, lease and observability columns ───────────────────────

alter table public.project_runs
  add column if not exists lease_token uuid;
alter table public.project_runs
  add column if not exists lease_expires_at timestamptz;
alter table public.project_runs
  add column if not exists job_attempt integer not null default 0;
alter table public.project_runs
  add column if not exists max_job_attempts integer not null default 3;
alter table public.project_runs
  add column if not exists next_attempt_at timestamptz;
alter table public.project_runs
  add column if not exists enqueued_at timestamptz;
alter table public.project_runs
  add column if not exists dispatched_at timestamptz;
alter table public.project_runs
  add column if not exists cancellation_requested_at timestamptz;
alter table public.project_runs
  add column if not exists dead_lettered_at timestamptz;
alter table public.project_runs
  add column if not exists worker_id text;
alter table public.project_runs
  add column if not exists trace_id text;
alter table public.project_runs
  add column if not exists job_version integer not null default 1;
alter table public.project_runs
  add column if not exists last_error_class text;
alter table public.project_runs
  add column if not exists last_error_summary text;
alter table public.project_runs
  add column if not exists reported_cost_usd numeric;
alter table public.project_runs
  add column if not exists cost_known boolean not null default false;
alter table public.project_runs
  add column if not exists dispatch_mode text not null default 'inline';

-- Existing rows get truthful backfill values. `started_at` is the enqueue time
-- for every pre-worker run; no new timestamp is invented.
update public.project_runs
set enqueued_at = coalesce(enqueued_at, started_at, now())
where enqueued_at is null;

update public.project_runs
set trace_id = replace(gen_random_uuid()::text, '-', '')
where trace_id is null;

alter table public.project_runs
  alter column enqueued_at set default now();
alter table public.project_runs
  alter column enqueued_at set not null;

alter table public.project_runs
  alter column trace_id set default replace(gen_random_uuid()::text, '-', '');
alter table public.project_runs
  alter column trace_id set not null;

-- `retry_wait` is deliberately NOT a terminal or an active-execution stage: the
-- job is accepted, durable and pending, but no worker owns it yet.
alter table public.project_runs
  drop constraint if exists project_runs_stage_check;
alter table public.project_runs
  add constraint project_runs_stage_check check (stage in (
    'queued',
    'validating',
    'generating',
    'retrying',
    'retry_wait',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ));

alter table public.project_runs
  drop constraint if exists project_runs_dispatch_mode_check;
alter table public.project_runs
  add constraint project_runs_dispatch_mode_check
  check (dispatch_mode in ('inline', 'worker'));

alter table public.project_runs
  drop constraint if exists project_runs_job_attempt_check;
alter table public.project_runs
  add constraint project_runs_job_attempt_check
  check (job_attempt >= 0 and job_attempt <= max_job_attempts);

alter table public.project_runs
  drop constraint if exists project_runs_max_attempts_check;
alter table public.project_runs
  add constraint project_runs_max_attempts_check
  check (max_job_attempts between 1 and 10);

alter table public.project_runs
  drop constraint if exists project_runs_cost_check;
alter table public.project_runs
  add constraint project_runs_cost_check
  check (reported_cost_usd is null or reported_cost_usd >= 0);

comment on column public.project_runs.lease_token is
  'Random fencing token for the worker that currently owns the run. Every worker write must present it.';
comment on column public.project_runs.lease_expires_at is
  'When the current lease stops being authoritative. Expired leases are recovered into retry_wait or a dead letter.';
comment on column public.project_runs.job_attempt is
  'Durable job attempts (claims), separate from attempt_count, which counts provider calls.';
comment on column public.project_runs.max_job_attempts is
  'Hard cap on durable job attempts. A manual user resume resets job_attempt.';
comment on column public.project_runs.next_attempt_at is
  'Earliest time a retry_wait job may be claimed.';
comment on column public.project_runs.enqueued_at is
  'When the job entered the durable queue. Queue lag is claimed_at - enqueued_at.';
comment on column public.project_runs.trace_id is
  'Non-secret correlation id propagated through worker events. Never a prompt or credential.';
comment on column public.project_runs.last_error_class is
  'Machine-readable, sanitized failure class from the latest attempt.';
comment on column public.project_runs.last_error_summary is
  'Bounded, sanitized failure summary. Never contains prompts, code, credentials or user PII.';
comment on column public.project_runs.reported_cost_usd is
  'Provider-reported cost only when every provider attempt reported one; NULL otherwise. Never estimated.';
comment on column public.project_runs.dispatch_mode is
  'inline = Next.js after() path; worker = the run was handed to the durable generation worker.';

-- ── 2. Queue, lease and recovery indexes ────────────────────────────────────

create index if not exists project_runs_ready_queue_idx
  on public.project_runs (stage, next_attempt_at, enqueued_at)
  where finished_at is null;

create index if not exists project_runs_expired_lease_idx
  on public.project_runs (lease_expires_at)
  where finished_at is null and lease_token is not null;

create index if not exists project_runs_dead_letter_idx
  on public.project_runs (dead_lettered_at)
  where dead_lettered_at is not null;

create index if not exists project_runs_trace_idx
  on public.project_runs (trace_id);

create index if not exists project_runs_worker_heartbeat_idx
  on public.project_runs (worker_id, heartbeat_at)
  where finished_at is null and worker_id is not null;

-- ── 3. Least-privilege user updates ────────────────────────────────────────
--
-- The user path still updates its own run through RLS, but it must not be able
-- to forge a lease, reset the attempt budget, rewrite the queue timestamps or
-- mark a job dead. Replace the table-wide UPDATE grant with an explicit column
-- list. Values written by the pre-worker code are all present, so a mixed
-- rollout keeps working.

revoke update on public.project_runs from anon, authenticated;
grant update (
  status,
  stage,
  finished_at,
  error_message,
  error_code,
  retry_after_seconds,
  claimed_at,
  heartbeat_at,
  last_progress_at,
  generation_manifest,
  checkpoint_count,
  files_written,
  batch_count,
  attempt_count,
  provider_request_id,
  model_used,
  finish_reason,
  prompt_tokens,
  completion_tokens,
  total_tokens,
  reasoning_tokens,
  provider_attempts,
  cancellation_requested_at
) on public.project_runs to authenticated;

revoke insert on public.project_runs from anon, authenticated;

-- ── 4. Schema marker / preflight ───────────────────────────────────────────

create or replace function public.generation_worker_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 16;
$$;

revoke all on function public.generation_worker_schema_version() from public;
revoke all on function public.generation_worker_schema_version() from anon;
grant execute on function public.generation_worker_schema_version() to authenticated, service_role;

comment on function public.generation_worker_schema_version() is
  'Generation-worker schema marker. 16 means queue leases, retries and fencing are installed.';

-- ── 5. Admission keeps its signature, but never discards queued work ───────
--
-- The old stale-recovery predicate closed EVERY unfinished run whose heartbeat
-- was old. That is correct for a claimed inline run, but it also killed a job
-- that had been sitting in the durable queue for more than ten minutes without
-- being claimed. Queued worker jobs are deliberately durable and must survive a
-- backlog. Inline queued runs keep the old recovery so a deployment that never
-- ran `after()` does not lock the project forever.

-- Adding a defaulted parameter changes the function's identity. Drop the old
-- four-argument signature so a stale PostgREST schema cache cannot resolve an
-- implementation that does not record dispatch mode. The new function still
-- accepts four arguments (the fifth defaults to `inline`), so mixed-version
-- callers keep working after the schema cache reloads.
drop function if exists public.create_generation_job(text, text, text, text);

create or replace function public.create_generation_job(
  p_project_id text,
  p_model text,
  p_prompt text,
  p_idempotency_key text default null,
  p_dispatch_mode text default 'inline'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_global_limit constant integer := 8;
  c_user_limit constant integer := 2;
  c_stale interval := interval '10 minutes';
  v_uid uuid := auth.uid();
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 200), '');
  v_mode text := lower(btrim(coalesce(p_dispatch_mode, 'inline')));
  v_run public.project_runs;
  v_active_user integer;
  v_active_global integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if v_mode not in ('inline', 'worker') then
    raise exception 'INVALID_DISPATCH_MODE' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  /*
   * Stale recovery is limited to runs a worker actually claimed, plus queued
   * inline runs whose after() never started. A queued worker job (dispatch_mode
   * = 'worker') is not interrupted by queue age.
   */
  update public.project_runs r
  set status = 'error',
      stage = 'interrupted',
      finished_at = now(),
      last_progress_at = now(),
      error_message = coalesce(r.error_message, 'The run was interrupted before completion.'),
      error_code = coalesce(r.error_code, 'RUN_INTERRUPTED')
  where r.finished_at is null
    and (
      (
        r.stage in ('validating', 'generating', 'retrying')
        and r.lease_token is null
        and coalesce(r.heartbeat_at, r.started_at) < now() - c_stale
      )
      or
      (
        r.stage = 'queued'
        and r.dispatch_mode = 'inline'
        and coalesce(r.heartbeat_at, r.started_at) < now() - c_stale
      )
    );

  if v_key is not null then
    select * into v_run
    from public.project_runs r
    where r.project_id = p_project_id and r.idempotency_key = v_key
    order by r.started_at desc
    limit 1;
    if found then
      return jsonb_build_object('status', 'existing', 'run', to_jsonb(v_run));
    end if;
  end if;

  select * into v_run
  from public.project_runs r
  where r.project_id = p_project_id and r.finished_at is null
  order by r.started_at desc
  limit 1;
  if found then
    return jsonb_build_object('status', 'conflict', 'run', to_jsonb(v_run));
  end if;

  select count(*) into v_active_user
  from public.project_runs r
  join public.projects p on p.project_id = r.project_id
  where p.user_id = v_uid and r.finished_at is null;

  if v_active_user >= c_user_limit then
    return jsonb_build_object(
      'status', 'rate_limited',
      'scope', 'user',
      'retryAfterSeconds', 30
    );
  end if;

  select count(*) into v_active_global
  from public.project_runs r
  where r.finished_at is null;

  if v_active_global >= c_global_limit then
    return jsonb_build_object(
      'status', 'rate_limited',
      'scope', 'global',
      'retryAfterSeconds', 30
    );
  end if;

  insert into public.project_runs (
    project_id, status, stage, model, prompt, idempotency_key,
    heartbeat_at, last_progress_at, dispatch_mode
  ) values (
    p_project_id,
    'init',
    'queued',
    p_model,
    left(p_prompt, 32000),
    v_key,
    now(),
    now(),
    v_mode
  )
  returning * into v_run;

  return jsonb_build_object('status', 'created', 'run', to_jsonb(v_run));

exception
  when unique_violation then
    select * into v_run
    from public.project_runs r
    where r.project_id = p_project_id and r.finished_at is null
    order by r.started_at desc
    limit 1;
    if found then
      return jsonb_build_object('status', 'conflict', 'run', to_jsonb(v_run));
    end if;
    raise;
end;
$$;

revoke all on function public.create_generation_job(text, text, text, text, text) from public;
revoke all on function public.create_generation_job(text, text, text, text, text) from anon;
grant execute on function public.create_generation_job(text, text, text, text, text) to authenticated;

-- ── 6. Atomic batch persistence, fenced by the worker lease ────────────────
--
-- This replaces the write-then-checkpoint pair for both paths. The run row is
-- locked first, the caller's guard is checked, and only then are files, the
-- checkpoint and the progress counters written. A stale worker cannot write
-- files at all. The authenticated path uses auth.uid(); the service-role path
-- must pass the owner id it verified.

create or replace function public.persist_generation_batch(
  p_project_id text,
  p_run_id uuid,
  p_lease_token uuid,
  p_claimed_at timestamptz,
  p_user_id uuid,
  p_batch_index integer,
  p_files jsonb,
  p_path_hashes jsonb,
  p_source_hash text,
  p_bytes integer,
  p_files_written integer,
  p_lease_seconds integer default 420
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_file_bytes constant integer := 262144;
  c_max_batch_bytes constant integer := 1500000;
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_uid uuid := auth.uid();
  v_run public.project_runs;
  v_file jsonb;
  v_path text;
  v_content text;
  v_total_bytes integer := 0;
  v_count integer := 0;
  v_now timestamptz := now();
  v_batch_bytes integer;
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 420), 900));
begin
  if p_project_id is null or p_run_id is null
     or p_batch_index is null or p_batch_index < 0 then
    raise exception 'INVALID_BATCH' using errcode = '22023';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array'
     or jsonb_array_length(p_files) = 0 or jsonb_array_length(p_files) > 80 then
    raise exception 'INVALID_BATCH' using errcode = '22023';
  end if;
  if p_path_hashes is null or jsonb_typeof(p_path_hashes) <> 'object' then
    raise exception 'INVALID_BATCH' using errcode = '22023';
  end if;

  if v_is_service then
    if p_user_id is null or not exists (
      select 1 from public.projects p
      where p.project_id = p_project_id and p.user_id = p_user_id
    ) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  else
    if v_uid is null or not exists (
      select 1 from public.projects p
      where p.project_id = p_project_id and p.user_id = v_uid
    ) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id and r.project_id = p_project_id
  for update;

  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.finished_at is not null
     or v_run.stage in ('completed', 'failed', 'cancelled', 'interrupted') then
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;

  if p_lease_token is not null then
    if v_run.lease_token is null or v_run.lease_token <> p_lease_token then
      raise exception 'LEASE_LOST' using errcode = 'P0001';
    end if;
    if v_run.lease_expires_at is not null and v_run.lease_expires_at < v_now then
      raise exception 'LEASE_LOST' using errcode = 'P0001';
    end if;
  elsif p_claimed_at is not null then
    if v_run.claimed_at is null or v_run.claimed_at <> p_claimed_at then
      raise exception 'LEASE_LOST' using errcode = 'P0001';
    end if;
  else
    raise exception 'LEASE_LOST' using errcode = 'P0001';
  end if;

  for v_file in select value from jsonb_array_elements(p_files) loop
    if coalesce(jsonb_typeof(v_file), '') <> 'object' then
      raise exception 'INVALID_BATCH' using errcode = '22023';
    end if;

    v_path := v_file->>'path';
    v_content := v_file->>'content';

    if v_path is null or v_path = '' or length(v_path) > 400
       or v_path ~ '^/' or v_path ~ '(^|/)\.\.(/|$)'
       or position('\' in v_path) > 0
       or v_path ~ '[[:cntrl:]]'
       or v_path ~* '(^|/)(\.env|node_modules|\.git)(/|$|\.)' then
      raise exception 'INVALID_PATH' using errcode = '22023';
    end if;
    if v_content is null or octet_length(v_content) > c_max_file_bytes then
      raise exception 'INVALID_BATCH' using errcode = '22023';
    end if;

    v_total_bytes := v_total_bytes + octet_length(v_content);
    if v_total_bytes > c_max_batch_bytes then
      raise exception 'INVALID_BATCH' using errcode = '22023';
    end if;

    insert into public.project_files (project_id, path, content, updated_at)
    values (p_project_id, v_path, v_content, v_now)
    on conflict (project_id, path) do update
      set content = excluded.content,
          updated_at = excluded.updated_at;

    v_count := v_count + 1;
  end loop;

  v_batch_bytes := greatest(0, coalesce(p_bytes, v_total_bytes));

  insert into public.project_run_batches (
    run_id, project_id, batch_index, paths, path_hashes, source_hash,
    bytes, status, completed_at
  ) values (
    p_run_id,
    p_project_id,
    p_batch_index,
    (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_object_keys(p_path_hashes) key),
    p_path_hashes,
    coalesce(p_source_hash, ''),
    v_batch_bytes,
    'done',
    v_now
  )
  on conflict (run_id, batch_index) do update
    set paths = excluded.paths,
        path_hashes = excluded.path_hashes,
        source_hash = excluded.source_hash,
        bytes = excluded.bytes,
        status = 'done',
        completed_at = excluded.completed_at;

  update public.project_runs r
  set stage = 'generating',
      heartbeat_at = v_now,
      last_progress_at = v_now,
      files_written = greatest(r.files_written, greatest(0, coalesce(p_files_written, v_count))),
      checkpoint_count = greatest(r.checkpoint_count, p_batch_index + 1),
      batch_count = greatest(r.batch_count, p_batch_index + 1),
      lease_expires_at = case
        when p_lease_token is not null then v_now + make_interval(secs => v_lease)
        else r.lease_expires_at
      end
  where r.id = p_run_id;

  update public.projects p
  set updated_at = v_now
  where p.project_id = p_project_id;

  return jsonb_build_object(
    'batch_index', p_batch_index,
    'paths', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_object_keys(p_path_hashes) key),
    'path_hashes', p_path_hashes,
    'source_hash', coalesce(p_source_hash, ''),
    'bytes', v_batch_bytes,
    'status', 'done'
  );
end;
$$;

revoke all on function public.persist_generation_batch(text, uuid, uuid, timestamptz, uuid, integer, jsonb, jsonb, text, integer, integer, integer) from public;
revoke all on function public.persist_generation_batch(text, uuid, uuid, timestamptz, uuid, integer, jsonb, jsonb, text, integer, integer, integer) from anon;
grant execute on function public.persist_generation_batch(text, uuid, uuid, timestamptz, uuid, integer, jsonb, jsonb, text, integer, integer, integer) to authenticated, service_role;

-- ── 7. Worker claim: one ready job, atomically ──────────────────────────────

create or replace function public.claim_generation_job(
  p_worker_id text,
  p_lease_seconds integer default 420,
  p_project_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 420), 900));
  v_run public.project_runs;
  v_user uuid;
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 120);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_worker = '' then
    raise exception 'INVALID_WORKER' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.project_runs r
  where r.finished_at is null
    and r.dispatch_mode = 'worker'
    and r.stage in ('queued', 'retry_wait')
    and (r.next_attempt_at is null or r.next_attempt_at <= now())
    and (p_project_ids is null or r.project_id = any (p_project_ids))
    and exists (
      select 1 from public.projects p where p.project_id = r.project_id
    )
  order by coalesce(r.next_attempt_at, r.enqueued_at), r.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  select p.user_id into v_user
  from public.projects p
  where p.project_id = v_run.project_id;

  if v_user is null then
    update public.project_runs r
    set status = 'error',
        stage = 'failed',
        finished_at = now(),
        dead_lettered_at = now(),
        lease_token = null,
        lease_expires_at = null,
        error_code = 'PROJECT_MISSING',
        last_error_class = 'project_missing',
        last_error_summary = 'The project no longer exists.'
    where r.id = v_run.id;
    return jsonb_build_object('status', 'dead_letter', 'reason', 'project_missing');
  end if;

  if v_run.job_attempt >= v_run.max_job_attempts then
    update public.project_runs r
    set status = 'error',
        stage = 'failed',
        finished_at = now(),
        dead_lettered_at = now(),
        lease_token = null,
        lease_expires_at = null,
        error_code = 'JOB_ATTEMPTS_EXHAUSTED',
        last_error_class = 'attempts_exhausted',
        last_error_summary = 'The job reached its attempt limit before it could be claimed.'
    where r.id = v_run.id;

    insert into public.project_messages (project_id, author, message, message_type)
    values (
      v_run.project_id,
      'agent',
      'The generation stopped after reaching its attempt limit. You can resume this run from the workspace.',
      'error'
    );

    return jsonb_build_object('status', 'dead_letter', 'reason', 'attempts_exhausted');
  end if;

  update public.project_runs r
  set status = 'init',
      stage = 'validating',
      job_attempt = r.job_attempt + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      claimed_at = now(),
      heartbeat_at = now(),
      last_progress_at = now(),
      dispatched_at = now(),
      worker_id = v_worker,
      next_attempt_at = null,
      error_code = null,
      retry_after_seconds = null
  where r.id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'status', 'claimed',
    'run', to_jsonb(v_run),
    'user_id', v_user,
    'lease_seconds', v_lease
  );
end;
$$;

revoke all on function public.claim_generation_job(text, integer, text[]) from public;
revoke all on function public.claim_generation_job(text, integer, text[]) from anon;
revoke all on function public.claim_generation_job(text, integer, text[]) from authenticated;
grant execute on function public.claim_generation_job(text, integer, text[]) to service_role;

comment on function public.claim_generation_job(text, integer, text[]) is
  'Service-role only. Claims one ready job with SKIP LOCKED, verifies its owning project and writes a fencing lease token.';

-- ── 8. Worker lease renewal ────────────────────────────────────────────────

create or replace function public.renew_generation_lease(
  p_run_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 420
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 420), 900));
  v_run public.project_runs;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_runs r
  set heartbeat_at = now(),
      last_progress_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease)
  where r.id = p_run_id
    and r.lease_token = p_lease_token
    and r.finished_at is null
    and r.stage in ('validating', 'generating', 'retrying')
  returning * into v_run;

  if not found then
    select * into v_run from public.project_runs r where r.id = p_run_id;
    return jsonb_build_object(
      'status', 'lost',
      'stage', case when found then v_run.stage else null end,
      'finished', case when found then v_run.finished_at is not null else true end
    );
  end if;

  return jsonb_build_object('status', 'renewed', 'run', to_jsonb(v_run));
end;
$$;

revoke all on function public.renew_generation_lease(uuid, uuid, integer) from public;
revoke all on function public.renew_generation_lease(uuid, uuid, integer) from anon;
revoke all on function public.renew_generation_lease(uuid, uuid, integer) from authenticated;
grant execute on function public.renew_generation_lease(uuid, uuid, integer) to service_role;

-- ── 9. Bounded retry or dead letter ────────────────────────────────────────

create or replace function public.schedule_generation_retry(
  p_run_id uuid,
  p_lease_token uuid,
  p_error_class text,
  p_error_summary text,
  p_retry_after_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.project_runs;
  v_error_class text := nullif(left(btrim(coalesce(p_error_class, '')), 80), '');
  v_error_summary text := nullif(left(btrim(coalesce(p_error_summary, '')), 1000), '');
  v_delay integer := greatest(1, least(coalesce(p_retry_after_seconds, 30), 3600));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.finished_at is not null then
    return jsonb_build_object('status', 'lost', 'stage', v_run.stage);
  end if;
  if v_run.lease_token is null or v_run.lease_token <> p_lease_token then
    return jsonb_build_object('status', 'lost', 'stage', v_run.stage);
  end if;

  if v_run.job_attempt >= v_run.max_job_attempts then
    update public.project_runs r
    set status = 'error',
        stage = 'failed',
        finished_at = now(),
        dead_lettered_at = now(),
        lease_token = null,
        lease_expires_at = null,
        heartbeat_at = now(),
        last_progress_at = now(),
        error_code = coalesce(v_error_class, 'JOB_ATTEMPTS_EXHAUSTED'),
        error_message = v_error_summary,
        last_error_class = v_error_class,
        last_error_summary = v_error_summary
    where r.id = p_run_id;

    return jsonb_build_object(
      'status', 'dead_letter',
      'attempt', v_run.job_attempt,
      'maxAttempts', v_run.max_job_attempts
    );
  end if;

  update public.project_runs r
  set status = 'init',
      stage = 'retry_wait',
      finished_at = null,
      next_attempt_at = now() + make_interval(secs => v_delay),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      claimed_at = null,
      heartbeat_at = now(),
      last_progress_at = now(),
      error_code = v_error_class,
      retry_after_seconds = v_delay,
      last_error_class = v_error_class,
      last_error_summary = v_error_summary
  where r.id = p_run_id
  returning * into v_run;

  return jsonb_build_object(
    'status', 'retry',
    'run', to_jsonb(v_run),
    'retryAt', v_run.next_attempt_at,
    'retryAfterSeconds', v_delay,
    'attempt', v_run.job_attempt,
    'maxAttempts', v_run.max_job_attempts
  );
end;
$$;

revoke all on function public.schedule_generation_retry(uuid, uuid, text, text, integer) from public;
revoke all on function public.schedule_generation_retry(uuid, uuid, text, text, integer) from anon;
revoke all on function public.schedule_generation_retry(uuid, uuid, text, text, integer) from authenticated;
grant execute on function public.schedule_generation_retry(uuid, uuid, text, text, integer) to service_role;

-- ── 10. Expired-lease recovery ─────────────────────────────────────────────
--
-- A crashed worker cannot finalize its own run. This advances the job without
-- deleting it: a retry_wait row with a future `next_attempt_at`, or a terminal
-- failed row once the attempt budget is exhausted. The stale worker's writes
-- are already fenced off by the cleared lease token.

create or replace function public.recover_expired_generation_leases(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_run public.project_runs;
  v_delay integer;
  v_results jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_run in
    select r.*
    from public.project_runs r
    where r.finished_at is null
      and r.dispatch_mode = 'worker'
      and r.lease_token is not null
      and r.lease_expires_at is not null
      and r.lease_expires_at < now()
      and r.stage in ('validating', 'generating', 'retrying')
    order by r.lease_expires_at
    for update skip locked
    limit v_limit
  loop
    if v_run.job_attempt >= v_run.max_job_attempts then
      update public.project_runs r
      set status = 'error',
          stage = 'failed',
          finished_at = now(),
          dead_lettered_at = now(),
          lease_token = null,
          lease_expires_at = null,
          claimed_at = null,
          worker_id = null,
          heartbeat_at = now(),
          last_progress_at = now(),
          error_code = 'LEASE_EXPIRED',
          error_message = 'The worker stopped without finishing this run. You can resume it.',
          last_error_class = 'lease_expired',
          last_error_summary = 'The worker lease expired before the job completed.'
      where r.id = v_run.id;

      insert into public.project_messages (project_id, author, message, message_type)
      values (
        v_run.project_id,
        'agent',
        'The generation stopped because the worker did not finish. You can resume this run from the workspace.',
        'error'
      );

      v_results := v_results || jsonb_build_object(
        'runId', v_run.id,
        'status', 'dead_letter',
        'attempt', v_run.job_attempt
      );
    else
      v_delay := least(300, (15 * power(2, greatest(v_run.job_attempt - 1, 0)))::integer);
      v_delay := v_delay + floor(random() * v_delay * 0.25)::integer;

      update public.project_runs r
      set status = 'init',
          stage = 'retry_wait',
          next_attempt_at = now() + make_interval(secs => v_delay),
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          claimed_at = null,
          heartbeat_at = now(),
          last_progress_at = now(),
          error_code = 'LEASE_EXPIRED',
          retry_after_seconds = v_delay,
          last_error_class = 'lease_expired',
          last_error_summary = 'The worker lease expired before the job completed.'
      where r.id = v_run.id;

      v_results := v_results || jsonb_build_object(
        'runId', v_run.id,
        'status', 'retry',
        'retryInSeconds', v_delay,
        'attempt', v_run.job_attempt
      );
    end if;
  end loop;

  return jsonb_build_object('recovered', v_results);
end;
$$;

revoke all on function public.recover_expired_generation_leases(integer) from public;
revoke all on function public.recover_expired_generation_leases(integer) from anon;
revoke all on function public.recover_expired_generation_leases(integer) from authenticated;
grant execute on function public.recover_expired_generation_leases(integer) to service_role;

comment on function public.recover_expired_generation_leases(integer) is
  'Service-role only. Converts expired worker leases into bounded retries or terminal dead letters without deleting jobs.';

-- ── 11. User resume: explicit, atomic, attempt-budget reset ────────────────

create or replace function public.resume_generation_job(
  p_project_id text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.project_runs;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id
    and r.project_id = p_project_id
    and r.finished_at is not null
    and r.stage in ('failed', 'interrupted')
  for update;

  if not found then
    return jsonb_build_object('status', 'not_resumable');
  end if;

  update public.project_runs r
  set status = 'init',
      stage = 'queued',
      finished_at = null,
      error_message = null,
      error_code = null,
      retry_after_seconds = null,
      claimed_at = null,
      heartbeat_at = now(),
      last_progress_at = now(),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      job_attempt = 0,
      next_attempt_at = null,
      dispatched_at = null,
      cancellation_requested_at = null,
      dead_lettered_at = null,
      last_error_class = null,
      last_error_summary = null
      -- A manual resume is a new attempt budget; provider usage counters remain
      -- cumulative for the run.
  where r.id = p_run_id
  returning * into v_run;

  return jsonb_build_object('status', 'resumed', 'run', to_jsonb(v_run));
end;
$$;

revoke all on function public.resume_generation_job(text, uuid) from public;
revoke all on function public.resume_generation_job(text, uuid) from anon;
grant execute on function public.resume_generation_job(text, uuid) to authenticated;

comment on function public.resume_generation_job(text, uuid) is
  'Owner-only resume of a failed/interrupted run. Resets the durable job-attempt budget and leaves checkpoints intact.';

commit;
