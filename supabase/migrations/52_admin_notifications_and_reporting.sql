-- Mavly — persistent admin notifications and India-timezone reporting windows.
--
-- Apply after migration 51. This migration is additive and deliberately does not
-- create any billing event. The current repository has no Mavly platform
-- subscription/payment source; customer-app Razorpay rows are a separate domain.
-- Signup notifications are written by the existing auth.users trigger, while
-- future trusted server billing paths may use record_admin_notification().

begin;

-- ── 1. Reporting window authority ────────────────────────────────────────────
--
-- All admin period aggregates use this helper. The boundary timezone is fixed to
-- Asia/Kolkata so a report does not change day/month merely because the database
-- session or application host uses another timezone.

create or replace function public.admin_reporting_window(
  p_period text,
  p_now timestamptz default now()
)
returns table (
  start_at timestamptz,
  end_at timestamptz,
  previous_start_at timestamptz,
  previous_end_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_period text := lower(btrim(coalesce(p_period, '')));
  v_now timestamptz := coalesce(p_now, now());
  v_local_date date := (v_now at time zone 'Asia/Kolkata')::date;
  v_local_month_start timestamp := date_trunc('month', v_now at time zone 'Asia/Kolkata');
  v_start timestamptz;
  v_span interval;
begin
  if v_period not in ('7d', '30d', '3m', 'ytd') then
    raise exception 'admin_reporting_window: invalid period' using errcode = '22023';
  end if;

  v_start := case v_period
    -- Seven/30 days means seven/30 India calendar dates including today.
    when '7d' then ((v_local_date - 6)::timestamp at time zone 'Asia/Kolkata')
    when '30d' then ((v_local_date - 29)::timestamp at time zone 'Asia/Kolkata')
    -- Three calendar months including the current, partially elapsed month.
    when '3m' then ((v_local_month_start - interval '2 months') at time zone 'Asia/Kolkata')
    else (date_trunc('year', v_now at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
  end;

  v_span := v_now - v_start;
  return query
    select v_start, v_now, v_start - v_span, v_start;
end;
$$;

comment on function public.admin_reporting_window(text, timestamptz) is
  'Internal admin reporting window authority. All four periods use Asia/Kolkata calendar boundaries.';

revoke all on function public.admin_reporting_window(text, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_reporting_window(text, timestamptz) to service_role;

-- ── 2. Persistent notifications ─────────────────────────────────────────────

create table if not exists public.admin_notifications (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  title text not null,
  message text not null,
  user_id uuid references auth.users (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  deduplication_key text unique,
  constraint admin_notifications_event_type_check
    check (event_type in (
      'user_signup',
      'plan_purchase',
      'plan_upgrade',
      'plan_renewal',
      'plan_downgrade',
      'subscription_cancelled',
      'subscription_expired',
      'payment_failed',
      'refund_completed'
    )),
  constraint admin_notifications_title_len
    check (char_length(btrim(title)) between 1 and 160),
  constraint admin_notifications_message_len
    check (char_length(btrim(message)) between 1 and 2000),
  constraint admin_notifications_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.admin_notifications is
  'Server-authored admin event notifications. Direct client writes are forbidden; admin reads are protected by current_user_is_admin().';
comment on column public.admin_notifications.deduplication_key is
  'Stable trusted event id. A unique value makes webhook retries and trigger replays idempotent.';

create index if not exists admin_notifications_created_idx
  on public.admin_notifications (created_at desc, id desc);
create index if not exists admin_notifications_unread_idx
  on public.admin_notifications (created_at desc, id desc)
  where read_at is null;
create index if not exists admin_notifications_event_type_idx
  on public.admin_notifications (event_type, created_at desc);

alter table public.admin_notifications enable row level security;
alter table public.admin_notifications replica identity full;
revoke all on public.admin_notifications from public, anon;
revoke insert, update, delete, truncate on public.admin_notifications from authenticated;
grant select on public.admin_notifications to authenticated;
grant select, insert, update, delete on public.admin_notifications to service_role;

drop policy if exists admin_notifications_select_admin on public.admin_notifications;
create policy admin_notifications_select_admin
  on public.admin_notifications
  for select
  to authenticated
  using (public.current_user_is_admin());

-- Supabase Realtime is optional on local/self-hosted installs. When its standard
-- publication exists, add this table once; the API remains the source of the
-- initial history and works even when Realtime is unavailable.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication p
       join pg_publication_rel pr on pr.prpubid = p.oid
       join pg_class c on c.oid = pr.prrelid
       join pg_namespace n on n.oid = c.relnamespace
       where p.pubname = 'supabase_realtime'
         and n.nspname = 'public'
         and c.relname = 'admin_notifications'
     ) then
    alter publication supabase_realtime add table public.admin_notifications;
  end if;
end;
$$;

-- Trusted write boundary. This is not executable by authenticated callers; the
-- auth trigger and a future server-side verified billing path are the only
-- intended callers. The unique key is enforced by PostgreSQL, not the browser.
create or replace function public.record_admin_notification(
  p_event_type text,
  p_title text,
  p_message text,
  p_user_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_deduplication_key text default null,
  p_created_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_event_type text := lower(btrim(coalesce(p_event_type, '')));
  v_title text := btrim(coalesce(p_title, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  if v_event_type not in (
    'user_signup',
    'plan_purchase',
    'plan_upgrade',
    'plan_renewal',
    'plan_downgrade',
    'subscription_cancelled',
    'subscription_expired',
    'payment_failed',
    'refund_completed'
  ) then
    raise exception 'record_admin_notification: invalid event type' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 160
     or char_length(v_message) not between 1 and 2000
     or jsonb_typeof(v_metadata) <> 'object' then
    raise exception 'record_admin_notification: invalid notification payload' using errcode = '22023';
  end if;

  insert into public.admin_notifications (
    event_type, title, message, user_id, metadata, created_at, deduplication_key
  ) values (
    v_event_type,
    v_title,
    v_message,
    p_user_id,
    v_metadata,
    coalesce(p_created_at, now()),
    nullif(btrim(p_deduplication_key), '')
  )
  on conflict (deduplication_key) do nothing
  returning id into v_id;

  if v_id is null and nullif(btrim(p_deduplication_key), '') is not null then
    select n.id
      into v_id
      from public.admin_notifications n
     where n.deduplication_key = nullif(btrim(p_deduplication_key), '');
  end if;

  return v_id;
end;
$$;

comment on function public.record_admin_notification(text, text, text, uuid, jsonb, text, timestamptz) is
  'Trusted server-side admin notification insert. Deduplicates on the stable event key and never accepts browser authorization claims.';

revoke all on function public.record_admin_notification(text, text, text, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_admin_notification(text, text, text, uuid, jsonb, text, timestamptz)
  to service_role;

-- The existing auth trigger remains the source of truth for signup. Extend its
-- function rather than adding a second auth.users trigger, which avoids duplicate
-- profile/notification work and keeps the event in the signup transaction.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(btrim(new.email), '');
  v_provider text := nullif(
    coalesce(
      new.raw_app_meta_data ->> 'provider',
      new.raw_user_meta_data ->> 'provider'
    ),
    ''
  );
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    nullif(
      coalesce(
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name'
      ),
      ''
    ),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now();

  perform public.record_admin_notification(
    'user_signup',
    'New User Registered',
    case
      when v_email is null then 'A new user has successfully registered on Mavly.'
      else format('A new user %s has joined Mavly.', v_email)
    end,
    new.id,
    jsonb_build_object(
      'eventType', 'user_signup',
      'userId', new.id,
      'email', v_email,
      'registeredAt', new.created_at,
      'provider', v_provider
    ),
    format('user_signup:%s', new.id),
    new.created_at
  );

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ── 3. Admin notification read API ──────────────────────────────────────────

create or replace function public.admin_notifications_page(
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total bigint;
  v_unread bigint;
  v_has_more boolean;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_notifications_page: not authorized' using errcode = '42501';
  end if;

  select count(*) into v_total from public.admin_notifications;
  select count(*) into v_unread
    from public.admin_notifications
   where read_at is null;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page.id,
      'eventType', page.event_type,
      'title', page.title,
      'message', page.message,
      'userId', page.user_id,
      'metadata', page.metadata,
      'createdAt', page.created_at,
      'readAt', page.read_at
    ) order by page.created_at desc, page.id desc
  ), '[]'::jsonb)
  into v_rows
  from (
    select n.id, n.event_type, n.title, n.message, n.user_id, n.metadata,
           n.created_at, n.read_at
      from public.admin_notifications n
     order by n.created_at desc, n.id desc
     limit v_limit offset v_offset
  ) page;

  select exists (
    select 1
      from public.admin_notifications n
     order by n.created_at desc, n.id desc
     limit 1 offset (v_offset + v_limit)
  ) into v_has_more;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'unreadCount', coalesce(v_unread, 0),
    'limit', v_limit,
    'offset', v_offset,
    'hasMore', coalesce(v_has_more, false)
  );
end;
$$;

comment on function public.admin_notifications_page(integer, integer) is
  'Admin-only paginated notification history and unread count.';

revoke all on function public.admin_notifications_page(integer, integer) from public, anon;
grant execute on function public.admin_notifications_page(integer, integer) to authenticated, service_role;

create or replace function public.admin_notifications_mark_read(p_notification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unread bigint;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_notifications_mark_read: not authorized' using errcode = '42501';
  end if;

  update public.admin_notifications
     set read_at = coalesce(read_at, now())
   where id = p_notification_id;

  select count(*) into v_unread
    from public.admin_notifications
   where read_at is null;

  return jsonb_build_object('unreadCount', coalesce(v_unread, 0));
end;
$$;

revoke all on function public.admin_notifications_mark_read(uuid) from public, anon;
grant execute on function public.admin_notifications_mark_read(uuid) to authenticated, service_role;

create or replace function public.admin_notifications_mark_all_read()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_notifications_mark_all_read: not authorized' using errcode = '42501';
  end if;

  update public.admin_notifications
     set read_at = now()
   where read_at is null;

  return jsonb_build_object('unreadCount', 0);
end;
$$;

revoke all on function public.admin_notifications_mark_all_read() from public, anon;
grant execute on function public.admin_notifications_mark_all_read() to authenticated, service_role;

-- Optional bounded retention. It is service-role-only and removes only already
-- read rows, so an unread event cannot disappear during a pending admin review.
create or replace function public.cleanup_admin_notifications(p_retention_days integer default 180)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted bigint;
  v_days integer := least(greatest(coalesce(p_retention_days, 180), 30), 3650);
begin
  if auth.role() <> 'service_role' then
    raise exception 'cleanup_admin_notifications: not authorized' using errcode = '42501';
  end if;

  delete from public.admin_notifications
   where read_at is not null
     and created_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.cleanup_admin_notifications(integer) from public, anon, authenticated;
grant execute on function public.cleanup_admin_notifications(integer) to service_role;

create or replace function public.admin_notifications_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 52;
$$;

revoke all on function public.admin_notifications_schema_version() from public, anon;
grant execute on function public.admin_notifications_schema_version() to authenticated, service_role;

-- ── 4. Replace the two period aggregates with the shared window authority ────

create or replace function public.admin_overview(p_period text default '30d')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_start timestamptz;
  v_prev_start timestamptz;
  v_prev_end timestamptz;
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

  select w.start_at, w.end_at, w.previous_start_at, w.previous_end_at
    into v_start, v_now, v_prev_start, v_prev_end
    from public.admin_reporting_window(p_period, now()) w;

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
      ) order by s.runs desc, s.model asc
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
    'oldestQueuedAt', min(started_at) filter (where stage = 'queued')
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
  'Admin-only Overview aggregate. Periods use Asia/Kolkata calendar boundaries; billing remains unavailable without a Mavly platform source.';

revoke all on function public.admin_overview(text) from public, anon;
grant execute on function public.admin_overview(text) to authenticated, service_role;

create or replace function public.admin_ai_usage(
  p_period text default '30d',
  p_model text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_start timestamptz;
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_summary jsonb;
  v_models jsonb;
  v_total bigint;
  v_attempts jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_ai_usage: not authorized' using errcode = '42501';
  end if;

  select w.start_at, w.end_at
    into v_start, v_now
    from public.admin_reporting_window(p_period, now()) w;

  with runs as (
    select
      r.id,
      r.stage,
      coalesce(nullif(r.model_used, ''), nullif(r.model, ''), 'unknown') as model,
      coalesce(r.total_tokens, 0)::bigint as tokens,
      coalesce(r.prompt_tokens, 0)::bigint as prompt_tokens,
      coalesce(r.completion_tokens, 0)::bigint as completion_tokens,
      r.reported_cost_usd,
      r.cost_known,
      r.started_at,
      r.finished_at,
      case
        when r.finished_at is not null and r.started_at is not null
          then extract(epoch from (r.finished_at - r.started_at))
        else null
      end as duration_seconds
    from public.project_runs r
   where r.started_at >= v_start and r.started_at < v_now
  )
  select jsonb_build_object(
    'requests', count(*),
    'completed', count(*) filter (where stage = 'completed'),
    'failed', count(*) filter (where stage in ('failed', 'interrupted')),
    'cancelled', count(*) filter (where stage = 'cancelled'),
    'active', count(*) filter (
      where stage in ('queued', 'validating', 'generating', 'retrying', 'retry_wait')
    ),
    'tokens', coalesce(sum(tokens), 0),
    'promptTokens', coalesce(sum(prompt_tokens), 0),
    'completionTokens', coalesce(sum(completion_tokens), 0),
    'costUsd', coalesce(sum(reported_cost_usd) filter (where cost_known), 0),
    'costKnownRuns', count(*) filter (where cost_known),
    'costUnknownRuns', count(*) filter (where not cost_known),
    'durationP50', percentile_cont(0.5) within group (order by duration_seconds),
    'durationP95', percentile_cont(0.95) within group (order by duration_seconds)
  )
  into v_summary
  from runs;

  with runs as (
    select
      coalesce(nullif(r.model_used, ''), nullif(r.model, ''), 'unknown') as model,
      r.stage,
      coalesce(r.total_tokens, 0)::bigint as tokens,
      coalesce(r.prompt_tokens, 0)::bigint as prompt_tokens,
      coalesce(r.completion_tokens, 0)::bigint as completion_tokens,
      r.reported_cost_usd,
      r.cost_known,
      case
        when r.finished_at is not null and r.started_at is not null
          then extract(epoch from (r.finished_at - r.started_at))
        else null
      end as duration_seconds
    from public.project_runs r
   where r.started_at >= v_start and r.started_at < v_now
  ),
  grouped as (
    select
      model,
      count(*) as requests,
      count(*) filter (where stage = 'completed') as completed,
      count(*) filter (where stage in ('failed', 'interrupted')) as failed,
      coalesce(sum(tokens), 0) as tokens,
      coalesce(sum(prompt_tokens), 0) as prompt_tokens,
      coalesce(sum(completion_tokens), 0) as completion_tokens,
      coalesce(sum(reported_cost_usd) filter (where cost_known), 0) as cost_usd,
      count(*) filter (where cost_known) as cost_known_runs,
      count(*) filter (where not cost_known) as cost_unknown_runs,
      percentile_cont(0.5) within group (order by duration_seconds) as p50,
      percentile_cont(0.95) within group (order by duration_seconds) as p95
    from runs
   where v_model is null or model = v_model
   group by model
  )
  select
    coalesce(count(*), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'model', grouped.model,
        'requests', grouped.requests,
        'completed', grouped.completed,
        'failed', grouped.failed,
        'tokens', grouped.tokens,
        'promptTokens', grouped.prompt_tokens,
        'completionTokens', grouped.completion_tokens,
        'costUsd', grouped.cost_usd,
        'costKnownRuns', grouped.cost_known_runs,
        'costUnknownRuns', grouped.cost_unknown_runs,
        'durationP50', grouped.p50,
        'durationP95', grouped.p95
      ) order by grouped.requests desc, grouped.model
    ), '[]'::jsonb)
  into v_total, v_models
  from grouped;

  if to_regclass('public.ai_usage_attempts') is not null then
    execute $q$
      select coalesce(jsonb_agg(row_json order by created_at desc), '[]'::jsonb)
      from (
        select
          a.created_at,
          jsonb_build_object(
            'id', a.id,
            'model', a.model,
            'provider', a.provider,
            'role', a.role,
            'taskKey', a.task_key,
            'attemptIndex', a.attempt_index,
            'promptTokens', a.prompt_tokens,
            'completionTokens', a.completion_tokens,
            'totalTokens', a.total_tokens,
            'usageSource', a.usage_source,
            'estimatedCostUsd', a.estimated_cost_usd,
            'actualCostUsd', a.actual_cost_usd,
            'costSource', a.cost_source,
            'reconciliationStatus', a.reconciliation_status,
            'uncertain', a.uncertain,
            'createdAt', a.created_at
          ) as row_json
        from public.ai_usage_attempts a
       where a.created_at >= $1 and a.created_at < $2
         and ($3 = '' or a.model = $3)
       order by a.created_at desc
       limit $4 offset $5
      ) page
    $q$
    into v_attempts
    using v_start, v_now, coalesce(v_model, ''), v_limit, v_offset;
  else
    v_attempts := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'period', p_period,
    'window', jsonb_build_object('start', v_start, 'end', v_now),
    'summary', v_summary,
    'models', v_models,
    'modelTotal', coalesce(v_total, 0),
    'attempts', v_attempts,
    'attemptsAvailable', to_regclass('public.ai_usage_attempts') is not null
  );
end;
$$;

comment on function public.admin_ai_usage(text, text, integer, integer) is
  'Admin-only AI usage aggregate with the shared Asia/Kolkata reporting windows. Cost is provider-reported only.';

revoke all on function public.admin_ai_usage(text, text, integer, integer) from public, anon;
grant execute on function public.admin_ai_usage(text, text, integer, integer) to authenticated, service_role;

commit;
