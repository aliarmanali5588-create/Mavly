-- Mavly — managed backend runtime: verified schema + data gateway (Phase 14)
--
-- Additive and forward-only, applied after 30 (and after 34).
--
-- What this migration adds:
--
--   1. The configuration phase of the managed-backend lifecycle
--      (provisioned → configuring → ready). `ready` is only reachable through
--      `complete_managed_backend_configuration`, which requires BOTH a verified
--      schema and a verified runtime connection. A database without a schema is
--      never `ready`.
--   2. A sanitized mirror of the customer database's own migration ledger, so
--      an owner/operator can see which model revision was applied.
--   3. `data_gateway_context` + `consume_app_gateway_rate`, the only two
--      functions a generated application's browser code can reach. They are
--      gated by a server-only RPC proof; the project id alone is not a
--      credential.
--   4. A durable per-project rate window for the public gateway.
--
-- It does NOT delete a Neon project, apply SQL to customer data, rotate any
-- key, or change Mavly's own auth, credits, publishing or generation tables.
-- `cleanup_pending` is bookkeeping only: no external deletion is implemented
-- here or anywhere else in this repository.

begin;

-- ── Lifecycle columns ───────────────────────────────────────────────────────

alter table public.project_managed_backends
  add column if not exists data_model jsonb,
  add column if not exists data_model_checksum text,
  add column if not exists schema_verified_at timestamptz,
  add column if not exists migration_step_count integer not null default 0,
  add column if not exists runtime_verified_at timestamptz,
  add column if not exists gateway_origin text,
  add column if not exists gateway_configured_at timestamptz,
  add column if not exists gateway_secret_hash text,
  add column if not exists auth_required boolean not null default false,
  add column if not exists config_lease_token uuid,
  add column if not exists config_lease_expires_at timestamptz,
  add column if not exists last_step text,
  add column if not exists cleanup_state text;

comment on column public.project_managed_backends.data_model is
  'The validated application data model applied to this database. Table/column names only; no connection data.';
comment on column public.project_managed_backends.schema_verified_at is
  'Set only after the runner applied every step AND read the resulting schema back successfully.';
comment on column public.project_managed_backends.runtime_verified_at is
  'Set only after a post-migration server-side connectivity check succeeded.';
comment on column public.project_managed_backends.gateway_secret_hash is
  'SHA-256 of the server-only managed-backend RPC proof. Never the secret itself; never returned to a browser.';
comment on column public.project_managed_backends.cleanup_state is
  'Bookkeeping only. No automatic Neon project deletion is implemented.';

alter table public.project_managed_backends
  drop constraint if exists project_managed_backends_status_check;
alter table public.project_managed_backends
  add constraint project_managed_backends_status_check
  check (
    status in (
      'provisioning', 'provisioned', 'configuring', 'ready',
      'failed', 'outcome_unknown', 'cleanup_pending'
    )
  );

-- A row may only be provisioned/configuring/ready when its connection metadata
-- is actually present. `ready` therefore cannot exist without a database.
alter table public.project_managed_backends
  drop constraint if exists project_managed_backends_connection_check;
alter table public.project_managed_backends
  add constraint project_managed_backends_connection_check
  check (
    (
      status in ('provisioned', 'configuring', 'ready')
      and neon_project_id is not null
      and connection_uri_ciphertext is not null
      and connection_verified_at is not null
    )
    or status not in ('provisioned', 'configuring', 'ready')
  );

alter table public.project_managed_backends
  drop constraint if exists project_managed_backends_ready_requires_schema;
alter table public.project_managed_backends
  add constraint project_managed_backends_ready_requires_schema
  check (
    status <> 'ready'
    or (
      data_model is not null
      and data_model_checksum is not null
      and schema_verified_at is not null
      and runtime_verified_at is not null
      and gateway_origin is not null
      and gateway_configured_at is not null
      and gateway_secret_hash is not null
    )
  );

alter table public.project_managed_backends
  drop constraint if exists project_managed_backends_step_check;
alter table public.project_managed_backends
  add constraint project_managed_backends_step_check
  check (
    (last_step is null or last_step ~ '^[a-z0-9:_-]{1,64}$')
    and migration_step_count >= 0
    and migration_step_count <= 64
    and (gateway_origin is null or gateway_origin ~ '^https://[a-z0-9.-]{1,190}(:[0-9]{1,5})?$')
  );

-- ── Sanitized migration mirror ─────────────────────────────────────────────

create table if not exists public.project_managed_backend_migrations (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null
    references public.project_managed_backends (id) on delete cascade,
  project_id text not null,
  user_id uuid,
  step_name text not null check (step_name ~ '^[a-z0-9:_-]{1,64}$'),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now(),
  constraint project_managed_backend_migrations_key
    unique (registry_id, step_name, checksum)
);

comment on table public.project_managed_backend_migrations is
  'Owner-readable mirror of the customer database migration ledger. No SQL text, credentials or row data.';

create index if not exists project_managed_backend_migrations_project_idx
  on public.project_managed_backend_migrations (project_id, applied_at desc);

alter table public.project_managed_backend_migrations enable row level security;

drop policy if exists "project_managed_backend_migrations_select_own"
  on public.project_managed_backend_migrations;
create policy "project_managed_backend_migrations_select_own"
  on public.project_managed_backend_migrations
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.projects p
      where p.project_id = project_managed_backend_migrations.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.project_managed_backend_migrations from public, anon, authenticated;
grant select (id, project_id, user_id, step_name, checksum, applied_at)
  on public.project_managed_backend_migrations to authenticated;

-- ── Durable public-gateway rate windows ────────────────────────────────────

create table if not exists public.app_gateway_rate_windows (
  project_id text not null,
  action text not null check (action in ('read', 'write', 'auth')),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (project_id, action, window_start)
);

comment on table public.app_gateway_rate_windows is
  'Durable per-project data-gateway request windows. Limits are fixed in consume_app_gateway_rate().';

alter table public.app_gateway_rate_windows enable row level security;
revoke all on public.app_gateway_rate_windows from public, anon, authenticated;

-- ── Provisioning claim: reuse ready/configuring rows without re-creating ────

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

  -- A provisioned or ready database is reused. Re-provisioning a ready row
  -- would silently downgrade it to `provisioned` and lose schema readiness.
  if v_row.status in ('provisioned', 'ready') then
    return query select
      'provisioned'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  -- Configuration is a separate lease; while it is alive this is busy.
  if v_row.status = 'configuring' then
    if v_row.config_lease_expires_at is not null
      and v_row.config_lease_expires_at > now() then
      return query select
        'busy'::text, v_row.neon_project_id, v_row.region_id,
        null::text, v_row.creation_attempted, v_row.project_created_at,
        v_row.id;
      return;
    end if;
    -- An expired configuration lease is safe to resume: the schema steps are
    -- idempotent and the ledger records what already committed.
    return query select
      'provisioned'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  -- A row awaiting an owner-approved cleanup is never resurrected implicitly.
  if v_row.status = 'cleanup_pending' then
    return query select
      'busy'::text, v_row.neon_project_id, v_row.region_id,
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

-- ── Configuration claim ────────────────────────────────────────────────────

create or replace function public.begin_managed_backend_configuration(
  p_project_id text,
  p_user_id uuid,
  p_lease_token uuid
)
returns table (
  claim_status text,
  registry_id uuid,
  project_created_at timestamptz,
  neon_project_id text,
  region_id text,
  connection_uri_ciphertext text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.project_managed_backends%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease token';
  end if;

  select b.* into v_row
  from public.project_managed_backends b
  join public.projects p
    on p.project_id = b.project_id
   and p.created_at = b.project_created_at
   and p.user_id = p_user_id
  where b.project_id = p_project_id
    and b.user_id = p_user_id
  order by b.created_at desc
  limit 1
  for update of b;

  if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  if v_row.status in ('provisioning', 'outcome_unknown', 'cleanup_pending') then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  if v_row.neon_project_id is null or v_row.connection_uri_ciphertext is null
    or v_row.connection_verified_at is null then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, null::text,
      v_row.region_id, null::text;
    return;
  end if;

  if v_row.config_lease_expires_at is not null
    and v_row.config_lease_expires_at > now()
    and v_row.config_lease_token is distinct from p_lease_token then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  update public.project_managed_backends b
  set status = 'configuring',
      config_lease_token = p_lease_token,
      config_lease_expires_at = now() + interval '5 minutes',
      last_step = 'schema',
      error_code = null,
      updated_at = now()
  where b.id = v_row.id
  returning b.* into v_row;

  if not found then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  return query select
    'claimed'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
    v_row.region_id, v_row.connection_uri_ciphertext;
end;
$$;

comment on function public.begin_managed_backend_configuration(text, uuid, uuid) is
  'Service-role-only fenced claim of the schema/gateway configuration phase. Never creates a database.';

-- ── Migration mirror write ─────────────────────────────────────────────────

create or replace function public.record_managed_backend_migration(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_step_name text,
  p_checksum text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_step_name is null or p_step_name !~ '^[a-z0-9:_-]{1,64}$'
    or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid migration metadata';
  end if;

  select b.id into v_id
  from public.project_managed_backends b
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'configuring'
    and b.config_lease_token = p_lease_token
    and b.config_lease_expires_at > now();

  if v_id is null then
    return false;
  end if;

  insert into public.project_managed_backend_migrations (
    registry_id, project_id, user_id, step_name, checksum
  )
  select v_id, b.project_id, b.user_id, p_step_name, p_checksum
  from public.project_managed_backends b
  where b.id = v_id
  on conflict (registry_id, step_name, checksum) do nothing;

  return true;
end;
$$;

comment on function public.record_managed_backend_migration(text, timestamptz, uuid, text, text) is
  'Service-role-only append of a sanitized migration step. The customer database ledger remains authoritative.';

-- ── Configuration completion ───────────────────────────────────────────────

create or replace function public.complete_managed_backend_configuration(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_data_model jsonb,
  p_data_model_checksum text,
  p_step_count integer,
  p_auth_required boolean,
  p_gateway_origin text,
  p_gateway_secret_hash text,
  p_schema_verified boolean,
  p_runtime_verified boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ready boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_data_model is null or jsonb_typeof(p_data_model) <> 'object'
    or pg_column_size(p_data_model) > 262144 then
    raise exception using errcode = '22023', message = 'invalid data model';
  end if;
  if p_data_model_checksum is null
    or p_data_model_checksum !~ '^[a-f0-9]{8,64}$' then
    raise exception using errcode = '22023', message = 'invalid model checksum';
  end if;
  if p_step_count is null or p_step_count < 0 or p_step_count > 64 then
    raise exception using errcode = '22023', message = 'invalid step count';
  end if;
  if p_auth_required is null or p_schema_verified is null
    or p_runtime_verified is null then
    raise exception using errcode = '22023', message = 'invalid readiness flags';
  end if;
  if p_gateway_origin is null
    or p_gateway_origin !~ '^https://[a-z0-9.-]{1,190}(:[0-9]{1,5})?$'
    or pg_column_size(p_gateway_origin) > 200 then
    raise exception using errcode = '22023', message = 'invalid gateway origin';
  end if;
  if p_gateway_secret_hash is null
    or p_gateway_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid gateway proof';
  end if;

  v_ready := p_schema_verified and p_runtime_verified;

  update public.project_managed_backends b
  set status = case when v_ready then 'ready' else 'failed' end,
      data_model = p_data_model,
      data_model_checksum = p_data_model_checksum,
      migration_step_count = p_step_count,
      auth_required = p_auth_required,
      schema_verified_at = case when p_schema_verified then now() else null end,
      runtime_verified_at = case when p_runtime_verified then now() else null end,
      gateway_origin = p_gateway_origin,
      gateway_secret_hash = p_gateway_secret_hash,
      gateway_configured_at = case when v_ready then now() else null end,
      error_code = case when v_ready then null else 'SCHEMA_NOT_VERIFIED' end,
      last_step = case when v_ready then 'ready' else 'verify' end,
      config_lease_token = null,
      config_lease_expires_at = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'configuring'
    and b.config_lease_token = p_lease_token
    and b.config_lease_expires_at > now();

  return found;
end;
$$;

comment on function public.complete_managed_backend_configuration(text, timestamptz, uuid, jsonb, text, integer, boolean, text, text, boolean, boolean) is
  'Service-role-only completion. ready requires a verified schema AND a verified runtime connection.';

create or replace function public.fail_managed_backend_configuration(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_error_code text,
  p_step text
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
  if p_step is null or p_step !~ '^[a-z0-9:_-]{1,64}$' then
    raise exception using errcode = '22023', message = 'invalid step';
  end if;

  update public.project_managed_backends b
  set status = 'failed',
      error_code = p_error_code,
      last_step = p_step,
      config_lease_token = null,
      config_lease_expires_at = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'configuring'
    and b.config_lease_token = p_lease_token
    and b.config_lease_expires_at > now();

  return found;
end;
$$;

comment on function public.fail_managed_backend_configuration(text, timestamptz, uuid, text, text) is
  'Service-role-only sanitized failure record. Preserves the database and its data.';

-- ── Owner-visible status ───────────────────────────────────────────────────

create or replace function public.managed_backend_status(
  p_project_id text
)
returns table (
  status text,
  registry_id uuid,
  project_created_at timestamptz,
  region_id text,
  data_model jsonb,
  auth_required boolean,
  connection_verified_at timestamptz,
  schema_verified_at timestamptz,
  migration_step_count integer,
  gateway_origin text,
  gateway_configured_at timestamptz,
  error_code text,
  last_step text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  return query
    select b.status, b.id, b.project_created_at, b.region_id, b.data_model,
           b.auth_required, b.connection_verified_at, b.schema_verified_at,
           b.migration_step_count, b.gateway_origin, b.gateway_configured_at,
           b.error_code, b.last_step, b.updated_at
      from public.project_managed_backends b
     where b.project_id = p_project_id
       and b.user_id = auth.uid()
       and exists (
         select 1
         from public.projects p
         where p.project_id = b.project_id
           and p.user_id = auth.uid()
           and p.created_at = b.project_created_at
       )
     order by b.created_at desc
     limit 1;
end;
$$;

comment on function public.managed_backend_status(text) is
  'Owner-scoped managed-backend status. Never returns ciphertext or provider credentials.';

create or replace function public.managed_backend_lifecycle(
  p_project_id text,
  p_user_id uuid
)
returns table (
  status text,
  registry_id uuid,
  project_created_at timestamptz,
  region_id text,
  data_model jsonb,
  auth_required boolean,
  connection_verified_at timestamptz,
  schema_verified_at timestamptz,
  migration_step_count integer,
  gateway_origin text,
  gateway_configured_at timestamptz,
  error_code text,
  last_step text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  return query
    select b.status, b.id, b.project_created_at, b.region_id, b.data_model,
           b.auth_required, b.connection_verified_at, b.schema_verified_at,
           b.migration_step_count, b.gateway_origin, b.gateway_configured_at,
           b.error_code, b.last_step, b.updated_at
      from public.project_managed_backends b
     where b.project_id = p_project_id
       and b.user_id = p_user_id
       and exists (
         select 1
         from public.projects p
         where p.project_id = b.project_id
           and p.user_id = p_user_id
           and p.created_at = b.project_created_at
       )
     order by b.created_at desc
     limit 1;
end;
$$;

comment on function public.managed_backend_lifecycle(text, uuid) is
  'Service-role-only lifecycle read for the generation worker. Never returns ciphertext.';

-- ── Public data gateway ────────────────────────────────────────────────────

create or replace function public.data_gateway_context(
  p_project_id text,
  p_rpc_hash text
)
returns table (
  project_id text,
  user_id uuid,
  registry_id uuid,
  project_created_at timestamptz,
  connection_uri_ciphertext text,
  data_model jsonb,
  auth_required boolean,
  gateway_origin text
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.project_id,
         b.user_id,
         b.id,
         b.project_created_at,
         b.connection_uri_ciphertext,
         b.data_model,
         b.auth_required,
         b.gateway_origin
    from public.project_managed_backends b
   where p_project_id ~ '^[a-z][a-z0-9-]{3,62}$'
     and p_rpc_hash ~ '^[a-f0-9]{64}$'
     and b.project_id = p_project_id
     and b.gateway_secret_hash = p_rpc_hash
     and b.status = 'ready'
     and b.data_model is not null
     and b.connection_uri_ciphertext is not null
   limit 1;
$$;

comment on function public.data_gateway_context(text, text) is
  'Public data-gateway resolution: one READY project, gated by the server-only RPC proof. Returns ciphertext to the Mavly server route only, never to a browser payload.';

/**
 * ⚠️ FIXED LIMITS, NOT CALLER-SUPPLIED. 240 reads, 60 writes and 20 auth
 * attempts per project per minute, shared across instances. The same function
 * is used by the gateway before any database work, so a burst cannot consume
 * connection slots.
 */
create or replace function public.consume_app_gateway_rate(
  p_project_id text,
  p_action text,
  p_rpc_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_hits integer;
begin
  if p_project_id is null or p_project_id !~ '^[a-z][a-z0-9-]{3,62}$' then
    return false;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  if p_action = 'read' then
    v_limit := 240;
  elsif p_action = 'write' then
    v_limit := 60;
  elsif p_action = 'auth' then
    v_limit := 20;
  else
    return false;
  end if;

  if not exists (
    select 1
    from public.project_managed_backends b
    where b.project_id = p_project_id
      and b.status = 'ready'
      and b.gateway_secret_hash = p_rpc_hash
  ) then
    return false;
  end if;

  insert into public.app_gateway_rate_windows (
    project_id, action, window_start, hits
  )
  values (p_project_id, p_action, date_trunc('minute', now()), 1)
  on conflict (project_id, action, window_start)
  do update set hits = public.app_gateway_rate_windows.hits + 1
  returning hits into v_hits;

  delete from public.app_gateway_rate_windows w
   where w.window_start < now() - interval '2 hours';

  return v_hits <= v_limit;
end;
$$;

comment on function public.consume_app_gateway_rate(text, text, text) is
  'Durable per-project data-gateway limits: read 240/min, write 60/min, auth 20/min. Fails closed for an unknown project or proof.';

-- ── Grants ─────────────────────────────────────────────────────────────────

revoke all on function public.begin_managed_backend_configuration(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_managed_backend_migration(text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_managed_backend_configuration(text, timestamptz, uuid, jsonb, text, integer, boolean, text, text, boolean, boolean)
  from public, anon, authenticated;
revoke all on function public.fail_managed_backend_configuration(text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.managed_backend_lifecycle(text, uuid)
  from public, anon, authenticated;
revoke all on function public.managed_backend_status(text)
  from public, anon;
revoke all on function public.data_gateway_context(text, text)
  from public;
revoke all on function public.consume_app_gateway_rate(text, text, text)
  from public;

grant execute on function public.begin_managed_backend_configuration(text, uuid, uuid)
  to service_role;
grant execute on function public.record_managed_backend_migration(text, timestamptz, uuid, text, text)
  to service_role;
grant execute on function public.complete_managed_backend_configuration(text, timestamptz, uuid, jsonb, text, integer, boolean, text, text, boolean, boolean)
  to service_role;
grant execute on function public.fail_managed_backend_configuration(text, timestamptz, uuid, text, text)
  to service_role;
grant execute on function public.managed_backend_lifecycle(text, uuid)
  to service_role;
grant execute on function public.managed_backend_status(text)
  to authenticated, service_role;
grant execute on function public.data_gateway_context(text, text)
  to anon, authenticated;
grant execute on function public.consume_app_gateway_rate(text, text, text)
  to anon, authenticated;

create or replace function public.managed_backend_schema_version()
returns integer
language sql
stable
as $$ select 35 $$;

comment on function public.managed_backend_schema_version() is
  'Schema marker 35: verified managed-backend schema, data gateway context and durable gateway rate limits.';

revoke all on function public.managed_backend_schema_version() from public;
revoke all on function public.managed_backend_schema_version() from anon;
grant execute on function public.managed_backend_schema_version()
  to authenticated, service_role;

commit;
