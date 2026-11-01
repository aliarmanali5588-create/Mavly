-- ═══════════════════════════════════════════════════════════════════════════
-- 46_admin_directory_optional_publication.sql
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE AND NON-DESTRUCTIVE. Apply after 45.
--
-- ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
--
-- `admin_project_directory` (migration 41, wrapped by 44) reads six relations:
--
--   public.projects                    migration 02   (always present)
--   auth.users                         Supabase Auth  (always present)
--   public.profiles                    migration 01   (always present)
--   public.project_runs                migration 03   (always present)
--   public.project_deployments         migration 07   (always present)
--   public.project_published_versions  migration 14   (OPT-IN FEATURE)
--
-- `project_published_versions` arrives with migration 14, which only matters
-- when shared tenant hosting is enabled. A deployment that never turned that
-- feature on legitimately has no such table — and because a plpgsql function
-- body is resolved at RUN time, migration 41 applied cleanly on exactly that
-- database and then failed on every request with:
--
--   ERROR: relation "public.project_published_versions" does not exist
--   SQLSTATE 42P01
--
-- which the route correctly reported as DIRECTORY_TABLE_MISSING. The directory
-- was right; the function was wrong to hard-depend on an optional feature.
--
-- ═══ WHAT THIS CHANGES ═════════════════════════════════════════════════════
--
-- The publication dependency becomes OPTIONAL, exactly the way migration 41
-- already treats `public.credit_accounts` in the Users directory: the function
-- probes `to_regclass` and degrades instead of raising.
--
--   · `publicationState` is `'available'` or `'schema_missing'`.
--   · When the table is absent, publication is reported as NOT RECORDED:
--     `published` and `verifiedMavlyDomains` are null, `visibility` is
--     `'unknown'`, and `publishedUrl` is null.
--   · It is NEVER reported as `draft` / `0 published`. "No publication table"
--     and "nothing is published" are different facts and must not be conflated.
--
-- ═══ WHAT THIS DOES NOT CHANGE ═════════════════════════════════════════════
--
--   · No table is created, altered or dropped. This migration creates NO table.
--     It does not "fix" the missing table by inventing an empty one — an empty
--     `project_published_versions` would be a fabricated answer to a real
--     question, and would silently break publishing if migration 14 were later
--     applied with a different shape.
--   · No customer row is read, written or deleted.
--   · RLS, ownership, grants and the admin gate are unchanged.
--   · The RPC signature is unchanged, so the route and its validator still work.
--   · Pagination, search, status and visibility filters keep working. The
--     `custom_domain` / `preview_url` visibility filters simply match nothing
--     while publication is unrecorded, which is the truth.
--
-- ═══ TO ACTUALLY ENABLE PUBLICATION ════════════════════════════════════════
--
-- Apply `14_shared_hosting.sql`, then `15_shared_hosting_attempt_state.sql`.
-- The directory picks the table up on the next request; this migration needs no
-- re-run because the probe is evaluated per call.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The directory implementation, with publication as an optional input ──

create or replace function public.admin_project_directory_v46(
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
  /**
   * ⚠️ THE ONE NEW INPUT. True only when migration 14's publication table is
   * installed. Every publication expression below is gated on it, so the
   * function never names a relation that is not there.
   */
  v_publication_available boolean :=
    to_regclass('public.project_published_versions') is not null;
  /**
   * project_id -> true, for every project whose deployment points at an ACTIVE
   * published version. Populated by dynamic SQL only when the table exists, so
   * the static query below never names `project_published_versions` at all.
   *
   * ⚠️ WHY EXECUTE AND NOT A `CASE` GUARD. A `case when <flag> then ... else
   * (select ... from missing_table) end` does NOT protect against 42P01: the
   * planner resolves every relation in the expression before evaluation, so the
   * statement still fails while planning. Dynamic SQL is the only construct
   * that keeps the relation name out of the planned statement — the same pattern
   * migration 41 already uses for the optional `credit_accounts` table.
   */
  v_active_versions jsonb := '{}'::jsonb;
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
    'all', 'custom_domain', 'preview_url', 'draft', 'unknown'
  ) then
    raise exception 'admin_project_directory: invalid visibility' using errcode = '22023';
  end if;

  v_month_start := date_trunc('month', v_now at time zone 'UTC') at time zone 'UTC';

  /**
   * ⚠️ THE 42P01 FIX. This is the only place the publication table is named,
   * and it is inside a string literal, so it is resolved only when executed —
   * and it is executed only when the table is installed.
   */
  if v_publication_available then
    execute $query$
      select coalesce(jsonb_object_agg(active.project_id, true), '{}'::jsonb)
      from (
        select distinct deployment.project_id
        from public.project_deployments deployment
        join public.project_published_versions published_version
          on published_version.id = deployment.active_version_id
         and published_version.project_id = deployment.project_id
         and published_version.status = 'active'
        where deployment.status <> 'unpublished'
      ) active
    $query$ into v_active_versions;
  end if;

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
      /**
       * ⚠️ THE 42P01 FIX. This reads the jsonb map built above by dynamic SQL,
       * so `project_published_versions` is never named in this statement.
       */
      (
        deployment.status <> 'unpublished'
        and deployment.active_version_id is not null
        and (v_active_versions ->> p.project_id) is not null
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
      /**
       * ⚠️ FOUR STATES, NOT THREE. `unknown` is what a project is when the
       * publication table itself is absent. Reporting `draft` there would be a
       * fabricated claim that nothing is published.
       */
      case
        when not v_publication_available then 'unknown'
        when (has_active_version or has_legacy_ready_deployment)
          and mavly_domain_status = 'verified'
          and mavly_hostname = (lower(project_id) || '.mavly.xyz')
          and mavly_hostname is not null then 'custom_domain'
        when has_active_version or has_legacy_ready_deployment then 'preview_url'
        else 'draft'
      end as visibility,
      case
        when not v_publication_available then null
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
  ),
  /**
   * ⚠️ THE METRICS MUST BE COMPUTED IN THE SAME STATEMENT AS THE ROWS.
   *
   * A CTE is visible only to the query it belongs to, so `filtered`/`classified`
   * cannot be referenced by a second `select` in the same function body. Both
   * aggregates therefore come from this one query.
   *
   * ⚠️ NULL, NOT ZERO. When publication is unrecorded, `published` and
   * `verifiedMavlyDomains` are null so the page can say "unavailable" instead
   * of rendering a confident 0. `total`, `createdThisMonth` and
   * `createdLast7Days` come from `projects` and stay real numbers.
   */
  metrics as (
    select jsonb_build_object(
      'total', count(*),
      'createdThisMonth', count(*) filter (
        where created_at >= v_month_start and created_at < v_now
      ),
      'createdLast7Days', count(*) filter (
        where created_at >= v_now - interval '7 days' and created_at < v_now
      ),
      'published', case
        when v_publication_available then count(*) filter (
          where has_active_version or has_legacy_ready_deployment
        )
        else null
      end,
      'verifiedMavlyDomains', case
        when v_publication_available then count(*) filter (
          where (has_active_version or has_legacy_ready_deployment)
            and mavly_domain_status = 'verified'
            and mavly_hostname = (lower(project_id) || '.mavly.xyz')
            and mavly_hostname is not null
        )
        else null
      end
    ) as value
    from classified
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
    ), '[]'::jsonb),
    (select value from metrics)
  into v_total, v_rows, v_metrics;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'page', v_page,
    'pageSize', v_page_size,
    'status', v_status,
    'visibility', v_visibility,
    'metrics', v_metrics,
    'publicationState', case
      when v_publication_available then 'available'
      else 'schema_missing'
    end,
    'generatedAt', v_now
  );
end;
$$;

comment on function public.admin_project_directory_v46(text, text, text, integer, integer) is
  'Admin-only read-only project directory. Publication state is read only when migration 14''s project_published_versions table is installed; otherwise it is reported as schema_missing with null publication metrics, never as zero published.';

revoke all on function public.admin_project_directory_v46(text, text, text, integer, integer)
  from public, anon, authenticated;

-- ── 2. The public wrapper keeps the same signature and the same admin gate ──
--
-- Migration 44's wrapper renamed the original into `admin_project_directory_v41`
-- and re-applied the truthful-name correction on top. This wrapper does the same
-- job over the v46 implementation, so names stay null when unrecorded and the
-- caller-facing contract is unchanged.

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
  v_result jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null or not public.current_user_is_admin() then
    raise exception 'admin_project_directory: not authorized' using errcode = '42501';
  end if;

  v_result := public.admin_project_directory_v46(
    p_search, p_status, p_visibility, p_page, p_page_size
  );

  select coalesce(
    jsonb_agg(
      jsonb_set(
        jsonb_set(
          entry.value,
          '{name}',
          coalesce(to_jsonb(nullif(btrim(project.label), '')), 'null'::jsonb),
          true
        ),
        '{owner}',
        coalesce(to_jsonb(names.full_name), 'null'::jsonb),
        true
      )
      order by entry.ordinal
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(coalesce(v_result -> 'rows', '[]'::jsonb))
    with ordinality as entry(value, ordinal)
  join public.projects project
    on project.project_id = entry.value ->> 'id'
  join auth.users auth_user
    on auth_user.id = project.user_id
  left join public.profiles profile
    on profile.id = auth_user.id
  cross join lateral (
    select coalesce(
      nullif(btrim(profile.full_name), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(auth_user.raw_user_meta_data ->> 'name'), '')
    ) as full_name
  ) names;

  return jsonb_set(v_result, '{rows}', v_rows, true);
end;
$$;

comment on function public.admin_project_directory(text, text, text, integer, integer) is
  'Admin-only read-only project directory. Project/owner names are null when no name is recorded. Publication state is reported as schema_missing when migration 14 is not installed.';

revoke all on function public.admin_project_directory(text, text, text, integer, integer)
  from public, anon;
grant execute on function public.admin_project_directory(text, text, text, integer, integer)
  to authenticated;

-- ── 3. A diagnostic that names the exact missing relation ───────────────────
--
-- The route can only classify a SQLSTATE. This function answers "which relation
-- is actually absent" from the database itself, so an operator never has to
-- guess between migrations 03, 07 and 14.

create or replace function public.admin_directory_schema_report()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'projects', to_regclass('public.projects') is not null,
    'profiles', to_regclass('public.profiles') is not null,
    'projectRuns', to_regclass('public.project_runs') is not null,
    'projectDeployments', to_regclass('public.project_deployments') is not null,
    'projectPublishedVersions', to_regclass('public.project_published_versions') is not null,
    'adminAllowlist', to_regclass('public.admin_allowlist') is not null,
    'creditAccounts', to_regclass('public.credit_accounts') is not null,
    'adminGate', to_regprocedure('public.current_user_is_admin()') is not null,
    'projectDirectoryRpc',
      to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') is not null,
    'userDirectoryRpc',
      to_regprocedure('public.admin_user_directory(text,text,integer,integer)') is not null,
    'publicationState', case
      when to_regclass('public.project_published_versions') is not null then 'available'
      else 'schema_missing'
    end,
    'missingPrerequisites', (
      select coalesce(jsonb_agg(entry), '[]'::jsonb)
      from (
        select 'public.project_runs (migration 03)' as entry
        where to_regclass('public.project_runs') is null
        union all
        select 'public.project_deployments (migration 07)'
        where to_regclass('public.project_deployments') is null
        union all
        select 'public.profiles (migration 01)'
        where to_regclass('public.profiles') is null
        union all
        select 'public.admin_allowlist (migration 18)'
        where to_regclass('public.admin_allowlist') is null
      ) missing
    ),
    'optionalAbsent', (
      select coalesce(jsonb_agg(entry), '[]'::jsonb)
      from (
        select 'public.project_published_versions (migration 14 — required only for shared hosting)' as entry
        where to_regclass('public.project_published_versions') is null
        union all
        select 'public.credit_accounts (migration 31 — required only for credit balances)'
        where to_regclass('public.credit_accounts') is null
      ) optional
    )
  );
$$;

comment on function public.admin_directory_schema_report() is
  'Admin-only read-only report of which relations the admin directories need, which are present, and which absent relations are required versus optional.';

revoke all on function public.admin_directory_schema_report() from public, anon;
grant execute on function public.admin_directory_schema_report() to authenticated;

-- ── 4. Schema marker ────────────────────────────────────────────────────────

create or replace function public.admin_directory_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 46;
$$;

revoke all on function public.admin_directory_schema_version() from public, anon;
grant execute on function public.admin_directory_schema_version()
  to authenticated, service_role;

comment on function public.admin_directory_schema_version() is
  'Admin directory schema marker. 46 means the project directory tolerates a missing publication table and admin_directory_schema_report() is installed.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION (run after applying; changes nothing)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- 1. Which relations are present, and which absences are optional?
--   select public.admin_directory_schema_report();
--
--   -- 2. Is the new implementation installed and is the wrapper the public one?
--   select p.proname,
--          pg_get_function_identity_arguments(p.oid) as args,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('admin_project_directory',
--                       'admin_project_directory_v41',
--                       'admin_project_directory_v46')
--   order by p.proname;
--
--   -- 3. Row counts prove no customer data moved.
--   select 'projects' as object, count(*) from public.projects
--   union all select 'project_runs', count(*) from public.project_runs
--   union all select 'project_deployments', count(*) from public.project_deployments;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This migration creates no table and deletes no row, so rollback is a function
-- swap back to migration 44's wrapper:
--
--   begin;
--   create or replace function public.admin_project_directory(
--     p_search text default null, p_status text default 'all',
--     p_visibility text default 'all', p_page integer default 1,
--     p_page_size integer default 10
--   ) returns jsonb language plpgsql stable security definer set search_path = ''
--   as $rb$
--   declare v_result jsonb; v_rows jsonb;
--   begin
--     if auth.uid() is null or not public.current_user_is_admin() then
--       raise exception 'admin_project_directory: not authorized' using errcode = '42501';
--     end if;
--     v_result := public.admin_project_directory_v41(
--       p_search, p_status, p_visibility, p_page, p_page_size);
--     select coalesce(jsonb_agg(jsonb_set(jsonb_set(entry.value, '{name}',
--         coalesce(to_jsonb(nullif(btrim(project.label), '')), 'null'::jsonb), true),
--         '{owner}', coalesce(to_jsonb(names.full_name), 'null'::jsonb), true)
--       order by entry.ordinal), '[]'::jsonb)
--     into v_rows
--     from jsonb_array_elements(coalesce(v_result -> 'rows', '[]'::jsonb))
--       with ordinality as entry(value, ordinal)
--     join public.projects project on project.project_id = entry.value ->> 'id'
--     join auth.users auth_user on auth_user.id = project.user_id
--     left join public.profiles profile on profile.id = auth_user.id
--     cross join lateral (select coalesce(
--       nullif(btrim(profile.full_name), ''),
--       nullif(btrim(auth_user.raw_user_meta_data ->> 'full_name'), ''),
--       nullif(btrim(auth_user.raw_user_meta_data ->> 'name'), '')) as full_name) names;
--     return jsonb_set(v_result, '{rows}', v_rows, true);
--   end; $rb$;
--   commit;
--
-- ⚠️ Rolling back restores the 42P01 failure on a database without migration 14.
-- The correct forward action for that database is to apply migration 14.
-- ═══════════════════════════════════════════════════════════════════════════
