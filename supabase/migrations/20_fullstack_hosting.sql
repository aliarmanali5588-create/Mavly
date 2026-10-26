-- Mavly — Phase 5: full-stack production hosting
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Phases 1–4 publish static sites and verify generated source in an isolated
-- microVM. Phase 5 adds a bounded, opt-in path that deploys a VERIFIED Next.js
-- App Router snapshot to Vercel's native Next.js runtime, so route handlers and
-- server logic execute in the deployment rather than in Mavly.
--
-- This migration is ADDITIVE. It does not change RLS on `projects`, does not
-- touch `project_files`, `project_runs`, snapshots, published versions or the
-- verification tables, and it leaves every existing (static) deployment row a
-- valid static row (`deployment_kind = 'static'`, `lifecycle = NULL`).
--
-- ═══ WHAT IS ADDED ═══════════════════════════════════════════════════════════
--
--   1. Full-stack columns on `project_deployments` (kind, lifecycle, immutable
--      snapshot binding, attempt fence, previous known-good deployment).
--   2. `project_deployment_attempts` — durable per-attempt history. It is the
--      rollback target list and the stale-result fence: a delayed provider
--      response can only settle the attempt it belongs to.
--   3. `project_deployment_env` — METADATA ONLY for provider env sync. It never
--      stores a secret value or ciphertext, only the key name, a SHA-256
--      fingerprint of the value and the sync state.
--   4. `project_database_configs` — METADATA ONLY connection contract. The
--      connection URL lives in `project_secrets` as an encrypted value.
--   5. SECURITY DEFINER RPCs that verify `auth.uid()` ownership themselves, so
--      an authenticated client never gets direct INSERT/UPDATE on deployment
--      attempts or env sync state.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Apply after migration 19 (verification runtime/health state) and 11 (project
-- secrets). Nothing runs until the operator sets
-- `MAVLY_FULLSTACK_HOSTING_ENABLED=on` AND an explicit
-- `MAVLY_FULLSTACK_HOSTING_PROJECTS` cohort. A project is also refused unless it
-- has a PASSED verification row for the exact snapshot hash being deployed.
--
-- See `docs/architecture/phase-5-fullstack-hosting.md` and
-- `docs/runbooks/fullstack-hosting.md`.

begin;

-- ── 1. Deployment mapping columns ───────────────────────────────────────────

alter table public.project_deployments
  add column if not exists deployment_kind text,
  add column if not exists lifecycle text,
  add column if not exists source_snapshot_id uuid
    references public.project_snapshots (id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists runtime_profile text,
  add column if not exists deployment_attempt integer,
  add column if not exists previous_deployment_id text,
  add column if not exists previous_snapshot_id uuid
    references public.project_snapshots (id) on delete set null,
  add column if not exists readiness_checked_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists disabled_at timestamptz;

-- Every pre-existing row is a static deployment.
update public.project_deployments
   set deployment_kind = 'static'
 where deployment_kind is null;

alter table public.project_deployments
  alter column deployment_kind set default 'static';
alter table public.project_deployments
  alter column deployment_kind set not null;

alter table public.project_deployments
  drop constraint if exists project_deployments_deployment_kind_check;
alter table public.project_deployments
  add constraint project_deployments_deployment_kind_check
  check (deployment_kind in ('static', 'fullstack'));

alter table public.project_deployments
  drop constraint if exists project_deployments_lifecycle_check;
alter table public.project_deployments
  add constraint project_deployments_lifecycle_check
  check (
    lifecycle is null
    or lifecycle in (
      'queued',
      'building',
      'deploying',
      'ready',
      'failed',
      'cancelled',
      'rolling_back',
      'disabled'
    )
  );

alter table public.project_deployments
  drop constraint if exists project_deployments_source_hash_check;
alter table public.project_deployments
  add constraint project_deployments_source_hash_check
  check (source_hash is null or source_hash ~ '^[a-f0-9]{64}$');

alter table public.project_deployments
  drop constraint if exists project_deployments_runtime_profile_check;
alter table public.project_deployments
  add constraint project_deployments_runtime_profile_check
  check (runtime_profile is null or runtime_profile in ('next-app-router'));

alter table public.project_deployments
  drop constraint if exists project_deployments_attempt_check;
alter table public.project_deployments
  add constraint project_deployments_attempt_check
  check (deployment_attempt is null or deployment_attempt between 1 and 1000000);

-- A full-stack row without an immutable snapshot binding is not a deployment we
-- can reason about, so the database refuses it rather than trusting the service.
alter table public.project_deployments
  drop constraint if exists project_deployments_fullstack_integrity_check;
alter table public.project_deployments
  add constraint project_deployments_fullstack_integrity_check
  check (
    deployment_kind <> 'fullstack'
    or (
      source_snapshot_id is not null
      and source_hash is not null
      and runtime_profile is not null
      and deployment_attempt is not null
      and lifecycle is not null
    )
  );

create index if not exists project_deployments_lifecycle_idx
  on public.project_deployments (lifecycle)
  where lifecycle is not null;

comment on column public.project_deployments.deployment_kind is
  'static (existing preview/html publish) or fullstack (verified Next.js snapshot on a provider runtime).';
comment on column public.project_deployments.lifecycle is
  'Full-stack attempt lifecycle. NULL for every static row. It never replaces status, which stays the backward-compatible wire projection.';
comment on column public.project_deployments.source_snapshot_id is
  'The immutable snapshot this full-stack deployment was built from.';
comment on column public.project_deployments.source_hash is
  'SHA-256 of the deployed file set; must equal the verified snapshot hash.';
comment on column public.project_deployments.deployment_attempt is
  'Monotonic attempt fence. A settle call may only update the mapping for this attempt.';
comment on column public.project_deployments.previous_deployment_id is
  'The provider deployment that was live before this attempt; kept so a failed update does not lose the known-good version.';

-- ── Attempt-owned columns are not client-writable ───────────────────────────
--
-- Migration 07 granted table-wide UPDATE on this table to `authenticated`. That
-- was acceptable when every column was just a wire projection. It is NOT
-- acceptable now: `lifecycle`, the attempt fence and the immutable snapshot
-- binding decide whether a deployment is reported ready, so they must only be
-- written by the SECURITY DEFINER RPCs above (which run as the table owner).
--
-- The legacy columns the deployment service patches through the caller's own
-- session are granted explicitly. INSERT stays table-wide (a first publish
-- creates the mapping row). If a future static-path field is added, it must be
-- added to this list too; a missing grant fails closed with a permission error
-- rather than silently letting the client write deployment state.
revoke update on public.project_deployments from authenticated;

grant update (
  provider,
  vercel_project_id,
  vercel_project_name,
  vercel_deployment_id,
  status,
  url,
  error_code,
  error_message,
  mavly_hostname,
  mavly_domain_status,
  mavly_domain_error,
  mavly_domain_checked_at,
  active_version_id,
  last_published_at,
  last_unpublished_at,
  updated_at
) on public.project_deployments to authenticated;

-- ── 2. Deployment attempts ──────────────────────────────────────────────────

create table if not exists public.project_deployment_attempts (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  attempt integer not null check (attempt between 1 and 1000000),
  kind text not null default 'deploy' check (kind in ('deploy', 'rollback')),
  lifecycle text not null default 'queued'
    check (lifecycle in (
      'queued',
      'building',
      'deploying',
      'ready',
      'failed',
      'cancelled',
      'rolling_back',
      'disabled'
    )),
  snapshot_id uuid references public.project_snapshots (id) on delete set null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  runtime_profile text not null default 'next-app-router'
    check (runtime_profile in ('next-app-router')),
  verification_id uuid references public.project_verifications (id) on delete set null,
  provider text not null default 'vercel' check (provider in ('vercel')),
  provider_project_id text,
  provider_deployment_id text,
  provider_url text,
  target_attempt_id uuid
    references public.project_deployment_attempts (id) on delete set null,
  error_code text,
  error_message text,
  trace_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (project_id, attempt),
  constraint project_deployment_attempts_error_message_check
    check (error_message is null or length(error_message) <= 500),
  constraint project_deployment_attempts_trace_check
    check (trace_id is null or length(trace_id) <= 128)
);

comment on table public.project_deployment_attempts is
  'Durable full-stack deployment attempts. One active (unfinished) attempt per project; completed rows are the rollback target history.';
comment on column public.project_deployment_attempts.target_attempt_id is
  'For a rollback attempt: the previously ready attempt whose provider deployment was restored.';

create index if not exists project_deployment_attempts_project_idx
  on public.project_deployment_attempts (project_id, started_at desc);

create index if not exists project_deployment_attempts_ready_idx
  on public.project_deployment_attempts (project_id, finished_at desc)
  where lifecycle = 'ready';

-- One in-flight attempt per project. A crashed attempt is expired by the claim
-- RPC after 30 minutes, so this cannot deadlock a project for ever.
create unique index if not exists project_deployment_attempts_active_uidx
  on public.project_deployment_attempts (project_id)
  where finished_at is null;

alter table public.project_deployment_attempts enable row level security;

drop policy if exists "project_deployment_attempts_select_own"
  on public.project_deployment_attempts;
create policy "project_deployment_attempts_select_own"
  on public.project_deployment_attempts
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_deployment_attempts.project_id
      and p.user_id = (select auth.uid())
  ));

-- Attempts are written ONLY by the SECURITY DEFINER RPCs below.
revoke all on public.project_deployment_attempts from public;
revoke all on public.project_deployment_attempts from anon;
revoke all on public.project_deployment_attempts from authenticated;

grant select (
  id,
  project_id,
  user_id,
  attempt,
  kind,
  lifecycle,
  snapshot_id,
  source_hash,
  runtime_profile,
  verification_id,
  provider,
  provider_project_id,
  provider_deployment_id,
  provider_url,
  target_attempt_id,
  error_code,
  error_message,
  trace_id,
  started_at,
  finished_at,
  updated_at
) on public.project_deployment_attempts to authenticated;

-- ── 3. Provider environment sync metadata ────────────────────────────────────

create table if not exists public.project_deployment_env (
  project_id text not null references public.projects (project_id) on delete cascade,
  secret_name text not null,
  environment text not null check (environment in ('development', 'production', 'both')),
  env_key text not null,
  target text not null default 'production' check (target in ('production', 'development')),
  value_fingerprint text
    check (value_fingerprint is null or value_fingerprint ~ '^[a-f0-9]{64}$'),
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'awaiting_project', 'failed', 'revoked')),
  provider text not null default 'vercel' check (provider in ('vercel')),
  provider_env_id text,
  revision integer not null default 1 check (revision between 1 and 1000000),
  last_error text check (last_error is null or length(last_error) <= 300),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, secret_name, environment),
  constraint project_deployment_env_name_format
    check (secret_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')
);

comment on table public.project_deployment_env is
  'Metadata for pushing project secrets into a hosting provider environment. NEVER stores a secret value or ciphertext; value_fingerprint is a one-way SHA-256.';
comment on column public.project_deployment_env.sync_status is
  'synced means the provider confirmed the value is present. awaiting_project means no provider project existed when the value was saved; re-saving is required.';

create index if not exists project_deployment_env_project_idx
  on public.project_deployment_env (project_id);

alter table public.project_deployment_env enable row level security;

drop policy if exists "project_deployment_env_select_own" on public.project_deployment_env;
create policy "project_deployment_env_select_own"
  on public.project_deployment_env
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_deployment_env.project_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_deployment_env from public;
revoke all on public.project_deployment_env from anon;
revoke all on public.project_deployment_env from authenticated;

grant select (
  project_id,
  secret_name,
  environment,
  env_key,
  target,
  value_fingerprint,
  sync_status,
  provider,
  provider_env_id,
  revision,
  last_error,
  synced_at,
  created_at,
  updated_at
) on public.project_deployment_env to authenticated;

-- ── 4. Application database contract (metadata only) ────────────────────────

create table if not exists public.project_database_configs (
  project_id text primary key references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('postgres', 'supabase')),
  host text not null,
  port integer not null check (port between 1 and 65535),
  database_name text not null,
  username text not null,
  ssl_mode text not null check (ssl_mode in ('require', 'verify-full')),
  connection_mode text not null check (connection_mode in ('transaction', 'session')),
  secret_name text not null default 'DATABASE_URL' check (secret_name = 'DATABASE_URL'),
  env_key text not null default 'DATABASE_URL' check (env_key = 'DATABASE_URL'),
  connection_fingerprint text not null
    check (connection_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'configured'
    check (status in ('configured', 'invalid')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_database_configs_host_format
    check (host ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$' and host not like '%.local'),
  constraint project_database_configs_name_length
    check (char_length(database_name) between 1 and 128),
  constraint project_database_configs_username_length
    check (char_length(username) between 1 and 128)
);

comment on table public.project_database_configs is
  'Non-secret application database metadata. The connection URL/password lives in project_secrets as DATABASE_URL and is never stored here.';
comment on column public.project_database_configs.connection_fingerprint is
  'SHA-256 of the exact DATABASE_URL value. Readiness requires the synced provider env row to carry the same fingerprint.';

create index if not exists project_database_configs_user_idx
  on public.project_database_configs (user_id);

alter table public.project_database_configs enable row level security;

drop policy if exists "project_database_configs_select_own" on public.project_database_configs;
create policy "project_database_configs_select_own"
  on public.project_database_configs
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_database_configs.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_database_configs_insert_own" on public.project_database_configs;
create policy "project_database_configs_insert_own"
  on public.project_database_configs
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_database_configs.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_database_configs_update_own" on public.project_database_configs;
create policy "project_database_configs_update_own"
  on public.project_database_configs
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_database_configs.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_database_configs.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_database_configs_delete_own" on public.project_database_configs;
create policy "project_database_configs_delete_own"
  on public.project_database_configs
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_database_configs.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.project_database_configs from public;
revoke all on public.project_database_configs from anon;
grant select, insert, update, delete on public.project_database_configs to authenticated;

-- ── 5. Claim a deployment attempt (ownership + snapshot + verification) ─────

create or replace function public.claim_fullstack_attempt(
  p_project_id text,
  p_kind text,
  p_snapshot_id uuid,
  p_source_hash text,
  p_runtime_profile text,
  p_vercel_project_name text,
  p_target_attempt_id uuid default null
)
returns table (
  attempt_id uuid,
  attempt integer,
  provider_project_id text,
  provider_deployment_id text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_attempt integer;
  v_id uuid;
  v_verification uuid;
  v_provider_project text;
  v_target_deployment text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  if p_kind not in ('deploy', 'rollback') then
    raise exception 'invalid deployment kind' using errcode = '22023';
  end if;
  if p_runtime_profile <> 'next-app-router' then
    raise exception 'unsupported runtime profile' using errcode = '22023';
  end if;
  if p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid source hash' using errcode = '22023';
  end if;
  if p_vercel_project_name is null or btrim(p_vercel_project_name) = '' then
    raise exception 'a provider project name is required' using errcode = '22023';
  end if;

  -- Serialize claims for one project.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id, 0));

  -- Expire abandoned attempts. A settle call for one of these is fenced out.
  update public.project_deployment_attempts a
     set lifecycle = 'failed',
         error_code = 'interrupted',
         error_message = 'The deployment attempt was interrupted before a result was recorded.',
         finished_at = now(),
         updated_at = now()
   where a.project_id = p_project_id
     and a.finished_at is null
     and a.updated_at < now() - interval '30 minutes';

  if exists (
    select 1 from public.project_deployment_attempts a
    where a.project_id = p_project_id and a.finished_at is null
  ) then
    raise exception 'a deployment attempt is already in progress' using errcode = '23505';
  end if;

  if p_kind = 'rollback' then
    if p_target_attempt_id is null then
      raise exception 'rollback target required' using errcode = '22023';
    end if;
    select a.provider_deployment_id
      into v_target_deployment
      from public.project_deployment_attempts a
     where a.id = p_target_attempt_id
       and a.project_id = p_project_id
       and a.lifecycle = 'ready'
       and a.provider_deployment_id is not null;
    if v_target_deployment is null then
      raise exception 'rollback target is not available' using errcode = '22023';
    end if;
  end if;

  -- The snapshot must belong to this project, be readable, and carry the hash.
  if p_snapshot_id is null then
    raise exception 'a verified snapshot is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.project_snapshots s
    where s.id = p_snapshot_id
      and s.project_id = p_project_id
      and s.status = 'ready'
      and s.source_hash = p_source_hash
  ) then
    raise exception 'the snapshot does not match the verified source' using errcode = '22023';
  end if;

  -- The SAME snapshot must have a PASSED Phase 3/4 verification.
  select v.id
    into v_verification
    from public.project_verifications v
   where v.project_id = p_project_id
     and v.status = 'passed'
     and coalesce(v.effective_snapshot_id, v.snapshot_id) = p_snapshot_id
     and coalesce(v.effective_source_hash, v.source_hash) = p_source_hash
   order by v.finished_at desc nulls last
   limit 1;

  if v_verification is null then
    raise exception 'the snapshot has no passed verification' using errcode = '22023';
  end if;

  select coalesce(max(a.attempt), 0) + 1
    into v_attempt
    from public.project_deployment_attempts a
   where a.project_id = p_project_id;

  select d.vercel_project_id
    into v_provider_project
    from public.project_deployments d
   where d.project_id = p_project_id;

  insert into public.project_deployment_attempts (
    project_id, user_id, attempt, kind, lifecycle, snapshot_id, source_hash,
    runtime_profile, verification_id, provider_project_id, target_attempt_id
  ) values (
    p_project_id, v_uid, v_attempt, p_kind, 'queued', p_snapshot_id, p_source_hash,
    p_runtime_profile, v_verification, v_provider_project, p_target_attempt_id
  )
  returning id into v_id;

  insert into public.project_deployments (
    project_id, provider, vercel_project_name, status, deployment_kind, lifecycle,
    source_snapshot_id, source_hash, runtime_profile, deployment_attempt,
    vercel_deployment_id, error_code, error_message, updated_at
  ) values (
    p_project_id, 'vercel', p_vercel_project_name, 'queued', 'fullstack', 'queued',
    p_snapshot_id, p_source_hash, p_runtime_profile, v_attempt,
    null, null, null, now()
  )
  on conflict (project_id) do update set
    provider = 'vercel',
    vercel_project_name = excluded.vercel_project_name,
    status = 'queued',
    deployment_kind = 'fullstack',
    lifecycle = 'queued',
    source_snapshot_id = excluded.source_snapshot_id,
    source_hash = excluded.source_hash,
    runtime_profile = excluded.runtime_profile,
    deployment_attempt = excluded.deployment_attempt,
    -- Preserve the previously live deployment for failure/rollback. The URL is
    -- kept (not cleared) so a failed build can still describe what is live.
    previous_deployment_id = coalesce(
      public.project_deployments.vercel_deployment_id,
      public.project_deployments.previous_deployment_id
    ),
    previous_snapshot_id = coalesce(
      public.project_deployments.source_snapshot_id,
      public.project_deployments.previous_snapshot_id
    ),
    -- Cleared so status polling cannot adopt the OLD deployment as this attempt.
    vercel_deployment_id = null,
    error_code = null,
    error_message = null,
    readiness_checked_at = null,
    disabled_at = null,
    updated_at = now();

  return query
    select
      v_id,
      v_attempt,
      coalesce(v_provider_project, null),
      case when p_kind = 'rollback' then v_target_deployment else null end;
end;
$$;

comment on function public.claim_fullstack_attempt(text, text, uuid, text, text, text, uuid) is
  'Atomically claims the single full-stack deployment attempt slot. Verifies auth.uid() ownership, snapshot ownership, hash equality and a passed verification inside the function.';

revoke all on function public.claim_fullstack_attempt(text, text, uuid, text, text, text, uuid) from public;
revoke all on function public.claim_fullstack_attempt(text, text, uuid, text, text, text, uuid) from anon;
grant execute on function public.claim_fullstack_attempt(text, text, uuid, text, text, text, uuid) to authenticated;

-- ── 6. Settle an attempt (fenced on the attempt number) ─────────────────────

create or replace function public.settle_fullstack_attempt(
  p_attempt_id uuid,
  p_lifecycle text,
  p_provider_deployment_id text default null,
  p_provider_url text default null,
  p_provider_project_id text default null,
  p_domain_status text default null,
  p_domain_error text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_trace_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_attempt public.project_deployment_attempts%rowtype;
  v_status text;
  v_terminal boolean;
  v_new_deployment text;
  v_blocked integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_lifecycle not in (
    'building', 'deploying', 'ready', 'failed', 'cancelled', 'rolling_back'
  ) then
    raise exception 'invalid lifecycle transition' using errcode = '22023';
  end if;
  if p_domain_status is not null
     and p_domain_status not in ('pending', 'verified', 'error') then
    raise exception 'invalid domain status' using errcode = '22023';
  end if;

  select a.* into v_attempt
    from public.project_deployment_attempts a
    join public.projects p on p.project_id = a.project_id
   where a.id = p_attempt_id
     and p.user_id = v_uid;

  if v_attempt.id is null then
    raise exception 'deployment attempt not found' using errcode = '42501';
  end if;

  -- A newer attempt owns the mapping now. Never let a delayed response settle it.
  if exists (
    select 1 from public.project_deployment_attempts a
    where a.project_id = v_attempt.project_id
      and a.attempt > v_attempt.attempt
  ) then
    return false;
  end if;

  v_terminal := p_lifecycle in ('ready', 'failed', 'cancelled');

  if v_attempt.finished_at is not null then
    -- Idempotent replay of the same terminal outcome is a no-op success.
    return v_attempt.lifecycle = p_lifecycle;
  end if;

  if p_lifecycle = 'ready' then
    -- A READY TRANSITION REQUIRES AN IN-FLIGHT ATTEMPT AND MUST NOT SWAP THE
    -- PROVIDER DEPLOYMENT. The service always records `building` (deploy) or
    -- `rolling_back` (rollback) with the provider deployment id first, then
    -- polls that same deployment to `ready`. Requiring the same state machine
    -- here prevents a direct queued->ready write and prevents a delayed ready
    -- response from pointing the row at a different provider deployment.
    if v_attempt.lifecycle not in ('building', 'deploying', 'rolling_back') then
      raise exception 'ready requires an in-flight deployment attempt' using errcode = '22023';
    end if;
    if v_attempt.provider_deployment_id is not null
       and p_provider_deployment_id is not null
       and v_attempt.provider_deployment_id <> p_provider_deployment_id then
      raise exception 'ready cannot change the provider deployment' using errcode = '22023';
    end if;

    v_new_deployment := coalesce(p_provider_deployment_id, v_attempt.provider_deployment_id);
    if v_new_deployment is null then
      raise exception 'ready requires a provider deployment' using errcode = '22023';
    end if;

    -- No production secret may be unsynced when a deployment is declared ready.
    select count(*) into v_blocked
      from public.project_deployment_env e
     where e.project_id = v_attempt.project_id
       and e.environment <> 'development'
       and e.sync_status in ('pending', 'awaiting_project', 'failed');
    if v_blocked > 0 then
      raise exception 'deployment environment is not synced' using errcode = 'P0001';
    end if;

    -- A configured database must have passed the bounded connectivity check.
    if exists (
      select 1 from public.project_database_configs c
      where c.project_id = v_attempt.project_id
        and c.verified_at is null
    ) then
      raise exception 'database configuration has not passed a connectivity check'
        using errcode = 'P0001';
    end if;

    -- A configured database must be represented by the SAME synced URL.
    if exists (
      select 1 from public.project_database_configs c
      where c.project_id = v_attempt.project_id
    ) and not exists (
      select 1
        from public.project_database_configs c
        join public.project_deployment_env e
          on e.project_id = c.project_id
         and e.secret_name = c.secret_name
         and e.environment in ('production', 'both')
       where c.project_id = v_attempt.project_id
         and e.sync_status = 'synced'
         and e.value_fingerprint = c.connection_fingerprint
    ) then
      raise exception 'database configuration is not synced' using errcode = 'P0001';
    end if;
  end if;

  update public.project_deployment_attempts a
     set lifecycle = p_lifecycle,
         provider_project_id = coalesce(p_provider_project_id, a.provider_project_id),
         provider_deployment_id = coalesce(p_provider_deployment_id, a.provider_deployment_id),
         provider_url = coalesce(p_provider_url, a.provider_url),
         error_code = p_error_code,
         error_message = left(p_error_message, 500),
         trace_id = coalesce(p_trace_id, a.trace_id),
         finished_at = case when v_terminal then now() else a.finished_at end,
         updated_at = now()
   where a.id = v_attempt.id;

  v_status := case p_lifecycle
    when 'ready' then 'ready'
    when 'failed' then 'error'
    when 'cancelled' then 'canceled'
    when 'queued' then 'queued'
    when 'disabled' then 'unpublished'
    else 'building'
  end;

  update public.project_deployments d
     set status = v_status,
         lifecycle = p_lifecycle,
         vercel_project_id = coalesce(p_provider_project_id, d.vercel_project_id),
         vercel_deployment_id = case
           when p_lifecycle = 'ready' then v_new_deployment
           when p_lifecycle = 'failed' then coalesce(d.previous_deployment_id, d.vercel_deployment_id)
           when p_lifecycle = 'cancelled' then coalesce(d.previous_deployment_id, d.vercel_deployment_id)
           else coalesce(p_provider_deployment_id, d.vercel_deployment_id)
         end,
         url = coalesce(p_provider_url, d.url),
         error_code = case when p_lifecycle = 'ready' then null else p_error_code end,
         error_message = case when p_lifecycle = 'ready' then null
                              else left(coalesce(p_error_message, ''), 500) end,
         mavly_domain_status = coalesce(p_domain_status, d.mavly_domain_status),
         mavly_domain_error = case when p_domain_status is null then d.mavly_domain_error
                                   else p_domain_error end,
         mavly_domain_checked_at = case when p_domain_status is null then d.mavly_domain_checked_at
                                        else now() end,
         readiness_checked_at = now(),
         ready_at = case when p_lifecycle = 'ready' then now() else d.ready_at end,
         last_published_at = case when p_lifecycle = 'ready' then now() else d.last_published_at end,
         updated_at = now()
   where d.project_id = v_attempt.project_id
     and d.deployment_attempt = v_attempt.attempt;

  return true;
end;
$$;

comment on function public.settle_fullstack_attempt(uuid, text, text, text, text, text, text, text, text, text) is
  'Records the outcome of one attempt. Fenced by attempt number: a delayed provider response cannot overwrite a newer attempt, and ready is refused while a production secret or database configuration is unsynced.';

revoke all on function public.settle_fullstack_attempt(uuid, text, text, text, text, text, text, text, text, text) from public;
revoke all on function public.settle_fullstack_attempt(uuid, text, text, text, text, text, text, text, text, text) from anon;
grant execute on function public.settle_fullstack_attempt(uuid, text, text, text, text, text, text, text, text, text) to authenticated;

-- ── 7. Disable a full-stack deployment (after the provider takedown) ────────

create or replace function public.disable_fullstack_attempt(p_project_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id, 0));

  if exists (
    select 1 from public.project_deployment_attempts a
    where a.project_id = p_project_id and a.finished_at is null
  ) then
    raise exception 'a deployment attempt is in progress' using errcode = '23505';
  end if;

  update public.project_deployments d
     set status = 'unpublished',
         lifecycle = 'disabled',
         url = null,
         error_code = null,
         error_message = null,
         disabled_at = now(),
         readiness_checked_at = now(),
         updated_at = now()
   where d.project_id = p_project_id
     and d.deployment_kind = 'fullstack';

  return found;
end;
$$;

revoke all on function public.disable_fullstack_attempt(text) from public;
revoke all on function public.disable_fullstack_attempt(text) from anon;
grant execute on function public.disable_fullstack_attempt(text) to authenticated;

-- ── 8. Provider env sync metadata write (ownership verified inside) ─────────

create or replace function public.record_deployment_env_sync(
  p_project_id text,
  p_secret_name text,
  p_environment text,
  p_env_key text,
  p_target text,
  p_sync_status text,
  p_value_fingerprint text default null,
  p_provider_env_id text default null,
  p_last_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  if p_secret_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' then
    raise exception 'invalid secret name' using errcode = '22023';
  end if;
  if p_environment not in ('development', 'production', 'both') then
    raise exception 'invalid environment' using errcode = '22023';
  end if;
  if p_target not in ('production', 'development') then
    raise exception 'invalid target' using errcode = '22023';
  end if;
  if p_sync_status not in ('pending', 'synced', 'awaiting_project', 'failed', 'revoked') then
    raise exception 'invalid sync status' using errcode = '22023';
  end if;
  if p_value_fingerprint is not null and p_value_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid fingerprint' using errcode = '22023';
  end if;

  insert into public.project_deployment_env (
    project_id, secret_name, environment, env_key, target,
    value_fingerprint, sync_status, provider_env_id, last_error,
    revision, synced_at, updated_at
  ) values (
    p_project_id, p_secret_name, p_environment, p_env_key, p_target,
    p_value_fingerprint, p_sync_status, p_provider_env_id,
    left(coalesce(p_last_error, ''), 300),
    1,
    case when p_sync_status = 'synced' then now() else null end,
    now()
  )
  on conflict (project_id, secret_name, environment) do update set
    env_key = excluded.env_key,
    target = excluded.target,
    value_fingerprint = coalesce(excluded.value_fingerprint, public.project_deployment_env.value_fingerprint),
    sync_status = excluded.sync_status,
    provider_env_id = case
      when excluded.sync_status = 'revoked' then null
      else coalesce(excluded.provider_env_id, public.project_deployment_env.provider_env_id)
    end,
    last_error = excluded.last_error,
    revision = public.project_deployment_env.revision + case
      when excluded.sync_status = 'synced' then 1 else 0 end,
    synced_at = case
      when excluded.sync_status = 'synced' then now()
      else public.project_deployment_env.synced_at
    end,
    updated_at = now();
end;
$$;

revoke all on function public.record_deployment_env_sync(text, text, text, text, text, text, text, text, text) from public;
revoke all on function public.record_deployment_env_sync(text, text, text, text, text, text, text, text, text) from anon;
grant execute on function public.record_deployment_env_sync(text, text, text, text, text, text, text, text, text) to authenticated;

-- ── 9. Schema marker / preflight ────────────────────────────────────────────

create or replace function public.fullstack_hosting_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 20;
$$;

revoke all on function public.fullstack_hosting_schema_version() from public;
revoke all on function public.fullstack_hosting_schema_version() from anon;
grant execute on function public.fullstack_hosting_schema_version() to authenticated, service_role;

comment on function public.fullstack_hosting_schema_version() is
  'Full-stack hosting schema marker. 20 means the attempt/env/database tables, fenced RPCs and deployment columns are installed.';

commit;
