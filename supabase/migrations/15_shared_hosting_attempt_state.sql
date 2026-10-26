-- Mavly — shared hosting: separate the LIVE version from the PUBLISH ATTEMPT
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Migration 14 gave `public.project_deployments` one row per project and used
-- its `status` column for two different jobs:
--
--   • the outcome of the latest publish attempt (`queued`, `building`, `error`…);
--   • the public serving gate, because `resolve_published_tenant` required
--     `d.status = 'ready'`.
--
-- Starting a republish writes `status = 'queued'`, and a failed republish writes
-- `status = 'error'`. Under the old resolver both of those values made a
-- previously published, still perfectly intact version stop resolving — the live
-- site went 404 for the whole republish, and stayed down after a failed one.
--
-- This migration makes the separation explicit:
--
--   LIVE STATE      `project_deployments.active_version_id` + the version whose
--                   status is `active`. This is the ONLY public serving input.
--   ATTEMPT STATE   `project_deployments.status` / `error_code` / `error_message`.
--                   It describes the latest attempt and never takes the previous
--                   live version offline.
--
-- The resolver therefore stops requiring `status = 'ready'`. It still requires
-- all of the safety properties from 14:
--
--   · the version is `active`;
--   · the deployment row points at exactly that version;
--   · the requested Host matches the row's immutable Mavly hostname, which must
--     itself equal `<version.project_id>.mavly.xyz`;
--   · an explicitly unpublished row never serves.
--
-- ═══ ATOMIC ACTIVATION ═══════════════════════════════════════════════════════
--
-- `activate_shared_publication` records the successful attempt and the live
-- pointer in one transaction. It writes `status = 'ready'`, the active version,
-- the hostname and `mavly_domain_status = 'pending'` — but NEVER `verified`.
-- The publishing code probes the runtime after this commit and only then stores
-- `verified`. A failed activation leaves the previous active version and the
-- previous row state untouched.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and idempotent. Apply AFTER 14_shared_hosting.sql. No table, row or
-- existing version is rewritten or deleted. `shared_hosting_schema_version()`
-- is the install marker the publish path checks before it starts an attempt, so
-- an un-migrated deployment fails with 503 BACKEND_NOT_CONFIGURED instead of
-- changing a row whose resolver cannot serve it yet.

begin;

-- ── 1. Install marker (also the publish-path preflight) ─────────────────────

create or replace function public.shared_hosting_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 15;
$$;

revoke all on function public.shared_hosting_schema_version() from public;
revoke all on function public.shared_hosting_schema_version() from anon;
grant execute on function public.shared_hosting_schema_version() to authenticated;

comment on function public.shared_hosting_schema_version() is
  'Shared-hosting schema marker. 15 means attempt state is separate from the live active version.';

-- ── 2. Public resolver: live state only, never the attempt status ───────────

create or replace function public.resolve_published_tenant(p_hostname text)
returns table (
  project_id text,
  version_id uuid,
  published_at timestamptz,
  content_hash text,
  entry_path text,
  spa_fallback boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    v.project_id,
    v.id,
    coalesce(v.activated_at, v.created_at),
    v.content_hash,
    v.entry_path,
    v.spa_fallback
  from public.project_published_versions v
  join public.project_deployments d on d.project_id = v.project_id
  where v.status = 'active'
    and d.active_version_id = v.id
    and d.status <> 'unpublished'
    and d.mavly_hostname = public.mavly_tenant_hostname(p_hostname)
    /**
     * Defense in depth: a row's public address must be derived from the version's
     * own project id. Even if an owner could edit their mapping row directly
     * (RLS permits owner updates), this prevents pointing it at another tenant's
     * hostname and serving their site there.
     */
    and d.mavly_hostname = lower(v.project_id) || '.mavly.xyz'
  limit 1;
$$;

revoke all on function public.resolve_published_tenant(text) from public;
grant execute on function public.resolve_published_tenant(text) to anon, authenticated;

comment on function public.resolve_published_tenant(text) is
  'Resolve a tenant host to its ACTIVE published version. Serving depends on active_version_id, not on the latest attempt status.';

-- ── 3. Atomic successful publish (attempt → live) ──────────────────────────

create or replace function public.activate_shared_publication(
  p_project_id text,
  p_version_id uuid,
  p_hostname text
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_project text := lower(trim(coalesce(p_project_id, '')));
  v_host text := lower(trim(coalesce(p_hostname, '')));
begin
  if v_project = '' or v_host = '' then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- The hostname is always server-derived as `<project-id>.mavly.xyz`. Refusing
  -- anything else keeps an owner from mapping a different tenant's address.
  if v_host <> v_project || '.mavly.xyz' then
    raise exception 'INVALID_HOSTNAME' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = v_project
      and p.user_id = (select auth.uid())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.project_published_versions v
    where v.id = p_version_id
      and v.project_id = v_project
      and v.status in ('draft', 'active')
  ) then
    raise exception 'VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Supersede first: the partial unique index allows only one active row, and
  -- both statements run in this function's transaction.
  update public.project_published_versions
     set status = 'superseded',
         superseded_at = now()
   where project_id = v_project
     and status = 'active'
     and id <> p_version_id;

  update public.project_published_versions
     set status = 'active',
         activated_at = now()
   where id = p_version_id
     and project_id = v_project;

  -- This is the only transition that may claim a live site. The previous active
  -- version (if any) is superseded in the same transaction, so a failed attempt
  -- before this call leaves it untouched and resolvable.
  update public.project_deployments
     set active_version_id = p_version_id,
         provider = 'shared',
         status = 'ready',
         vercel_deployment_id = null,
         url = null,
         error_code = null,
         error_message = null,
         mavly_hostname = v_host,
         mavly_domain_status = 'pending',
         mavly_domain_error = null,
         mavly_domain_checked_at = now(),
         last_published_at = now(),
         updated_at = now()
   where project_id = v_project;

  return p_version_id;
end;
$$;

revoke all on function public.activate_shared_publication(text, uuid, text) from public;
revoke all on function public.activate_shared_publication(text, uuid, text) from anon;
grant execute on function public.activate_shared_publication(text, uuid, text) to authenticated;

comment on function public.activate_shared_publication(text, uuid, text) is
  'Atomically supersede the previous active version, activate the new one and record the successful shared publish. Never stores verified.';

commit;
