-- ═══════════════════════════════════════════════════════════════════════════
-- MAVLY PHASE 4 — RUNTIME VERIFICATION, BOUNDED REPAIR AND PREVIEW STATUS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Additive to migration 17 (and to 14/15/16). It does NOT replace the durable
-- verification queue; it adds the runtime, health, preview-status and bounded
-- repair state that the same worker tick advances.
--
-- ⚠️ `passed` BECOMES STRONGER. The terminal write rejects it unless the build
-- passed, the runtime served, and a sandbox-local health request succeeded.
--
-- ⚠️ PREVIEW STAYS UNAVAILABLE. The provider can mint a public URL for a
-- sandbox port, and Mavly has no authenticated proxy in front of it. This
-- migration stores only a status/reason pair — never a URL.
--
-- ⚠️ A REPAIR IS A NEW IMMUTABLE SNAPSHOT, NOT AN EDIT TO THE PROJECT. The
-- original snapshot and hash remain addressable for audit.
--
-- Apply with `supabase db push` or the project's migration runner. It is
-- idempotent on re-run except for the RPC replacements, which are
-- `create or replace`.

begin;

-- ── 1. Verification row: build / runtime / health / preview / repair ───────

alter table public.project_verifications
  drop constraint if exists project_verifications_status_check;

alter table public.project_verifications
  add constraint project_verifications_status_check check (status in (
    'queued',
    'preparing',
    'installing',
    'building',
    'runtime_starting',
    'health_checking',
    'repairing',
    'passed',
    'failed',
    'timed_out',
    'cancelled',
    'unsupported_runtime',
    'configuration_error',
    'infrastructure_error'
  ));

alter table public.project_verifications
  add column if not exists effective_snapshot_id uuid
    references public.project_snapshots (id) on delete set null,
  add column if not exists effective_source_hash text,
  add column if not exists build_passed boolean,
  add column if not exists runtime_started boolean,
  add column if not exists health_passed boolean,
  add column if not exists runtime_profile text,
  add column if not exists runtime_port integer,
  add column if not exists runtime_exit_code integer,
  add column if not exists health_http_status integer,
  add column if not exists runtime_started_at timestamptz,
  add column if not exists runtime_finished_at timestamptz,
  add column if not exists health_checked_at timestamptz,
  add column if not exists preview_status text not null default 'unavailable',
  add column if not exists preview_reason text,
  add column if not exists repair_attempts integer not null default 0,
  add column if not exists repair_max_attempts integer not null default 1,
  add column if not exists repair_status text not null default 'none',
  add column if not exists repaired_snapshot_id uuid
    references public.project_snapshots (id) on delete set null;

-- Existing rows verified only a build. Backfill the effective snapshot so the
-- unchanged Phase 3 rows remain resolvable without guessing.
update public.project_verifications v
set effective_snapshot_id = coalesce(v.effective_snapshot_id, v.snapshot_id),
    effective_source_hash = coalesce(v.effective_source_hash, v.source_hash)
where v.effective_snapshot_id is null or v.effective_source_hash is null;

alter table public.project_verifications
  drop constraint if exists project_verifications_effective_source_hash_check,
  drop constraint if exists project_verifications_runtime_profile_check,
  drop constraint if exists project_verifications_runtime_port_check,
  drop constraint if exists project_verifications_runtime_exit_check,
  drop constraint if exists project_verifications_health_http_check,
  drop constraint if exists project_verifications_preview_status_check,
  drop constraint if exists project_verifications_preview_reason_check,
  drop constraint if exists project_verifications_repair_attempts_check,
  drop constraint if exists project_verifications_repair_max_attempts_check,
  drop constraint if exists project_verifications_repair_status_check;

alter table public.project_verifications
  add constraint project_verifications_effective_source_hash_check
    check (effective_source_hash is null or effective_source_hash ~ '^[a-f0-9]{64}$'),
  add constraint project_verifications_runtime_profile_check
    check (runtime_profile is null or runtime_profile in ('next-app-router')),
  add constraint project_verifications_runtime_port_check
    check (runtime_port is null or runtime_port between 1024 and 65535),
  add constraint project_verifications_runtime_exit_check
    check (runtime_exit_code is null or runtime_exit_code between -1 and 255),
  add constraint project_verifications_health_http_check
    check (health_http_status is null or health_http_status between 100 and 599),
  add constraint project_verifications_preview_status_check
    check (preview_status in ('unavailable', 'disabled')),
  add constraint project_verifications_preview_reason_check
    check (preview_reason is null or length(preview_reason) <= 400),
  add constraint project_verifications_repair_attempts_check
    check (repair_attempts between 0 and 2),
  add constraint project_verifications_repair_max_attempts_check
    check (repair_max_attempts between 0 and 2),
  add constraint project_verifications_repair_status_check
    check (repair_status in ('none', 'requested', 'applied', 'failed', 'rejected', 'ineligible'));

comment on column public.project_verifications.status is
  'queued/preparing/installing/building/runtime_starting/health_checking/repairing are in flight. passed requires build_passed AND runtime_started AND health_passed; it never implies deployment, preview or correctness.';
comment on column public.project_verifications.preview_status is
  'unavailable or disabled only. No provider URL is ever stored; an authenticated preview proxy does not exist yet.';
comment on column public.project_verifications.repair_attempts is
  'Applied or attempted bounded AI repairs for this verification. Hard-capped at 2 by constraint.';
comment on column public.project_verifications.effective_snapshot_id is
  'The snapshot currently being built: the original, or the newest immutable repair snapshot.';

-- ── 2. Immutable repair attempts ───────────────────────────────────────────

create table if not exists public.project_verification_repairs (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null
    references public.project_verifications (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  run_id uuid not null references public.project_runs (id) on delete cascade,
  attempt integer not null check (attempt between 1 and 2),
  status text not null default 'requested'
    check (status in ('requested', 'applied', 'failed', 'rejected')),
  original_snapshot_id uuid not null
    references public.project_snapshots (id) on delete cascade,
  repaired_snapshot_id uuid
    references public.project_snapshots (id) on delete set null,
  original_hash text not null check (original_hash ~ '^[a-f0-9]{64}$'),
  repaired_hash text check (repaired_hash is null or repaired_hash ~ '^[a-f0-9]{64}$'),
  model text check (model is null or length(model) <= 120),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  cost_usd numeric(18, 8) check (cost_usd is null or cost_usd >= 0),
  cost_known boolean not null default false,
  error_class text check (error_class is null or length(error_class) <= 80),
  summary text check (summary is null or length(summary) <= 400),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (verification_id, attempt)
);

create index if not exists project_verification_repairs_verification_idx
  on public.project_verification_repairs (verification_id, attempt);

comment on table public.project_verification_repairs is
  'One row per bounded AI repair attempt. A repaired snapshot is immutable and never applied to the user project by verification.';
comment on column public.project_verification_repairs.cost_usd is
  'The provider-reported cost only. NULL with cost_known = false means unknown; no rate card is ever applied.';

alter table public.project_verification_repairs enable row level security;

drop policy if exists "project_verification_repairs_select_own"
  on public.project_verification_repairs;
create policy "project_verification_repairs_select_own"
  on public.project_verification_repairs
  for select
  to authenticated
  using (exists (
    select 1
    from public.project_verifications v
    join public.projects p on p.project_id = v.project_id
    where v.id = project_verification_repairs.verification_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_verification_repairs from anon, authenticated;
grant select (
  id,
  verification_id,
  project_id,
  run_id,
  attempt,
  status,
  repaired_snapshot_id,
  model,
  prompt_tokens,
  completion_tokens,
  cost_usd,
  cost_known,
  error_class,
  summary,
  started_at,
  finished_at
) on public.project_verification_repairs to authenticated;
grant all on public.project_verification_repairs to service_role;

-- ── 3. Public verification columns ─────────────────────────────────────────

revoke all on public.project_verifications from anon, authenticated;
grant select (
  id,
  project_id,
  run_id,
  snapshot_id,
  source_hash,
  effective_snapshot_id,
  effective_source_hash,
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
  updated_at,
  build_passed,
  runtime_started,
  health_passed,
  runtime_profile,
  runtime_port,
  runtime_exit_code,
  health_http_status,
  runtime_started_at,
  runtime_finished_at,
  health_checked_at,
  preview_status,
  preview_reason,
  repair_attempts,
  repair_max_attempts,
  repair_status,
  repaired_snapshot_id
) on public.project_verifications to authenticated;

grant all on public.project_verifications to service_role;

-- ── 4. Snapshot kind for an immutable repair result ────────────────────────

alter table public.project_snapshots
  drop constraint if exists project_snapshots_kind_check;
alter table public.project_snapshots
  add constraint project_snapshots_kind_check
  check (kind in ('baseline', 'result', 'pre_restore', 'import', 'manual', 'repair'));

-- ── 5. Schema marker / preflight ───────────────────────────────────────────

create or replace function public.verification_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 19;
$$;

revoke all on function public.verification_schema_version() from public;
revoke all on function public.verification_schema_version() from anon;
grant execute on function public.verification_schema_version() to authenticated, service_role;

comment on function public.verification_schema_version() is
  'Verification schema marker. 19 means runtime/health/preview-status/repair state and fenced repair RPCs are installed.';

-- ── 6. Enqueue with the persisted repair budget ────────────────────────────

drop function if exists public.enqueue_verification(
  text, uuid, uuid, text, text, text
);

create or replace function public.enqueue_verification(
  p_project_id text,
  p_run_id uuid,
  p_snapshot_id uuid,
  p_source_hash text,
  p_provider text,
  p_trace_id text default null,
  p_max_repairs integer default 1
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
  c_repair_hard_max constant integer := 2;
  v_run public.project_runs;
  v_snapshot public.project_snapshots;
  v_user uuid;
  v_active integer;
  v_repairs integer := greatest(0, least(coalesce(p_max_repairs, 1), c_repair_hard_max));
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
    effective_snapshot_id, effective_source_hash,
    status, max_attempts, provider, trace_id,
    repair_max_attempts, preview_status
  ) values (
    p_project_id,
    v_user,
    p_run_id,
    p_snapshot_id,
    p_source_hash,
    p_snapshot_id,
    p_source_hash,
    'queued',
    c_max_attempts,
    p_provider,
    nullif(left(btrim(coalesce(p_trace_id, '')), 64), ''),
    v_repairs,
    'unavailable'
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

revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text, integer) from public;
revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text, integer) from anon;
revoke all on function public.enqueue_verification(text, uuid, uuid, text, text, text, integer) from authenticated;
grant execute on function public.enqueue_verification(text, uuid, uuid, text, text, text, integer) to service_role;

comment on function public.enqueue_verification(text, uuid, uuid, text, text, text, integer) is
  'Service-role only. Enqueues one verification for a completed run and its immutable snapshot, with a persisted bounded repair budget; idempotent on run_id and bounded by project/user/global caps.';

-- ── 7. Claim: new row or continuation of a detached build/runtime stage ────

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
  c_deadline interval := interval '26 minutes';
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
        v.status in (
          'preparing', 'installing', 'building',
          'runtime_starting', 'health_checking'
        )
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
      effective_snapshot_id = coalesce(v.effective_snapshot_id, v.snapshot_id),
      effective_source_hash = coalesce(v.effective_source_hash, v.source_hash),
      -- A new claim begins a fresh build against the effective snapshot. It
      -- must not show the previous failure or a previous sandbox's result.
      exit_code = case when v_mode = 'new' then null else v.exit_code end,
      runtime_profile = case when v_mode = 'new' then null else v.runtime_profile end,
      runtime_port = case when v_mode = 'new' then null else v.runtime_port end,
      runtime_exit_code = case when v_mode = 'new' then null else v.runtime_exit_code end,
      health_http_status = case when v_mode = 'new' then null else v.health_http_status end,
      build_passed = case when v_mode = 'new' then null else v.build_passed end,
      runtime_started = case when v_mode = 'new' then null else v.runtime_started end,
      health_passed = case when v_mode = 'new' then null else v.health_passed end,
      runtime_started_at = case when v_mode = 'new' then null else v.runtime_started_at end,
      runtime_finished_at = case when v_mode = 'new' then null else v.runtime_finished_at end,
      health_checked_at = case when v_mode = 'new' then null else v.health_checked_at end,
      error_class = case when v_mode = 'new' then null else v.error_class end,
      summary = case when v_mode = 'new' then null else v.summary end,
      diagnostics = case when v_mode = 'new' then '[]'::jsonb else v.diagnostics end,
      diagnostics_truncated = case when v_mode = 'new' then false else v.diagnostics_truncated end,
      preview_status = 'unavailable',
      preview_reason = case when v_mode = 'new' then null else v.preview_reason end,
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
  'Service-role only. Claims a queued verification or reattaches to a live build/runtime sandbox. Never starts a second sandbox for the same row.';

-- ── 8. Stage notes: build, runtime launch, health check ────────────────────

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
  if p_status is null or p_status not in (
    'preparing', 'installing', 'building', 'runtime_starting', 'health_checking'
  ) then
    raise exception 'INVALID_STAGE' using errcode = '22023';
  end if;

  update public.project_verifications v
  set status = p_status,
      sandbox_id = coalesce(p_sandbox_id, v.sandbox_id),
      exit_code = coalesce(p_exit_code, v.exit_code),
      -- Reaching runtime_starting means the production build exited 0.
      build_passed = case when p_status = 'runtime_starting' then true else v.build_passed end,
      runtime_started_at = case
        when p_status in ('runtime_starting', 'health_checking')
          then coalesce(v.runtime_started_at, now())
        else v.runtime_started_at
      end,
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

-- ── 9. Fenced sandbox detach before a repair ───────────────────────────────

create or replace function public.clear_verification_sandbox(
  p_verification_id uuid,
  p_lease_token uuid,
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
  if coalesce(p_confirmed, false) is not true then
    -- Never forget a sandbox reference without provider confirmation.
    return jsonb_build_object('status', 'not_confirmed');
  end if;

  update public.project_verifications v
  set sandbox_id = null,
      cleanup_complete = true,
      cleanup_attempts = 0,
      updated_at = now()
  where v.id = p_verification_id
    and v.lease_token = p_lease_token
    and v.finished_at is null
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'cleared', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.clear_verification_sandbox(uuid, uuid, boolean) from public;
revoke all on function public.clear_verification_sandbox(uuid, uuid, boolean) from anon;
revoke all on function public.clear_verification_sandbox(uuid, uuid, boolean) from authenticated;
grant execute on function public.clear_verification_sandbox(uuid, uuid, boolean) to service_role;

-- ── 10. Terminal completion: build + runtime + health, fenced and idempotent ─

drop function if exists public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean
);

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
  p_cleanup_complete boolean,
  p_build_passed boolean default null,
  p_runtime_started boolean default null,
  p_health_passed boolean default null,
  p_health_checked boolean default false,
  p_runtime_exit_code integer default null,
  p_health_http_status integer default null,
  p_runtime_port integer default null,
  p_runtime_profile text default null,
  p_preview_status text default 'unavailable',
  p_preview_reason text default null
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
  v_preview_reason text := nullif(left(btrim(coalesce(p_preview_reason, '')), 400), '');
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
  if coalesce(p_preview_status, 'unavailable') not in ('unavailable', 'disabled') then
    raise exception 'INVALID_PREVIEW_STATUS' using errcode = '22023';
  end if;
  if p_runtime_profile is not null and p_runtime_profile <> 'next-app-router' then
    raise exception 'INVALID_RUNTIME_PROFILE' using errcode = '22023';
  end if;
  if jsonb_typeof(v_diagnostics) <> 'array' or jsonb_array_length(v_diagnostics) > 80 then
    raise exception 'INVALID_DIAGNOSTICS' using errcode = '22023';
  end if;
  -- ⚠️ THE PHASE 4 INVARIANT: a build alone is never `passed`.
  if p_status = 'passed' and not (
    p_build_passed is true and p_runtime_started is true and p_health_passed is true
  ) then
    raise exception 'PASSED_REQUIRES_RUNTIME' using errcode = '22023';
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
      build_passed = p_build_passed,
      runtime_started = p_runtime_started,
      health_passed = p_health_passed,
      runtime_started_at = v.runtime_started_at,
      runtime_finished_at = case
        when p_runtime_started is not null or p_runtime_exit_code is not null then now()
        else v.runtime_finished_at
      end,
      health_checked_at = case
        when coalesce(p_health_checked, false) then now()
        else v.health_checked_at
      end,
      runtime_exit_code = p_runtime_exit_code,
      health_http_status = p_health_http_status,
      runtime_port = p_runtime_port,
      runtime_profile = p_runtime_profile,
      preview_status = coalesce(p_preview_status, 'unavailable'),
      preview_reason = v_preview_reason,
      -- The repair lifecycle owns repair_status; a terminal write never
      -- promotes a requested attempt to `applied` on its own.
      repair_status = v.repair_status,
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      finished_at = now(),
      deadline_at = null,
      updated_at = now()
  where v.id = p_verification_id
  returning * into v_row;

  return jsonb_build_object('status', 'completed', 'verification', to_jsonb(v_row));
end;
$$;

revoke all on function public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, integer, integer, integer, text, text, text
) from public;
revoke all on function public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, integer, integer, integer, text, text, text
) from anon;
revoke all on function public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, integer, integer, integer, text, text, text
) from authenticated;
grant execute on function public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, integer, integer, integer, text, text, text
) to service_role;

comment on function public.complete_verification(
  uuid, uuid, text, integer, text, text, jsonb, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, integer, integer, integer, text, text, text
) is
  'Service-role only. Fenced terminal write. `passed` is rejected unless build, runtime and health all succeeded; cleanup failure never overwrites the outcome.';

-- ── 11. Bounded repair: begin ──────────────────────────────────────────────

create or replace function public.begin_verification_repair(
  p_verification_id uuid,
  p_lease_token uuid,
  p_max_repairs integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_hard_max constant integer := 2;
  v_max integer;
  v_row public.project_verifications;
  v_repair public.project_verification_repairs;
  v_attempt integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_row
  from public.project_verifications v
  where v.id = p_verification_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.finished_at is not null then
    return jsonb_build_object('status', 'already_terminal');
  end if;
  if v_row.lease_token is null or v_row.lease_token <> p_lease_token then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_row.sandbox_id is not null then
    -- The first sandbox must be confirmed destroyed before a repaired
    -- snapshot is uploaded; otherwise two sandboxes could run at once.
    return jsonb_build_object('status', 'sandbox_present');
  end if;
  if v_row.status not in ('building', 'runtime_starting', 'health_checking') then
    return jsonb_build_object('status', 'invalid_stage');
  end if;
  -- The persisted budget is an upper bound; a caller can only lower it.
  v_max := greatest(0, least(
    c_hard_max,
    coalesce(v_row.repair_max_attempts, 1),
    coalesce(p_max_repairs, v_row.repair_max_attempts, 1)
  ));
  if v_row.repair_attempts >= v_max then
    return jsonb_build_object('status', 'exhausted');
  end if;

  v_attempt := v_row.repair_attempts + 1;

  insert into public.project_verification_repairs (
    verification_id, project_id, run_id, attempt, status,
    original_snapshot_id, original_hash
  ) values (
    v_row.id,
    v_row.project_id,
    v_row.run_id,
    v_attempt,
    'requested',
    coalesce(v_row.effective_snapshot_id, v_row.snapshot_id),
    coalesce(v_row.effective_source_hash, v_row.source_hash)
  )
  on conflict (verification_id, attempt) do nothing
  returning * into v_repair;

  if not found then
    -- The unique key is the duplicate-repair backstop.
    return jsonb_build_object('status', 'duplicate');
  end if;

  update public.project_verifications v
  set status = 'repairing',
      repair_status = 'requested',
      repair_attempts = v_attempt,
      stage_started_at = now(),
      updated_at = now()
  where v.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'status', 'begun',
    'attempt', v_attempt,
    'verification', to_jsonb(v_row),
    'repair', to_jsonb(v_repair)
  );
end;
$$;

revoke all on function public.begin_verification_repair(uuid, uuid, integer) from public;
revoke all on function public.begin_verification_repair(uuid, uuid, integer) from anon;
revoke all on function public.begin_verification_repair(uuid, uuid, integer) from authenticated;
grant execute on function public.begin_verification_repair(uuid, uuid, integer) to service_role;

-- ── 12. Bounded repair: finish ─────────────────────────────────────────────

create or replace function public.finish_verification_repair(
  p_verification_id uuid,
  p_lease_token uuid,
  p_attempt integer,
  p_status text,
  p_repaired_snapshot_id uuid default null,
  p_repaired_hash text default null,
  p_error_class text default null,
  p_summary text default null,
  p_model text default null,
  p_prompt_tokens integer default null,
  p_completion_tokens integer default null,
  p_cost_usd numeric default null,
  p_cost_known boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_verifications;
  v_repair public.project_verification_repairs;
  v_snapshot public.project_snapshots;
  v_class text := nullif(left(btrim(coalesce(p_error_class, '')), 80), '');
  v_summary text := nullif(left(btrim(coalesce(p_summary, '')), 400), '');
  v_model text := nullif(left(btrim(coalesce(p_model, '')), 120), '');
  v_cost numeric := case
    when coalesce(p_cost_known, false) and p_cost_usd is not null and p_cost_usd >= 0
      then p_cost_usd
    else null
  end;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('applied', 'failed', 'rejected') then
    raise exception 'INVALID_REPAIR_STATUS' using errcode = '22023';
  end if;

  select * into v_row
  from public.project_verifications v
  where v.id = p_verification_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.finished_at is not null then
    return jsonb_build_object('status', 'already_terminal');
  end if;
  if v_row.lease_token is null or v_row.lease_token <> p_lease_token then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select * into v_repair
  from public.project_verification_repairs r
  where r.verification_id = p_verification_id
    and r.attempt = p_attempt
    and r.status = 'requested'
  for update;

  if not found then
    return jsonb_build_object('status', 'not_requested');
  end if;

  if p_status = 'applied' then
    if p_repaired_snapshot_id is null or p_repaired_hash is null
       or p_repaired_hash !~ '^[a-f0-9]{64}$' then
      raise exception 'INVALID_REPAIR_SNAPSHOT' using errcode = '22023';
    end if;

    select * into v_snapshot
    from public.project_snapshots s
    where s.id = p_repaired_snapshot_id
      and s.project_id = v_row.project_id
      and s.run_id = v_row.run_id
      and s.kind = 'repair'
      and s.status = 'ready'
      and s.source_hash = p_repaired_hash;

    if not found then
      raise exception 'INVALID_REPAIR_SNAPSHOT' using errcode = '22023';
    end if;
  end if;

  update public.project_verification_repairs r
  set status = p_status,
      repaired_snapshot_id = case when p_status = 'applied' then p_repaired_snapshot_id else null end,
      repaired_hash = case when p_status = 'applied' then p_repaired_hash else null end,
      model = v_model,
      prompt_tokens = p_prompt_tokens,
      completion_tokens = p_completion_tokens,
      cost_usd = v_cost,
      cost_known = coalesce(p_cost_known, false) and v_cost is not null,
      error_class = v_class,
      summary = v_summary,
      finished_at = now()
  where r.id = v_repair.id
  returning * into v_repair;

  if p_status = 'applied' then
    update public.project_verifications v
    set status = 'queued',
        effective_snapshot_id = p_repaired_snapshot_id,
        effective_source_hash = p_repaired_hash,
        repaired_snapshot_id = p_repaired_snapshot_id,
        repair_status = 'applied',
        -- A repair starts a fresh attempt budget for the new snapshot; the
        -- repair count is the separate, hard-capped budget.
        attempt = 0,
        exit_code = null,
        runtime_profile = null,
        runtime_port = null,
        runtime_exit_code = null,
        health_http_status = null,
        build_passed = null,
        runtime_started = null,
        health_passed = null,
        runtime_started_at = null,
        runtime_finished_at = null,
        health_checked_at = null,
        error_class = null,
        summary = null,
        diagnostics = '[]'::jsonb,
        diagnostics_truncated = false,
        preview_status = 'unavailable',
        preview_reason = null,
        sandbox_id = null,
        worker_id = null,
        lease_token = null,
        lease_expires_at = null,
        stage_started_at = null,
        deadline_at = now() + interval '20 minutes',
        updated_at = now()
    where v.id = v_row.id
    returning * into v_row;

    return jsonb_build_object(
      'status', 'applied',
      'attempt', p_attempt,
      'verification', to_jsonb(v_row),
      'repair', to_jsonb(v_repair)
    );
  end if;

  -- failed/rejected: keep the row non-terminal and leased so the worker can
  -- write the original build/runtime failure as the verification outcome.
  update public.project_verifications v
  set repair_status = p_status,
      updated_at = now()
  where v.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'status', p_status,
    'attempt', p_attempt,
    'verification', to_jsonb(v_row),
    'repair', to_jsonb(v_repair)
  );
end;
$$;

revoke all on function public.finish_verification_repair(
  uuid, uuid, integer, text, uuid, text, text, text, text, integer, integer, numeric, boolean
) from public;
revoke all on function public.finish_verification_repair(
  uuid, uuid, integer, text, uuid, text, text, text, text, integer, integer, numeric, boolean
) from anon;
revoke all on function public.finish_verification_repair(
  uuid, uuid, integer, text, uuid, text, text, text, text, integer, integer, numeric, boolean
) from authenticated;
grant execute on function public.finish_verification_repair(
  uuid, uuid, integer, text, uuid, text, text, text, text, integer, integer, numeric, boolean
) to service_role;

comment on function public.finish_verification_repair(
  uuid, uuid, integer, text, uuid, text, text, text, text, integer, integer, numeric, boolean
) is
  'Service-role only. Applied repairs point verification at a NEW immutable snapshot and requeue it; failed/rejected repairs leave the original outcome to the terminal write.';

-- ── 13. Recovery: interrupted runtime and repair fail closed ───────────────

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
      update public.project_verification_repairs r
      set status = 'failed',
          error_class = 'timeout',
          summary = 'The repair did not finish before the verification deadline.',
          finished_at = now()
      where r.verification_id = v_row.id and r.status = 'requested';

      update public.project_verifications v
      set status = 'timed_out',
          error_class = 'timeout',
          summary = 'Verification passed its hard deadline and was stopped.',
          repair_status = case when v.repair_status = 'requested' then 'failed' else v.repair_status end,
          finished_at = now(),
          deadline_at = null,
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (v.sandbox_id is null),
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'timed_out';
    elsif v_row.status = 'repairing' then
      -- ⚠️ A repair is not resumable. We cannot prove which model output was
      -- produced or whether a snapshot write landed, so the verification fails
      -- closed instead of spending a second repair on an unknown state.
      update public.project_verification_repairs r
      set status = 'failed',
          error_class = 'repair_failed',
          summary = 'The repair worker stopped before the attempt was recorded.',
          finished_at = now()
      where r.verification_id = v_row.id and r.status = 'requested';

      update public.project_verifications v
      set status = 'failed',
          error_class = 'repair_failed',
          summary = 'The AI repair was interrupted before it produced a verified snapshot.',
          repair_status = 'failed',
          finished_at = now(),
          deadline_at = null,
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (v.sandbox_id is null),
          updated_at = now()
      where v.id = v_row.id;
      v_outcome := 'repair_failed';
    elsif v_row.status in (
        'preparing', 'installing', 'building', 'runtime_starting', 'health_checking'
      )
      and v_row.sandbox_id is not null then
      -- The build or runtime may still be running. Hand it to the next tick
      -- unchanged; it never starts a second sandbox for the same row.
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
          summary = 'The verification worker stopped before the stage finished.',
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
  'Service-role only. Expires deadlines, releases recoverable build/runtime sandboxes, fails interrupted repairs closed and dead-letters the rest.';

-- ── 14. Owner cancellation also fences an in-flight repair ─────────────────

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

  update public.project_verification_repairs r
  set status = 'failed',
      error_class = 'cancelled',
      summary = 'The repair was cancelled by the project owner.',
      finished_at = now()
  where r.verification_id = v_row.id and r.status = 'requested';

  update public.project_verifications v
  set status = 'cancelled',
      error_class = 'cancelled',
      summary = 'Verification was cancelled by the project owner.',
      repair_status = case when v.repair_status = 'requested' then 'failed' else v.repair_status end,
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
  'Owner-only cancellation. Cancels a pending repair and retains the sandbox reference until the worker confirms deletion.';

commit;
