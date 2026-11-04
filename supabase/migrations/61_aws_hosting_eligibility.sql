-- AWS customer frontend hosting: database-driven eligibility and capacity.
--
-- Apply after migrations 51 and 56 (AWS publication queue + fencing) and after
-- 57_platform_billing.sql (the canonical plan entitlement source). 49 is already a
-- prerequisite of 51.
--
-- This migration REPLACES the manual per-customer project allowlist as the
-- authority for new customer AWS publications. `MAVLY_AWS_FRONTEND_HOSTING_PROJECTS`
-- remains only as an optional emergency restriction parsed by the application and
-- is never required for ordinary onboarding.
--
-- Additive and non-destructive:
--   · no existing deployment, version, file, billing or credit row is rewritten;
--   · only a platform settings singleton and functions are created;
--   · Vercel/shared rows are untouched and no provider is migrated.
--
-- Customer-facing plan limits are NOT invented here. The published-site ceiling is
-- derived from the canonical `price_catalog.project_limit` (via
-- `billing_user_entitlements()` for the owner and the same catalog for the worker),
-- unless an operator sets the optional platform-wide `max_published_sites` bound.

begin;

do $$
declare
  v_aws integer;
  v_billing integer;
  v_restriction integer;
begin
  if to_regprocedure('public.aws_frontend_fencing_schema_version()') is null then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: apply migration 56_aws_frontend_fencing_and_status.sql first';
  end if;
  execute 'select public.aws_frontend_fencing_schema_version()' into v_aws;
  if v_aws < 56 then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: migration 56_aws_frontend_fencing_and_status.sql is outdated';
  end if;

  if to_regprocedure('public.billing_schema_version()') is null then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: apply migration 57_platform_billing.sql first';
  end if;
  execute 'select public.billing_schema_version()' into v_billing;
  if v_billing < 57 then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: migration 57_platform_billing.sql is outdated';
  end if;

  if to_regprocedure('public.account_restriction_schema_version()') is null then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: apply migration 49_account_restriction_reason.sql first';
  end if;
  execute 'select public.account_restriction_schema_version()' into v_restriction;
  if v_restriction < 49 then
    raise exception 'AWS_HOSTING_ELIGIBILITY_PREREQUISITE_MISSING: migration 49_account_restriction_reason.sql is outdated';
  end if;
end
$$;

-- ── Platform capacity (one row, service-role only) ──────────────────────────
--
-- Stable platform configuration, never per-customer configuration and never a
-- customer-provided value. Operators change it through a reviewed service-role
-- procedure. `publication_enabled = false` is the database-level publishing kill
-- switch: it refuses new publications without touching an existing route.

create table if not exists public.hosting_platform_settings (
  singleton boolean primary key default true,
  publication_enabled boolean not null default true,
  max_active_publications integer not null default 1,
  max_queued_publications integer not null default 50,
  max_published_sites integer,
  updated_at timestamptz not null default now(),
  constraint hosting_platform_settings_singleton_check check (singleton),
  constraint hosting_platform_settings_active_check
    check (max_active_publications between 1 and 50),
  constraint hosting_platform_settings_queued_check
    check (max_queued_publications between 1 and 500),
  constraint hosting_platform_settings_sites_check
    check (max_published_sites is null or max_published_sites between 1 and 500)
);

insert into public.hosting_platform_settings (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.hosting_platform_settings enable row level security;
revoke all on public.hosting_platform_settings from public, anon, authenticated;
grant select, insert, update, delete on public.hosting_platform_settings to service_role;

create or replace function public.hosting_platform_settings_touch()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hosting_platform_settings_updated_at on public.hosting_platform_settings;
create trigger hosting_platform_settings_updated_at
  before update on public.hosting_platform_settings
  for each row execute function public.hosting_platform_settings_touch();

revoke all on function public.hosting_platform_settings_touch() from public, anon, authenticated;

-- A helper that reads the singleton without ever inventing defaults: if the row is
-- missing the caller treats capacity as disabled (fail closed).
create or replace function public.aws_hosting_capacity_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'configured', s.singleton is not null,
    'enabled', coalesce(s.publication_enabled, false),
    -- Expired processing rows are recovered by the claim RPC, so they must not
    -- count against capacity: otherwise a crashed worker would block its own
    -- recovery forever. Only a live lease is active work.
    'activeCount', (
      select count(*)::integer from public.aws_frontend_publications j
       where j.status = 'processing'
         and j.lease_expires_at > now()
    ),
    'queuedCount', (
      select count(*)::integer from public.aws_frontend_publications j
       where j.status in ('queued', 'retry_wait')
          or (j.status = 'processing' and j.lease_expires_at > now())
    ),
    'maxActive', coalesce(s.max_active_publications, 0),
    'maxQueued', coalesce(s.max_queued_publications, 0)
  )
  from (select true as singleton) probe
  left join public.hosting_platform_settings s on s.singleton = probe.singleton;
$$;

revoke all on function public.aws_hosting_capacity_snapshot() from public, anon, authenticated;
grant execute on function public.aws_hosting_capacity_snapshot() to service_role;

-- ── Owner-facing eligibility ────────────────────────────────────────────────
--
-- The authoritative answer for the authenticated owner. Structured reasons only:
-- no AWS resource identifier, bucket name, key, region or internal address is
-- returned. The browser cannot supply any of the facts this function reads.

create or replace function public.aws_hosting_eligibility(p_project_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_banned timestamptz;
  v_settings public.hosting_platform_settings%rowtype;
  v_plan jsonb;
  v_reason text := 'eligible';
  v_plan_id text := 'free';
  v_project_limit integer;
  v_published_limit integer;
  v_published integer := 0;
  v_active integer := 0;
  v_queued integer := 0;
  v_latest_stage text;
  v_has_completed boolean := false;
  v_active_run boolean := false;
  v_available bigint := 0;
  v_max_active integer := 0;
  v_max_queued integer := 0;
begin
  if auth.role() is distinct from 'authenticated' or v_uid is null then
    v_reason := 'ownership_mismatch';
  else
    select * into v_project
      from public.projects
     where project_id = p_project_id;

    if not found then
      v_reason := 'project_not_found';
    elsif v_project.user_id <> v_uid then
      v_reason := 'ownership_mismatch';
    else
      select u.banned_until into v_banned
        from auth.users u
       where u.id = v_uid;
      if v_banned is not null and v_banned > now() then
        v_reason := 'user_suspended';
      else
        -- Capacity scalars are read first so the response never dereferences an
        -- unassigned settings record. A missing row leaves them at 0 (disabled).
        select coalesce(max_active_publications, 0), coalesce(max_queued_publications, 0)
          into v_max_active, v_max_queued
          from public.hosting_platform_settings
         where singleton;
        select * into v_settings
          from public.hosting_platform_settings
         where singleton;
        if not found or not v_settings.publication_enabled then
          v_reason := 'platform_hosting_disabled';
        elsif coalesce(v_project.project_type, 'website') <> 'website' then
          v_reason := 'project_not_publishable';
        else
          select stage into v_latest_stage
            from public.project_runs
           where project_id = p_project_id
           order by started_at desc, id desc
           limit 1;

          select exists (
            select 1 from public.project_runs r
             where r.project_id = p_project_id
               and r.status = 'done'
               and r.stage = 'completed'
          ) into v_has_completed;

          select exists (
            select 1 from public.project_runs r
             where r.project_id = p_project_id
               and r.finished_at is null
               and r.stage in ('queued', 'validating', 'generating', 'retrying', 'retry_wait')
          ) into v_active_run;

          if not exists (
            select 1 from public.project_files f where f.project_id = p_project_id
          ) then
            v_reason := 'generation_incomplete';
          elsif v_active_run then
            v_reason := 'generation_incomplete';
          elsif v_latest_stage is not null and v_latest_stage <> 'completed' and not v_has_completed then
            v_reason := 'generation_incomplete';
          else
            v_plan := public.billing_user_entitlements();
            v_plan_id := coalesce(v_plan ->> 'planId', 'free');
            if jsonb_typeof(v_plan -> 'projectLimit') = 'number' then
              v_project_limit := (v_plan ->> 'projectLimit')::integer;
            end if;
            if jsonb_typeof(v_plan -> 'availableCredits') = 'number' then
              v_available := (v_plan ->> 'availableCredits')::bigint;
            end if;

            if v_project_limit is null or v_project_limit < 1 then
              v_reason := 'plan_not_allowed';
            else
              v_published_limit := coalesce(v_settings.max_published_sites, v_project_limit);

              select count(*)::integer into v_published
                from public.project_deployments d
                join public.projects p on p.project_id = d.project_id
               where p.user_id = v_uid
                 and d.project_id <> p_project_id
                 and d.status in ('ready', 'unpublishing');

              if v_published >= v_published_limit then
                v_reason := 'project_limit_reached';
              else
                select
                  (count(*) filter (
                    where j.status = 'processing' and j.lease_expires_at > now()
                  ))::integer,
                  (count(*) filter (
                    where j.status in ('queued', 'retry_wait')
                       or (j.status = 'processing' and j.lease_expires_at > now())
                  ))::integer
                  into v_active, v_queued
                  from public.aws_frontend_publications j
                 where j.status in ('queued', 'processing', 'retry_wait');

                if v_queued >= v_settings.max_queued_publications then
                  v_reason := 'hosting_capacity_exceeded';
                end if;
              end if;
            end if;
          end if;
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'eligible', v_reason = 'eligible',
    'reason', v_reason,
    'planId', v_plan_id,
    'projectLimit', v_project_limit,
    'publishedSiteLimit', v_published_limit,
    'publishedSiteCount', v_published,
    'creditsRequired', 0,
    'availableCredits', v_available,
    'capacity', jsonb_build_object(
      'activeCount', v_active,
      'queuedCount', v_queued,
      'maxActive', v_max_active,
      'maxQueued', v_max_queued
    )
  );
end;
$$;

revoke all on function public.aws_hosting_eligibility(text) from public, anon;
grant execute on function public.aws_hosting_eligibility(text) to authenticated;

-- ── Worker-facing authorization ─────────────────────────────────────────────
--
-- The EC2 worker has no end-user session. It re-proves ownership from the claim
-- and re-evaluates the same rules (suspension, plan ceiling, source presence,
-- platform capacity) before touching S3. Service-role only; the browser can
-- never call it and cannot pass another user's id.

create or replace function public.aws_hosting_worker_authorization(
  p_project_id text,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_settings public.hosting_platform_settings%rowtype;
  v_reason text := 'eligible';
  v_plan_id text := 'free';
  v_market text;
  v_project_limit integer;
  v_published_limit integer;
  v_published integer := 0;
  v_active integer := 0;
  v_queued integer := 0;
  v_latest_stage text;
  v_has_completed boolean := false;
  v_active_run boolean := false;
  v_max_active integer := 0;
  v_max_queued integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_owner_id is null or p_project_id is null then
    v_reason := 'ownership_mismatch';
  else
    select * into v_project
      from public.projects
     where project_id = p_project_id;
    if not found then
      v_reason := 'project_not_found';
    elsif v_project.user_id <> p_owner_id then
      v_reason := 'ownership_mismatch';
    elsif public.account_user_is_restricted(p_owner_id) then
      v_reason := 'user_suspended';
    else
      select coalesce(max_active_publications, 0), coalesce(max_queued_publications, 0)
        into v_max_active, v_max_queued
        from public.hosting_platform_settings
       where singleton;
      select * into v_settings
        from public.hosting_platform_settings
       where singleton;
      if not found or not v_settings.publication_enabled then
        v_reason := 'platform_hosting_disabled';
      elsif coalesce(v_project.project_type, 'website') <> 'website' then
        v_reason := 'project_not_publishable';
      else
        select stage into v_latest_stage
          from public.project_runs
         where project_id = p_project_id
         order by started_at desc, id desc
         limit 1;

        select exists (
          select 1 from public.project_runs r
           where r.project_id = p_project_id
             and r.status = 'done'
             and r.stage = 'completed'
        ) into v_has_completed;

        select exists (
          select 1 from public.project_runs r
           where r.project_id = p_project_id
             and r.finished_at is null
             and r.stage in ('queued', 'validating', 'generating', 'retrying', 'retry_wait')
        ) into v_active_run;

        if not exists (
          select 1 from public.project_files f where f.project_id = p_project_id
        ) then
          v_reason := 'generation_incomplete';
        elsif v_active_run then
          v_reason := 'generation_incomplete';
        elsif v_latest_stage is not null and v_latest_stage <> 'completed' and not v_has_completed then
          v_reason := 'generation_incomplete';
        else
          -- Mirrors `billing_user_entitlements()`: free has a project ceiling of
          -- 1, a paid plan uses the catalog row for its own market, and a paid
          -- subscription with no matching approved catalog row stays NULL
          -- (`plan_not_allowed`) instead of inventing a limit.
          select s.plan_id, s.market into v_plan_id, v_market
            from public.subscriptions s
           where s.user_id = p_owner_id
             and s.status in ('active', 'past_due')
           order by s.current_period_end desc nulls last, s.created_at desc
           limit 1;
          v_plan_id := coalesce(v_plan_id, 'free');

          if v_plan_id = 'free' then
            v_project_limit := 1;
          else
            select p.project_limit into v_project_limit
              from public.price_catalog p
              join public.price_catalog_versions v on v.id = p.version_id
             where p.product_id = v_plan_id
               and p.market = v_market
               and p.active
               and p.approved
             order by v.created_at desc
             limit 1;
          end if;

          if v_project_limit is null or v_project_limit < 1 then
            v_reason := 'plan_not_allowed';
          else
            v_published_limit := coalesce(v_settings.max_published_sites, v_project_limit);

            select count(*)::integer into v_published
              from public.project_deployments d
              join public.projects p on p.project_id = d.project_id
             where p.user_id = p_owner_id
               and d.project_id <> p_project_id
               and d.status in ('ready', 'unpublishing');

            if v_published >= v_published_limit then
              v_reason := 'project_limit_reached';
            else
              select
                (count(*) filter (
                  where j.status = 'processing' and j.lease_expires_at > now()
                ))::integer,
                (count(*) filter (
                  where j.status in ('queued', 'retry_wait')
                     or (j.status = 'processing' and j.lease_expires_at > now())
                ))::integer
                into v_active, v_queued
                from public.aws_frontend_publications j
               where j.status in ('queued', 'processing', 'retry_wait');

              -- The claimed job itself is now `processing`, so active uses `>`.
              if v_queued >= v_settings.max_queued_publications
                 or v_active > v_settings.max_active_publications then
                v_reason := 'hosting_capacity_exceeded';
              end if;
            end if;
          end if;
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'eligible', v_reason = 'eligible',
    'reason', v_reason,
    'planId', v_plan_id,
    'projectLimit', v_project_limit,
    'publishedSiteLimit', v_published_limit,
    'publishedSiteCount', v_published,
    'capacity', jsonb_build_object(
      'activeCount', v_active,
      'queuedCount', v_queued,
      'maxActive', v_max_active,
      'maxQueued', v_max_queued
    )
  );
end;
$$;

revoke all on function public.aws_hosting_worker_authorization(text, uuid) from public, anon, authenticated;
grant execute on function public.aws_hosting_worker_authorization(text, uuid) to service_role;

-- ── Enqueue admission (replaces the migration-56 definition) ────────────────
--
-- The owner-scoped RPC now re-evaluates eligibility inside the same transaction
-- that queues the publication. A caller cannot bypass plan, suspension, source,
-- or capacity rules by calling the RPC directly with a valid queued deployment.

create or replace function public.enqueue_aws_frontend_publication(
  p_project_id text,
  p_version_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_bytes bigint;
  v_expected_count integer;
  v_expected_bytes bigint;
  v_hostname text;
  v_nonce uuid := gen_random_uuid();
  v_eligibility jsonb;
  v_reason text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null or not exists (
    select 1
      from public.projects p
     where p.project_id = p_project_id
       and p.user_id = auth.uid()
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_eligibility := public.aws_hosting_eligibility(p_project_id);
  if coalesce((v_eligibility ->> 'eligible')::boolean, false) is not true then
    v_reason := coalesce(v_eligibility ->> 'reason', 'unknown');
    raise exception 'HOSTING_NOT_ELIGIBLE:%', v_reason using errcode = '42501';
  end if;

  v_hostname := public.mavly_tenant_hostname(p_project_id || '.mavly.xyz');
  if v_hostname is null then
    raise exception 'INVALID_HOSTNAME' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.project_deployments d
     where d.project_id = p_project_id
       and d.provider = 'aws'
       and d.status = 'queued'
  ) then
    raise exception 'DEPLOYMENT_NOT_QUEUED' using errcode = '22023';
  end if;

  select v.file_count, v.byte_count
    into v_expected_count, v_expected_bytes
    from public.project_published_versions v
   where v.id = p_version_id
     and v.project_id = p_project_id
     and v.status = 'draft'
   for update;
  if not found then
    raise exception 'INVALID_PUBLICATION' using errcode = '22023';
  end if;

  select count(*)::integer, coalesce(sum(f.size_bytes), 0)
    into v_count, v_bytes
    from public.project_published_files f
   where f.version_id = p_version_id;

  if v_expected_count <> v_count
     or v_expected_bytes <> v_bytes
     or v_count not between 1 and 1000
     or v_bytes not between 1 and 8000000 then
    raise exception 'INVALID_PUBLICATION' using errcode = '22023';
  end if;

  insert into public.aws_frontend_publications (version_id, project_id, owner_id)
  values (p_version_id, p_project_id, auth.uid())
  on conflict (version_id) do nothing;

  insert into public.aws_frontend_mutation_nonces (nonce, purpose)
  values (v_nonce, 'publication_enqueue');
  perform set_config('mavly.aws_mutation_nonce', v_nonce::text, true);
  update public.project_deployments
     set mavly_hostname = v_hostname,
         mavly_domain_status = 'pending',
         mavly_domain_error = null,
         mavly_domain_checked_at = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where project_id = p_project_id
     and provider = 'aws'
     and status = 'queued';
  if not found then
    delete from public.aws_frontend_mutation_nonces where nonce = v_nonce;
    raise exception 'DEPLOYMENT_STATE_CHANGED' using errcode = '40001';
  end if;
  delete from public.aws_frontend_mutation_nonces where nonce = v_nonce;

  return p_version_id;
end;
$$;

revoke all on function public.enqueue_aws_frontend_publication(text, uuid) from public, anon;
grant execute on function public.enqueue_aws_frontend_publication(text, uuid) to authenticated;

create or replace function public.aws_hosting_eligibility_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 61;
$$;

revoke all on function public.aws_hosting_eligibility_schema_version() from public, anon;
grant execute on function public.aws_hosting_eligibility_schema_version()
  to authenticated, service_role;

commit;
