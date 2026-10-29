-- Live runtime preview sandboxes (Phase 13).
--
-- Additive and forward-only. This migration adds:
--   · project_runtime_sandboxes — one durable lifecycle row per live preview
--     sandbox: owner, project, run, provider reference, state, source hash,
--     synced path manifest, validated port and preview URL, bounded logs,
--     bounded diagnostics, lifetime and expiry;
--   · owner-checked SECURITY DEFINER RPCs for atomic begin, state update and
--     stop, plus a service-role-only expiry sweep;
--   · SELECT-only RLS for the project owner and schema marker 34.
--
-- ⚠️ IT DOES NOT CHANGE GENERATION, CREDITS, IMAGES, VERIFICATION OR DEPLOYMENT.
-- A runtime sandbox is a disposable preview runtime, not a source of truth:
-- project_files remain authoritative, and nothing here writes them.
--
-- ⚠️ THE PROVIDER REFERENCE IS SERVER-ONLY. `provider_sandbox_id` is never
-- returned to the browser; the preview URL is the only provider-derived value a
-- signed-in owner sees, and it is validated by the server before it is stored.
--
-- ⚠️ ONE ACTIVE SANDBOX PER PROJECT. The partial unique index plus the
-- transaction-scoped advisory lock make concurrent start requests resolve to the
-- same row instead of creating (and paying for) two sandboxes.
--
-- ⚠️ NO APPLICATION SQL IS RUN. Nothing here executes generated project code on
-- a Mavly host.

begin;

create table if not exists public.project_runtime_sandboxes (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid,
  run_id uuid references public.project_runs (id) on delete set null,
  provider text not null default 'e2b' check (provider in ('e2b')),
  provider_sandbox_id text
    check (
      provider_sandbox_id is null
      or provider_sandbox_id ~ '^[A-Za-z0-9_-]{1,128}$'
    ),
  framework text not null default 'react_vite'
    check (framework in ('react_vite')),
  state text not null default 'provisioning'
    check (state in (
      'provisioning','syncing','installing','starting','ready',
      'stopping','stopped','expired','failed'
    )),
  source_hash text
    check (source_hash is null or source_hash ~ '^[a-f0-9]{64}$'),
  synced_paths jsonb not null default '[]'::jsonb,
  port integer check (port is null or port between 1024 and 65535),
  preview_url text
    check (
      preview_url is null
      or (preview_url ~ '^https://' and length(preview_url) <= 400)
    ),
  failure_code text
    check (failure_code is null or failure_code ~ '^[A-Z0-9_]{1,64}$'),
  failure_reason text
    check (failure_reason is null or length(failure_reason) <= 300),
  logs text not null default ''
    check (length(logs) <= 16384),
  diagnostics jsonb not null default '{}'::jsonb,
  install_ms integer check (install_ms is null or install_ms between 0 and 1200000),
  startup_ms integer check (startup_ms is null or startup_ms between 0 and 1200000),
  command_count integer not null default 0 check (command_count between 0 and 200),
  max_lifetime_seconds integer not null default 1800
    check (max_lifetime_seconds between 120 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  stopped_at timestamptz,
  constraint project_runtime_sandboxes_ready_complete check (
    state <> 'ready'
    or (provider_sandbox_id is not null and port is not null and preview_url is not null)
  )
);

comment on table public.project_runtime_sandboxes is
  'Durable lifecycle record for one live preview sandbox. project_files remain the source of truth; this row never stores source files.';
comment on column public.project_runtime_sandboxes.provider_sandbox_id is
  'Provider sandbox reference used only by the server adapter. It is not a credential and the API does not expose it, but RLS SELECT is row-level so the owning project can read it.';
comment on column public.project_runtime_sandboxes.logs is
  'Bounded, server-redacted terminal output from the approved operations only.';
comment on column public.project_runtime_sandboxes.synced_paths is
  'The authoritative paths written into this sandbox, so a later sync removes only files Mavly put there.';

-- One live sandbox per project. A terminal row does not block a new session.
create unique index if not exists project_runtime_sandboxes_one_active
  on public.project_runtime_sandboxes (project_id)
  where state in ('provisioning','syncing','installing','starting','ready','stopping');

create index if not exists project_runtime_sandboxes_project_created_idx
  on public.project_runtime_sandboxes (project_id, created_at desc);

create index if not exists project_runtime_sandboxes_expiry_idx
  on public.project_runtime_sandboxes (expires_at)
  where state in ('provisioning','syncing','installing','starting','ready','stopping');

alter table public.project_runtime_sandboxes enable row level security;

drop policy if exists "project_runtime_sandboxes_select_own"
  on public.project_runtime_sandboxes;
create policy "project_runtime_sandboxes_select_own"
  on public.project_runtime_sandboxes
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_runtime_sandboxes.project_id
      and p.user_id = (select auth.uid())
  ));

revoke all on table public.project_runtime_sandboxes from anon;
revoke insert, update, delete on table public.project_runtime_sandboxes from authenticated;
grant select on table public.project_runtime_sandboxes to authenticated, service_role;

-- ── Ownership helper ────────────────────────────────────────────────────────

create or replace function public.runtime_sandbox_caller_owns_project(p_project_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return true;
  end if;
  if v_uid is null then
    return false;
  end if;
  return exists (
    select 1 from public.projects p
    where p.project_id = p_project_id
      and p.user_id = v_uid
  );
end;
$$;

comment on function public.runtime_sandbox_caller_owns_project(text) is
  'Owner check for the runtime sandbox RPCs. service_role is trusted; every other caller must own the project row.';

-- The only legal lifecycle edges. Enforced in the database as well as in the
-- service, because an owner can call the RPC directly through PostgREST.
create or replace function public.runtime_sandbox_transition_allowed(
  p_from text,
  p_to text
)
returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to then true
    when p_from = 'provisioning' then p_to in ('syncing','stopping','failed','expired')
    when p_from = 'syncing' then p_to in ('installing','stopping','failed','expired')
    when p_from = 'installing' then p_to in ('starting','stopping','failed','expired')
    when p_from = 'starting' then p_to in ('ready','stopping','failed','expired')
    when p_from = 'ready' then p_to in ('stopping','failed','expired')
    when p_from = 'stopping' then p_to in ('stopped','failed')
    else false
  end
$$;

comment on function public.runtime_sandbox_transition_allowed(text, text) is
  'The fixed live-runtime lifecycle edges. ready is reachable only from starting.';

create or replace function public.runtime_sandbox_json(p_row public.project_runtime_sandboxes)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'projectId', p_row.project_id,
    'runId', p_row.run_id,
    'provider', p_row.provider,
    'sandboxId', p_row.provider_sandbox_id,
    'framework', p_row.framework,
    'state', p_row.state,
    'sourceHash', p_row.source_hash,
    'syncedPaths', p_row.synced_paths,
    'port', p_row.port,
    'previewUrl', p_row.preview_url,
    'failureCode', p_row.failure_code,
    'failureReason', p_row.failure_reason,
    'logs', p_row.logs,
    'diagnostics', p_row.diagnostics,
    'installMs', p_row.install_ms,
    'startupMs', p_row.startup_ms,
    'commandCount', p_row.command_count,
    'maxLifetimeSeconds', p_row.max_lifetime_seconds,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at,
    'lastActivityAt', p_row.last_activity_at,
    'expiresAt', p_row.expires_at,
    'stoppedAt', p_row.stopped_at
  );
$$;

-- ── Begin (atomic, idempotent per project) ──────────────────────────────────

create or replace function public.begin_runtime_sandbox(
  p_project_id text,
  p_run_id uuid,
  p_provider text,
  p_framework text,
  p_source_hash text,
  p_max_lifetime_seconds integer,
  p_max_active_per_user integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_project_type text;
  v_row public.project_runtime_sandboxes;
  v_active integer := 0;
  v_lifetime integer;
begin
  if not public.runtime_sandbox_caller_owns_project(p_project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  select p.project_type into v_project_type
  from public.projects p
  where p.project_id = p_project_id;

  if v_project_type is null then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;
  if v_project_type <> 'website' then
    raise exception 'RUNTIME_PROJECT_TYPE_UNSUPPORTED' using errcode = '22023';
  end if;

  if p_source_hash is not null and p_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'RUNTIME_SOURCE_INVALID' using errcode = '22023';
  end if;

  v_lifetime := least(3600, greatest(120, coalesce(p_max_lifetime_seconds, 1800)));

  -- Serialize starts for this project so concurrent requests reuse one row, and
  -- serialize this caller's other starts so the per-user quota cannot be raced.
  perform pg_advisory_xact_lock(hashtext('mavly_runtime_sandbox:' || p_project_id));
  perform pg_advisory_xact_lock(
    hashtext('mavly_runtime_sandbox_user:' || coalesce(v_uid::text, 'service'))
  );

  select * into v_row
  from public.project_runtime_sandboxes s
  where s.project_id = p_project_id
    and s.state in ('provisioning','syncing','installing','starting','ready','stopping')
  order by s.created_at desc
  limit 1;

  if v_row.id is not null then
    return jsonb_build_object('created', false, 'sandbox', public.runtime_sandbox_json(v_row));
  end if;

  select count(*) into v_active
  from public.project_runtime_sandboxes s
  join public.projects p on p.project_id = s.project_id
  where p.user_id = v_uid
    and s.state in ('provisioning','syncing','installing','starting','ready','stopping');

  if v_active >= least(5, greatest(1, coalesce(p_max_active_per_user, 2))) then
    raise exception 'RUNTIME_SANDBOX_QUOTA' using errcode = 'P0001';
  end if;

  if p_run_id is not null and not exists (
    select 1 from public.project_runs r
    where r.id = p_run_id and r.project_id = p_project_id
  ) then
    p_run_id := null;
  end if;

  insert into public.project_runtime_sandboxes (
    project_id, user_id, run_id, provider, framework, state,
    source_hash, max_lifetime_seconds, expires_at
  ) values (
    p_project_id, v_uid, p_run_id,
    coalesce(nullif(p_provider, ''), 'e2b'),
    coalesce(nullif(p_framework, ''), 'react_vite'),
    'provisioning',
    p_source_hash,
    v_lifetime,
    now() + make_interval(secs => v_lifetime)
  )
  returning * into v_row;

  return jsonb_build_object('created', true, 'sandbox', public.runtime_sandbox_json(v_row));
end;
$$;

comment on function public.begin_runtime_sandbox(text, uuid, text, text, text, integer, integer) is
  'Atomically begins (or returns) the one active runtime sandbox for an owned website project. Enforces the per-user active quota under an advisory lock.';

-- ── Update one lifecycle stage ─────────────────────────────────────────────

create or replace function public.update_runtime_sandbox(
  p_id uuid,
  p_state text,
  p_sandbox_id text,
  p_port integer,
  p_preview_url text,
  p_failure_code text,
  p_failure_reason text,
  p_logs text,
  p_diagnostics jsonb,
  p_synced_paths jsonb,
  p_install_ms integer,
  p_startup_ms integer,
  p_extend_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_runtime_sandboxes;
  v_state text := nullif(btrim(coalesce(p_state, '')), '');
  v_terminal text[] := array['stopped','expired','failed'];
  v_paths jsonb;
  v_diagnostics jsonb;
begin
  select * into v_row
  from public.project_runtime_sandboxes s
  where s.id = p_id;

  if v_row.id is null then
    return null;
  end if;
  if not public.runtime_sandbox_caller_owns_project(v_row.project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  if v_state is not null and v_state not in (
    'provisioning','syncing','installing','starting','ready',
    'stopping','stopped','expired','failed'
  ) then
    raise exception 'RUNTIME_STATE_INVALID' using errcode = '22023';
  end if;

  -- A terminal outcome is final. A late provider response may not resurrect it.
  if v_row.state = any(v_terminal) and coalesce(v_state, v_row.state) <> v_row.state then
    raise exception 'RUNTIME_SANDBOX_TERMINAL' using errcode = 'P0001';
  end if;

  -- Every non-terminal transition must follow the fixed table; a forged
  -- `provisioning -> ready` update is rejected even from the owner's own client.
  if v_state is not null
     and v_state <> v_row.state
     and not public.runtime_sandbox_transition_allowed(v_row.state, v_state) then
    raise exception 'RUNTIME_STATE_TRANSITION_INVALID' using errcode = 'P0001';
  end if;

  if p_sandbox_id is not null and p_sandbox_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'RUNTIME_SANDBOX_ID_INVALID' using errcode = '22023';
  end if;
  if p_port is not null and (p_port < 1024 or p_port > 65535) then
    raise exception 'RUNTIME_PORT_INVALID' using errcode = '22023';
  end if;
  if p_preview_url is not null and (p_preview_url !~ '^https://' or length(p_preview_url) > 400) then
    raise exception 'RUNTIME_PREVIEW_INVALID' using errcode = '22023';
  end if;

  if p_synced_paths is not null and jsonb_typeof(p_synced_paths) = 'array' then
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_paths
    from (
      select value
      from jsonb_array_elements(p_synced_paths)
      where jsonb_typeof(value) = 'string'
      limit 1000
    ) limited;
  else
    v_paths := null;
  end if;

  if p_diagnostics is not null and jsonb_typeof(p_diagnostics) = 'object'
     and length(p_diagnostics::text) <= 8000 then
    v_diagnostics := p_diagnostics;
  else
    v_diagnostics := null;
  end if;

  update public.project_runtime_sandboxes s
  set state = coalesce(v_state, s.state),
      provider_sandbox_id = coalesce(p_sandbox_id, s.provider_sandbox_id),
      port = coalesce(p_port, s.port),
      preview_url = coalesce(p_preview_url, s.preview_url),
      failure_code = coalesce(nullif(left(btrim(coalesce(p_failure_code, '')), 64), ''), s.failure_code),
      failure_reason = coalesce(nullif(left(btrim(coalesce(p_failure_reason, '')), 300), ''), s.failure_reason),
      logs = case when p_logs is null then s.logs else left(p_logs, 16384) end,
      diagnostics = coalesce(v_diagnostics, s.diagnostics),
      synced_paths = coalesce(v_paths, s.synced_paths),
      install_ms = coalesce(p_install_ms, s.install_ms),
      startup_ms = coalesce(p_startup_ms, s.startup_ms),
      command_count = least(200, s.command_count + 1),
      updated_at = now(),
      last_activity_at = now(),
      expires_at = case
        when coalesce(p_extend_seconds, 0) > 0 then
          least(
            s.created_at + make_interval(secs => s.max_lifetime_seconds),
            greatest(s.expires_at, now() + make_interval(secs => least(greatest(p_extend_seconds, 0), 600)))
          )
        else s.expires_at
      end,
      stopped_at = case
        when coalesce(v_state, s.state) in ('stopped','expired','failed') then
          coalesce(s.stopped_at, now())
        else s.stopped_at
      end
  where s.id = p_id
  returning * into v_row;

  return public.runtime_sandbox_json(v_row);
end;
$$;

comment on function public.update_runtime_sandbox(uuid, text, text, integer, text, text, text, text, jsonb, jsonb, integer, integer, integer) is
  'Writes one validated lifecycle stage. Terminal rows cannot transition again; logs and diagnostics are bounded; lifetime extension is capped by the session maximum.';

-- ── Owner stop ──────────────────────────────────────────────────────────────

create or replace function public.stop_runtime_sandbox(p_project_id text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_runtime_sandboxes;
begin
  if not public.runtime_sandbox_caller_owns_project(p_project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_row
  from public.project_runtime_sandboxes s
  where s.id = p_id and s.project_id = p_project_id;

  if v_row.id is null then
    return null;
  end if;

  if v_row.state in ('stopped','expired','failed') then
    return public.runtime_sandbox_json(v_row);
  end if;

  update public.project_runtime_sandboxes s
  set state = 'stopping',
      updated_at = now(),
      last_activity_at = now()
  where s.id = p_id
  returning * into v_row;

  return public.runtime_sandbox_json(v_row);
end;
$$;

comment on function public.stop_runtime_sandbox(text, uuid) is
  'Owner-requested stop. It records intent only; the server kills the provider process and sandbox, then finalizes the row as stopped. Idempotent for a terminal row.';

-- ── Service-role expiry sweep ───────────────────────────────────────────────

create or replace function public.expire_runtime_sandboxes(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with expired as (
    update public.project_runtime_sandboxes s
    set state = 'expired',
        failure_code = coalesce(s.failure_code, 'EXPIRED'),
        failure_reason = coalesce(s.failure_reason, 'The sandbox reached its lifetime or idle limit.'),
        updated_at = now(),
        stopped_at = coalesce(s.stopped_at, now())
    where s.id in (
      select s2.id
      from public.project_runtime_sandboxes s2
      where s2.state in ('provisioning','syncing','installing','starting','ready','stopping')
        and s2.expires_at < now()
      order by s2.expires_at asc
      limit least(50, greatest(1, coalesce(p_limit, 20)))
    )
    returning s.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'projectId', e.project_id,
    'sandboxId', e.provider_sandbox_id
  )), '[]'::jsonb)
  into v_rows
  from expired e;

  return v_rows;
end;
$$;

comment on function public.expire_runtime_sandboxes(integer) is
  'Service-role-only bounded sweep: marks at most N expired rows and returns the provider sandboxes the worker must destroy.';

-- ── Grants and schema marker ────────────────────────────────────────────────

revoke all on function public.runtime_sandbox_caller_owns_project(text) from public;
revoke all on function public.runtime_sandbox_caller_owns_project(text) from anon;
revoke all on function public.runtime_sandbox_transition_allowed(text, text) from public;
revoke all on function public.runtime_sandbox_transition_allowed(text, text) from anon;
revoke all on function public.runtime_sandbox_json(public.project_runtime_sandboxes) from public;
revoke all on function public.runtime_sandbox_json(public.project_runtime_sandboxes) from anon;
revoke all on function public.begin_runtime_sandbox(text, uuid, text, text, text, integer, integer) from public;
revoke all on function public.begin_runtime_sandbox(text, uuid, text, text, text, integer, integer) from anon;
revoke all on function public.update_runtime_sandbox(uuid, text, text, integer, text, text, text, text, jsonb, jsonb, integer, integer, integer) from public;
revoke all on function public.update_runtime_sandbox(uuid, text, text, integer, text, text, text, text, jsonb, jsonb, integer, integer, integer) from anon;
revoke all on function public.stop_runtime_sandbox(text, uuid) from public;
revoke all on function public.stop_runtime_sandbox(text, uuid) from anon;
revoke all on function public.expire_runtime_sandboxes(integer) from public;
revoke all on function public.expire_runtime_sandboxes(integer) from anon;
revoke all on function public.expire_runtime_sandboxes(integer) from authenticated;

grant execute on function public.begin_runtime_sandbox(text, uuid, text, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.update_runtime_sandbox(uuid, text, text, integer, text, text, text, text, jsonb, jsonb, integer, integer, integer) to authenticated, service_role;
grant execute on function public.stop_runtime_sandbox(text, uuid) to authenticated, service_role;
grant execute on function public.expire_runtime_sandboxes(integer) to service_role;

create or replace function public.runtime_sandbox_schema_version()
returns integer
language sql
stable
as $$ select 34 $$;

comment on function public.runtime_sandbox_schema_version() is
  'Schema marker 34: live runtime preview sandboxes (migration 34).';

revoke all on function public.runtime_sandbox_schema_version() from public;
revoke all on function public.runtime_sandbox_schema_version() from anon;
grant execute on function public.runtime_sandbox_schema_version() to authenticated, service_role;

commit;
