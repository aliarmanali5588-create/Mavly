-- ═══════════════════════════════════════════════════════════════════════════════
-- 64 — Vercel domain publishing
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- Migration 62's domain registry claims a domain job only when the project has an
-- ACTIVE row in `project_published_versions` reachable from
-- `project_deployments.active_version_id`. The shared and AWS publish paths write
-- that pair; the Vercel static publish path did not, so every custom-domain
-- operation on a Vercel-published project failed with
-- `DOMAIN_PROJECT_NOT_PUBLISHED`.
--
-- This migration adds the missing owner-checked activation RPC (the application
-- calls it after Vercel reports the deployment ready) and makes the recorded
-- routing provider reflect the actual deployment provider instead of the
-- hard-coded `aws_cloudfront` value migration 62's completion RPC wrote.
--
-- ADDITIVE ONLY: one function, one trigger, one schema marker and a state
-- backfill. No table, column, policy, grant or row is dropped. Existing AWS rows
-- are untouched. Apply after 63.
--
-- ROLLBACK: drop the trigger and function `sync_domain_routing_provider`, drop
-- `activate_vercel_publication` and the marker function. `active_version_id`
-- values written by the RPC are normal published-version references and are safe
-- to leave in place.

begin;

-- ── Schema marker ────────────────────────────────────────────────────────────

create or replace function public.vercel_domain_publishing_schema_version()
returns integer
language sql
immutable
as $$ select 64 $$;

comment on function public.vercel_domain_publishing_schema_version() is
  'Schema marker 64: Vercel published-version activation for the domain registry.';

revoke all on function public.vercel_domain_publishing_schema_version() from public, anon;
grant execute on function public.vercel_domain_publishing_schema_version()
  to authenticated, service_role;

-- ── Active published version for a Vercel-hosted project ─────────────────────
--
-- Owner-checked and SECURITY DEFINER: the authenticated role has no UPDATE grant
-- on `project_published_versions.status`, and must never be able to activate a
-- version of a project it does not own. The version id is always a server-created
-- draft of THIS project; a foreign or unknown id raises instead of being guessed.

create or replace function public.activate_vercel_publication(
  p_project_id text,
  p_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_version public.project_published_versions%rowtype;
  v_deployment public.project_deployments%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_project from public.projects where project_id = p_project_id;
  if not found then
    raise exception 'DEPLOYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_project.user_id <> v_uid then
    raise exception 'DEPLOYMENT_NOT_FOUND' using errcode = '42501';
  end if;

  select * into v_version
    from public.project_published_versions
   where id = p_version_id and project_id = p_project_id
   for update;
  if not found then
    raise exception 'DEPLOYMENT_VERSION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_version.status = 'failed' then
    raise exception 'DEPLOYMENT_VERSION_NOT_ACTIVATABLE' using errcode = 'P0001';
  end if;

  select * into v_deployment
    from public.project_deployments
   where project_id = p_project_id
   for update;
  if not found then
    raise exception 'DEPLOYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Only the Vercel static path may call this. An AWS row keeps its route
  -- generation fence and is never rewired by a published-version write.
  if coalesce(v_deployment.provider, 'vercel') <> 'vercel' then
    raise exception 'DEPLOYMENT_PROVIDER_MISMATCH' using errcode = 'P0001';
  end if;

  update public.project_published_versions
     set status = 'superseded'
   where project_id = p_project_id
     and id <> p_version_id
     and status = 'active';

  update public.project_published_versions
     set status = 'active'
   where id = p_version_id;

  update public.project_deployments
     set active_version_id = p_version_id,
         updated_at = now()
   where project_id = p_project_id;

  return jsonb_build_object(
    'projectId', p_project_id,
    'versionId', p_version_id,
    'status', 'active'
  );
end;
$$;

comment on function public.activate_vercel_publication(text, uuid) is
  'Owner-checked activation of one immutable published version for a Vercel-hosted project. The Vercel publish path calls it after the provider reports ready; it never changes an AWS row.';

revoke all on function public.activate_vercel_publication(text, uuid) from public, anon;
grant execute on function public.activate_vercel_publication(text, uuid) to authenticated;

-- ── Provider-accurate routing state ──────────────────────────────────────────
--
-- Migration 62's `complete_domain_job` stamped every active domain with
-- `aws_cloudfront`. That is wrong for a Vercel (or shared) deployment and made
-- the admin and owner surfaces name the wrong provider. The trigger derives the
-- value from the deployment row that actually serves the project. `manual`
-- routing is deliberately left alone: an operator chose it.

create or replace function public.sync_domain_routing_provider()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider text;
begin
  if new.status = 'active'
     and new.routing_provider in ('none', 'aws_cloudfront', 'shared', 'vercel') then
    select case d.provider
             when 'aws' then 'aws_cloudfront'
             when 'shared' then 'shared'
             when 'vercel' then 'vercel'
             else null
           end
      into v_provider
      from public.project_deployments d
     where d.project_id = new.project_id;

    if v_provider is not null then
      new.routing_provider := v_provider;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.sync_domain_routing_provider() is
  'Derives project_domains.routing_provider from the deployment that serves the project. Recorded state only: it grants nothing and never calls a provider.';

drop trigger if exists project_domains_sync_routing_provider on public.project_domains;
create trigger project_domains_sync_routing_provider
  before update of status, routing_provider on public.project_domains
  for each row
  execute function public.sync_domain_routing_provider();

-- Backfill only rows whose recorded provider disagrees with the deployment.
update public.project_domains d
   set routing_provider = case dep.provider
                            when 'aws' then 'aws_cloudfront'
                            when 'shared' then 'shared'
                            when 'vercel' then 'vercel'
                            else d.routing_provider
                          end
  from public.project_deployments dep
 where dep.project_id = d.project_id
   and d.status = 'active'
   and d.routing_provider <> 'manual'
   and d.routing_provider is distinct from case dep.provider
                                                  when 'aws' then 'aws_cloudfront'
                                                  when 'shared' then 'shared'
                                                  when 'vercel' then 'vercel'
                                                  else d.routing_provider
                                                end;

commit;
