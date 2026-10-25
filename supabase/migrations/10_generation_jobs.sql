-- Mavly — durable generation jobs, checkpoints and provider observability
--
-- This migration is ADDITIVE. It does not alter authentication, project
-- ownership, snapshots or published deployments.
--
-- ⚠️ APPLY THIS BEFORE DEPLOYING THE CODE THAT READS THE NEW COLUMNS.
--    The run lifecycle lives on the existing `project_runs` row, so there is no
--    second job system: one run row is one job.
--
-- ⚠️ THERE IS STILL NO AUTONOMOUS WORKER IN THIS REPOSITORY. `create_generation_job`
--    is an atomic admission gate (one active run per project, per-user and
--    global limits, stale-slot recovery, optional idempotency key). The run is
--    started opportunistically by Next.js `after()` after the HTTP response.
--    A production deployment that needs jobs to continue after a function is
--    terminated early must add an external worker/cron that calls the resume
--    endpoint documented in the runbook; creating the table alone does NOT
--    execute anything.

-- ── Run lifecycle, heartbeats and provider metadata ─────────────────────────

alter table public.project_runs
  add column if not exists stage text;
alter table public.project_runs
  add column if not exists heartbeat_at timestamptz;
alter table public.project_runs
  add column if not exists claimed_at timestamptz;
alter table public.project_runs
  add column if not exists last_progress_at timestamptz;
alter table public.project_runs
  add column if not exists idempotency_key text;
alter table public.project_runs
  add column if not exists attempt_count integer not null default 0;
alter table public.project_runs
  add column if not exists provider_request_id text;
alter table public.project_runs
  add column if not exists model_used text;
alter table public.project_runs
  add column if not exists finish_reason text;
alter table public.project_runs
  add column if not exists prompt_tokens integer;
alter table public.project_runs
  add column if not exists completion_tokens integer;
alter table public.project_runs
  add column if not exists total_tokens integer;
alter table public.project_runs
  add column if not exists reasoning_tokens integer;
alter table public.project_runs
  add column if not exists retry_after_seconds numeric;
alter table public.project_runs
  add column if not exists error_code text;
alter table public.project_runs
  add column if not exists provider_attempts jsonb not null default '[]'::jsonb;
alter table public.project_runs
  add column if not exists generation_manifest jsonb;
alter table public.project_runs
  add column if not exists checkpoint_count integer not null default 0;
alter table public.project_runs
  add column if not exists files_written integer not null default 0;
alter table public.project_runs
  add column if not exists batch_count integer not null default 0;

-- Existing rows get a truthful stage from their old coarse status.
update public.project_runs
set stage = case status
  when 'done' then 'completed'
  when 'error' then 'failed'
  else 'queued'
end
where stage is null;

alter table public.project_runs
  alter column stage set default 'queued';
alter table public.project_runs
  alter column stage set not null;

alter table public.project_runs
  drop constraint if exists project_runs_stage_check;
alter table public.project_runs
  add constraint project_runs_stage_check check (stage in (
    'queued',
    'validating',
    'generating',
    'retrying',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ));

comment on column public.project_runs.stage is
  'Durable job stage. Active stages are queued/validating/generating/retrying. Terminal stages are completed/failed/cancelled/interrupted.';
comment on column public.project_runs.heartbeat_at is
  'Last time the worker proved it was alive. Stale active runs are closed by create_generation_job.';
comment on column public.project_runs.provider_attempts is
  'Bounded, secret-free provider attempt metadata (status, model, finish reason, tokens, request id, safe error code).';
comment on column public.project_runs.generation_manifest is
  'The validated plan, persisted so an interrupted run can resume without re-planning.';

-- One active run per project, independent of the legacy status label.
--
-- Older data may contain more than one unfinished row for a project. Close all
-- but the newest before the unique index is created; a failed index would abort
-- the whole migration and leave production without the new lifecycle.
with ranked as (
  select
    id,
    row_number() over (
      partition by project_id
      order by started_at desc, id desc
    ) as rn
  from public.project_runs
  where finished_at is null
)
update public.project_runs r
set status = 'error',
    stage = 'interrupted',
    finished_at = now(),
    last_progress_at = now(),
    error_message = coalesce(r.error_message, 'Superseded while installing generation job controls.'),
    error_code = coalesce(r.error_code, 'DUPLICATE_ACTIVE_RUN')
from ranked
where r.id = ranked.id and ranked.rn > 1;

create unique index if not exists project_runs_one_active_per_project
  on public.project_runs (project_id)
  where finished_at is null;

-- An idempotency key is scoped to one project; a repeated request returns the
-- same run instead of spending the provider twice.
create unique index if not exists project_runs_project_idempotency_idx
  on public.project_runs (project_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists project_runs_active_heartbeat_idx
  on public.project_runs (heartbeat_at)
  where finished_at is null;

-- ── Validated batch checkpoints ─────────────────────────────────────────────

create table if not exists public.project_run_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.project_runs (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  batch_index integer not null,
  paths jsonb not null default '[]'::jsonb,
  path_hashes jsonb not null default '{}'::jsonb,
  source_hash text not null default '',
  bytes integer not null default 0,
  status text not null default 'done' check (status in ('done', 'failed')),
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  unique (run_id, batch_index)
);

comment on table public.project_run_batches is
  'One atomically persisted, validated generation batch. path_hashes lets a resume verify that the project still contains exactly the content this checkpoint wrote.';

create index if not exists project_run_batches_run_idx
  on public.project_run_batches (run_id, batch_index);

create index if not exists project_run_batches_project_idx
  on public.project_run_batches (project_id, created_at desc);

alter table public.project_run_batches enable row level security;

drop policy if exists "project_run_batches_select_own" on public.project_run_batches;
create policy "project_run_batches_select_own"
  on public.project_run_batches
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_run_batches.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_run_batches_insert_own" on public.project_run_batches;
create policy "project_run_batches_insert_own"
  on public.project_run_batches
  for insert
  to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_run_batches.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_run_batches_update_own" on public.project_run_batches;
create policy "project_run_batches_update_own"
  on public.project_run_batches
  for update
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_run_batches.project_id
      and p.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_run_batches.project_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_run_batches from anon;
grant select, insert, update, delete on public.project_run_batches to authenticated;

-- Direct inserts are no longer part of the design: all runs are created by
-- `create_generation_job`, which enforces the limits under an advisory lock.
-- Leaving the old insert policy in place would let an authenticated client insert
-- runs through PostgREST and bypass admission entirely.
drop policy if exists "project_runs_insert_own" on public.project_runs;
revoke insert on public.project_runs from anon, authenticated;

-- ── Active-run limit guard ──────────────────────────────────────────────────
--
-- Updates still go through the caller's RLS-scoped client (claim, heartbeat,
-- manifest, checkpoint metadata, finish). That means a user could otherwise
-- reactivate an old finished row and consume shared capacity. This trigger
-- re-checks the limits on every transition into the active state, including a
-- resume, and is SECURITY DEFINER so the counts are not filtered by RLS.

create or replace function public.enforce_active_run_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_user_limit constant integer := 2;
  c_global_limit constant integer := 8;
  v_user uuid;
  v_active_user integer;
  v_active_global integer;
begin
  if new.finished_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.finished_at is null then
    return new;
  end if;

  -- A resume is a direct RLS update, not an RPC. Take the same lock as
  -- admission so two concurrent resumes cannot both observe a free slot.
  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  select p.user_id into v_user
  from public.projects p
  where p.project_id = new.project_id;

  if v_user is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select count(*) into v_active_user
  from public.project_runs r
  join public.projects p on p.project_id = r.project_id
  where p.user_id = v_user and r.finished_at is null and r.id <> new.id;

  if v_active_user >= c_user_limit then
    raise exception 'RATE_LIMITED_USER' using errcode = 'P0001';
  end if;

  select count(*) into v_active_global
  from public.project_runs r
  where r.finished_at is null and r.id <> new.id;

  if v_active_global >= c_global_limit then
    raise exception 'RATE_LIMITED_GLOBAL' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_active_run_limit() from public;
revoke all on function public.enforce_active_run_limit() from anon;
-- Trigger functions cannot be called directly; this keeps runtime trigger
-- invocation compatible with the caller's role.
grant execute on function public.enforce_active_run_limit() to authenticated;

drop trigger if exists project_runs_active_limit on public.project_runs;
create trigger project_runs_active_limit
before insert or update of finished_at, stage on public.project_runs
for each row execute function public.enforce_active_run_limit();

comment on function public.enforce_active_run_limit() is
  'Re-checks the per-user and global active-run limits whenever a run enters or leaves the active state.';

-- ── Atomic admission ────────────────────────────────────────────────────────
--
-- The browser cannot count other users' runs (RLS), so a per-request counter is
-- not enough for a global limit. This SECURITY DEFINER function is the single
-- admission gate. It:
--
--   · verifies auth.uid() and project ownership itself;
--   · recovers stale unfinished runs (heartbeat older than 10 minutes) so a
--     crashed serverless invocation cannot hold a slot forever;
--   · returns the existing run for a repeated idempotency key;
--   · refuses a second active run for the same project;
--   · enforces a conservative per-user and global active-run limit atomically.
--
-- ⚠️ THE LIMITS ARE SERVER CONSTANTS, NOT FUNCTION ARGUMENTS. If they were
--    caller parameters, an authenticated user could call the RPC directly and
--    bypass them. 2 active runs per user / 8 globally are conservative defaults
--    pending measured provider quotas; change them in this function (a
--    migration) after capacity is verified.
--
-- The returned `status` is one of: created | existing | conflict | rate_limited.

create or replace function public.create_generation_job(
  p_project_id text,
  p_model text,
  p_prompt text,
  p_idempotency_key text default null
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
  v_run public.project_runs;
  v_active_user integer;
  v_active_global integer;
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

  -- Admission is a read-count-insert sequence. Serialize it across the whole
  -- instance, otherwise two concurrent starts for different projects can both
  -- observe a free global slot and exceed the limit. The lock is transaction
  -- scoped, so it is released on return or error.
  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  -- Stale recovery: a run that stopped heartbeating is no longer active.
  update public.project_runs r
  set status = 'error',
      stage = 'interrupted',
      finished_at = now(),
      last_progress_at = now(),
      error_message = coalesce(r.error_message, 'The run was interrupted before completion.'),
      error_code = coalesce(r.error_code, 'RUN_INTERRUPTED')
  where r.finished_at is null
    and coalesce(r.heartbeat_at, r.started_at) < now() - c_stale;

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
    project_id, status, stage, model, prompt, idempotency_key, heartbeat_at, last_progress_at
  ) values (
    p_project_id,
    'init',
    'queued',
    p_model,
    left(p_prompt, 32000),
    v_key,
    now(),
    now()
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

comment on function public.create_generation_job(text, text, text, text) is
  'Atomic generation admission: ownership, stale recovery, idempotency, one active run per project, per-user and global limits.';

revoke all on function public.create_generation_job(text, text, text, text) from public;
revoke all on function public.create_generation_job(text, text, text, text) from anon;
grant execute on function public.create_generation_job(text, text, text, text) to authenticated;
