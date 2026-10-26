-- Mavly — isolated verification sandbox: durable verification state
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- A generation run ends with a durable, immutable snapshot. Phase 3 answers the
-- next question honestly: does that snapshot actually build? The build cannot
-- run inside the generation HTTP request, so verification is its own durable,
-- leased work item:
--
--   ENQUEUE    After a worker generation run completes, one verification row is
--              created for that run and its snapshot. It is idempotent on
--              `run_id`; a duplicate completion cannot create a second build.
--   CLAIM      A worker tick claims one queued row (or reattaches to a row whose
--              sandbox is already running) with `FOR UPDATE SKIP LOCKED` and a
--              fencing lease token.
--   STAGES     `preparing` → `installing` → `building` → terminal. The provider
--              runs install/build detached, so each stage can span ticks. The
--              row records the sandbox reference before the build starts.
--   RECOVER    An expired lease is recovered without ever launching a second
--              sandbox for the same row: a build that already has a sandbox is
--              continued, not duplicated. Past the deadline it becomes
--              `timed_out`.
--   CLEANUP    Every terminal row keeps its sandbox reference until cleanup is
--              confirmed. `cleanup_complete = false` is the durable orphan
--              queue; a cleanup failure never overwrites the build outcome.
--   CANCEL     An owner can cancel through an authenticated RPC. It never
--              deletes history and never pretends the sandbox is gone.
--
-- ═══ SECURITY ════════════════════════════════════════════════════════════════
--
--   · Users may SELECT only their own rows, through `public.projects` RLS.
--   · Users may not INSERT, UPDATE or DELETE. The worker RPCs are executable
--     only by `service_role`. `cancel_verification` is the one owner-facing
--     mutation and verifies ownership inside the function.
--   · Lease tokens, worker ids and raw provider sandbox ids are not part of the
--     authenticated column grant.
--   · Diagnostics are bounded JSON text. They are already sanitized by the
--     application; the function re-checks the shape and size.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and idempotent. Nothing in `project_runs`, `project_files`,
-- `project_snapshots` or the hosting tables is changed or deleted. Apply after
-- migration 16. The feature stays off until
-- `MAVLY_VERIFICATION_SANDBOX_ENABLED` and an explicit project cohort are set.
--
-- See `docs/architecture/phase-3-verification-sandbox.md` and
-- `docs/runbooks/verification-sandbox.md`.

begin;

-- ── 1. Verification rows ────────────────────────────────────────────────────

create table if not exists public.project_verifications (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id uuid not null references public.project_runs (id) on delete cascade,
  snapshot_id uuid not null references public.project_snapshots (id) on delete cascade,
  source_hash text not null,
  status text not null default 'queued' check (status in (
    'queued',
    'preparing',
    'installing',
    'building',
    'passed',
    'failed',
    'timed_out',
    'cancelled',
    'unsupported_runtime',
    'configuration_error',
    'infrastructure_error'
  )),
  attempt integer not null default 0,
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  provider text check (provider is null or provider in ('vercel', 'e2b')),
  sandbox_id text,
  exit_code integer,
  error_class text,
  summary text,
  diagnostics jsonb not null default '[]'::jsonb,
  diagnostics_truncated boolean not null default false,
  cleanup_complete boolean not null default false,
  cleanup_attempts integer not null default 0,
  partial boolean not null default false,
  trace_id text,
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  stage_started_at timestamptz,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  deadline_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint project_verifications_attempt_check
    check (attempt >= 0 and attempt <= max_attempts),
  constraint project_verifications_source_hash_check
    check (source_hash ~ '^[a-f0-9]{64}$'),
  constraint project_verifications_sandbox_id_check
    check (sandbox_id is null or sandbox_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  constraint project_verifications_diagnostics_check
    check (jsonb_typeof(diagnostics) = 'array' and jsonb_array_length(diagnostics) <= 80),
  constraint project_verifications_error_class_check
    check (error_class is null or length(error_class) <= 80),
  constraint project_verifications_summary_check
    check (summary is null or length(summary) <= 400),
  constraint project_verifications_cleanup_attempts_check
    check (cleanup_attempts between 0 and 20)
);

comment on table public.project_verifications is
  'Durable, leased, isolated verification of one completed generation run. One row per run; the build runs in a managed microVM, never on the Mavly server.';
comment on column public.project_verifications.status is
  'queued/preparing/installing/building are in flight; the rest are terminal. passed means the production build exited 0, not that a preview was reached.';
comment on column public.project_verifications.sandbox_id is
  'Opaque provider sandbox reference, retained until cleanup is confirmed. Never returned through the authenticated column grant.';
comment on column public.project_verifications.deadline_at is
  'Hard deadline for this verification, set at claim. Past it the row becomes timed_out even if a sandbox still exists.';
comment on column public.project_verifications.cleanup_complete is
  'True only after the provider confirmed the sandbox is gone (or reported it absent). A false value is the orphan cleanup queue.';
comment on column public.project_verifications.partial is
  'True when the outcome is terminal but a non-essential part (for example full diagnostics) was not obtained. Never used to imply success.';

-- Idempotent enqueue: one verification per generation run.
create unique index if not exists project_verifications_run_uidx
  on public.project_verifications (run_id);

create index if not exists project_verifications_queue_idx
  on public.project_verifications (enqueued_at)
  where finished_at is null;

create index if not exists project_verifications_lease_idx
  on public.project_verifications (lease_expires_at)
  where finished_at is null and lease_token is not null;

create index if not exists project_verifications_cleanup_idx
  on public.project_verifications (updated_at)
  where finished_at is not null and cleanup_complete = false and sandbox_id is not null;

create index if not exists project_verifications_project_idx
  on public.project_verifications (project_id, enqueued_at desc);

create index if not exists project_verifications_user_idx
  on public.project_verifications (user_id)
  where finished_at is null;

-- ── 2. RLS and least-privilege grants ───────────────────────────────────────

alter table public.project_verifications enable row level security;

drop policy if exists "project_verifications_select_own" on public.project_verifications;
create policy "project_verifications_select_own"
  on public.project_verifications
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_verifications.project_id
      and p.user_id = (select auth.uid())
  ));

-- No INSERT/UPDATE/DELETE policies and no table-wide grant for users.
revoke all on public.project_verifications from anon, authenticated;
grant select (
  id,
  project_id,
  run_id,
  snapshot_id,
  source_hash,
  status,
  attempt,
  max_attempts,
  provider,
  exit_code,
  error_class,
  summary,
  diagnostics,
  diagnostics_truncated,
  cleanup_complete,
  partial,
  trace_id,
  enqueued_at,
  started_at,
  finished_at,
  deadline_at,
  stage_started_at,
  updated_at
) on public.project_verifications to authenticated;

grant all on public.project_verifications to service_role;

-- ── 3. Schema marker / preflight ────────────────────────────────────────────

create or replace function public.verification_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 17;
$$;

revoke all on function public.verification_schema_version() from public;
revoke all on function public.verification_schema_version() from anon;
grant execute on function public.verification_schema_version() to authenticated, service_role;

comment on function public.verification_schema_version() is
  'Verification-sandbox schema marker. 17 means durable verification, leases and cleanup state are installed.';

-- ── 4. Enqueue one verification for a completed run ─────────────────────────

create or replace function public.enqueue_verification(
  p_project_id text,
  p_run_id uuid,
  p_snapshot_id uuid,
  p_source_hash text,
  p_provider text,
  p_trace_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_project_limit constant integer := 1;
  c_user_limit constant integer := 2;
  c_global_limit constant integer := 8;
  c_max_attempts constant integer := 2;
  v_run public.project_runs;
  v_snapshot public.project_snapshots;
  v_user uuid;
  v_active integer;
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('vercel', 'e2b') then
    raise exception 'INVALID_PROVIDER' using errcode = '22023';
  end if;
  if p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'INVALID_SOURCE_HASH' using errcode = '22023';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id and r.project_id = p_project_id;

  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_run.stage <> 'completed' or v_run.finished_at is null then
    raise exception 'RUN_NOT_COMPLETED' using errcode = '22023';
  end if;

  select p.user_id into v_user
  from public.projects p
  where p.project_id = p_project_id;
  if v_user is null then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_snapshot
  from public.project_snapshots s
  where s.id = p_snapshot_id
    and s.project_id = p_project_id
    and s.run_id = p_run_id
    and s.status = 'ready';

  if not found then
    raise exception 'SNAPSHOT_NOT_VERIFIABLE' using errcode = '22023';
  end if;
  if v_snapshot.source_hash <> p_source_hash then
    raise exception 'SNAPSHOT_MISMATCH' using errcode = '22023';
  end if;

  -- Idempotency first: a duplicate completion must never create a second build.
  select * into v_row
  from public.project_verifications v
  where v.run_id = p_run_id;
  if found then
    return jsonb_build_object('status', 'existing', 'verification', to_jsonb(v_row));
  end if;

  select count(*) into v_active
  from public.project_verifications v
  where v.project_id = p_project_id and v.finished_at is null;
  if v_active >= c_project_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'project', 'retryAfterSeconds', 60);
  end if;

  select count(*) into v_active
  from public.project_verifications v
  where v.user_id = v_user and v.finished_at is null;
  if v_active >= c_user_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'user', 'retryAfterSeconds', 60);
  end if;

  select count(*) into v_active
  from public.project_verifications v
  where v.finished_at is null;
  if v_active >= c_global_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'global', 'retryAfterSeconds', 60);
  end if;

  insert into public.project_verifications (
    project_id, user_id, run_id, snapshot_id, source_hash,
    status, max_attempts, provider, trace_id
  ) values (
    p_project_id,
    v_user,
    p_run_id,
    p_snapshot_id,
    p_source_hash,
    'queued',
    c_max_attempts,
    p_provider,
    nullif(left(btrim(coalesce(p_trace_id, '')), 64), '')
  )
  on conflict (run_id) do nothing
  returning * into v_row;

  if not found then
    select * into v_row
    from public.project_verifications v
    where v.run_id = p_run_id;
    return jsonb_build_object('status', 'existing', 'verification', to_jsonb(v_row));
  end if;

  return jsonb_build_object('status', 'created', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text) from public;
revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text) from anon;
revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text) from authenticated;
grant execute on function public.enqueue_verification(text, uuid, uuid, text, text, text) to service_role;

comment on function public.enqueue_verification(text, uuid, uuid, text, text, text) is
  'Service-role only. Enqueues one verification for a completed run and its immutable snapshot; idempotent on run_id and bounded by project/user/global caps.';

-- ── 5. Claim: a new row or a continuation of a detached stage ───────────────

create or replace function public.claim_verification(
  p_worker_id text,
  p_lease_seconds integer default 120,
  p_project_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_deadline interval := interval '20 minutes';
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 300));
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 120);
  v_row public.project_verifications;
  v_mode text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_worker = '' then
    raise exception 'INVALID_WORKER' using errcode = '22023';
  end if;

  select v.* into v_row
  from public.project_verifications v
  where v.finished_at is null
    and (
      (v.status = 'queued' and v.attempt < v.max_attempts)
      or
      (
        v.status in ('preparing', 'installing', 'building')
        and v.sandbox_id is not null
        and (v.lease_token is null or v.lease_expires_at is null or v.lease_expires_at < now())
        and (v.deadline_at is null or v.deadline_at > now())
      )
    )
    and (p_project_ids is null or v.project_id = any (p_project_ids))
    and exists (select 1 from public.projects p where p.project_id = v.project_id)
  order by v.enqueued_at, v.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  v_mode := case when v_row.status = 'queued' then 'new' else 'continue' end;

  update public.project_verifications v
  set status = case when v_mode = 'new' then 'preparing' else v.status end,
      attempt = case when v_mode = 'new' then v.attempt + 1 else v.attempt end,
      started_at = coalesce(v.started_at, now()),
      stage_started_at = case when v_mode = 'new' then now() else v.stage_started_at end,
      deadline_at = coalesce(v.deadline_at, now() + c_deadline),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      worker_id = v_worker,
      exit_code = case when v_mode = 'new' then null else v.exit_code end,
      updated_at = now()
  where v.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'status', 'claimed',
    'mode', v_mode,
    'lease_seconds', v_lease,
    'verification', to_jsonb(v_row)
  );
end;
$$;

revoke all on function public.claim_verification(text, integer, text[]) from public;
revoke all on function public.claim_verification(text, integer, text[]) from anon;
revoke all on function public.claim_verification(text, integer, text[]) from authenticated;
grant execute on function public.claim_verification(text, integer, text[]) to service_role;

comment on function public.claim_verification(text, integer, text[]) is
  'Service-role only. Claims a queued verification or reattaches to one whose sandbox is live. Never starts a second sandbox for the same row.';

-- ── 6. Stage note, renewal and deliberate lease release ────────────────────

create or replace function public.note_verification_stage(
  p_verification_id uuid,
  p_lease_token uuid,
  p_status text,
  p_sandbox_id text default null,
  p_exit_code integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('preparing', 'installing', 'building') then
    raise exception 'INVALID_STAGE' using errcode = '22023';
  end if;

  update public.project_verifications v
  set status = p_status,
      sandbox_id = coalesce(p_sandbox_id, v.sandbox_id),
      exit_code = coalesce(p_exit_code, v.exit_code),
      stage_started_at = now(),
      updated_at = now()
  where v.id = p_verification_id
    and v.lease_token = p_lease_token
    and v.finished_at is null
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'noted', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.note_verification_stage(uuid, uuid, text, text, integer) from public;
revoke all on function public.note_verification_stage(uuid, uuid, text, text, integer) from anon;
revoke all on function public.note_verification_stage(uuid, uuid, text, text, integer) from authenticated;
grant execute on function public.note_verification_stage(uuid, uuid, text, text, integer) to service_role;

create or replace function public.renew_verification_lease(
  p_verification_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 300));
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_verifications v
  set lease_expires_at = now() + make_interval(secs => v_lease),
      updated_at = now()
  where v.id = p_verification_id
    and v.lease_token = p_lease_token
    and v.finished_at is null
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'renewed', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.renew_verification_lease(uuid, uuid, integer) from public;
revoke all on function public.renew_verification_lease(uuid, uuid, integer) from anon;
revoke all on function public.renew_verification_lease(uuid, uuid, integer) from authenticated;
grant execute on function public.renew_verification_lease(uuid, uuid, integer) to service_role;

create or replace function public.release_verification(
  p_verification_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_verifications v
  set lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where v.id = p_verification_id
    and v.lease_token = p_lease_token
    and v.finished_at is null;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'released');
end;
$$;

revoke all on function public.release_verification(uuid, uuid) from public;
revoke all on function public.release_verification(uuid, uuid) from anon;
revoke all on function public.release_verification(uuid, uuid) from authenticated;
grant execute on function public.release_verification(uuid, uuid) to service_role;

comment on function public.release_verification(uuid, uuid) is
  'Service-role only. Ends a tick without ending the verification: the detached stage keeps running and a later tick reattaches under a new lease.';

-- ── 7. Terminal completion (idempotent, fenced) ────────────────────────────

create or replace function public.complete_verification(
  p_verification_id uuid,
  p_lease_token uuid,
  p_status text,
  p_exit_code integer,
  p_error_class text,
  p_summary text,
  p_diagnostics jsonb,
  p_diagnostics_truncated boolean,
  p_partial boolean,
  p_cleanup_complete boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_verifications;
  v_class text := nullif(left(btrim(coalesce(p_error_class, '')), 80), '');
  v_summary text := nullif(left(btrim(coalesce(p_summary, '')), 400), '');
  v_diagnostics jsonb := coalesce(p_diagnostics, '[]'::jsonb);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in (
    'passed', 'failed', 'timed_out', 'cancelled', 'unsupported_runtime',
    'configuration_error', 'infrastructure_error'
  ) then
    raise exception 'INVALID_TERMINAL_STATUS' using errcode = '22023';
  end if;
  if jsonb_typeof(v_diagnostics) <> 'array' or jsonb_array_length(v_diagnostics) > 80 then
    raise exception 'INVALID_DIAGNOSTICS' using errcode = '22023';
  end if;

  select * into v_row
  from public.project_verifications v
  where v.id = p_verification_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.finished_at is not null then
    -- A duplicate completion is a no-op, never a second result.
    return jsonb_build_object('status', 'already_terminal', 'verification', to_jsonb(v_row));
  end if;
  if v_row.lease_token is null or v_row.lease_token <> p_lease_token then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  update public.project_verifications v
  set status = p_status,
      exit_code = p_exit_code,
      error_class = v_class,
      summary = v_summary,
      diagnostics = v_diagnostics,
      diagnostics_truncated = coalesce(p_diagnostics_truncated, false),
      partial = coalesce(p_partial, false),
      cleanup_complete = (v.sandbox_id is null) or coalesce(p_cleanup_complete, false),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      finished_at = now(),
      updated_at = now()
  where v.id = p_verification_id
  returning * into v_row;

  return jsonb_build_object('status', 'completed', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.complete_verification(uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean) from public;
revoke all on function public.complete_verification(uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean) from anon;
revoke all on function public.complete_verification(uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean) from authenticated;
grant execute on function public.complete_verification(uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean) to service_role;

comment on function public.complete_verification(uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean) is
  'Service-role only. Fenced terminal write. A duplicate completion returns already_terminal; cleanup failure never overwrites the build outcome.';

-- ── 8. Recovery: expired leases and deadlines ──────────────────────────────

create or replace function public.recover_expired_verification_leases(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_row public.project_verifications;
  v_results jsonb := '[]'::jsonb;
  v_outcome text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_row in
    select v.*
    from public.project_verifications v
    where v.finished_at is null
      and (
        (v.deadline_at is not null and v.deadline_at < now())
        or (v.lease_token is not null and v.lease_expires_at is not null and v.lease_expires_at < now())
      )
    order by coalesce(v.deadline_at, v.lease_expires_at)
    for update skip locked
    limit v_limit
  loop
    if v_row.deadline_at is not null and v_row.deadline_at < now() then
      update public.project_verifications v
      set status = 'timed_out',
          error_class = 'timeout',
          summary = 'Verification passed its hard deadline and was stopped.',
          finished_at = now(),
          deadline_at = null,
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (v.sandbox_id is null),
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'timed_out';
    elsif v_row.status in ('preparing', 'installing', 'building')
          and v_row.sandbox_id is not null then
      -- The build may still be running. Hand it to the next tick unchanged.
      update public.project_verifications v
      set lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'released';
    elsif v_row.attempt < v_row.max_attempts and v_row.sandbox_id is null then
      update public.project_verifications v
      set status = 'queued',
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          stage_started_at = null,
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'requeued';
    else
      update public.project_verifications v
      set status = 'infrastructure_error',
          error_class = 'provider_error',
          summary = 'The verification worker stopped before the build finished.',
          finished_at = now(),
          deadline_at = null,
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (v.sandbox_id is null),
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'infrastructure_error';
    end if;

    v_results := v_results || jsonb_build_object(
      'verificationId', v_row.id,
      'outcome', v_outcome
    );
  end loop;

  return jsonb_build_object('recovered', v_results);
end;
$$;

revoke all on function public.recover_expired_verification_leases(integer) from public;
revoke all on function public.recover_expired_verification_leases(integer) from anon;
revoke all on function public.recover_expired_verification_leases(integer) from authenticated;
grant execute on function public.recover_expired_verification_leases(integer) to service_role;

comment on function public.recover_expired_verification_leases(integer) is
  'Service-role only. Expires deadlines, releases recoverable sandboxes and dead-letters the rest. It never deletes a row or starts a second sandbox.';

-- ── 9. Orphan cleanup: durable, bounded, outcome-preserving ────────────────

create or replace function public.claim_verification_cleanup(
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_attempts constant integer := 5;
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 20));
  v_rows jsonb := '[]'::jsonb;
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_row in
    select v.*
    from public.project_verifications v
    where v.finished_at is not null
      and v.cleanup_complete = false
      and v.sandbox_id is not null
      and v.cleanup_attempts < c_max_attempts
    order by v.updated_at
    for update skip locked
    limit v_limit
  loop
    update public.project_verifications v
    set cleanup_attempts = v.cleanup_attempts + 1,
        updated_at = now()
    where v.id = v_row.id;

    v_rows := v_rows || jsonb_build_object(
      'verificationId', v_row.id,
      'provider', v_row.provider,
      'sandboxId', v_row.sandbox_id,
      'cleanupAttempts', v_row.cleanup_attempts + 1
    );
  end loop;

  return jsonb_build_object('candidates', v_rows);
end;
$$;

revoke all on function public.claim_verification_cleanup(integer) from public;
revoke all on function public.claim_verification_cleanup(integer) from anon;
revoke all on function public.claim_verification_cleanup(integer) from authenticated;
grant execute on function public.claim_verification_cleanup(integer) to service_role;

create or replace function public.mark_verification_cleanup(
  p_verification_id uuid,
  p_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_verifications v
  set cleanup_complete = coalesce(p_confirmed, false),
      updated_at = now()
  where v.id = p_verification_id
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object(
    'status', case when v_row.cleanup_complete then 'confirmed' else 'pending' end,
    'cleanupAttempts', v_row.cleanup_attempts
  );
end;
$$;

revoke all on function public.mark_verification_cleanup(uuid, boolean) from public;
revoke all on function public.mark_verification_cleanup(uuid, boolean) from anon;
revoke all on function public.mark_verification_cleanup(uuid, boolean) from authenticated;
grant execute on function public.mark_verification_cleanup(uuid, boolean) to service_role;

comment on function public.claim_verification_cleanup(integer) is
  'Service-role only. Returns terminal rows whose sandbox was not confirmed destroyed. Cleanup is retried at most five times; the row is preserved for operator review.';

-- ── 10. Owner cancellation ──────────────────────────────────────────────────

create or replace function public.cancel_verification(
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
  v_row public.project_verifications;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_uid is null then
      raise exception 'UNAUTHENTICATED' using errcode = '28000';
    end if;
    if not exists (
      select 1 from public.projects p
      where p.project_id = p_project_id and p.user_id = v_uid
    ) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  end if;

  select * into v_row
  from public.project_verifications v
  where v.project_id = p_project_id and v.run_id = p_run_id
  for update;

  if not found then
    return jsonb_build_object('status', 'none');
  end if;
  if v_row.finished_at is not null then
    return jsonb_build_object('status', 'already_terminal', 'verification', to_jsonb(v_row));
  end if;

  update public.project_verifications v
  set status = 'cancelled',
      error_class = 'cancelled',
      summary = 'Verification was cancelled by the project owner.',
      finished_at = now(),
      deadline_at = null,
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      cleanup_complete = (v.sandbox_id is null),
      updated_at = now()
  where v.id = v_row.id
  returning * into v_row;

  return jsonb_build_object('status', 'cancelled', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.cancel_verification(text, uuid) from public;
revoke all on function public.cancel_verification(text, uuid) from anon;
grant execute on function public.cancel_verification(text, uuid) to authenticated, service_role;

comment on function public.cancel_verification(text, uuid) is
  'Owner-only cancellation. The sandbox reference is retained until the worker confirms deletion; cancellation never fabricates cleanup.';

commit;
