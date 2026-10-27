-- ═══════════════════════════════════════════════════════════════════════════
-- 26_android_builds.sql — durable isolated Android debug builds
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Additive and forward-only. Apply after 22 (project_type), 25 (creation
-- idempotency) and 20 (uses only public.projects/project_snapshots here).
--
-- WHAT THIS INSTALLS
--   · one durable row per Android build, bound to an immutable snapshot;
--   · fenced claim / renew / release / complete / retry / recover RPCs;
--   · owner-only cancellation and a service-role-only worker lifecycle;
--   · artifact metadata (never the binary) and bounded retention state;
--   · owner SELECT grants that omit storage paths and lease secrets;
--   · a private Supabase Storage bucket for APKs.
--
-- ⚠️ THE APK IS NEVER STORED IN POSTGRES. Only its checksum, size, safe file
--    name, application id and a private object path (service-role only) are
--    recorded. Authenticated readers never receive the bucket or object path.
--
-- ⚠️ STATUS VS STAGE. `status` is the durable lifecycle; `stage` is the current
--    bounded step. `succeeded` is written only by a fenced completion that
--    presents verified artifact metadata.
--
-- ⚠️ ROLLBACK. This migration adds only new objects and one private storage
--    bucket. To roll back, disable MAVLY_ANDROID_BUILD_ENABLED and delete the
--    new functions/table/bucket after no worker is running. Existing projects,
--    source files and snapshots are never modified.

-- ── 1. Build table ──────────────────────────────────────────────────────────

create table if not exists public.project_android_builds (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  snapshot_id uuid not null references public.project_snapshots (id) on delete cascade,
  source_hash text not null,
  status text not null default 'queued'
    check (status in (
      'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out',
      'configuration_error', 'infrastructure_error'
    )),
  stage text not null default 'queued'
    check (stage in (
      'queued', 'preparing', 'uploading', 'building', 'validating_artifact',
      'uploading_artifact', 'finalizing', 'succeeded', 'failed', 'cancelled',
      'timed_out', 'configuration_error', 'infrastructure_error'
    )),
  -- Rows start at 0; the first claim increments to 1 so that
  -- `attempt < max_attempts` allows exactly `max_attempts` executions.
  attempt integer not null default 0 check (attempt >= 0 and attempt <= 10),
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  toolchain text not null default 'android-debug-v1',
  build_variant text not null default 'debug' check (build_variant = 'debug'),

  -- Worker fencing. Never exposed to authenticated readers.
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text,
  sandbox_id text,
  deadline_at timestamptz not null,
  next_attempt_at timestamptz,
  stage_started_at timestamptz,
  cleanup_complete boolean not null default false,
  cleanup_claimed_at timestamptz,
  cleanup_token uuid,

  -- Artifact metadata. Path/bucket are service-role only.
  artifact_state text not null default 'none'
    check (artifact_state in (
      'none', 'available', 'expiring', 'expired', 'delete_failed', 'failed'
    )),
  artifact_bucket text,
  artifact_path text,
  artifact_file_name text,
  artifact_content_type text,
  artifact_size_bytes bigint,
  artifact_sha256 text,
  application_id text,
  package_name text,
  artifact_expires_at timestamptz,

  diagnostics jsonb not null default '[]'::jsonb,
  log_excerpt text,
  log_truncated boolean not null default false,
  error_class text,
  error_summary text,
  cancel_requested_at timestamptz,
  correlation_id text,
  idempotency_key text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Idempotent for a database where an earlier draft of this migration created
-- the table with an `attempt` default of 1 (which made `attempt < max_attempts`
-- reject every retry). Rows already written by a build are left untouched.
alter table public.project_android_builds
  alter column attempt set default 0;

comment on table public.project_android_builds is
  'Durable isolated Android debug builds. Binary artifacts live in private Storage, never here.';
comment on column public.project_android_builds.snapshot_id is
  'Immutable project snapshot this build compiles. A later file edit cannot change the input.';
comment on column public.project_android_builds.source_hash is
  'SHA-256 of the snapshot; re-verified by the worker before upload/build.';
comment on column public.project_android_builds.artifact_path is
  'Private Storage object key. Never granted to the authenticated role.';

-- One active build per project. Terminal history is unlimited.
create unique index if not exists project_android_builds_active_project_idx
  on public.project_android_builds (project_id)
  where status in ('queued', 'running');

create unique index if not exists project_android_builds_idempotency_idx
  on public.project_android_builds (project_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists project_android_builds_claim_idx
  on public.project_android_builds (status, next_attempt_at, created_at);
create index if not exists project_android_builds_project_created_idx
  on public.project_android_builds (project_id, created_at desc);
create index if not exists project_android_builds_user_active_idx
  on public.project_android_builds (user_id, status);
create index if not exists project_android_builds_artifact_expiry_idx
  on public.project_android_builds (artifact_state, artifact_expires_at);
create index if not exists project_android_builds_cleanup_idx
  on public.project_android_builds (finished_at, cleanup_complete);

-- ── 2. RLS and column grants ────────────────────────────────────────────────

alter table public.project_android_builds enable row level security;

drop policy if exists "project_android_builds_select_own" on public.project_android_builds;
create policy "project_android_builds_select_own"
  on public.project_android_builds
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_android_builds.project_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_android_builds from anon, authenticated;
grant select (
  id,
  project_id,
  snapshot_id,
  source_hash,
  status,
  stage,
  attempt,
  max_attempts,
  toolchain,
  build_variant,
  deadline_at,
  next_attempt_at,
  stage_started_at,
  cleanup_complete,
  artifact_state,
  artifact_file_name,
  artifact_content_type,
  artifact_size_bytes,
  artifact_sha256,
  application_id,
  package_name,
  artifact_expires_at,
  diagnostics,
  log_excerpt,
  log_truncated,
  error_class,
  error_summary,
  cancel_requested_at,
  correlation_id,
  created_at,
  started_at,
  finished_at,
  updated_at
) on public.project_android_builds to authenticated;

grant all on public.project_android_builds to service_role;

-- ── 3. Schema marker ────────────────────────────────────────────────────────

create or replace function public.android_build_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 26;
$$;

revoke all on function public.android_build_schema_version() from public;
revoke all on function public.android_build_schema_version() from anon;
grant execute on function public.android_build_schema_version() to authenticated, service_role;

comment on function public.android_build_schema_version() is
  'Android build schema marker. 26 means durable builds, fenced artifact publication and retention state are installed.';

-- ── 4. Create a build (owner, idempotent, bounded) ──────────────────────────

create or replace function public.create_android_build(
  p_project_id text,
  p_snapshot_id uuid,
  p_source_hash text,
  p_toolchain text default 'android-debug-v1',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_project_limit constant integer := 1;
  c_user_limit constant integer := 2;
  c_global_limit constant integer := 4;
  c_max_attempts constant integer := 2;
  c_deadline interval := interval '22 minutes';
  v_user uuid := auth.uid();
  v_owner uuid;
  v_type text;
  v_snapshot public.project_snapshots;
  v_row public.project_android_builds;
  v_active integer;
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 200), '');
  v_toolchain text := left(btrim(coalesce(p_toolchain, '')), 120);
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if v_toolchain = '' then
    raise exception 'INVALID_TOOLCHAIN' using errcode = '22023';
  end if;
  if p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'INVALID_SOURCE_HASH' using errcode = '22023';
  end if;

  select p.user_id, p.project_type into v_owner, v_type
  from public.projects p
  where p.project_id = p_project_id;

  if not found then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_owner <> v_user then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(v_type, 'website') <> 'android' then
    raise exception 'NOT_ANDROID_PROJECT' using errcode = '22023';
  end if;

  select * into v_snapshot
  from public.project_snapshots s
  where s.id = p_snapshot_id
    and s.project_id = p_project_id
    and s.user_id = v_user
    and s.status = 'ready';

  if not found then
    raise exception 'SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_snapshot.source_hash <> p_source_hash then
    raise exception 'SNAPSHOT_MISMATCH' using errcode = '22023';
  end if;

  -- Serialize same-project requests so the active unique index is not a race.
  perform pg_advisory_xact_lock(hashtextextended('android_build:' || p_project_id, 0));

  if v_key is not null then
    select * into v_row
    from public.project_android_builds b
    where b.project_id = p_project_id and b.idempotency_key = v_key
    limit 1;
    if found then
      return jsonb_build_object(
        'status', 'existing',
        'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
          - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
      );
    end if;
  end if;

  select * into v_row
  from public.project_android_builds b
  where b.project_id = p_project_id
    and b.status in ('queued', 'running')
  order by b.created_at
  limit 1;
  if found then
    return jsonb_build_object(
      'status', 'existing',
      'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
        - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
    );
  end if;

  select count(*) into v_active
  from public.project_android_builds b
  where b.project_id = p_project_id and b.status in ('queued', 'running');
  if v_active >= c_project_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'project', 'retryAfterSeconds', 30);
  end if;

  select count(*) into v_active
  from public.project_android_builds b
  where b.user_id = v_user and b.status in ('queued', 'running');
  if v_active >= c_user_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'user', 'retryAfterSeconds', 60);
  end if;

  select count(*) into v_active
  from public.project_android_builds b
  where b.status in ('queued', 'running');
  if v_active >= c_global_limit then
    return jsonb_build_object('status', 'rate_limited', 'scope', 'global', 'retryAfterSeconds', 60);
  end if;

  insert into public.project_android_builds (
    project_id, user_id, snapshot_id, source_hash, status, stage,
    max_attempts, toolchain, deadline_at, idempotency_key
  ) values (
    p_project_id, v_user, p_snapshot_id, p_source_hash, 'queued', 'queued',
    c_max_attempts, v_toolchain, now() + c_deadline, v_key
  )
  returning * into v_row;

  return jsonb_build_object(
    'status', 'created',
    'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
      - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
  );
end;
$$;

revoke all on function public.create_android_build(text, uuid, text, text, text) from public;
revoke all on function public.create_android_build(text, uuid, text, text, text) from anon;
grant execute on function public.create_android_build(text, uuid, text, text, text) to authenticated, service_role;

comment on function public.create_android_build(text, uuid, text, text, text) is
  'Owner-only. Creates one build for an immutable Android snapshot; idempotent by key and by active project; bounded per project/user/global.';

-- ── 5. Claim / lease / stage ────────────────────────────────────────────────

create or replace function public.claim_android_build(
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
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 300));
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 120);
  v_row public.project_android_builds;
  v_mode text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_worker = '' then
    raise exception 'INVALID_WORKER' using errcode = '22023';
  end if;

  select b.* into v_row
  from public.project_android_builds b
  where b.finished_at is null
    and b.cancel_requested_at is null
    and b.deadline_at > now()
    and (
      (
        b.status = 'queued'
        and (b.next_attempt_at is null or b.next_attempt_at <= now())
      )
      or
      (
        b.status = 'running'
        and b.sandbox_id is not null
        and (b.lease_token is null or b.lease_expires_at is null or b.lease_expires_at < now())
      )
    )
    and (p_project_ids is null or b.project_id = any (p_project_ids))
    and exists (select 1 from public.projects p where p.project_id = b.project_id)
  order by b.created_at, b.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  v_mode := case when v_row.status = 'queued' then 'new' else 'continue' end;

  update public.project_android_builds b
  set status = 'running',
      stage = case when v_mode = 'new' then 'preparing' else b.stage end,
      attempt = case when v_mode = 'new' then b.attempt + 1 else b.attempt end,
      started_at = coalesce(b.started_at, now()),
      stage_started_at = case when v_mode = 'new' then now() else b.stage_started_at end,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      worker_id = v_worker,
      updated_at = now()
  where b.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'status', 'claimed',
    'mode', v_mode,
    'lease_seconds', v_lease,
    'build', to_jsonb(v_row)
  );
end;
$$;

revoke all on function public.claim_android_build(text, integer, text[]) from public;
revoke all on function public.claim_android_build(text, integer, text[]) from anon;
revoke all on function public.claim_android_build(text, integer, text[]) from authenticated;
grant execute on function public.claim_android_build(text, integer, text[]) to service_role;

comment on function public.claim_android_build(text, integer, text[]) is
  'Service-role only. Claims a queued build or reattaches to a live sandbox after a lost lease.';

create or replace function public.note_android_build_stage(
  p_build_id uuid,
  p_lease_token uuid,
  p_stage text,
  p_sandbox_id text default null,
  p_diagnostics jsonb default null,
  p_log_excerpt text default null,
  p_log_truncated boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_android_builds;
  v_diagnostics jsonb := coalesce(p_diagnostics, '[]'::jsonb);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in (
    'preparing', 'uploading', 'building', 'validating_artifact',
    'uploading_artifact', 'finalizing'
  ) then
    raise exception 'INVALID_STAGE' using errcode = '22023';
  end if;
  if jsonb_typeof(v_diagnostics) <> 'array' or jsonb_array_length(v_diagnostics) > 80 then
    raise exception 'INVALID_DIAGNOSTICS' using errcode = '22023';
  end if;

  update public.project_android_builds b
  set stage = p_stage,
      sandbox_id = coalesce(nullif(btrim(coalesce(p_sandbox_id, '')), ''), b.sandbox_id),
      diagnostics = case when p_diagnostics is null then b.diagnostics else v_diagnostics end,
      log_excerpt = coalesce(left(p_log_excerpt, 32768), b.log_excerpt),
      log_truncated = case when p_log_excerpt is null then b.log_truncated else coalesce(p_log_truncated, false) end,
      stage_started_at = now(),
      updated_at = now()
  where b.id = p_build_id
    and b.lease_token = p_lease_token
    and b.finished_at is null
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'noted', 'build', to_jsonb(v_row));
end;
$$;

revoke all on function public.note_android_build_stage(uuid, uuid, text, text, jsonb, text, boolean) from public;
revoke all on function public.note_android_build_stage(uuid, uuid, text, text, jsonb, text, boolean) from anon;
revoke all on function public.note_android_build_stage(uuid, uuid, text, text, jsonb, text, boolean) from authenticated;
grant execute on function public.note_android_build_stage(uuid, uuid, text, text, jsonb, text, boolean) to service_role;

create or replace function public.renew_android_build_lease(
  p_build_id uuid,
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
  v_row public.project_android_builds;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_android_builds b
  set lease_expires_at = now() + make_interval(secs => v_lease),
      updated_at = now()
  where b.id = p_build_id
    and b.lease_token = p_lease_token
    and b.finished_at is null
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'renewed', 'build', to_jsonb(v_row));
end;
$$;

revoke all on function public.renew_android_build_lease(uuid, uuid, integer) from public;
revoke all on function public.renew_android_build_lease(uuid, uuid, integer) from anon;
revoke all on function public.renew_android_build_lease(uuid, uuid, integer) from authenticated;
grant execute on function public.renew_android_build_lease(uuid, uuid, integer) to service_role;

create or replace function public.release_android_build(
  p_build_id uuid,
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

  update public.project_android_builds b
  set lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      updated_at = now()
  where b.id = p_build_id
    and b.lease_token = p_lease_token
    and b.finished_at is null;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'released');
end;
$$;

revoke all on function public.release_android_build(uuid, uuid) from public;
revoke all on function public.release_android_build(uuid, uuid) from anon;
revoke all on function public.release_android_build(uuid, uuid) from authenticated;
grant execute on function public.release_android_build(uuid, uuid) to service_role;

-- ── 6. Fenced terminal completion and bounded retry ─────────────────────────

create or replace function public.complete_android_build(
  p_build_id uuid,
  p_lease_token uuid,
  p_status text,
  p_stage text,
  p_error_class text default null,
  p_summary text default null,
  p_diagnostics jsonb default null,
  p_log_excerpt text default null,
  p_log_truncated boolean default false,
  p_cleanup_complete boolean default false,
  p_artifact_bucket text default null,
  p_artifact_path text default null,
  p_artifact_file_name text default null,
  p_artifact_content_type text default null,
  p_artifact_size_bytes bigint default null,
  p_artifact_sha256 text default null,
  p_application_id text default null,
  p_package_name text default null,
  p_artifact_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_android_builds;
  v_class text := nullif(left(btrim(coalesce(p_error_class, '')), 80), '');
  v_summary text := nullif(left(btrim(coalesce(p_summary, '')), 400), '');
  v_diagnostics jsonb := coalesce(p_diagnostics, '[]'::jsonb);
  v_bucket text := nullif(left(btrim(coalesce(p_artifact_bucket, '')), 80), '');
  v_path text := nullif(left(btrim(coalesce(p_artifact_path, '')), 512), '');
  v_file text := nullif(left(btrim(coalesce(p_artifact_file_name, '')), 160), '');
  v_type text := nullif(left(btrim(coalesce(p_artifact_content_type, '')), 120), '');
  v_sha text := nullif(left(btrim(coalesce(p_artifact_sha256, '')), 64), '');
  v_app text := nullif(left(btrim(coalesce(p_application_id, '')), 160), '');
  v_pkg text := nullif(left(btrim(coalesce(p_package_name, '')), 160), '');
  v_cleaned boolean := coalesce(p_cleanup_complete, false);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in (
    'succeeded', 'failed', 'cancelled', 'timed_out',
    'configuration_error', 'infrastructure_error'
  ) then
    raise exception 'INVALID_TERMINAL_STATUS' using errcode = '22023';
  end if;
  if jsonb_typeof(v_diagnostics) <> 'array' or jsonb_array_length(v_diagnostics) > 80 then
    raise exception 'INVALID_DIAGNOSTICS' using errcode = '22023';
  end if;

  select * into v_row
  from public.project_android_builds b
  where b.id = p_build_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.finished_at is not null then
    return jsonb_build_object('status', 'already_terminal', 'build', to_jsonb(v_row));
  end if;
  if v_row.lease_token is null or v_row.lease_token <> p_lease_token then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  if p_status = 'succeeded' and v_row.cancel_requested_at is not null then
    -- A cancellation that landed while the artifact was uploading must win.
    -- Settle it under the same lease fence instead of publishing.
    update public.project_android_builds b
    set status = 'cancelled',
        stage = 'cancelled',
        error_class = 'cancelled',
        error_summary = 'The Android build was cancelled.',
        finished_at = now(),
        deadline_at = now(),
        lease_token = null,
        lease_expires_at = null,
        worker_id = null,
        sandbox_id = case when (b.sandbox_id is null) or v_cleaned then null else b.sandbox_id end,
        cleanup_complete = (b.sandbox_id is null) or v_cleaned,
        updated_at = now()
    where b.id = p_build_id
    returning * into v_row;
    return jsonb_build_object('status', 'cancelled', 'build', to_jsonb(v_row));
  end if;

  if p_status = 'succeeded' then
    if v_bucket is null or v_bucket !~ '^[a-z0-9][a-z0-9._-]{2,62}$' then
      raise exception 'INVALID_ARTIFACT_BUCKET' using errcode = '22023';
    end if;
    if v_path is null
       or v_path <> v_row.project_id || '/' || v_row.id::text || '/' || coalesce(v_sha, '') || '.apk' then
      raise exception 'INVALID_ARTIFACT_PATH' using errcode = '22023';
    end if;
    if v_sha is null or v_sha !~ '^[a-f0-9]{64}$' then
      raise exception 'INVALID_ARTIFACT_SHA' using errcode = '22023';
    end if;
    if p_artifact_size_bytes is null or p_artifact_size_bytes < 1
       or p_artifact_size_bytes > 104857600 then
      raise exception 'INVALID_ARTIFACT_SIZE' using errcode = '22023';
    end if;
    if v_file is null or v_file !~ '^[A-Za-z0-9._-]{1,160}$' then
      raise exception 'INVALID_ARTIFACT_NAME' using errcode = '22023';
    end if;
    if v_type is null or v_type <> 'application/vnd.android.package-archive' then
      raise exception 'INVALID_ARTIFACT_TYPE' using errcode = '22023';
    end if;
    if v_app is null or v_pkg is null or v_app <> v_pkg then
      raise exception 'INVALID_APPLICATION_ID' using errcode = '22023';
    end if;
    if v_app !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' then
      raise exception 'INVALID_APPLICATION_ID' using errcode = '22023';
    end if;
    if p_artifact_expires_at is null or p_artifact_expires_at <= now() then
      raise exception 'INVALID_ARTIFACT_EXPIRY' using errcode = '22023';
    end if;
  end if;

  update public.project_android_builds b
  set status = p_status,
      stage = p_status,
      error_class = v_class,
      error_summary = v_summary,
      diagnostics = v_diagnostics,
      log_excerpt = coalesce(left(p_log_excerpt, 32768), b.log_excerpt),
      log_truncated = case when p_log_excerpt is null then b.log_truncated else coalesce(p_log_truncated, false) end,
      cleanup_complete = (b.sandbox_id is null) or v_cleaned,
      sandbox_id = case when (b.sandbox_id is null) or v_cleaned then null else b.sandbox_id end,
      artifact_state = case when p_status = 'succeeded' then 'available' else 'none' end,
      artifact_bucket = case when p_status = 'succeeded' then v_bucket else null end,
      artifact_path = case when p_status = 'succeeded' then v_path else null end,
      artifact_file_name = case when p_status = 'succeeded' then v_file else null end,
      artifact_content_type = case when p_status = 'succeeded' then v_type else null end,
      artifact_size_bytes = case when p_status = 'succeeded' then p_artifact_size_bytes else null end,
      artifact_sha256 = case when p_status = 'succeeded' then v_sha else null end,
      application_id = case when p_status = 'succeeded' then v_app else null end,
      package_name = case when p_status = 'succeeded' then v_pkg else null end,
      artifact_expires_at = case when p_status = 'succeeded' then p_artifact_expires_at else null end,
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      finished_at = now(),
      deadline_at = now(),
      updated_at = now()
  where b.id = p_build_id
  returning * into v_row;

  return jsonb_build_object('status', 'completed', 'build', to_jsonb(v_row));
end;
$$;

revoke all on function public.complete_android_build(
  uuid, uuid, text, text, text, text, jsonb, text, boolean, boolean,
  text, text, text, text, bigint, text, text, text, timestamptz
) from public;
revoke all on function public.complete_android_build(
  uuid, uuid, text, text, text, text, jsonb, text, boolean, boolean,
  text, text, text, text, bigint, text, text, text, timestamptz
) from anon;
revoke all on function public.complete_android_build(
  uuid, uuid, text, text, text, text, jsonb, text, boolean, boolean,
  text, text, text, text, bigint, text, text, text, timestamptz
) from authenticated;
grant execute on function public.complete_android_build(
  uuid, uuid, text, text, text, text, jsonb, text, boolean, boolean,
  text, text, text, text, bigint, text, text, text, timestamptz
) to service_role;

comment on function public.complete_android_build(
  uuid, uuid, text, text, text, text, jsonb, text, boolean, boolean,
  text, text, text, text, bigint, text, text, text, timestamptz
) is
  'Service-role only. Fenced terminal write. succeeded requires complete, consistent artifact metadata; a duplicate or stale completion never overwrites.';

create or replace function public.retry_android_build(
  p_build_id uuid,
  p_lease_token uuid,
  p_error_class text,
  p_summary text,
  p_retry_after_seconds integer default 15,
  p_sandbox_cleared boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_android_builds;
  v_retry integer := greatest(1, least(coalesce(p_retry_after_seconds, 15), 300));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_row
  from public.project_android_builds b
  where b.id = p_build_id
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

  -- A cancellation that arrived while the worker held the lease wins over a
  -- retry. Settling it here is atomic; a requeue would resurrect cancelled work.
  if v_row.cancel_requested_at is not null then
    update public.project_android_builds b
    set status = 'cancelled',
        stage = 'cancelled',
        error_class = 'cancelled',
        error_summary = 'The Android build was cancelled.',
        finished_at = now(),
        deadline_at = now(),
        lease_token = null,
        lease_expires_at = null,
        worker_id = null,
        sandbox_id = case when coalesce(p_sandbox_cleared, false) then null else b.sandbox_id end,
        cleanup_complete = (b.sandbox_id is null) or coalesce(p_sandbox_cleared, false),
        updated_at = now()
    where b.id = p_build_id
    returning * into v_row;
    return jsonb_build_object('status', 'cancelled', 'build', to_jsonb(v_row));
  end if;

  if v_row.attempt >= v_row.max_attempts then
    return jsonb_build_object('status', 'exhausted');
  end if;

  update public.project_android_builds b
  set status = 'queued',
      stage = 'queued',
      next_attempt_at = now() + make_interval(secs => v_retry),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      sandbox_id = case when coalesce(p_sandbox_cleared, false) then null else b.sandbox_id end,
      cleanup_complete = case when coalesce(p_sandbox_cleared, false) then true else false end,
      error_class = nullif(left(btrim(coalesce(p_error_class, '')), 80), ''),
      error_summary = nullif(left(btrim(coalesce(p_summary, '')), 400), ''),
      stage_started_at = null,
      updated_at = now()
  where b.id = p_build_id
  returning * into v_row;

  return jsonb_build_object('status', 'retry', 'build', to_jsonb(v_row));
end;
$$;

revoke all on function public.retry_android_build(uuid, uuid, text, text, integer, boolean) from public;
revoke all on function public.retry_android_build(uuid, uuid, text, text, integer, boolean) from anon;
revoke all on function public.retry_android_build(uuid, uuid, text, text, integer, boolean) from authenticated;
grant execute on function public.retry_android_build(uuid, uuid, text, text, integer, boolean) to service_role;

-- ── 7. Recovery, cancellation and cleanup ──────────────────────────────────

create or replace function public.recover_expired_android_builds(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_row public.project_android_builds;
  v_results jsonb := '[]'::jsonb;
  v_outcome text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_row in
    select b.*
    from public.project_android_builds b
    where b.finished_at is null
      and (
        b.cancel_requested_at is not null
        or b.deadline_at <= now()
        or (b.lease_token is not null and b.lease_expires_at is not null and b.lease_expires_at < now())
      )
    order by b.cancel_requested_at asc nulls last, b.deadline_at
    for update skip locked
    limit v_limit
  loop
    if v_row.cancel_requested_at is not null then
      -- Cancellation wins over a retry or a success that has not been
      -- finalized. A surviving sandbox is left for the cleanup sweep.
      update public.project_android_builds b
      set status = 'cancelled',
          stage = 'cancelled',
          error_class = 'cancelled',
          error_summary = 'The Android build was cancelled.',
          finished_at = now(),
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (b.sandbox_id is null),
          updated_at = now()
      where b.id = v_row.id;
      v_outcome := 'cancelled';
    elsif v_row.deadline_at <= now() then
      update public.project_android_builds b
      set status = 'timed_out',
          stage = 'timed_out',
          error_class = 'timeout',
          error_summary = 'The Android build passed its hard deadline and was stopped.',
          finished_at = now(),
          lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          cleanup_complete = (b.sandbox_id is null),
          updated_at = now()
      where b.id = v_row.id;
      v_outcome := 'timed_out';
    elsif v_row.status = 'running' and v_row.sandbox_id is not null then
      update public.project_android_builds b
      set lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          updated_at = now()
      where b.id = v_row.id;
      v_outcome := 'released';
    elsif v_row.status = 'running' and v_row.sandbox_id is null then
      if v_row.attempt < v_row.max_attempts then
        update public.project_android_builds b
        set status = 'queued',
            stage = 'queued',
            next_attempt_at = now(),
            lease_token = null,
            lease_expires_at = null,
            worker_id = null,
            stage_started_at = null,
            updated_at = now()
        where b.id = v_row.id;
        v_outcome := 'requeued';
      else
        update public.project_android_builds b
        set status = 'infrastructure_error',
            stage = 'infrastructure_error',
            error_class = 'provider_error',
            error_summary = 'The Android build worker stopped before the build finished.',
            finished_at = now(),
            lease_token = null,
            lease_expires_at = null,
            worker_id = null,
            cleanup_complete = true,
            updated_at = now()
        where b.id = v_row.id;
        v_outcome := 'infrastructure_error';
      end if;
    else
      update public.project_android_builds b
      set lease_token = null,
          lease_expires_at = null,
          worker_id = null,
          updated_at = now()
      where b.id = v_row.id;
      v_outcome := 'released';
    end if;

    v_results := v_results || jsonb_build_object(
      'buildId', v_row.id,
      'projectId', v_row.project_id,
      'outcome', v_outcome
    );
  end loop;

  return jsonb_build_object('recovered', v_results);
end;
$$;

revoke all on function public.recover_expired_android_builds(integer) from public;
revoke all on function public.recover_expired_android_builds(integer) from anon;
revoke all on function public.recover_expired_android_builds(integer) from authenticated;
grant execute on function public.recover_expired_android_builds(integer) to service_role;

create or replace function public.cancel_android_build(
  p_project_id text,
  p_build_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_row public.project_android_builds;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_user
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_row
  from public.project_android_builds b
  where b.id = p_build_id and b.project_id = p_project_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.finished_at is not null then
    return jsonb_build_object(
      'status', 'already_terminal',
      'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
        - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
    );
  end if;

  if v_row.status = 'queued' and v_row.sandbox_id is null then
    update public.project_android_builds b
    set status = 'cancelled',
        stage = 'cancelled',
        cancel_requested_at = now(),
        finished_at = now(),
        lease_token = null,
        lease_expires_at = null,
        worker_id = null,
        cleanup_complete = true,
        updated_at = now()
    where b.id = p_build_id
    returning * into v_row;
    return jsonb_build_object(
      'status', 'cancelled',
      'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
        - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
    );
  end if;

  update public.project_android_builds b
  set cancel_requested_at = coalesce(b.cancel_requested_at, now()),
      updated_at = now()
  where b.id = p_build_id
  returning * into v_row;

  return jsonb_build_object(
    'status', 'requested',
    'build', to_jsonb(v_row) - 'artifact_bucket' - 'artifact_path' - 'sandbox_id'
      - 'worker_id' - 'lease_token' - 'lease_expires_at' - 'cleanup_token'
  );
end;
$$;

revoke all on function public.cancel_android_build(text, uuid) from public;
revoke all on function public.cancel_android_build(text, uuid) from anon;
grant execute on function public.cancel_android_build(text, uuid) to authenticated, service_role;

-- ── 8. Orphan sandbox cleanup ───────────────────────────────────────────────

create or replace function public.claim_android_build_cleanup(
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 20));
  v_row public.project_android_builds;
  v_results jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_row in
    select b.*
    from public.project_android_builds b
    where b.finished_at is not null
      and b.sandbox_id is not null
      and b.cleanup_complete = false
      and (b.cleanup_claimed_at is null or b.cleanup_claimed_at < now())
    order by b.finished_at
    for update skip locked
    limit v_limit
  loop
    update public.project_android_builds b
    set cleanup_claimed_at = now() + interval '5 minutes',
        cleanup_token = gen_random_uuid(),
        updated_at = now()
    where b.id = v_row.id
    returning * into v_row;

    v_results := v_results || jsonb_build_object(
      'buildId', v_row.id,
      'projectId', v_row.project_id,
      'sandboxId', v_row.sandbox_id,
      'cleanupToken', v_row.cleanup_token
    );
  end loop;

  return jsonb_build_object('cleanup', v_results);
end;
$$;

revoke all on function public.claim_android_build_cleanup(integer) from public;
revoke all on function public.claim_android_build_cleanup(integer) from anon;
revoke all on function public.claim_android_build_cleanup(integer) from authenticated;
grant execute on function public.claim_android_build_cleanup(integer) to service_role;

create or replace function public.mark_android_build_cleanup(
  p_build_id uuid,
  p_cleanup_token uuid,
  p_cleared boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_android_builds;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_android_builds b
  set cleanup_complete = coalesce(p_cleared, false),
      sandbox_id = case when coalesce(p_cleared, false) then null else b.sandbox_id end,
      cleanup_token = null,
      cleanup_claimed_at = case when coalesce(p_cleared, false) then null else now() + interval '5 minutes' end,
      updated_at = now()
  where b.id = p_build_id
    and b.cleanup_token = p_cleanup_token
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'updated');
end;
$$;

revoke all on function public.mark_android_build_cleanup(uuid, uuid, boolean) from public;
revoke all on function public.mark_android_build_cleanup(uuid, uuid, boolean) from anon;
revoke all on function public.mark_android_build_cleanup(uuid, uuid, boolean) from authenticated;
grant execute on function public.mark_android_build_cleanup(uuid, uuid, boolean) to service_role;

-- ── 9. Artifact retention / deletion ────────────────────────────────────────

create or replace function public.claim_expired_android_artifacts(
  p_limit integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 20));
  v_row public.project_android_builds;
  v_results jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_row in
    select b.*
    from public.project_android_builds b
    where b.artifact_bucket is not null
      and b.artifact_path is not null
      and (
        (
          b.artifact_state = 'available'
          and b.artifact_expires_at is not null
          and b.artifact_expires_at <= now()
        )
        or (
          b.artifact_state = 'expiring'
          and b.updated_at < now() - interval '10 minutes'
        )
        -- A transient Storage failure must not strand the object forever.
        or (
          b.artifact_state = 'delete_failed'
          and b.updated_at < now() - interval '30 minutes'
        )
      )
    order by b.artifact_expires_at nulls first
    for update skip locked
    limit v_limit
  loop
    update public.project_android_builds b
    set artifact_state = 'expiring',
        updated_at = now()
    where b.id = v_row.id
    returning * into v_row;

    v_results := v_results || jsonb_build_object(
      'buildId', v_row.id,
      'projectId', v_row.project_id,
      'bucket', v_row.artifact_bucket,
      'path', v_row.artifact_path
    );
  end loop;

  return jsonb_build_object('artifacts', v_results);
end;
$$;

revoke all on function public.claim_expired_android_artifacts(integer) from public;
revoke all on function public.claim_expired_android_artifacts(integer) from anon;
revoke all on function public.claim_expired_android_artifacts(integer) from authenticated;
grant execute on function public.claim_expired_android_artifacts(integer) to service_role;

create or replace function public.mark_android_artifact_deleted(
  p_build_id uuid,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_android_builds;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_android_builds b
  set artifact_state = case when coalesce(p_deleted, false) then 'expired' else 'delete_failed' end,
      artifact_bucket = case when coalesce(p_deleted, false) then null else b.artifact_bucket end,
      artifact_path = case when coalesce(p_deleted, false) then null else b.artifact_path end,
      artifact_expires_at = null,
      updated_at = now()
  where b.id = p_build_id
    and b.artifact_state = 'expiring'
  returning * into v_row;

  if not found then
    return jsonb_build_object('status', 'lost');
  end if;
  return jsonb_build_object('status', 'updated');
end;
$$;

revoke all on function public.mark_android_artifact_deleted(uuid, boolean) from public;
revoke all on function public.mark_android_artifact_deleted(uuid, boolean) from anon;
revoke all on function public.mark_android_artifact_deleted(uuid, boolean) from authenticated;
grant execute on function public.mark_android_artifact_deleted(uuid, boolean) to service_role;

-- ── 10. Private artifact bucket ─────────────────────────────────────────────
--
-- The bucket is private. Only the service role (the build worker) uploads, and
-- the API mints short-lived signed URLs after an owner check. No storage policy
-- grants authenticated clients direct object access.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'android-artifacts',
  'android-artifacts',
  false,
  104857600,
  array['application/vnd.android.package-archive']
)
on conflict (id) do update set public = false;

comment on table public.project_android_builds is
  'Durable isolated Android debug builds bound to immutable source snapshots; binary artifacts live only in private Storage.';
