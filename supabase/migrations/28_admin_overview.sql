-- Mavly — admin Overview aggregates (read-only)
--
-- The Overview page runs under the caller's RLS-scoped Supabase client, and every
-- child table is owner-scoped. Cross-user counts therefore cannot be read directly
-- without a service-role client in a route. Instead this migration adds two
-- SECURITY DEFINER functions that:
--
--   * refuse unless public.current_user_is_admin() is true for the CALLER;
--   * run with an empty search_path and fully qualified names;
--   * only SELECT (no mutation, no storage, no provider call);
--   * are executable by `authenticated` (the function gate is the authority) but
--     never by `anon` or PUBLIC.
--
-- No rows are fabricated and no financial data is invented. The deployment has no
-- Mavly subscription/invoice/credit-ledger table, so revenue and billing are not
-- computed here at all.
--
-- Additive and idempotent. Apply after migration 18 (allowlist) and 10 (run stages);
-- the cost columns from migration 16 are read through to_jsonb() so the functions
-- still work on a database where the durable worker has not been enabled yet.

begin;

-- ── 1. Indexes for the Overview's actual query shapes ───────────────────────

create index if not exists project_runs_started_at_idx
  on public.project_runs (started_at desc);

create index if not exists project_runs_stage_started_idx
  on public.project_runs (stage, started_at desc);

create index if not exists project_runs_model_used_idx
  on public.project_runs (model_used)
  where model_used is not null;

create index if not exists projects_created_at_idx
  on public.projects (created_at desc);

-- ── 2. Overview aggregate ────────────────────────────────────────────────────
--
-- Definitions (kept explicit so the UI copy can match them):
--   users.total       registered auth.users rows (not a join of projects)
--   users.new         auth.users created inside the selected window
--   runs.completed    stage = 'completed'
--   runs.failed       stage = 'failed'
--   runs.cancelled    stage = 'cancelled'
--   runs.interrupted  stage = 'interrupted' (recovery closed it without completing)
--   runs.active       stage in queued/validating/generating/retrying/retry_wait
--   runs.successRate  completed / (completed + failed + cancelled + interrupted), NULL if none
--   usage.tokens      sum(total_tokens) over runs started in the window
--   usage.costUsd     sum(reported_cost_usd) where cost_known, in USD
--   queue.*           current (not period-scoped) run backlog

create or replace function public.admin_overview(p_period text default '30d')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_start timestamptz;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
  v_span interval;
  v_users_total bigint;
  v_users_new bigint;
  v_users_prev bigint;
  v_projects_total bigint;
  v_projects_new bigint;
  v_runs jsonb;
  v_prev_completed bigint;
  v_prev_failed bigint;
  v_prev_cancelled bigint;
  v_prev_interrupted bigint;
  v_usage jsonb;
  v_models jsonb;
  v_queue jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_overview: not authorized' using errcode = '42501';
  end if;

  if p_period is null or p_period not in ('7d', '30d', '3m', 'ytd') then
    raise exception 'admin_overview: invalid period' using errcode = '22023';
  end if;

  v_start := case p_period
    when '7d' then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    when '3m' then v_now - interval '90 days'
    else (date_trunc('year', v_now at time zone 'UTC') at time zone 'UTC')
  end;
  v_prev_end := v_start;
  v_span := v_now - v_start;
  v_prev_start := v_start - v_span;

  select count(*) into v_users_total from auth.users;
  select count(*) into v_users_new
    from auth.users
    where created_at >= v_start and created_at < v_now;
  select count(*) into v_users_prev
    from auth.users
    where created_at >= v_prev_start and created_at < v_prev_end;

  select count(*) into v_projects_total from public.projects;
  select count(*) into v_projects_new
    from public.projects
    where created_at >= v_start and created_at < v_now;

  select jsonb_build_object(
    'total', count(*),
    'completed', count(*) filter (where stage = 'completed'),
    'failed', count(*) filter (where stage = 'failed'),
    'cancelled', count(*) filter (where stage = 'cancelled'),
    'interrupted', count(*) filter (where stage = 'interrupted'),
    'active', count(*) filter (
      where stage in ('queued', 'validating', 'generating', 'retrying', 'retry_wait')
    ),
    'successRate', case
      when count(*) filter (
        where stage in ('completed', 'failed', 'cancelled', 'interrupted')
      ) = 0 then null
      else round(
        100.0 * count(*) filter (where stage = 'completed')
          / count(*) filter (where stage in ('completed', 'failed', 'cancelled', 'interrupted')),
        1
      )
    end
  )
  into v_runs
  from public.project_runs
  where started_at >= v_start and started_at < v_now;

  select
    count(*) filter (where stage = 'completed'),
    count(*) filter (where stage = 'failed'),
    count(*) filter (where stage = 'cancelled'),
    count(*) filter (where stage = 'interrupted')
  into v_prev_completed, v_prev_failed, v_prev_cancelled, v_prev_interrupted
  from public.project_runs
  where started_at >= v_prev_start and started_at < v_prev_end;

  select jsonb_build_object(
    'tokens', coalesce(sum(r.total_tokens), 0),
    'costUsd', coalesce(sum(
      case
        when coalesce((to_jsonb(r) ->> 'cost_known')::boolean, false)
          then coalesce((to_jsonb(r) ->> 'reported_cost_usd')::numeric, 0)
        else 0
      end
    ), 0),
    'costKnownRuns', count(*) filter (
      where coalesce((to_jsonb(r) ->> 'cost_known')::boolean, false)
        and (to_jsonb(r) ->> 'reported_cost_usd') is not null
    )
  )
  into v_usage
  from public.project_runs r
  where r.started_at >= v_start and r.started_at < v_now;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'model', s.model,
        'runs', s.runs,
        'completed', s.completed,
        'failed', s.failed,
        'tokens', s.tokens,
        'costUsd', s.cost_usd,
        'costKnownRuns', s.cost_known_runs
      )
      order by s.runs desc, s.model asc
    ),
    '[]'::jsonb
  )
  into v_models
  from (
    select
      coalesce(nullif(r.model_used, ''), r.model, 'unknown') as model,
      count(*) as runs,
      count(*) filter (where r.stage = 'completed') as completed,
      count(*) filter (where r.stage = 'failed') as failed,
      coalesce(sum(r.total_tokens), 0) as tokens,
      coalesce(sum(
        case
          when coalesce((to_jsonb(r) ->> 'cost_known')::boolean, false)
            then coalesce((to_jsonb(r) ->> 'reported_cost_usd')::numeric, 0)
          else 0
        end
      ), 0) as cost_usd,
      count(*) filter (
        where coalesce((to_jsonb(r) ->> 'cost_known')::boolean, false)
          and (to_jsonb(r) ->> 'reported_cost_usd') is not null
      ) as cost_known_runs
    from public.project_runs r
    where r.started_at >= v_start and r.started_at < v_now
    group by coalesce(nullif(r.model_used, ''), r.model, 'unknown')
    order by count(*) desc
    limit 20
  ) s;

  select jsonb_build_object(
    'queued', count(*) filter (where stage = 'queued'),
    'running', count(*) filter (
      where stage in ('validating', 'generating', 'retrying', 'retry_wait')
    ),
    'staleLeases', count(*) filter (
      where stage in ('validating', 'generating', 'retrying', 'retry_wait')
        and coalesce(heartbeat_at, started_at) < v_now - interval '5 minutes'
    ),
    'oldestQueuedAt', (min(started_at) filter (where stage = 'queued'))
  )
  into v_queue
  from public.project_runs
  where stage in ('queued', 'validating', 'generating', 'retrying', 'retry_wait');

  return jsonb_build_object(
    'generatedAt', v_now,
    'period', p_period,
    'window', jsonb_build_object(
      'start', v_start,
      'end', v_now,
      'previousStart', v_prev_start,
      'previousEnd', v_prev_end
    ),
    'users', jsonb_build_object(
      'total', v_users_total,
      'new', v_users_new,
      'previousNew', v_users_prev
    ),
    'projects', jsonb_build_object(
      'total', v_projects_total,
      'new', v_projects_new
    ),
    'runs', v_runs || jsonb_build_object(
      'previousCompleted', v_prev_completed,
      'previousFailed', v_prev_failed,
      'previousCancelled', v_prev_cancelled,
      'previousInterrupted', v_prev_interrupted
    ),
    'usage', v_usage,
    'models', v_models,
    'queue', v_queue,
    'billing', jsonb_build_object('configured', false)
  );
end;
$$;

comment on function public.admin_overview(text) is
  'Admin-only, read-only Overview aggregate. Returns registered users, projects, run outcomes, token/cost usage, model breakdown and the current queue backlog for the selected period. No revenue is computed because no Mavly billing table exists.';

revoke all on function public.admin_overview(text) from public;
revoke all on function public.admin_overview(text) from anon;
grant execute on function public.admin_overview(text) to authenticated;
grant execute on function public.admin_overview(text) to service_role;

-- ── 3. Generation stream (server-side search, filter and pagination) ─────────

create or replace function public.admin_generation_stream(
  p_status text default 'all',
  p_search text default null,
  p_limit integer default 10,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'all');
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_generation_stream: not authorized' using errcode = '42501';
  end if;

  if v_status not in ('all', 'completed', 'running', 'queued', 'failed') then
    raise exception 'admin_generation_stream: invalid status' using errcode = '22023';
  end if;

  with filtered as (
    select
      r.id,
      r.project_id,
      p.label as project_label,
      coalesce(nullif(pr.full_name, ''), u.email, 'Unknown owner') as owner_name,
      u.email as owner_email,
      coalesce(nullif(r.model_used, ''), r.model, 'unknown') as model,
      r.stage,
      case
        when r.stage = 'completed' then 'completed'
        when r.stage = 'failed' then 'failed'
        when r.stage = 'cancelled' then 'cancelled'
        when r.stage = 'interrupted' then 'interrupted'
        when r.stage = 'queued' then 'queued'
        else 'running'
      end as display_status,
      r.started_at,
      r.finished_at,
      r.total_tokens,
      r.attempt_count,
      r.error_code
    from public.project_runs r
    join public.projects p on p.project_id = r.project_id
    join auth.users u on u.id = p.user_id
    left join public.profiles pr on pr.id = p.user_id
    where (
      v_status = 'all'
      or (v_status = 'completed' and r.stage = 'completed')
      or (v_status = 'failed' and r.stage in ('failed', 'interrupted'))
      or (v_status = 'queued' and r.stage = 'queued')
      or (v_status = 'running' and r.stage in ('validating', 'generating', 'retrying', 'retry_wait'))
    )
    and (
      v_search is null
      or r.project_id ilike '%' || v_search || '%'
      or coalesce(p.label, '') ilike '%' || v_search || '%'
      or coalesce(nullif(r.model_used, ''), r.model, '') ilike '%' || v_search || '%'
      or coalesce(u.email, '') ilike '%' || v_search || '%'
      or coalesce(pr.full_name, '') ilike '%' || v_search || '%'
    )
  ),
  page as (
    select *
    from filtered
    order by started_at desc
    limit v_limit
    offset v_offset
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'projectId', page.project_id,
          'projectLabel', page.project_label,
          'ownerName', page.owner_name,
          'ownerEmail', page.owner_email,
          'model', page.model,
          'stage', page.stage,
          'status', page.display_status,
          'startedAt', page.started_at,
          'finishedAt', page.finished_at,
          'tokens', page.total_tokens,
          'attempts', page.attempt_count,
          'errorCode', page.error_code
        )
        order by page.started_at desc
      )
      from page
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'status', v_status,
    'search', v_search
  );
end;
$$;

comment on function public.admin_generation_stream(text, text, integer, integer) is
  'Admin-only generation operations page: server-side status filter, project/owner/model search and bounded pagination over public.project_runs. Read-only.';

revoke all on function public.admin_generation_stream(text, text, integer, integer) from public;
revoke all on function public.admin_generation_stream(text, text, integer, integer) from anon;
grant execute on function public.admin_generation_stream(text, text, integer, integer) to authenticated;
grant execute on function public.admin_generation_stream(text, text, integer, integer) to service_role;

commit;
