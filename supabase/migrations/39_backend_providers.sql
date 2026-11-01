-- Mavly — Backend & Source Control Center: authoritative backend provider (migration 39).
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- A project may have a Mavly-managed Neon database OR a customer-owned Supabase
-- project, and it must never have both active at once. Before this migration
-- there was no record of that choice: the managed backend lived in
-- `project_managed_backends` (migrations 30/35) and a customer Supabase
-- connection did not exist at all.
--
-- ═══ WHAT IS ADDED ═══════════════════════════════════════════════════════════
--
--   1. `project_backend_providers` — one row per (project, provider) with an
--      `active` flag. A partial unique index makes "one authoritative backend
--      per project" a DATABASE fact, not a convention the UI is trusted to keep.
--   2. `service_role_ciphertext` — the Supabase service-role key, encrypted with
--      AES-256-GCM and bound to (user, project, provider row).
--   3. Owner-checked SECURITY DEFINER RPCs. The authenticated role gets SELECT
--      on the owner's own rows and NO direct write grant; every write is fenced.
--
-- ═══ WHY THE SERVICE-ROLE KEY IS NOT A `project_secrets` ROW ═════════════════
--
-- `project_secrets` is the mechanism by which values reach a DEPLOYED
-- application's environment (see `DATABASE_URL_SECRET_NAME` in
-- `src/lib/hosting/fullstack-database.ts`). A Supabase service-role key bypasses
-- RLS entirely, so putting it there would hand it to generated code and to every
-- end user of the generated app. It therefore lives in this table only, is
-- readable only by the server adapter, and is NEVER returned by any RPC.
--
-- The anon key is public by design and may be referenced as a project secret;
-- this table stores only its NAME, never a value.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and non-destructive. Apply after 38. It does not alter `projects`,
-- `project_managed_backends`, `project_secrets` or any earlier table, and it
-- never deletes a database resource or customer data.

begin;

-- ── 1. The provider registry ────────────────────────────────────────────────

create table if not exists public.project_backend_providers (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  status text not null default 'not_connected',
  active boolean not null default false,
  -- Non-secret provider metadata only: the Supabase project ref, its region and
  -- the verified host. Never a credential.
  config jsonb not null default '{}'::jsonb,
  -- AES-256-GCM ciphertext, AAD-bound to (user, project, provider). Anon key is
  -- public and is referenced by name only.
  service_role_ciphertext text,
  anon_key_secret_name text,
  last_error text,
  verified_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_backend_providers_provider_check
    check (provider in ('mavly_managed_neon', 'external_supabase')),
  constraint project_backend_providers_status_check
    check (status in (
      'not_connected', 'connecting', 'provisioning', 'ready',
      'failed', 'suspended', 'disconnecting', 'reconnection_required'
    )),
  constraint project_backend_providers_config_object
    check (jsonb_typeof(config) = 'object'),
  constraint project_backend_providers_last_error_length
    check (last_error is null or length(last_error) <= 300),
  constraint project_backend_providers_anon_name_format
    check (anon_key_secret_name is null or anon_key_secret_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  -- A row that is not the Supabase provider must not carry a service-role key.
  constraint project_backend_providers_secret_provider_check
    check (service_role_ciphertext is null or provider = 'external_supabase'),
  -- An active row must be in a state that can actually serve.
  constraint project_backend_providers_active_status_check
    check (not active or status in ('ready', 'provisioning'))
);

comment on table public.project_backend_providers is
  'Authoritative backend provider per project. Exactly one row may be active; enforced by a partial unique index.';
comment on column public.project_backend_providers.service_role_ciphertext is
  'Supabase service-role key, AES-256-GCM, AAD-bound to (user, project, provider). NEVER stored in project_secrets, which syncs to deployed app environments. Never returned by any RPC.';
comment on column public.project_backend_providers.anon_key_secret_name is
  'Name of the project_secrets row holding the public anon key. A name only; no value or ciphertext here.';

-- One provider row per project per provider kind.
create unique index if not exists project_backend_providers_project_provider_key
  on public.project_backend_providers (project_id, provider);

-- ⚠️ THE AUTHORITATIVE RULE, AS A CONSTRAINT: at most one ACTIVE provider.
create unique index if not exists project_backend_providers_one_active_idx
  on public.project_backend_providers (project_id)
  where active;

create index if not exists project_backend_providers_user_idx
  on public.project_backend_providers (user_id);

-- ── 2. Owner-checked RPCs ───────────────────────────────────────────────────

/**
 * Every RPC verifies `auth.uid()` against the project owner itself. A project id
 * from the browser is never proof of anything.
 */
create or replace function public.backend_provider_owner_ok(
  p_project_id text,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
     where p.project_id = p_project_id and p.user_id = p_user_id
  );
$$;
revoke all on function public.backend_provider_owner_ok(text, uuid)
  from public, anon, authenticated;

/**
 * The owner's provider rows. Returns NO ciphertext and NO secret value: the
 * projection is metadata only, which is what the UI needs and nothing more.
 */
create or replace function public.read_backend_providers(p_project_id text)
returns table (
  provider text,
  status text,
  active boolean,
  config jsonb,
  has_service_role_key boolean,
  last_error text,
  verified_at timestamptz,
  connected_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  return query
    select r.provider, r.status, r.active, r.config,
           r.service_role_ciphertext is not null,
           r.last_error, r.verified_at, r.connected_at, r.updated_at
      from public.project_backend_providers r
     where r.project_id = p_project_id
     order by r.active desc, r.provider;
end;
$$;
revoke all on function public.read_backend_providers(text)
  from public, anon;
grant execute on function public.read_backend_providers(text)
  to authenticated;

/**
 * Connect (or re-verify) the customer-owned Supabase provider.
 *
 * ⚠️ THIS DOES NOT ACTIVATE. Connecting and activating are separate acts: a
 * connection that has never been verified must not become the authoritative
 * backend, and switching away from a live managed database requires the user's
 * explicit confirmation, which is a different call.
 */
create or replace function public.connect_external_supabase(
  p_project_id text,
  p_config jsonb,
  p_service_role_ciphertext text,
  p_anon_key_secret_name text,
  p_verified boolean
)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid provider config';
  end if;

  v_status := case when coalesce(p_verified, false) then 'ready' else 'reconnection_required' end;

  insert into public.project_backend_providers as r (
    project_id, user_id, provider, status, active, config,
    service_role_ciphertext, anon_key_secret_name, verified_at, connected_at
  )
  values (
    p_project_id, v_user, 'external_supabase', v_status, false, p_config,
    p_service_role_ciphertext, p_anon_key_secret_name,
    case when coalesce(p_verified, false) then now() end, now()
  )
  on conflict (project_id, provider) do update
    set status = v_status,
        config = excluded.config,
        service_role_ciphertext = excluded.service_role_ciphertext,
        anon_key_secret_name = excluded.anon_key_secret_name,
        verified_at = excluded.verified_at,
        connected_at = coalesce(r.connected_at, now()),
        disconnected_at = null,
        last_error = null,
        updated_at = now();

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = 'external_supabase';
end;
$$;
revoke all on function public.connect_external_supabase(text, jsonb, text, text, boolean)
  from public, anon;
grant execute on function public.connect_external_supabase(text, jsonb, text, text, boolean)
  to authenticated;

/**
 * Activate exactly one provider, atomically.
 *
 * ⚠️ THE PARTIAL UNIQUE INDEX IS THE REAL GUARANTEE. Deactivating the previous
 * provider and activating the new one happen in one statement pair inside one
 * transaction, so a concurrent call cannot leave two active rows behind.
 *
 * ⚠️ IT NEVER DELETES A RESOURCE. Deactivating the managed provider does not
 * drop a Neon project, and deactivating Supabase does not touch the customer's
 * database. Only the `active` flag moves.
 */
create or replace function public.activate_backend_provider(
  p_project_id text,
  p_provider text
)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.project_backend_providers%rowtype;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  select * into v_row
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.provider = p_provider
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'provider not connected';
  end if;
  if v_row.status not in ('ready', 'provisioning') then
    raise exception using errcode = 'P0001', message = 'provider is not ready to activate';
  end if;

  -- Serialize the swap per project.
  perform pg_advisory_xact_lock(hashtext('backend_provider:' || p_project_id));

  update public.project_backend_providers r
     set active = false, updated_at = now()
   where r.project_id = p_project_id and r.active and r.provider <> p_provider;

  update public.project_backend_providers r
     set active = true, updated_at = now()
   where r.project_id = p_project_id and r.provider = p_provider;

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = p_provider;
end;
$$;
revoke all on function public.activate_backend_provider(text, text)
  from public, anon;
grant execute on function public.activate_backend_provider(text, text)
  to authenticated;

/**
 * Disconnect the customer-owned Supabase provider.
 *
 * ⚠️ IT REFUSES WHILE ACTIVE. Disconnecting the authoritative backend would
 * leave the project with none, so the caller must switch to another provider
 * first. This is a refusal, not a silent deactivation.
 *
 * ⚠️ IT DELETES NO CUSTOMER DATA. Only Mavly's own metadata row is cleared; the
 * customer's Supabase project is untouched.
 */
create or replace function public.disconnect_external_supabase(p_project_id text)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_active boolean;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  select r.active into v_active
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.provider = 'external_supabase'
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'provider not connected';
  end if;
  if v_active then
    raise exception using errcode = 'P0001',
      message = 'switch to another backend before disconnecting this one';
  end if;

  update public.project_backend_providers r
     set status = 'not_connected',
         service_role_ciphertext = null,
         anon_key_secret_name = null,
         config = '{}'::jsonb,
         disconnected_at = now(),
         updated_at = now()
   where r.project_id = p_project_id and r.provider = 'external_supabase';

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = 'external_supabase';
end;
$$;
revoke all on function public.disconnect_external_supabase(text)
  from public, anon;
grant execute on function public.disconnect_external_supabase(text)
  to authenticated;

/**
 * The server-only read of the service-role ciphertext. Service role only, so no
 * browser session can ever obtain the key even with a valid owner session.
 */
create or replace function public.read_backend_provider_secret(p_project_id text)
returns table (provider text, service_role_ciphertext text, config jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  return query
    select r.provider, r.service_role_ciphertext, r.config
      from public.project_backend_providers r
     where r.project_id = p_project_id
       and r.provider = 'external_supabase'
       and r.service_role_ciphertext is not null;
end;
$$;
revoke all on function public.read_backend_provider_secret(text)
  from public, anon, authenticated;
grant execute on function public.read_backend_provider_secret(text)
  to service_role;

-- ── 3. RLS: owner reads, nobody writes directly ─────────────────────────────

alter table public.project_backend_providers enable row level security;

drop policy if exists project_backend_providers_owner_select
  on public.project_backend_providers;
create policy project_backend_providers_owner_select
  on public.project_backend_providers
  for select
  to authenticated
  using (user_id = auth.uid());

/**
 * ⚠️ NO INSERT/UPDATE/DELETE POLICY. Every write goes through a fenced RPC, so
 * the authenticated role cannot flip `active` directly and cannot bypass the
 * one-active-provider constraint by writing around it.
 */
revoke insert, update, delete on public.project_backend_providers
  from authenticated, anon;
grant select on public.project_backend_providers to authenticated;

-- ── 4. Schema marker ────────────────────────────────────────────────────────
--
-- ⚠️ THE HOUSE CONVENTION IS A VERSION FUNCTION, NOT A MARKER TABLE (see 35 and
-- 37). A new table here would be a second, competing way to answer "which
-- migrations are applied?".

create or replace function public.backend_providers_schema_version()
returns integer
language sql
stable
as $$ select 39 $$;

comment on function public.backend_providers_schema_version() is
  'Schema marker 39: authoritative backend provider registry, one-active-provider constraint, owner-checked RPCs and the encrypted customer Supabase service-role key.';

revoke all on function public.backend_providers_schema_version() from public;
revoke all on function public.backend_providers_schema_version() from anon;
grant execute on function public.backend_providers_schema_version()
  to authenticated, service_role;

commit;
