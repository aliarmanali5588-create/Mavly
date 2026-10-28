-- Mavly-managed Neon database provisioning registry.
--
-- Additive and forward-only. This registry is separate from Mavly's Supabase
-- control plane and does not change project ownership, auth, billing or RLS.
-- Neon connection URIs are encrypted by the server before persistence; they
-- are never selectable by authenticated users or returned from a route.
--
-- `provisioned` means only that Mavly created a Neon project and verified a
-- server-side `select 1`. It does NOT mean generated code can connect, schema
-- migrations were applied, authentication works, or the app is hosted.
--
-- Registry rows deliberately survive project/user deletion so future
-- ownership-verified cleanup can identify the external Neon resource. No
-- automatic Neon deletion is performed by this migration. `project_created_at`
-- binds the row to one project incarnation so reusing a deleted project slug
-- cannot inherit or expose its prior managed database.

begin;

create table if not exists public.project_managed_backends (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  project_created_at timestamptz not null,
  user_id uuid references auth.users (id) on delete set null,
  provider text not null default 'neon' check (provider = 'neon'),
  neon_project_id text,
  region_id text not null,
  database_name text not null default 'mavly_app',
  role_name text not null default 'mavly_app_owner',
  status text not null default 'provisioning'
    check (status in ('provisioning', 'provisioned', 'failed', 'outcome_unknown')),
  creation_attempted boolean not null default false,
  connection_uri_ciphertext text,
  connection_verified_at timestamptz,
  schema_version integer,
  error_code text check (
    error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_managed_backends_project_instance_key
    unique (project_id, project_created_at),
  constraint project_managed_backends_neon_project_unique unique (neon_project_id),
  constraint project_managed_backends_schema_version_nonnegative
    check (schema_version is null or schema_version >= 0),
  constraint project_managed_backends_connection_check
    check (
      (status = 'provisioned' and neon_project_id is not null
        and connection_uri_ciphertext is not null
        and connection_verified_at is not null)
      or status <> 'provisioned'
    )
);

comment on table public.project_managed_backends is
  'Owner-readable Neon provisioning metadata. Encrypted connection URI is service-role-only; provisioned is not app runtime readiness.';
comment on column public.project_managed_backends.id is
  'Stable registry incarnation UUID used to isolate Neon resource names and connection-URI encryption across retries and project slug reuse.';
comment on column public.project_managed_backends.project_created_at is
  'The projects.created_at value for this project incarnation; prevents slug reuse from inheriting old backend state.';
comment on column public.project_managed_backends.connection_uri_ciphertext is
  'AES-256-GCM ciphertext encrypted by Mavly with a server-only key. Never grant this column to authenticated.';
comment on column public.project_managed_backends.schema_version is
  'Null until a separately reviewed, controlled application schema migration system exists.';

create index if not exists project_managed_backends_user_created_idx
  on public.project_managed_backends (user_id, created_at desc);

alter table public.project_managed_backends enable row level security;

drop policy if exists "project_managed_backends_select_own"
  on public.project_managed_backends;
create policy "project_managed_backends_select_own"
  on public.project_managed_backends
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.projects p
      where p.project_id = project_managed_backends.project_id
        and p.user_id = (select auth.uid())
        and p.created_at = project_managed_backends.project_created_at
    )
  );

revoke all on public.project_managed_backends from public, anon, authenticated;
grant select (
  id, project_id, user_id, provider, neon_project_id, region_id,
  database_name, role_name, status, connection_verified_at, schema_version,
  error_code, created_at, updated_at
) on public.project_managed_backends to authenticated;

create or replace function public.claim_managed_backend(
  p_project_id text,
  p_user_id uuid,
  p_lease_token uuid,
  p_region_id text,
  p_lease_seconds integer default 90
)
returns table (
  claim_status text,
  neon_project_id text,
  region_id text,
  connection_uri_ciphertext text,
  creation_attempted boolean,
  project_created_at timestamptz,
  registry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.project_managed_backends%rowtype;
  v_project_created_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception using errcode = '22023', message = 'invalid lease duration';
  end if;
  if p_lease_token is null or p_region_id is null
    or p_region_id !~ '^[a-z0-9]+(-[a-z0-9]+){1,5}$' then
    raise exception using errcode = '22023', message = 'invalid claim parameters';
  end if;
  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id and p.user_id = p_user_id
  for key share;
  if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  insert into public.project_managed_backends (
    project_id, project_created_at, user_id, region_id, lease_token,
    lease_expires_at
  )
  values (
    p_project_id, v_project_created_at, p_user_id, p_region_id, p_lease_token,
    now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (project_id, project_created_at) do nothing;

  select * into v_row
  from public.project_managed_backends b
  where b.project_id = p_project_id
    and b.project_created_at = v_project_created_at
  for update;

  if v_row.user_id is distinct from p_user_id then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  if v_row.status = 'provisioned' then
    return query select
      'provisioned'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  if v_row.lease_token = p_lease_token then
    return query select
      'claimed'::text, v_row.neon_project_id, v_row.region_id,
      v_row.connection_uri_ciphertext, v_row.creation_attempted,
      v_row.project_created_at, v_row.id;
    return;
  end if;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > now() then
    return query select
      'busy'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  update public.project_managed_backends b
  set status = 'provisioning',
      region_id = case when b.creation_attempted then b.region_id else p_region_id end,
      lease_token = p_lease_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      error_code = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = v_project_created_at
  returning b.* into v_row;

  if not found then
    return query select
      'busy'::text, null::text, null::text, null::text, false,
      v_project_created_at, null::uuid;
    return;
  end if;
  return query select
    'claimed'::text,
    v_row.neon_project_id, v_row.region_id,
    v_row.connection_uri_ciphertext, v_row.creation_attempted,
    v_row.project_created_at, v_row.id;
end;
$$;

create or replace function public.mark_managed_backend_create_started(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_project_created_at is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease parameters';
  end if;

  update public.project_managed_backends b
  set creation_attempted = true, updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'provisioning'
    and b.lease_token = p_lease_token
    and b.lease_expires_at > now();
  return found;
end;
$$;

create or replace function public.complete_managed_backend(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_neon_project_id text,
  p_region_id text,
  p_connection_uri_ciphertext text,
  p_connection_verified boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_neon_project_id is null
    or p_neon_project_id !~ '^[A-Za-z0-9-]{1,128}$'
    or p_project_created_at is null
    or p_lease_token is null
    or p_region_id is null
    or p_region_id !~ '^[a-z0-9]+(-[a-z0-9]+){1,5}$'
    or p_connection_verified is null
    or p_connection_uri_ciphertext is null
    or p_connection_uri_ciphertext !~
      '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'
    or length(p_connection_uri_ciphertext) > 8192 then
    raise exception using errcode = '22023', message = 'invalid backend metadata';
  end if;

  update public.project_managed_backends b
  set neon_project_id = p_neon_project_id,
      region_id = p_region_id,
      connection_uri_ciphertext = p_connection_uri_ciphertext,
      status = case when p_connection_verified then 'provisioned' else 'failed' end,
      connection_verified_at =
        case when p_connection_verified then now() else null end,
      error_code =
        case when p_connection_verified then null else 'NEON_CONNECTION_UNAVAILABLE' end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'provisioning'
    and b.lease_token = p_lease_token
    and b.lease_expires_at > now();
  return found;
end;
$$;

create or replace function public.fail_managed_backend(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_error_code text,
  p_outcome_unknown boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_error_code is null or p_error_code !~ '^[A-Z0-9_]{1,64}$' then
    raise exception using errcode = '22023', message = 'invalid error code';
  end if;
  if p_project_created_at is null or p_lease_token is null
    or p_outcome_unknown is null then
    raise exception using errcode = '22023', message = 'invalid failure parameters';
  end if;

  update public.project_managed_backends b
  set status = case when p_outcome_unknown then 'outcome_unknown' else 'failed' end,
      error_code = p_error_code,
      creation_attempted =
        case when p_outcome_unknown then b.creation_attempted else false end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'provisioning'
    and b.lease_token = p_lease_token
    and b.lease_expires_at > now();
  return found;
end;
$$;

revoke all on function public.claim_managed_backend(text, uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.mark_managed_backend_create_started(text, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_managed_backend(text, timestamptz, uuid, text, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.fail_managed_backend(text, timestamptz, uuid, text, boolean)
  from public, anon, authenticated;

grant execute on function public.claim_managed_backend(text, uuid, uuid, text, integer)
  to service_role;
grant execute on function public.mark_managed_backend_create_started(text, timestamptz, uuid)
  to service_role;
grant execute on function public.complete_managed_backend(text, timestamptz, uuid, text, text, text, boolean)
  to service_role;
grant execute on function public.fail_managed_backend(text, timestamptz, uuid, text, boolean)
  to service_role;

commit;
