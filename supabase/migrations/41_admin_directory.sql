-- Mavly — admin Users and Projects directory aggregates.
--
-- Read-only SECURITY DEFINER RPCs let an authenticated, database-authorized
-- admin query cross-owner records without granting service-role credentials to
-- the application route or broadening ordinary RLS policies.
--
-- This migration creates no payment ledger. Mavly platform billing is not
-- represented by the customer-owned payment tables from migration 21.
--
-- Apply after migration 40 with the existing admin, generation, and deployment
-- schema (migrations 7, 9, 10, 14, 15, 18, and 20) installed. Credit balances
-- are optional and are omitted when migration 31's credit_accounts table is
-- absent.

begin;

create index if not exists projects_created_at_idx
  on public.projects (created_at desc);

create or replace function public.admin_user_directory(
  p_search text default null,
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_month_start timestamptz;
  v_search text := left(btrim(coalesce(p_search, '')), 120);
  v_status text := coalesce(nullif(btrim(p_status), ''), 'all');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 5), 1), 50);
  v_total bigint;
  v_rows jsonb;
  v_metrics jsonb;
  v_credit_rows jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'admin_user_directory: not authorized' using errcode = '42501';
  end if;
  if v_status not in ('all', 'not_banned', 'banned') then
    raise exception 'admin_user_directory: invalid status' using errcode = '22023';
  end if;

  v_month_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';

  if to_regclass('public.credit_accounts') is not null then
    execute $query$
      select coalesce(
        jsonb_object_agg(
          user_id::text,
          (balance_credits - reserved_credits)::text
        ),
        '{}'::jsonb
      )
      from public.credit_accounts
    $query$ into v_credit_rows;
  end if;

  with project_counts as (
    select p.user_id, count(*)::bigint as project_count
    from public.projects p
    group by p.user_id
  ),
  users as (
    select
      u.id,
      u.email,
      u.created_at,
      u.last_sign_in_at,
      u.banned_until,
      coalesce(
        nullif(btrim(profile.full_name), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
        'Unknown'
      ) as full_name,
      coalesce(project_counts.project_count, 0) as project_count,
      exists (
        select 1
        from public.admin_allowlist allowlist
        where lower(btrim(allowlist.email)) = lower(btrim(coalesce(u.email, '')))
      ) as is_admin
    from auth.users u
    left join public.profiles profile on profile.id = u.id
    left join project_counts on project_counts.user_id = u.id
  ),
  filtered as (
    select *
    from users
    where (
      v_search = ''
      or strpos(lower(coalesce(full_name, '')), lower(v_search)) > 0
      or strpos(lower(coalesce(email, '')), lower(v_search)) > 0
      or strpos(id::text, v_search) > 0
    )
      and (
        v_status = 'all'
        or (v_status = 'banned' and banned_until is not null and banned_until > v_now)
        or (v_status = 'not_banned' and (banned_until is null or banned_until <= v_now))
      )
  ),
  page_rows as (
    select *
    from filtered
    order by created_at desc, id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', id,
          'name', full_name,
          'email', email,
          'createdAt', created_at,
          'lastSignInAt', last_sign_in_at,
          'role', case when is_admin then 'Admin' else null end,
          'plan', null,
          'projectCount', project_count,
          'availableCredits', v_credit_rows ->> (id::text),
          'status', case
            when banned_until is not null and banned_until > v_now then 'Banned'
            else 'Not Banned'
          end,
          'bannedUntil', case when banned_until > v_now then banned_until else null end
        )
        order by created_at desc, id desc
      )
      from page_rows
    ), '[]'::jsonb)
  into v_total, v_rows;

  select jsonb_build_object(
    'total', count(*),
    'createdThisMonth', count(*) filter (
      where created_at >= v_month_start and created_at < v_now
    ),
    'createdLast7Days', count(*) filter (
      where created_at >= v_now - interval '7 days' and created_at < v_now
    ),
    'banned', count(*) filter (
      where banned_until is not null and banned_until > v_now
    )
  )
  into v_metrics
  from auth.users;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'page', v_page,
    'pageSize', v_page_size,
    'metrics', v_metrics,
    'planFilterAvailable', false,
    'statusFilterAvailable', true,
    'generatedAt', v_now
  );
end;
$$;

comment on function public.admin_user_directory(text, text, integer, integer) is
  'Admin-only read-only Users directory over auth.users, profiles, projects and credit_accounts. Missing plan data remains null.';

create or replace function public.admin_project_directory(
  p_search text default null,
  p_status text default 'all',
  p_visibility text default 'all',
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_month_start timestamptz;
  v_search text := left(btrim(coalesce(p_search, '')), 120);
  v_status text := coalesce(nullif(btrim(p_status), ''), 'all');
  v_visibility text := coalesce(nullif(btrim(p_visibility), ''), 'all');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 10), 1), 50);
  v_total bigint;
  v_rows jsonb;
  v_metrics jsonb;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'admin_project_directory: not authorized' using errcode = '42501';
  end if;

  if v_status not in (
    'all', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'no_run'
  ) then
    raise exception 'admin_project_directory: invalid status' using errcode = '22023';
  end if;
  if v_visibility not in (
    'all', 'custom_domain', 'preview_url', 'draft'
  ) then
    raise exception 'admin_project_directory: invalid visibility' using errcode = '22023';
  end if;

  v_month_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';

  with latest_runs as (
    select distinct on (r.project_id)
      r.project_id,
      r.stage,
      coalesce(nullif(r.model_used, ''), nullif(r.model, '')) as model,
      r.started_at
    from public.project_runs r
    order by r.project_id, r.started_at desc, r.id desc
  ),
  projects as (
    select
      p.project_id,
      coalesce(nullif(btrim(p.label), ''), p.project_id) as name,
      p.user_id,
      coalesce(
        nullif(btrim(profile.full_name), ''),
        nullif(btrim(owner.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(owner.raw_user_meta_data ->> 'name'), ''),
        nullif(split_part(coalesce(owner.email, ''), '@', 1), ''),
        'Unknown'
      ) as owner_name,
      owner.email as owner_email,
      p.created_at,
      p.updated_at,
      latest.stage as generation_stage,
      latest.model,
      coalesce(deployment.lifecycle, deployment.status) as deployment_attempt_status,
      deployment.url,
      deployment.mavly_hostname,
      deployment.mavly_domain_status,
      (
        deployment.status <> 'unpublished'
        and deployment.active_version_id is not null
        and exists (
          select 1
          from public.project_published_versions published_version
          where published_version.id = deployment.active_version_id
            and published_version.project_id = p.project_id
            and published_version.status = 'active'
        )
      ) as has_active_version,
      (
        coalesce(deployment.lifecycle, deployment.status) = 'ready'
        and deployment.active_version_id is null
        and nullif(btrim(deployment.url), '') is not null
      ) as has_legacy_ready_deployment
    from public.projects p
    join auth.users owner on owner.id = p.user_id
    left join public.profiles profile on profile.id = p.user_id
    left join latest_runs latest on latest.project_id = p.project_id
    left join public.project_deployments deployment on deployment.project_id = p.project_id
  ),
  classified as (
    select
      *,
      case
        when generation_stage is null then 'no_run'
        when generation_stage in ('validating', 'generating', 'retrying', 'retry_wait') then 'running'
        else generation_stage
      end as generation_status,
      case
        when (has_active_version or has_legacy_ready_deployment)
          and mavly_domain_status = 'verified'
          and mavly_hostname = (lower(project_id) || '.mavly.xyz')
          and mavly_hostname is not null then 'custom_domain'
        when has_active_version or has_legacy_ready_deployment then 'preview_url'
        else 'draft'
      end as visibility,
      case
        when (has_active_version or has_legacy_ready_deployment)
          and mavly_domain_status = 'verified'
          and mavly_hostname = (lower(project_id) || '.mavly.xyz')
          and mavly_hostname is not null
          then 'https://' || mavly_hostname
        when has_active_version or has_legacy_ready_deployment then url
        else null
      end as published_url
    from projects
  ),
  filtered as (
    select *
    from classified
    where (
      v_status = 'all'
      or generation_status = v_status
      or (v_status = 'queued' and generation_status = 'queued')
    )
      and (v_visibility = 'all' or visibility = v_visibility)
      and (
        v_search = ''
        or strpos(lower(name), lower(v_search)) > 0
        or strpos(lower(project_id), lower(v_search)) > 0
        or strpos(lower(coalesce(owner_name, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(owner_email, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(published_url, '')), lower(v_search)) > 0
      )
  ),
  page_rows as (
    select *
    from filtered
    order by created_at desc, project_id
    limit v_page_size
    offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', project_id,
          'name', name,
          'ownerId', user_id,
          'owner', owner_name,
          'ownerEmail', owner_email,
          'createdAt', created_at,
          'updatedAt', updated_at,
          'generationStatus', generation_status,
          'generationStage', generation_stage,
          'model', model,
          'deploymentAttemptStatus', deployment_attempt_status,
          'deploymentStatus', case
            when has_active_version or has_legacy_ready_deployment then 'published'
            when deployment_attempt_status in ('queued', 'building', 'deploying', 'rolling_back', 'unpublishing') then 'deploying'
            when deployment_attempt_status in ('error', 'canceled', 'failed', 'cancelled') then 'failed'
            when deployment_attempt_status = 'disabled' then 'unpublished'
            when deployment_attempt_status = 'unpublished' then 'unpublished'
            else 'draft'
          end,
          'visibility', visibility,
          'publishedUrl', published_url,
          'routesCount', null
        )
        order by created_at desc, project_id
      )
      from page_rows
    ), '[]'::jsonb)
  into v_total, v_rows;

  select jsonb_build_object(
    'total', count(*),
    'createdThisMonth', count(*) filter (
      where created_at >= v_month_start and created_at < v_now
    ),
    'createdLast7Days', count(*) filter (
      where created_at >= v_now - interval '7 days' and created_at < v_now
    ),
    'published', count(*) filter (
      where has_active_version or has_legacy_ready_deployment
    ),
    'verifiedMavlyDomains', count(*) filter (
      where (has_active_version or has_legacy_ready_deployment)
        and mavly_domain_status = 'verified'
        and mavly_hostname = (lower(project_id) || '.mavly.xyz')
        and mavly_hostname is not null
    )
  )
  into v_metrics
  from classified;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'page', v_page,
    'pageSize', v_page_size,
    'status', v_status,
    'visibility', v_visibility,
    'metrics', v_metrics,
    'generatedAt', v_now
  );
end;
$$;

comment on function public.admin_project_directory(text, text, text, integer, integer) is
  'Admin-only read-only project directory. Generation stage, active published version and verified Mavly hostname are reported from persisted records; route counts remain null.';

revoke all on function public.admin_user_directory(text, text, integer, integer) from public, anon;
revoke all on function public.admin_project_directory(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_user_directory(text, text, integer, integer) to authenticated;
grant execute on function public.admin_project_directory(text, text, text, integer, integer) to authenticated;

commit;
