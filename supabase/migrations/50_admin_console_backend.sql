-- ═══════════════════════════════════════════════════════════════════════════
-- 50_admin_console_backend.sql — backend for the seven admin console sections
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE. Apply after 49. It creates new tables and new functions and
-- replaces two existing read-only functions with supersets (same call shape).
-- No existing column, policy, grant or row is dropped or retyped.
--
-- ═══ WHAT THIS INSTALLS ═══
--
--   admin_announcements            persisted operator broadcasts
--   admin_audit_log                append-only administrative event trail
--   admin_settings                 runtime-editable operator settings
--
--   admin_credit_ledger()          ledger page + summary (Credits)
--   admin_adjust_credits()         atomic admin credit grant / adjustment
--   admin_ai_usage()               provider/model usage aggregate (AI Usage)
--   admin_generation_summary()     queue + outcome counters (Generation Monitor)
--   admin_generation_stream()      REPLACED: adds the 'cancelled' filter
--   admin_generation_detail()      one run, full operational detail
--   admin_retry_generation_run()   admin re-queue of a terminal failed run
--   admin_announcements_page()     announcement list page
--   admin_announcement_save()      create / update / publish / archive
--   admin_announcement_delete()    delete a draft or archived announcement
--   admin_audit_log_page()         unified audit trail (three real sources)
--   admin_settings_read()          every setting with its true source
--   admin_settings_write()         validated write of a runtime-editable key
--   admin_health_snapshot()        measured queue/worker facts (System Health)
--   active_announcements()         the app-facing published feed
--
-- ═══ TRUST BOUNDARY ═══
--
-- Every admin_* function refuses unless public.current_user_is_admin() is true
-- for the CALLER. Authority is never a header, body, cookie or client flag.
-- Functions run SECURITY DEFINER with an empty search_path and fully qualified
-- names, so a caller cannot shadow anything they reference.
--
-- ⚠️ NOTHING HERE FABRICATES A VALUE. A metric with no source is NULL and the
-- UI says "unavailable". Counts are real aggregates over real rows.
--
-- ⚠️ CREDIT BALANCES ARE NEVER WRITTEN DIRECTLY BY THE ADMIN PATH. Every
-- adjustment goes through admin_adjust_credits(), which writes the account row
-- and exactly one ledger row in the same transaction under the same advisory
-- lock the rest of the credit engine uses. The ledger stays the authority.

begin;

-- ── 1. Schema marker ────────────────────────────────────────────────────────

create or replace function public.admin_console_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 50;
$$;

comment on function public.admin_console_schema_version() is
  'Admin console schema marker. 50 means announcements, audit log, settings and the seven-section read/write RPCs are installed.';

-- ── 2. Announcements ────────────────────────────────────────────────────────

create table if not exists public.admin_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  /** Banner style. Mirrors the console's four visual variants. */
  kind text not null default 'information',
  /** draft | published | archived */
  status text not null default 'draft',
  /** Audience label. Free text so the operator can name a cohort the product
   *  does not model yet; it is never used for authorization. */
  target_plan text not null default 'All Plans',
  dismissible boolean not null default true,
  /** Visibility window. NULL start = immediately; NULL end = no expiry. */
  starts_at timestamptz,
  expires_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint admin_announcements_title_len
    check (char_length(btrim(title)) between 1 and 160),
  constraint admin_announcements_body_len
    check (char_length(btrim(body)) between 1 and 4000),
  constraint admin_announcements_kind_check
    check (kind in ('information', 'success', 'warning', 'maintenance')),
  constraint admin_announcements_status_check
    check (status in ('draft', 'published', 'archived')),
  constraint admin_announcements_target_len
    check (char_length(btrim(target_plan)) between 1 and 80),
  constraint admin_announcements_window_order
    check (expires_at is null or starts_at is null or expires_at > starts_at),
  /** A published row must record when it went live. */
  constraint admin_announcements_published_at_required
    check (status <> 'published' or published_at is not null)
);

comment on table public.admin_announcements is
  'Operator-authored announcements. RLS is enabled with no policies: only the admin SECURITY DEFINER functions read or write it, and the app-facing feed reads through active_announcements().';
comment on column public.admin_announcements.status is
  'draft = not visible; published = eligible for the app feed inside its window; archived = retained but never served.';

create index if not exists admin_announcements_status_idx
  on public.admin_announcements (status, created_at desc);

alter table public.admin_announcements enable row level security;
revoke all on public.admin_announcements from public, anon, authenticated;
grant select, insert, update, delete on public.admin_announcements to service_role;

-- ── 3. Audit log ────────────────────────────────────────────────────────────

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  /** The verified administrator who acted. Never client-supplied. */
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  /** Dotted verb, e.g. 'credits.adjustment', 'announcement.published'. */
  action text not null,
  /** What kind of thing was acted on, e.g. 'user', 'announcement', 'setting'. */
  target_type text not null,
  target_id text,
  /** success | failure */
  outcome text not null default 'success',
  /** Counts, identifiers and before/after values only. Never a secret. */
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_audit_log_action_len
    check (char_length(btrim(action)) between 1 and 120),
  constraint admin_audit_log_target_type_len
    check (char_length(btrim(target_type)) between 1 and 60),
  constraint admin_audit_log_outcome_check
    check (outcome in ('success', 'failure')),
  constraint admin_audit_log_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.admin_audit_log is
  'Append-only administrative event trail. UPDATE and DELETE are refused by trigger; a correction is a new compensating row.';

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc, id desc);
create index if not exists admin_audit_log_action_idx
  on public.admin_audit_log (action, created_at desc);

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from public, anon, authenticated;
grant select, insert on public.admin_audit_log to service_role;

create or replace function public.admin_audit_log_reject_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'ADMIN_AUDIT_LOG_APPEND_ONLY'
    using errcode = 'P0001',
          detail = 'Audit rows cannot be updated or deleted; write a compensating entry.';
end;
$$;

revoke all on function public.admin_audit_log_reject_mutation() from public, anon, authenticated;

drop trigger if exists admin_audit_log_append_only on public.admin_audit_log;
create trigger admin_audit_log_append_only
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_reject_mutation();

-- ── 4. Settings ─────────────────────────────────────────────────────────────

create table if not exists public.admin_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text,
  updated_at timestamptz not null default now(),
  constraint admin_settings_key_shape
    check (key ~ '^[a-z][a-z0-9_.]{1,60}$')
);

comment on table public.admin_settings is
  'Runtime-editable operator settings only. Deployment-managed configuration (model defaults, worker credentials, payment keys) is NOT stored here and is reported read-only by admin_settings_read().';

alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from public, anon, authenticated;
grant select, insert, update on public.admin_settings to service_role;

/**
 * ⚠️ THE REGISTRY IS THE CONTRACT. A key that is not listed here cannot be
 * written, so the settings page can never invent a toggle that persists
 * nothing. `editable = false` rows are deployment-managed and are reported with
 * their real source instead of being stored.
 */
create or replace function public.admin_settings_registry()
returns table (
  key text,
  kind text,
  editable boolean,
  default_value jsonb,
  description text
)
language sql
immutable
set search_path = public, pg_temp
as $$
  values
    ('announcements.enabled', 'boolean', true, 'true'::jsonb,
     'Serve published announcements to the app feed.'),
    ('credits.max_adjustment', 'integer', true, '100000'::jsonb,
     'Largest single credit grant or adjustment an administrator may apply.'),
    ('audit.retention_days', 'integer', true, '90'::jsonb,
     'How far back the audit log page reads. Older rows are retained, not deleted.'),
    ('console.platform_name', 'text', true, '"Mavly"'::jsonb,
     'Platform name shown in the admin console header.'),
    ('console.support_email', 'text', true, '"support@mavly.xyz"'::jsonb,
     'Support address shown in the admin console. Not wired to public pages.');
$$;

comment on function public.admin_settings_registry() is
  'The only writable settings keys, with type and default. Anything not listed is refused by admin_settings_write().';

-- ── 5. Credits: ledger page + summary ───────────────────────────────────────

create index if not exists credit_ledger_created_idx
  on public.credit_ledger (created_at desc, id desc);
create index if not exists credit_ledger_operation_idx
  on public.credit_ledger (operation, created_at desc);

/**
 * One page of the credit ledger plus period-independent summary cards.
 *
 * ⚠️ THE SUMMARY IS DERIVED FROM THE LEDGER, NOT FROM A CACHE. `issued` is the
 * sum of positive grant/adjustment amounts; `consumed` is the absolute sum of
 * generation_consumed rows; `refunded` is the sum of generation_refunded rows;
 * `outstanding` is the live account total. A hold writes amount 0, so it never
 * inflates issued or consumed.
 */
create or replace function public.admin_credit_ledger(
  p_search text default null,
  p_operation text default 'all',
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_operation text := coalesce(nullif(btrim(p_operation), ''), 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
  v_summary jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_credit_ledger: not authorized' using errcode = '42501';
  end if;
  if v_operation not in (
    'all', 'grant', 'admin_adjustment', 'generation_reserved',
    'generation_consumed', 'generation_released', 'generation_refunded'
  ) then
    raise exception 'admin_credit_ledger: invalid operation' using errcode = '22023';
  end if;

  with filtered as (
    select
      l.id,
      l.user_id,
      l.project_id,
      l.run_id,
      l.operation,
      l.amount_credits,
      l.reserved_delta_credits,
      l.balance_after_credits,
      l.reserved_after_credits,
      l.status,
      l.reason,
      l.created_at,
      coalesce(
        nullif(btrim(pr.full_name), ''),
        nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
        'Unknown'
      ) as user_name,
      u.email as user_email
    from public.credit_ledger l
    join auth.users u on u.id = l.user_id
    left join public.profiles pr on pr.id = l.user_id
    where (v_operation = 'all' or l.operation = v_operation)
      and (
        v_search is null
        or strpos(lower(coalesce(u.email, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(pr.full_name, '')), lower(v_search)) > 0
        or strpos(l.id::text, v_search) > 0
        or strpos(lower(coalesce(l.project_id, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(l.reason, '')), lower(v_search)) > 0
      )
  ),
  page_rows as (
    select * from filtered
    order by created_at desc, id desc
    limit v_limit offset v_offset
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page_rows.id,
          'userId', page_rows.user_id,
          'userName', page_rows.user_name,
          'userEmail', page_rows.user_email,
          'projectId', page_rows.project_id,
          'runId', page_rows.run_id,
          'operation', page_rows.operation,
          'amount', page_rows.amount_credits,
          'reservedDelta', page_rows.reserved_delta_credits,
          'balanceAfter', page_rows.balance_after_credits,
          'reservedAfter', page_rows.reserved_after_credits,
          'status', page_rows.status,
          'reason', page_rows.reason,
          'createdAt', page_rows.created_at
        ) order by page_rows.created_at desc, page_rows.id desc
      )
      from page_rows
    ), '[]'::jsonb)
  into v_total, v_rows;

  select jsonb_build_object(
    'issued', coalesce((
      select sum(l.amount_credits) from public.credit_ledger l
      where l.operation in ('grant', 'admin_adjustment') and l.amount_credits > 0
    ), 0),
    'consumed', coalesce((
      select -sum(l.amount_credits) from public.credit_ledger l
      where l.operation = 'generation_consumed'
    ), 0),
    'refunded', coalesce((
      select sum(l.amount_credits) from public.credit_ledger l
      where l.operation = 'generation_refunded'
    ), 0),
    'outstanding', coalesce((
      select sum(a.balance_credits - a.reserved_credits) from public.credit_accounts a
    ), 0),
    'reserved', coalesce((
      select sum(a.reserved_credits) from public.credit_accounts a
    ), 0),
    'wallets', coalesce((
      select count(*) from public.credit_accounts a where a.balance_credits > 0
    ), 0),
    'reversed', coalesce((
      select count(*) from public.credit_ledger l where l.status = 'reversed'
    ), 0),
    'transactions', coalesce((select count(*) from public.credit_ledger), 0)
  ) into v_summary;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'operation', v_operation,
    'search', v_search,
    'summary', v_summary
  );
end;
$$;

comment on function public.admin_credit_ledger(text, text, integer, integer) is
  'Admin-only credit ledger page and ledger-derived summary. Read-only.';

revoke all on function public.admin_credit_ledger(text, text, integer, integer) from public, anon;
grant execute on function public.admin_credit_ledger(text, text, integer, integer) to authenticated, service_role;

/**
 * Atomic administrator credit grant or adjustment.
 *
 * ⚠️ THIS IS THE ONLY ADMIN WRITE PATH TO A BALANCE, and it does exactly what
 * grant_credits() does: take the per-user advisory lock, lock the account row,
 * move the balance, and write exactly one ledger row in the same transaction.
 * The difference is the authority — this one is gated on the CALLER being an
 * administrator rather than on the service role, because the console has no
 * service-role client in the browser.
 *
 * ⚠️ A NEGATIVE ADJUSTMENT CANNOT EAT A HELD RESERVATION. The account invariant
 * is `reserved <= balance`; a debit that would violate it is refused rather
 * than silently releasing another run's hold.
 *
 * ⚠️ THE IDEMPOTENCY KEY IS REQUIRED. A double-submitted form returns the
 * existing row instead of granting twice.
 */
create or replace function public.admin_adjust_credits(
  p_user_id uuid,
  p_amount_credits bigint,
  p_operation text default 'grant',
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 200), '');
  v_operation text := coalesce(nullif(btrim(p_operation), ''), 'grant');
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_max bigint;
  v_existing public.credit_ledger;
  v_account public.credit_accounts;
  v_ledger_id uuid;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_adjust_credits: not authorized' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if p_user_id is null then
    raise exception 'INVALID_CREDIT_ADJUSTMENT' using errcode = '22023';
  end if;
  if v_operation not in ('grant', 'admin_adjustment') then
    raise exception 'INVALID_CREDIT_ADJUSTMENT_OPERATION' using errcode = '22023';
  end if;
  if p_amount_credits is null or p_amount_credits = 0 then
    raise exception 'INVALID_CREDIT_ADJUSTMENT' using errcode = '22023';
  end if;
  if v_operation = 'grant' and p_amount_credits < 1 then
    raise exception 'INVALID_CREDIT_GRANT' using errcode = '22023';
  end if;

  select coalesce((s.value #>> '{}')::bigint, 100000)
  into v_max
  from public.admin_settings s
  where s.key = 'credits.max_adjustment';
  v_max := coalesce(v_max, 100000);

  if abs(p_amount_credits) > v_max then
    raise exception 'CREDIT_ADJUSTMENT_TOO_LARGE'
      using errcode = '22023',
            detail = jsonb_build_object('max', v_max)::text;
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_key := coalesce(v_key, 'admin:' || gen_random_uuid()::text);

  perform pg_advisory_xact_lock(hashtext('mavly:credit:' || p_user_id::text));

  select * into v_existing
  from public.credit_ledger l
  where l.user_id = p_user_id and l.idempotency_key = v_key;

  if found then
    if v_existing.operation not in ('grant', 'admin_adjustment')
      or v_existing.amount_credits <> p_amount_credits then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '22000';
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'ledgerId', v_existing.id,
      'balance', v_existing.balance_after_credits,
      'reserved', v_existing.reserved_after_credits
    );
  end if;

  select * into v_account from public.lock_credit_account(p_user_id);

  if v_account.balance_credits + p_amount_credits < v_account.reserved_credits then
    raise exception 'INSUFFICIENT_CREDITS_FOR_ADJUSTMENT'
      using errcode = 'P0001',
            detail = jsonb_build_object(
              'balance', v_account.balance_credits,
              'reserved', v_account.reserved_credits,
              'amount', p_amount_credits
            )::text;
  end if;

  update public.credit_accounts a
  set balance_credits = a.balance_credits + p_amount_credits,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = p_user_id
  returning * into v_account;

  insert into public.credit_ledger (
    user_id, operation, amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    p_user_id,
    v_operation,
    p_amount_credits,
    0,
    v_account.balance_credits,
    v_account.reserved_credits,
    v_key,
    coalesce(v_reason, 'Administrator credit adjustment'),
    jsonb_build_object('source', 'admin_console', 'actor', v_actor)
  )
  returning id into v_ledger_id;

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor,
    v_actor_email,
    case when v_operation = 'grant' then 'credits.grant' else 'credits.adjustment' end,
    'user',
    p_user_id::text,
    'success',
    jsonb_build_object(
      'amount', p_amount_credits,
      'operation', v_operation,
      'balanceAfter', v_account.balance_credits,
      'reservedAfter', v_account.reserved_credits,
      'ledgerId', v_ledger_id,
      'reason', v_reason
    )
  );

  return jsonb_build_object(
    'status', 'applied',
    'ledgerId', v_ledger_id,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

comment on function public.admin_adjust_credits(uuid, bigint, text, text, text) is
  'Admin-only atomic credit grant/adjustment. Writes the account row and exactly one ledger row under the per-user advisory lock, and records an audit event.';

revoke all on function public.admin_adjust_credits(uuid, bigint, text, text, text) from public, anon;
grant execute on function public.admin_adjust_credits(uuid, bigint, text, text, text) to authenticated, service_role;

-- ── 6. AI usage ─────────────────────────────────────────────────────────────

/**
 * Provider and model usage over a period.
 *
 * ⚠️ COST IS ONLY REPORTED WHERE IT WAS RECORDED. `project_runs.reported_cost_usd`
 * is written only when the provider actually reported a cost, and `cost_known`
 * marks it. A run with no cost is counted in `costUnknownRuns`, never as $0 —
 * zero and unknown are different facts and the UI shows them differently.
 *
 * ⚠️ LATENCY IS RUN DURATION, NOT PROVIDER LATENCY. The database records
 * started_at/finished_at per run; it does not record per-request provider
 * latency. The percentiles here are labelled as run duration so nobody reads a
 * number the platform never measured.
 */
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
  v_now timestamptz := now();
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
  if p_period is null or p_period not in ('7d', '30d', '3m', 'ytd') then
    raise exception 'admin_ai_usage: invalid period' using errcode = '22023';
  end if;

  v_start := case p_period
    when '7d' then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    when '3m' then v_now - interval '90 days'
    else (date_trunc('year', v_now at time zone 'UTC') at time zone 'UTC')
  end;

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

  /**
   * Per-attempt rows exist only once the credit metering has run for a run
   * (migration 31). When the table is absent or empty this returns an empty
   * array and the UI says so, rather than presenting run-level numbers as
   * attempt-level detail.
   */
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
  'Admin-only AI usage aggregate over project_runs, plus per-attempt rows from ai_usage_attempts when that table exists. Cost is reported only where the provider reported it.';

revoke all on function public.admin_ai_usage(text, text, integer, integer) from public, anon;
grant execute on function public.admin_ai_usage(text, text, integer, integer) to authenticated, service_role;

-- ── 7. Generation monitor ───────────────────────────────────────────────────

create or replace function public.admin_generation_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_generation_summary: not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'queued', count(*) filter (where stage = 'queued' and finished_at is null),
    'running', count(*) filter (
      where stage in ('validating', 'generating', 'retrying') and finished_at is null
    ),
    'retryWait', count(*) filter (where stage = 'retry_wait' and finished_at is null),
    'completed', count(*) filter (where stage = 'completed'),
    'failed', count(*) filter (where stage = 'failed'),
    'cancelled', count(*) filter (where stage = 'cancelled'),
    'interrupted', count(*) filter (where stage = 'interrupted'),
    'staleLeases', count(*) filter (
      where finished_at is null
        and lease_expires_at is not null
        and lease_expires_at < now()
    ),
    'deadLettered', count(*) filter (where dead_lettered_at is not null),
    'oldestQueuedAt', min(enqueued_at) filter (where stage = 'queued' and finished_at is null),
    'lastHeartbeatAt', max(heartbeat_at),
    'lastCompletedAt', max(finished_at) filter (where stage = 'completed'),
    'avgDurationSeconds', avg(extract(epoch from (finished_at - started_at)))
      filter (where finished_at is not null and started_at is not null)
  )
  into v_result
  from public.project_runs;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

comment on function public.admin_generation_summary() is
  'Admin-only generation queue and outcome counters over public.project_runs. Read-only.';

revoke all on function public.admin_generation_summary() from public, anon;
grant execute on function public.admin_generation_summary() to authenticated, service_role;

/**
 * REPLACES admin_generation_stream from migration 28 with a superset.
 *
 * The only behavioural change is the added 'cancelled' filter, which the
 * Generation Monitor exposes as its own tab. Every other status, the search
 * fields, the ordering and the response shape are unchanged, so the existing
 * Overview consumer is unaffected.
 */
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

  if v_status not in ('all', 'completed', 'running', 'queued', 'failed', 'cancelled') then
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
      or (v_status = 'cancelled' and r.stage = 'cancelled')
      or (v_status = 'running' and r.stage in ('validating', 'generating', 'retrying', 'retry_wait'))
    )
    and (
      v_search is null
      or r.project_id ilike '%' || v_search || '%'
      or coalesce(p.label, '') ilike '%' || v_search || '%'
      or coalesce(nullif(r.model_used, ''), r.model, '') ilike '%' || v_search || '%'
      or coalesce(u.email, '') ilike '%' || v_search || '%'
      or coalesce(pr.full_name, '') ilike '%' || v_search || '%'
      or r.id::text ilike '%' || v_search || '%'
    )
  ),
  page as (
    select * from filtered
    order by started_at desc
    limit v_limit offset v_offset
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
        ) order by page.started_at desc
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
  'Admin-only generation operations page: server-side status filter (now including cancelled), project/owner/model/run-id search and bounded pagination over public.project_runs. Read-only.';

revoke all on function public.admin_generation_stream(text, text, integer, integer) from public, anon;
grant execute on function public.admin_generation_stream(text, text, integer, integer) to authenticated, service_role;

/**
 * One run, in full operational detail.
 *
 * ⚠️ THE PROMPT IS RETURNED. It is the operator's own platform data and the
 * console needs it to diagnose a failure. Provider credentials, lease tokens
 * and trace secrets are NOT returned.
 */
create or replace function public.admin_generation_detail(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_generation_detail: not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', r.id,
    'projectId', r.project_id,
    'projectLabel', p.label,
    'ownerName', coalesce(nullif(pr.full_name, ''), u.email, 'Unknown owner'),
    'ownerEmail', u.email,
    'status', r.status,
    'stage', r.stage,
    'model', coalesce(nullif(r.model_used, ''), r.model, 'unknown'),
    'requestedModel', r.model,
    'prompt', r.prompt,
    'startedAt', r.started_at,
    'finishedAt', r.finished_at,
    'heartbeatAt', r.heartbeat_at,
    'lastProgressAt', r.last_progress_at,
    'enqueuedAt', r.enqueued_at,
    'dispatchedAt', r.dispatched_at,
    'nextAttemptAt', r.next_attempt_at,
    'cancellationRequestedAt', r.cancellation_requested_at,
    'deadLetteredAt', r.dead_lettered_at,
    'dispatchMode', r.dispatch_mode,
    'workerId', r.worker_id,
    'traceId', r.trace_id,
    'attemptCount', r.attempt_count,
    'jobAttempt', r.job_attempt,
    'maxJobAttempts', r.max_job_attempts,
    'checkpointCount', r.checkpoint_count,
    'batchCount', r.batch_count,
    'filesWritten', r.files_written,
    'promptTokens', r.prompt_tokens,
    'completionTokens', r.completion_tokens,
    'totalTokens', r.total_tokens,
    'reasoningTokens', r.reasoning_tokens,
    'finishReason', r.finish_reason,
    'errorCode', r.error_code,
    'errorMessage', r.error_message,
    'lastErrorClass', r.last_error_class,
    'lastErrorSummary', r.last_error_summary,
    'reportedCostUsd', r.reported_cost_usd,
    'costKnown', r.cost_known,
    'leaseExpiresAt', r.lease_expires_at,
    'providerAttempts', case
      when jsonb_typeof(r.provider_attempts) = 'array' then r.provider_attempts
      else '[]'::jsonb
    end,
    'durationSeconds', case
      when r.finished_at is not null and r.started_at is not null
        then extract(epoch from (r.finished_at - r.started_at))
      else null
    end,
    'cancellable', r.finished_at is null,
    'retryable', r.finished_at is not null and r.stage in ('failed', 'interrupted')
  )
  into v_result
  from public.project_runs r
  join public.projects p on p.project_id = r.project_id
  join auth.users u on u.id = p.user_id
  left join public.profiles pr on pr.id = p.user_id
  where r.id = p_run_id;

  return v_result;
end;
$$;

comment on function public.admin_generation_detail(uuid) is
  'Admin-only full operational detail for one generation run. Read-only.';

revoke all on function public.admin_generation_detail(uuid) from public, anon;
grant execute on function public.admin_generation_detail(uuid) to authenticated, service_role;

/**
 * Re-queue a terminal failed/interrupted run.
 *
 * ⚠️ THIS MIRRORS resume_generation_job()'s reset exactly, because that function
 * authorizes on the PROJECT OWNER and an administrator is not the owner. It does
 * not invent a second resume path: same advisory lock, same column reset, same
 * "only a terminal failed/interrupted run is resumable" rule.
 *
 * ⚠️ A CREDIT-ENFORCED PROJECT IS REFUSED. Resuming it requires holding credits
 * from the owner's balance, and spending a user's credits is not an
 * administrator's decision to make silently. The console says so and points at
 * the owner-initiated resume instead of charging someone behind their back.
 */
create or replace function public.admin_retry_generation_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_run public.project_runs;
  v_credit_enabled boolean;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_retry_generation_run: not authorized' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  select * into v_run from public.project_runs r where r.id = p_run_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_run.finished_at is null then
    return jsonb_build_object('status', 'not_resumable', 'reason', 'run_active');
  end if;
  if v_run.stage not in ('failed', 'interrupted') then
    return jsonb_build_object('status', 'not_resumable', 'reason', 'not_failed');
  end if;

  select policy.enabled into v_credit_enabled
  from public.credit_project_policies policy
  where policy.project_id = v_run.project_id;

  if coalesce(v_credit_enabled, false) then
    return jsonb_build_object(
      'status', 'not_resumable',
      'reason', 'credit_project',
      'message', 'This project enforces credits. Resuming it must hold credits from the owner''s balance, so the owner has to resume it from their workspace.'
    );
  end if;

  begin
    update public.project_runs r
    set status = 'init',
        stage = 'queued',
        finished_at = null,
        error_message = null,
        error_code = null,
        retry_after_seconds = null,
        claimed_at = null,
        heartbeat_at = now(),
        last_progress_at = now(),
        lease_token = null,
        lease_expires_at = null,
        worker_id = null,
        job_attempt = 0,
        next_attempt_at = null,
        dispatched_at = null,
        cancellation_requested_at = null,
        dead_lettered_at = null,
        last_error_class = null,
        last_error_summary = null
    where r.id = p_run_id;
  exception
    when unique_violation then
      return jsonb_build_object(
        'status', 'not_resumable',
        'reason', 'another_run_active',
        'message', 'This project already has an active run. Wait for it to finish before retrying this one.'
      );
  end;

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor,
    v_actor_email,
    'generation.retried',
    'generation_run',
    p_run_id::text,
    'success',
    jsonb_build_object('projectId', v_run.project_id, 'previousStage', v_run.stage)
  );

  return jsonb_build_object('status', 'resumed', 'runId', p_run_id, 'stage', 'queued');
end;
$$;

comment on function public.admin_retry_generation_run(uuid) is
  'Admin-only re-queue of a terminal failed/interrupted run. Mirrors resume_generation_job() without the owner requirement, and refuses credit-enforced projects.';

revoke all on function public.admin_retry_generation_run(uuid) from public, anon;
grant execute on function public.admin_retry_generation_run(uuid) to authenticated, service_role;

-- ── 8. Announcements: admin page + mutations + app feed ─────────────────────

create or replace function public.admin_announcements_page(
  p_search text default null,
  p_status text default 'all',
  p_kind text default 'all',
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
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_status text := coalesce(nullif(btrim(p_status), ''), 'all');
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total bigint;
  v_rows jsonb;
  v_counts jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_announcements_page: not authorized' using errcode = '42501';
  end if;
  if v_status not in ('all', 'draft', 'published', 'archived') then
    raise exception 'admin_announcements_page: invalid status' using errcode = '22023';
  end if;
  if v_kind not in ('all', 'information', 'success', 'warning', 'maintenance') then
    raise exception 'admin_announcements_page: invalid kind' using errcode = '22023';
  end if;

  with filtered as (
    select a.*
    from public.admin_announcements a
    where (v_status = 'all' or a.status = v_status)
      and (v_kind = 'all' or a.kind = v_kind)
      and (
        v_search is null
        or strpos(lower(a.title), lower(v_search)) > 0
        or strpos(lower(a.body), lower(v_search)) > 0
        or strpos(lower(a.target_plan), lower(v_search)) > 0
      )
  ),
  page_rows as (
    select * from filtered
    order by created_at desc, id desc
    limit v_limit offset v_offset
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page_rows.id,
          'title', page_rows.title,
          'body', page_rows.body,
          'kind', page_rows.kind,
          'status', page_rows.status,
          'targetPlan', page_rows.target_plan,
          'dismissible', page_rows.dismissible,
          'startsAt', page_rows.starts_at,
          'expiresAt', page_rows.expires_at,
          'createdByEmail', page_rows.created_by_email,
          'createdAt', page_rows.created_at,
          'updatedAt', page_rows.updated_at,
          'publishedAt', page_rows.published_at
        ) order by page_rows.created_at desc, page_rows.id desc
      )
      from page_rows
    ), '[]'::jsonb)
  into v_total, v_rows;

  select jsonb_build_object(
    'total', count(*),
    'draft', count(*) filter (where status = 'draft'),
    'published', count(*) filter (where status = 'published'),
    'archived', count(*) filter (where status = 'archived'),
    'live', count(*) filter (
      where status = 'published'
        and (starts_at is null or starts_at <= now())
        and (expires_at is null or expires_at > now())
    )
  )
  into v_counts
  from public.admin_announcements;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'status', v_status,
    'kind', v_kind,
    'search', v_search,
    'counts', v_counts
  );
end;
$$;

comment on function public.admin_announcements_page(text, text, text, integer, integer) is
  'Admin-only announcement page with status/kind filters, search and counts. Read-only.';

revoke all on function public.admin_announcements_page(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_announcements_page(text, text, text, integer, integer) to authenticated, service_role;

create or replace function public.admin_announcement_save(
  p_id uuid default null,
  p_title text default null,
  p_body text default null,
  p_kind text default 'information',
  p_status text default 'draft',
  p_target_plan text default 'All Plans',
  p_dismissible boolean default true,
  p_starts_at timestamptz default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'information');
  v_status text := coalesce(nullif(btrim(p_status), ''), 'draft');
  v_target text := coalesce(nullif(btrim(p_target_plan), ''), 'All Plans');
  v_existing public.admin_announcements;
  v_row public.admin_announcements;
  v_published_at timestamptz;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_announcement_save: not authorized' using errcode = '42501';
  end if;

  if v_title is null or char_length(v_title) > 160 then
    raise exception 'INVALID_ANNOUNCEMENT_TITLE' using errcode = '22023';
  end if;
  if v_body is null or char_length(v_body) > 4000 then
    raise exception 'INVALID_ANNOUNCEMENT_BODY' using errcode = '22023';
  end if;
  if v_kind not in ('information', 'success', 'warning', 'maintenance') then
    raise exception 'INVALID_ANNOUNCEMENT_KIND' using errcode = '22023';
  end if;
  if v_status not in ('draft', 'published', 'archived') then
    raise exception 'INVALID_ANNOUNCEMENT_STATUS' using errcode = '22023';
  end if;
  if char_length(v_target) > 80 then
    raise exception 'INVALID_ANNOUNCEMENT_TARGET' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_starts_at is not null and p_expires_at <= p_starts_at then
    raise exception 'INVALID_ANNOUNCEMENT_WINDOW' using errcode = '22023';
  end if;

  select email into v_actor_email from auth.users u where u.id = v_actor;

  if p_id is null then
    v_published_at := case when v_status = 'published' then now() else null end;

    insert into public.admin_announcements (
      title, body, kind, status, target_plan, dismissible,
      starts_at, expires_at, created_by, created_by_email, published_at
    ) values (
      v_title, v_body, v_kind, v_status, v_target, coalesce(p_dismissible, true),
      p_starts_at, p_expires_at, v_actor, v_actor_email, v_published_at
    )
    returning * into v_row;

    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
    ) values (
      v_actor, v_actor_email, 'announcement.created', 'announcement', v_row.id::text,
      'success',
      jsonb_build_object('title', v_row.title, 'status', v_row.status, 'kind', v_row.kind)
    );
  else
    select * into v_existing from public.admin_announcements a where a.id = p_id for update;
    if not found then
      raise exception 'ANNOUNCEMENT_NOT_FOUND' using errcode = 'P0002';
    end if;

    /**
     * ⚠️ published_at IS SET ONCE, ON THE FIRST TRANSITION TO published, and
     * cleared when the row goes back to draft. Re-publishing after an archive
     * keeps the original timestamp so the history is not rewritten.
     */
    v_published_at := case
      when v_status = 'published' then coalesce(v_existing.published_at, now())
      when v_status = 'draft' then null
      else v_existing.published_at
    end;

    update public.admin_announcements a
    set title = v_title,
        body = v_body,
        kind = v_kind,
        status = v_status,
        target_plan = v_target,
        dismissible = coalesce(p_dismissible, a.dismissible),
        starts_at = p_starts_at,
        expires_at = p_expires_at,
        published_at = v_published_at,
        updated_at = now()
    where a.id = p_id
    returning * into v_row;

    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
    ) values (
      v_actor, v_actor_email,
      case
        when v_existing.status is distinct from v_row.status then 'announcement.status_changed'
        else 'announcement.updated'
      end,
      'announcement', v_row.id::text, 'success',
      jsonb_build_object(
        'title', v_row.title,
        'previousStatus', v_existing.status,
        'status', v_row.status,
        'kind', v_row.kind
      )
    );
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'title', v_row.title,
    'publishedAt', v_row.published_at,
    'updatedAt', v_row.updated_at
  );
end;
$$;

comment on function public.admin_announcement_save(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) is
  'Admin-only announcement create/update. Validates on the server, sets published_at once, and records an audit event.';

revoke all on function public.admin_announcement_save(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_announcement_save(uuid, text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.admin_announcement_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_row public.admin_announcements;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_announcement_delete: not authorized' using errcode = '42501';
  end if;

  select * into v_row from public.admin_announcements a where a.id = p_id for update;
  if not found then
    raise exception 'ANNOUNCEMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  /**
   * ⚠️ A LIVE ANNOUNCEMENT IS NOT DELETED IN ONE CLICK. It must be archived or
   * unpublished first, so removing something users can currently see is always
   * a deliberate two-step act with its own audit row.
   */
  if v_row.status = 'published' then
    raise exception 'ANNOUNCEMENT_PUBLISHED'
      using errcode = 'P0001',
            detail = 'Unpublish or archive this announcement before deleting it.';
  end if;

  delete from public.admin_announcements a where a.id = p_id;

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor, v_actor_email, 'announcement.deleted', 'announcement', p_id::text,
    'success',
    jsonb_build_object('title', v_row.title, 'previousStatus', v_row.status)
  );

  return jsonb_build_object('status', 'deleted', 'id', p_id);
end;
$$;

comment on function public.admin_announcement_delete(uuid) is
  'Admin-only announcement delete. Refuses a published row so a live banner is never removed in one step.';

revoke all on function public.admin_announcement_delete(uuid) from public, anon;
grant execute on function public.admin_announcement_delete(uuid) to authenticated, service_role;

/**
 * The app-facing feed.
 *
 * ⚠️ THIS IS PUBLICATION, NOT DELIVERY. A row here is available to whatever
 * reads the feed; Mavly has no push, email or in-app banner consumer wired to
 * it. The admin console says exactly that, so "Published" is never mistaken for
 * "the user saw it".
 */
create or replace function public.active_announcements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_result jsonb;
begin
  select coalesce((s.value #>> '{}')::boolean, true)
  into v_enabled
  from public.admin_settings s
  where s.key = 'announcements.enabled';

  if not coalesce(v_enabled, true) then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'body', a.body,
      'kind', a.kind,
      'targetPlan', a.target_plan,
      'dismissible', a.dismissible,
      'startsAt', a.starts_at,
      'expiresAt', a.expires_at
    ) order by a.published_at desc nulls last, a.id
  ), '[]'::jsonb)
  into v_result
  from public.admin_announcements a
  where a.status = 'published'
    and (a.starts_at is null or a.starts_at <= now())
    and (a.expires_at is null or a.expires_at > now());

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

comment on function public.active_announcements() is
  'Published, in-window announcements for the app feed. Honours announcements.enabled. Publication only: no delivery channel is implied.';

revoke all on function public.active_announcements() from public;
grant execute on function public.active_announcements() to anon, authenticated, service_role;

-- ── 9. Audit log page ───────────────────────────────────────────────────────

/**
 * The unified audit trail.
 *
 * ⚠️ THREE REAL SOURCES, NO SYNTHETIC ROWS:
 *   1. admin_audit_log      — every mutation performed through this console
 *   2. account_restriction_events — the existing block/unblock trail
 *   3. credit_ledger        — grant / admin_adjustment entries, whose actor is
 *                             not recorded by the credit engine (shown as null,
 *                             not guessed)
 *
 * A source with no rows contributes nothing. Nothing is backfilled or invented.
 */
create or replace function public.admin_audit_log_page(
  p_search text default null,
  p_outcome text default 'all',
  p_source text default 'all',
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
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_outcome text := coalesce(nullif(btrim(p_outcome), ''), 'all');
  v_source text := coalesce(nullif(btrim(p_source), ''), 'all');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_retention integer;
  v_since timestamptz;
  v_total bigint;
  v_rows jsonb;
  v_counts jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_audit_log_page: not authorized' using errcode = '42501';
  end if;
  if v_outcome not in ('all', 'success', 'failure') then
    raise exception 'admin_audit_log_page: invalid outcome' using errcode = '22023';
  end if;
  if v_source not in ('all', 'console', 'account_restriction', 'credit_ledger') then
    raise exception 'admin_audit_log_page: invalid source' using errcode = '22023';
  end if;

  select coalesce((s.value #>> '{}')::integer, 90)
  into v_retention
  from public.admin_settings s
  where s.key = 'audit.retention_days';
  v_retention := least(greatest(coalesce(v_retention, 90), 1), 3650);
  v_since := now() - make_interval(days => v_retention);

  with unified as (
    select
      l.id,
      l.created_at,
      l.actor_user_id,
      l.actor_email,
      l.action,
      l.target_type,
      l.target_id,
      l.outcome,
      'console'::text as source,
      l.metadata
    from public.admin_audit_log l
    where l.created_at >= v_since

    union all

    select
      e.id,
      e.created_at,
      e.actor_user_id,
      e.actor_email,
      case when e.action = 'blocked' then 'user.blocked' else 'user.unblocked' end,
      'user',
      e.target_user_id::text,
      'success',
      'account_restriction',
      jsonb_build_object(
        'reason', e.reason,
        'previousBannedUntil', e.previous_banned_until,
        'resultingBannedUntil', e.resulting_banned_until
      )
    from public.account_restriction_events e
    where e.created_at >= v_since

    union all

    select
      c.id,
      c.created_at,
      null::uuid,
      null::text,
      case when c.operation = 'grant' then 'credits.grant' else 'credits.adjustment' end,
      'user',
      c.user_id::text,
      'success',
      'credit_ledger',
      jsonb_build_object(
        'amount', c.amount_credits,
        'balanceAfter', c.balance_after_credits,
        'reason', c.reason,
        'ledgerStatus', c.status
      )
    from public.credit_ledger c
    where c.created_at >= v_since
      and c.operation in ('grant', 'admin_adjustment')
  ),
  filtered as (
    select * from unified
    where (v_outcome = 'all' or outcome = v_outcome)
      and (v_source = 'all' or source = v_source)
      and (
        v_search is null
        or strpos(lower(coalesce(actor_email, '')), lower(v_search)) > 0
        or strpos(lower(action), lower(v_search)) > 0
        or strpos(lower(coalesce(target_id, '')), lower(v_search)) > 0
        or strpos(lower(target_type), lower(v_search)) > 0
      )
  ),
  page_rows as (
    select * from filtered
    order by created_at desc, id desc
    limit v_limit offset v_offset
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page_rows.id,
          'createdAt', page_rows.created_at,
          'actorUserId', page_rows.actor_user_id,
          'actorEmail', page_rows.actor_email,
          'action', page_rows.action,
          'targetType', page_rows.target_type,
          'targetId', page_rows.target_id,
          'outcome', page_rows.outcome,
          'source', page_rows.source,
          'metadata', page_rows.metadata
        ) order by page_rows.created_at desc, page_rows.id desc
      )
      from page_rows
    ), '[]'::jsonb)
  into v_total, v_rows;

  select jsonb_build_object(
    'total', count(*),
    'success', count(*) filter (where outcome = 'success'),
    'failure', count(*) filter (where outcome = 'failure'),
    'console', count(*) filter (where source = 'console'),
    'accountRestriction', count(*) filter (where source = 'account_restriction'),
    'creditLedger', count(*) filter (where source = 'credit_ledger'),
    'distinctActors', count(distinct actor_user_id) filter (where actor_user_id is not null)
  )
  into v_counts
  from (
    select outcome, source, actor_user_id from public.admin_audit_log where created_at >= v_since
    union all
    select 'success', 'account_restriction', actor_user_id
      from public.account_restriction_events where created_at >= v_since
    union all
    select 'success', 'credit_ledger', null::uuid
      from public.credit_ledger
      where created_at >= v_since and operation in ('grant', 'admin_adjustment')
  ) all_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', coalesce(v_total, 0),
    'limit', v_limit,
    'offset', v_offset,
    'outcome', v_outcome,
    'source', v_source,
    'search', v_search,
    'retentionDays', v_retention,
    'counts', v_counts
  );
end;
$$;

comment on function public.admin_audit_log_page(text, text, text, integer, integer) is
  'Admin-only unified audit trail over admin_audit_log, account_restriction_events and credit_ledger. Read-only; no synthetic rows.';

revoke all on function public.admin_audit_log_page(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_audit_log_page(text, text, text, integer, integer) to authenticated, service_role;

-- ── 10. Settings read/write ─────────────────────────────────────────────────

/**
 * Every setting the console shows, with its TRUE source.
 *
 * ⚠️ A DEPLOYMENT-MANAGED SETTING IS REPORTED AS SUCH. The route adds the
 * environment-derived facts (model default, worker readiness, provider key
 * presence, payment gateway) and marks them `editable = false` with
 * `source = 'deployment'`. Nothing here can pretend an env var is editable.
 */
create or replace function public.admin_settings_read()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_settings_read: not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', reg.key,
      'kind', reg.kind,
      'editable', reg.editable,
      'source', 'database',
      'value', coalesce(s.value, reg.default_value),
      'defaultValue', reg.default_value,
      'isDefault', s.key is null,
      'description', reg.description,
      'updatedAt', s.updated_at,
      'updatedByEmail', s.updated_by_email
    ) order by reg.key
  ), '[]'::jsonb)
  into v_rows
  from public.admin_settings_registry() reg
  left join public.admin_settings s on s.key = reg.key;

  return jsonb_build_object('settings', v_rows);
end;
$$;

comment on function public.admin_settings_read() is
  'Admin-only read of every runtime-editable setting with its effective value and provenance.';

revoke all on function public.admin_settings_read() from public, anon;
grant execute on function public.admin_settings_read() to authenticated, service_role;

create or replace function public.admin_settings_write(
  p_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_reg record;
  v_previous jsonb;
  v_text text;
  v_number numeric;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_settings_write: not authorized' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'INVALID_SETTING_KEY' using errcode = '22023';
  end if;

  select * into v_reg from public.admin_settings_registry() reg where reg.key = v_key;
  if not found then
    raise exception 'UNKNOWN_SETTING' using errcode = '22023';
  end if;
  if not v_reg.editable then
    raise exception 'SETTING_NOT_EDITABLE' using errcode = '42501';
  end if;

  -- Type validation on the server. The browser is never the validator.
  if v_reg.kind = 'boolean' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
  elsif v_reg.kind = 'integer' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    v_number := (p_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'credits.max_adjustment' and (v_number < 1 or v_number > 1000000) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'audit.retention_days' and (v_number < 1 or v_number > 3650) then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
  elsif v_reg.kind = 'text' then
    if jsonb_typeof(p_value) <> 'string' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    v_text := btrim(p_value #>> '{}');
    if char_length(v_text) < 1 or char_length(v_text) > 200 then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    if v_key = 'console.support_email'
      and v_text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'INVALID_SETTING_VALUE' using errcode = '22023';
    end if;
    p_value := to_jsonb(v_text);
  end if;

  select s.value into v_previous from public.admin_settings s where s.key = v_key;

  insert into public.admin_settings (key, value, updated_by, updated_by_email, updated_at)
  values (v_key, p_value, v_actor, (select email from auth.users u where u.id = v_actor), now())
  on conflict (key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_by_email = excluded.updated_by_email,
        updated_at = now();

  select email into v_actor_email from auth.users u where u.id = v_actor;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, outcome, metadata
  ) values (
    v_actor, v_actor_email, 'setting.updated', 'setting', v_key, 'success',
    jsonb_build_object('previous', v_previous, 'next', p_value)
  );

  return jsonb_build_object(
    'key', v_key,
    'value', p_value,
    'previous', v_previous,
    'changed', v_previous is distinct from p_value
  );
end;
$$;

comment on function public.admin_settings_write(text, jsonb) is
  'Admin-only validated write of a runtime-editable setting. Refuses unknown or deployment-managed keys and records an audit event.';

revoke all on function public.admin_settings_write(text, jsonb) from public, anon;
grant execute on function public.admin_settings_write(text, jsonb) to authenticated, service_role;

-- ── 11. Health snapshot ─────────────────────────────────────────────────────

/**
 * Measured facts for the System Health page.
 *
 * ⚠️ THIS IS NOT AN UPTIME SERVICE. It reports what the database can observe
 * right now: queue depth, stale leases, the age of the newest heartbeat, and the
 * newest successful run. It has no historical availability data, so the page
 * must not claim a percentage.
 */
create or replace function public.admin_health_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_health_snapshot: not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'measuredAt', now(),
    'queued', count(*) filter (where stage = 'queued' and finished_at is null),
    'running', count(*) filter (
      where stage in ('validating', 'generating', 'retrying') and finished_at is null
    ),
    'staleLeases', count(*) filter (
      where finished_at is null and lease_expires_at is not null and lease_expires_at < now()
    ),
    'oldestQueuedAt', min(enqueued_at) filter (where stage = 'queued' and finished_at is null),
    'lastHeartbeatAt', max(heartbeat_at),
    'lastCompletedAt', max(finished_at) filter (where stage = 'completed'),
    'lastFailureAt', max(finished_at) filter (where stage in ('failed', 'interrupted')),
    'runsLast24h', count(*) filter (where started_at >= now() - interval '24 hours'),
    'failuresLast24h', count(*) filter (
      where started_at >= now() - interval '24 hours' and stage in ('failed', 'interrupted')
    )
  )
  into v_result
  from public.project_runs;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

comment on function public.admin_health_snapshot() is
  'Admin-only measured queue/worker facts for the System Health page. No historical uptime is available or claimed.';

revoke all on function public.admin_health_snapshot() from public, anon;
grant execute on function public.admin_health_snapshot() to authenticated, service_role;

commit;
