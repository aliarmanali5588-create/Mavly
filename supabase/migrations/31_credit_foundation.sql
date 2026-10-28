-- ═══════════════════════════════════════════════════════════════════════════
-- 31_credit_foundation.sql — authoritative credit accounting
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE. Apply after 30_managed_backends.sql. It creates new tables,
-- functions and a guarded trigger; it does not alter existing columns or RLS
-- policies.
--
-- ═══ WHAT THIS INSTALLS ═══
--
--   credit_accounts        cached per-user balance + active holds
--   credit_project_policies server-owned cohort/cost policy for admission
--   credit_reservations    one row per credit hold for a generation run
--   credit_ledger          APPEND-ONLY audit trail; the accounting authority
--   ai_cost_rates          optional operator rate card (empty by default)
--   ai_usage_attempts      per-provider-attempt usage/cost reconciliation rows
--
--   create_generation_job_with_credits()   atomic admission + reservation
--   settle_generation_reservation()        consume a hold after completion
--   release_generation_reservation()       release a hold on failure/cancel
--   refund_generation_reservation()        service-role-only audited refund
--   grant_credits()                        service-role-only funding entry
--   get_credit_account()                   owner balance read
--   reconcile_owner_credits()              owner-scoped settlement recovery
--   maintain_credit_reservations()         worker-scoped settlement recovery
--   record_ai_usage_attempts()             derive per-attempt usage from a run
--   record_ai_usage_attempt()              one service-role usage row (roles)
--
-- ═══ ACCOUNTING MODEL ═══
--
--   balance_credits   credits the account owns
--   reserved_credits  credits currently held for unfinished runs
--   available         balance_credits - reserved_credits
--
-- Every state change is one transaction that writes the account row, the
-- reservation row and exactly one ledger row. `sum(amount_credits)` over the
-- ledger equals `balance_credits`; `sum(reserved_delta_credits)` equals
-- `reserved_credits`. A hold is not a balance movement: it writes a ledger row
-- with amount 0 and a positive reserved delta, so releasing it is auditable.
--
-- ═══ PRECISION ═══
--
-- Credits are WHOLE UNITS (`bigint`). The approved packages, the workspace
-- indicator and every existing UI surface use whole credits; there is no
-- historical fractional-credit representation to preserve. No float is used
-- anywhere. USD amounts are `numeric(20,9)` and are never converted to credits
-- here — credits and provider cost are separate ledgers.
--
-- ═══ TRUST BOUNDARY ═══
--
-- Authenticated callers may read their own accounting rows. Credit admission,
-- terminal run writes for credit projects and reservation release are
-- service_role-only. No client-supplied balance, price or refund amount is
-- trusted.

begin;

-- ── 1. Schema marker ────────────────────────────────────────────────────────

create or replace function public.credit_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 31;
$$;

comment on function public.credit_schema_version() is
  'Credit schema marker. 31 means accounts, append-only ledger, reservations, metering and the atomic credit-aware admission RPC are installed.';

-- ── 2. Accounts ─────────────────────────────────────────────────────────────

create table if not exists public.credit_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance_credits bigint not null default 0,
  reserved_credits bigint not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_accounts_balance_non_negative check (balance_credits >= 0),
  constraint credit_accounts_reserved_non_negative check (reserved_credits >= 0),
  -- A hold can never exceed the credits the account actually owns.
  constraint credit_accounts_reserved_le_balance check (reserved_credits <= balance_credits)
);

comment on table public.credit_accounts is
  'Cached credit balance and active holds per user. The ledger is the authority; this row is updated in the same transaction as every ledger write.';
comment on column public.credit_accounts.balance_credits is
  'Credits the account owns. Whole units only. Never below zero, never below reserved_credits.';
comment on column public.credit_accounts.reserved_credits is
  'Credits held for unfinished generation runs. available = balance_credits - reserved_credits.';

-- ── 2a. Server-owned credit cohort and price ────────────────────────────────

create table if not exists public.credit_project_policies (
  project_id text primary key references public.projects (project_id) on delete cascade,
  generation_cost_credits bigint not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_project_policies_cost_bounds
    check (generation_cost_credits between 1 and 100000)
);

alter table public.credit_project_policies enable row level security;
revoke all on public.credit_project_policies from public, anon, authenticated;
grant select, insert, update, delete on public.credit_project_policies to service_role;

comment on table public.credit_project_policies is
  'Service-role/database-owner policy mirror for the explicit credit cohort and fixed generation cost. The database, not an authenticated RPC argument, is authoritative.';

-- ── 3. Reservations ─────────────────────────────────────────────────────────

create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  run_id uuid not null,
  amount_credits bigint not null,
  consumed_credits bigint not null default 0,
  released_credits bigint not null default 0,
  refunded_credits bigint not null default 0,
  status text not null default 'reserved',
  idempotency_key text not null,
  reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint credit_reservations_amount_positive check (amount_credits > 0),
  constraint credit_reservations_consumed_bounds
    check (consumed_credits >= 0 and consumed_credits <= amount_credits),
  constraint credit_reservations_released_bounds
    check (released_credits >= 0 and released_credits <= amount_credits),
  constraint credit_reservations_refunded_bounds
    check (refunded_credits >= 0 and refunded_credits <= amount_credits),
  /**
   * ⚠️ A REFUND IS ONLY EVER APPLIED TO A CONSUMED HOLD. The consumed amount is
   * the full reservation, so `consumed + refunded <= amount` would make every
   * refund impossible; the meaningful invariant is that `refunded` is bounded by
   * the amount (above) and cannot appear on a reserved or released row.
   */
  constraint credit_reservations_refund_only_consumed
    check (refunded_credits = 0 or status = 'consumed'),
  constraint credit_reservations_status_check
    check (status in ('reserved', 'consumed', 'released')),
  constraint credit_reservations_status_consistent check (
    (status = 'reserved' and consumed_credits = 0 and released_credits = 0 and settled_at is null)
    or (status = 'consumed' and consumed_credits = amount_credits and released_credits = 0)
    or (status = 'released' and released_credits = amount_credits and consumed_credits = 0)
  ),
  constraint credit_reservations_user_key_unique unique (user_id, idempotency_key)
);

-- At most ONE live hold per run. A failed run may be resumed only after its
-- previous hold was released, which is what makes the second hold safe.
create unique index if not exists credit_reservations_live_run_idx
  on public.credit_reservations (run_id)
  where status = 'reserved';

create index if not exists credit_reservations_run_idx
  on public.credit_reservations (run_id, created_at desc);

create index if not exists credit_reservations_user_status_idx
  on public.credit_reservations (user_id, status);

create index if not exists credit_reservations_project_status_idx
  on public.credit_reservations (project_id, status);

create or replace function public.guard_credit_project_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform pg_advisory_xact_lock(
      hashtext('mavly:credit-policy'),
      hashtext(old.project_id)
    );
  else
    perform pg_advisory_xact_lock(
      hashtext('mavly:credit-policy'),
      hashtext(new.project_id)
    );
  end if;

  if tg_op = 'UPDATE' then
    if old.project_id is distinct from new.project_id then
      raise exception 'CREDIT_POLICY_PROJECT_IMMUTABLE'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.credit_reservations reservation
      where reservation.project_id = old.project_id
        and reservation.status = 'reserved'
    ) then
      raise exception 'CREDIT_POLICY_HAS_LIVE_RESERVATIONS'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if new.enabled and exists (
    select 1
    from public.project_runs run
    where run.project_id = new.project_id
      and run.finished_at is null
      and (
        run.dispatch_mode <> 'worker'
        or not exists (
          select 1 from public.credit_reservations reservation
          where reservation.run_id = run.id
            and reservation.status = 'reserved'
        )
      )
  ) then
    raise exception 'CREDIT_POLICY_ACTIVE_RUNS_EXIST'
      using errcode = 'P0001';
  end if;

  if new.enabled and exists (
    select 1
    from public.credit_reservations reservation
    where reservation.project_id = new.project_id
      and reservation.status = 'reserved'
      and reservation.amount_credits <> new.generation_cost_credits
  ) then
    raise exception 'CREDIT_POLICY_RESERVATION_MISMATCH'
      using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    if (
      (old.enabled and not new.enabled)
      or old.generation_cost_credits is distinct from new.generation_cost_credits
    ) and exists (
      select 1 from public.credit_reservations reservation
      where reservation.project_id = old.project_id
        and reservation.status = 'reserved'
    ) then
      raise exception 'CREDIT_POLICY_HAS_LIVE_RESERVATIONS'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_credit_project_policy() from public, anon, authenticated;

drop trigger if exists credit_project_policy_guard on public.credit_project_policies;
create trigger credit_project_policy_guard
  before insert or update or delete on public.credit_project_policies
  for each row execute function public.guard_credit_project_policy();

/**
 * For an enabled credit project, only service-role worker/admission code may
 * create a run or change its settlement-driving state. A worker transition
 * also requires a live reservation, so an unreserved legacy job cannot run
 * through the worker after the policy is enabled.
 */
create or replace function public.guard_credit_project_run_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_credit_enabled boolean;
begin
  perform pg_advisory_xact_lock(
    hashtext('mavly:credit-policy'),
    hashtext(new.project_id)
  );

  select policy.enabled into v_credit_enabled
  from public.credit_project_policies policy
  where policy.project_id = new.project_id;

  if not coalesce(v_credit_enabled, false) then
    return new;
  end if;

  if auth.role() is distinct from 'service_role' then
    raise exception 'CREDIT_RUN_STATE_SERVER_ONLY'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.dispatch_mode is distinct from 'worker'
      or current_setting('mavly.credit_admission_project_id', true)
        is distinct from new.project_id then
      raise exception 'CREDIT_RESERVATION_REQUIRED'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status is distinct from new.status
    or old.stage is distinct from new.stage
    or old.finished_at is distinct from new.finished_at then
    if not exists (
      select 1
      from public.credit_reservations reservation
      where reservation.run_id = new.id
        and reservation.status = 'reserved'
    ) and not (
      old.finished_at is not null
      and new.finished_at is null
      and new.status = 'init'
      and new.stage = 'queued'
      and current_setting('mavly.credit_resume_project_id', true)
        is not distinct from new.project_id
    ) then
      raise exception 'CREDIT_RESERVATION_REQUIRED'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_credit_project_run_state() from public, anon, authenticated;

drop trigger if exists project_runs_credit_state_guard on public.project_runs;
create trigger project_runs_credit_state_guard
  before insert or update on public.project_runs
  for each row execute function public.guard_credit_project_run_state();

comment on table public.credit_reservations is
  'Credit hold for one generation run. A run has at most one live (reserved) hold; a consumed hold may be partially or fully refunded with an audited ledger entry.';
comment on column public.credit_reservations.status is
  'reserved = held; consumed = settled after successful completion; released = returned after a terminal failed/cancelled run.';

-- ── 4. Append-only ledger ───────────────────────────────────────────────────

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text,
  run_id uuid,
  reservation_id uuid references public.credit_reservations (id),
  operation text not null,
  amount_credits bigint not null,
  reserved_delta_credits bigint not null default 0,
  balance_after_credits bigint not null,
  reserved_after_credits bigint not null,
  idempotency_key text not null,
  reason text,
  status text not null default 'applied',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint credit_ledger_operation_check check (operation in (
    'grant',
    'admin_adjustment',
    'generation_reserved',
    'generation_consumed',
    'generation_released',
    'generation_refunded'
  )),
  constraint credit_ledger_status_check check (status in ('applied', 'reversed')),
  constraint credit_ledger_balances_non_negative check (
    balance_after_credits >= 0 and reserved_after_credits >= 0
  ),
  constraint credit_ledger_user_key_unique unique (user_id, idempotency_key)
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at desc);

create index if not exists credit_ledger_run_idx
  on public.credit_ledger (run_id);

comment on table public.credit_ledger is
  'APPEND-ONLY credit audit trail. One row per accounting event. sum(amount_credits) must equal credit_accounts.balance_credits and sum(reserved_delta_credits) must equal reserved_credits.';
comment on column public.credit_ledger.amount_credits is
  'Signed balance movement in whole credits. A hold writes 0 because holding does not move the balance.';
comment on column public.credit_ledger.reserved_delta_credits is
  'Signed movement of the reserved balance. A hold is positive, a release or consumption is negative.';

/**
 * Even a service-role mistake must not rewrite financial history. Corrections
 * are new ledger rows (a refund or an adjustment), never an UPDATE.
 */
create or replace function public.credit_ledger_reject_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'CREDIT_LEDGER_APPEND_ONLY'
    using errcode = 'P0001',
          detail = 'Credit ledger rows cannot be updated or deleted; write a compensating entry.';
end;
$$;

drop trigger if exists credit_ledger_immutable on public.credit_ledger;
create trigger credit_ledger_immutable
  before update or delete on public.credit_ledger
  for each row execute function public.credit_ledger_reject_mutation();

-- ── 5. Provider rate card (optional, empty by default) ──────────────────────

create table if not exists public.ai_cost_rates (
  model text primary key,
  provider text not null default 'openrouter',
  input_usd_per_million numeric(20, 9) not null,
  output_usd_per_million numeric(20, 9) not null,
  cached_input_usd_per_million numeric(20, 9),
  version text not null,
  effective_from timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_cost_rates_input_non_negative check (input_usd_per_million >= 0),
  constraint ai_cost_rates_output_non_negative check (output_usd_per_million >= 0),
  constraint ai_cost_rates_cached_non_negative check (
    cached_input_usd_per_million is null or cached_input_usd_per_million >= 0
  )
);

comment on table public.ai_cost_rates is
  'Optional operator-installed USD rate card per model. EMPTY BY DEFAULT: without a row, estimated cost is explicitly unavailable rather than invented.';
comment on column public.ai_cost_rates.version is
  'Operator rate-card version/snapshot. Copied onto every usage row estimated with it.';

-- ── 6. Per-attempt AI usage reconciliation ──────────────────────────────────

create table if not exists public.ai_usage_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_key text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  run_id uuid,
  workflow_id uuid,
  role text,
  task_key text,
  attempt_index integer not null,
  provider text not null default 'openrouter',
  model text not null,
  requested_model text,
  provider_request_id text,
  prompt_tokens bigint,
  completion_tokens bigint,
  cached_read_tokens bigint,
  cached_write_tokens bigint,
  reasoning_tokens bigint,
  total_tokens bigint,
  usage_source text not null,
  estimated_cost_usd numeric(20, 9),
  actual_cost_usd numeric(20, 9),
  cost_source text not null,
  rate_version text,
  reconciliation_status text not null,
  uncertain boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_usage_attempts_key_unique unique (attempt_key),
  constraint ai_usage_attempts_identifier_check check (run_id is not null or workflow_id is not null),
  constraint ai_usage_attempts_usage_source_check
    check (usage_source in ('provider', 'unavailable')),
  constraint ai_usage_attempts_cost_source_check
    check (cost_source in ('provider_reported', 'rate_card', 'unavailable')),
  constraint ai_usage_attempts_reconciliation_check
    check (reconciliation_status in ('reconciled', 'unreconciled', 'uncertain', 'unavailable')),
  constraint ai_usage_attempts_tokens_non_negative check (
    (prompt_tokens is null or prompt_tokens >= 0)
    and (completion_tokens is null or completion_tokens >= 0)
    and (cached_read_tokens is null or cached_read_tokens >= 0)
    and (cached_write_tokens is null or cached_write_tokens >= 0)
    and (reasoning_tokens is null or reasoning_tokens >= 0)
    and (total_tokens is null or total_tokens >= 0)
  ),
  constraint ai_usage_attempts_costs_non_negative check (
    (estimated_cost_usd is null or estimated_cost_usd >= 0)
    and (actual_cost_usd is null or actual_cost_usd >= 0)
  )
);

create index if not exists ai_usage_attempts_run_idx
  on public.ai_usage_attempts (run_id, attempt_index);

create index if not exists ai_usage_attempts_user_created_idx
  on public.ai_usage_attempts (user_id, created_at desc);

comment on table public.ai_usage_attempts is
  'One row per provider attempt (and per orchestration role call). Tokens and provider-reported cost are recorded verbatim; estimated cost exists only when an operator rate card is installed. Unknown values stay NULL — never zero.';
comment on column public.ai_usage_attempts.uncertain is
  'True when the provider may have accepted and billed a call whose response Mavly never received (timeout/network failure). Nothing is fabricated for it.';

-- ── 7. RLS and grants ───────────────────────────────────────────────────────

alter table public.credit_accounts enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.ai_usage_attempts enable row level security;
alter table public.ai_cost_rates enable row level security;

drop policy if exists credit_accounts_read_own on public.credit_accounts;
create policy credit_accounts_read_own on public.credit_accounts
  for select using (auth.uid() = user_id);

drop policy if exists credit_reservations_read_own on public.credit_reservations;
create policy credit_reservations_read_own on public.credit_reservations
  for select using (auth.uid() = user_id);

drop policy if exists credit_ledger_read_own on public.credit_ledger;
create policy credit_ledger_read_own on public.credit_ledger
  for select using (auth.uid() = user_id);

drop policy if exists ai_usage_attempts_read_own on public.ai_usage_attempts;
create policy ai_usage_attempts_read_own on public.ai_usage_attempts
  for select using (auth.uid() = user_id);

drop policy if exists ai_cost_rates_read_authenticated on public.ai_cost_rates;
create policy ai_cost_rates_read_authenticated on public.ai_cost_rates
  for select to authenticated using (true);

revoke all on public.credit_accounts from anon;
revoke all on public.credit_reservations from anon;
revoke all on public.credit_ledger from anon;
revoke all on public.ai_usage_attempts from anon;
revoke all on public.ai_cost_rates from anon;

grant select on public.credit_accounts to authenticated;
grant select on public.credit_reservations to authenticated;
grant select on public.credit_ledger to authenticated;
grant select on public.ai_usage_attempts to authenticated;
grant select on public.ai_cost_rates to authenticated;

grant select, insert, update, delete on public.credit_accounts to service_role;
grant select, insert, update, delete on public.credit_reservations to service_role;
grant select, insert on public.credit_ledger to service_role;
grant select, insert, update, delete on public.ai_usage_attempts to service_role;
grant select, insert, update, delete on public.ai_cost_rates to service_role;

-- ── 8. Internal helpers ─────────────────────────────────────────────────────

/**
 * Lock (or lazily create) the caller's account row for this transaction.
 *
 * The INSERT ... ON CONFLICT is what makes a first-ever grant/reservation safe
 * under concurrency: two transactions cannot both create the row, and the
 * loser then takes the row lock behind the winner.
 */
create or replace function public.lock_credit_account(p_user_id uuid)
returns public.credit_accounts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.credit_accounts;
begin
  insert into public.credit_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_account
  from public.credit_accounts
  where user_id = p_user_id
  for update;

  return v_account;
end;
$$;

revoke all on function public.lock_credit_account(uuid) from public;
revoke all on function public.lock_credit_account(uuid) from anon;
revoke all on function public.lock_credit_account(uuid) from authenticated;

/**
 * The one place a USD estimate is computed. Returns NULL when no rate card row
 * exists, so "unknown" is never disguised as zero.
 */
create or replace function public.ai_estimate_cost_usd(
  p_model text,
  p_prompt_tokens bigint,
  p_completion_tokens bigint,
  p_cached_read_tokens bigint
)
returns table (estimated_cost_usd numeric, rate_version text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate public.ai_cost_rates;
  v_prompt bigint := greatest(coalesce(p_prompt_tokens, 0), 0);
  v_cached bigint := least(greatest(coalesce(p_cached_read_tokens, 0), 0), v_prompt);
  v_completion bigint := greatest(coalesce(p_completion_tokens, 0), 0);
  v_total numeric;
begin
  select * into v_rate
  from public.ai_cost_rates r
  where r.model = p_model
  order by r.effective_from desc
  limit 1;

  if not found then
    -- No operator rate card: the estimate is genuinely unknown.
    return query select null::numeric, null::text;
    return;
  end if;

  v_total :=
    ((v_prompt - v_cached) * v_rate.input_usd_per_million
      + v_cached * coalesce(v_rate.cached_input_usd_per_million, v_rate.input_usd_per_million)
      + v_completion * v_rate.output_usd_per_million) / 1000000;

  return query select round(v_total, 9), v_rate.version;
end;
$$;

revoke all on function public.ai_estimate_cost_usd(text, bigint, bigint, bigint) from public;
revoke all on function public.ai_estimate_cost_usd(text, bigint, bigint, bigint) from anon;
revoke all on function public.ai_estimate_cost_usd(text, bigint, bigint, bigint) from authenticated;

/** The run's owner, for owner-or-service checks. NULL when the run is unknown. */
create or replace function public.credit_run_owner(p_run_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.user_id
  from public.project_runs r
  join public.projects p on p.project_id = r.project_id
  where r.id = p_run_id
  limit 1;
$$;

revoke all on function public.credit_run_owner(uuid) from public;
revoke all on function public.credit_run_owner(uuid) from anon;
revoke all on function public.credit_run_owner(uuid) from authenticated;

-- ── 9. Funding (service role only) ──────────────────────────────────────────

create or replace function public.grant_credits(
  p_user_id uuid,
  p_amount_credits bigint,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 200), '');
  v_existing public.credit_ledger;
  v_account public.credit_accounts;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'INVALID_CREDIT_GRANT' using errcode = '22023';
  end if;
  if p_amount_credits is null or p_amount_credits < 1 or p_amount_credits > 1000000 then
    raise exception 'INVALID_CREDIT_GRANT' using errcode = '22023';
  end if;

  v_key := coalesce(v_key, 'grant:' || gen_random_uuid()::text);

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
      'balance', v_existing.balance_after_credits,
      'reserved', v_existing.reserved_after_credits
    );
  end if;

  select * into v_account from public.lock_credit_account(p_user_id);

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
    'grant',
    p_amount_credits,
    0,
    v_account.balance_credits,
    v_account.reserved_credits,
    v_key,
    left(coalesce(p_reason, 'Credit grant'), 500),
    jsonb_build_object('source', 'service_role')
  );

  return jsonb_build_object(
    'status', 'applied',
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

revoke all on function public.grant_credits(uuid, bigint, text, text) from public;
revoke all on function public.grant_credits(uuid, bigint, text, text) from anon;
revoke all on function public.grant_credits(uuid, bigint, text, text) from authenticated;
grant execute on function public.grant_credits(uuid, bigint, text, text) to service_role;

comment on function public.grant_credits(uuid, bigint, text, text) is
  'Service-role-only credit funding entry. Idempotent per (user, key); a reused key with a different amount is refused.';

-- ── 10. Atomic admission + reservation ──────────────────────────────────────

/**
 * ⚠️ THE JOB AND THE HOLD ARE CREATED IN ONE TRANSACTION.
 *
 * `create_generation_job` already serializes admission with an advisory lock,
 * enforces ownership, idempotency and the per-user/global caps. This wrapper
 * calls it in the same transaction and then reserves the credits. An
 * insufficient balance RAISES, which rolls back the job insert — no partial
 * reservation and no orphan run can survive.
 *
 * The reused-idempotency-key check is stricter than the base RPC: a key that
 * already names a different prompt or model is a CONFLICT, never silently the
 * old job.
 */
create or replace function public.create_generation_job_with_credits(
  p_user_id uuid,
  p_project_id text,
  p_model text,
  p_prompt text,
  p_idempotency_key text default null,
  p_dispatch_mode text default 'inline',
  p_amount_credits bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_credits constant bigint := 100000;
  v_uid uuid := p_user_id;
  v_result jsonb;
  v_status text;
  v_run public.project_runs;
  v_account public.credit_accounts;
  v_reservation public.credit_reservations;
  v_live public.credit_reservations;
  v_policy public.credit_project_policies;
  v_available bigint;
  v_amount bigint;
  v_seq integer;
  v_reservation_key text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'INVALID_USER' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtext('mavly:credit-policy'),
    hashtext(p_project_id)
  );
  select * into v_policy
  from public.credit_project_policies policy
  where policy.project_id = p_project_id and policy.enabled;
  if not found then
    raise exception 'CREDIT_POLICY_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  if p_amount_credits is distinct from v_policy.generation_cost_credits then
    raise exception 'CREDIT_POLICY_MISMATCH' using errcode = 'P0001';
  end if;
  if p_dispatch_mode is distinct from 'worker' then
    raise exception 'CREDIT_WORKER_REQUIRED' using errcode = 'P0001';
  end if;
  v_amount := v_policy.generation_cost_credits;
  if v_amount is null or v_amount < 1 or v_amount > c_max_credits then
    raise exception 'INVALID_CREDIT_AMOUNT' using errcode = '22023';
  end if;

  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  perform set_config('mavly.credit_admission_project_id', p_project_id, true);

  /**
   * Admission first: it owns the advisory lock that serializes this project's
   * requests, so the duplicate-key check below cannot race a first request.
   */
  v_result := public.create_generation_job(
    p_project_id,
    p_model,
    p_prompt,
    p_idempotency_key,
    p_dispatch_mode
  );
  v_status := v_result ->> 'status';

  if v_status not in ('created', 'existing') then
    -- rate_limited / conflict: no reservation is made.
    return v_result;
  end if;

  v_run := jsonb_populate_record(null::public.project_runs, v_result -> 'run');

  if v_status = 'existing' then
    /**
     * ⚠️ A RETRY MUST NOT BECOME A DIFFERENT REQUEST. Same key + different
     * prompt/model is rejected instead of being attached to the old job.
     */
    if v_run.model is distinct from p_model
      or left(coalesce(p_prompt, ''), 32000) is distinct from coalesce(v_run.prompt, '') then
      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'idempotency_key_reused',
        'run', to_jsonb(v_run)
      );
    end if;

    select * into v_live
    from public.credit_reservations r
    where r.run_id = v_run.id and r.status = 'reserved'
    limit 1;

    if found then
      select * into v_account from public.credit_accounts where user_id = v_uid;
      return jsonb_build_object(
        'status', 'existing',
        'run', to_jsonb(v_run),
        'reservation', to_jsonb(v_live),
        'balance', coalesce(v_account.balance_credits, 0),
        'reserved', coalesce(v_account.reserved_credits, 0)
      );
    end if;

    -- The existing job was created before credits were enabled (or already
    -- settled): return it truthfully without a new hold.
    select * into v_account from public.credit_accounts where user_id = v_uid;
    return jsonb_build_object(
      'status', 'existing',
      'run', to_jsonb(v_run),
      'reservation', null,
      'balance', coalesce(v_account.balance_credits, 0),
      'reserved', coalesce(v_account.reserved_credits, 0)
    );
  end if;

  select * into v_account from public.lock_credit_account(v_uid);
  v_available := v_account.balance_credits - v_account.reserved_credits;

  if v_available < v_amount then
    /**
     * ⚠️ RAISE, DO NOT RETURN. Returning would commit the job that
     * `create_generation_job` just inserted. The exception aborts the whole
     * transaction, including the reservation and the account row.
     */
    raise exception 'INSUFFICIENT_CREDITS'
      using errcode = 'P0001',
            detail = jsonb_build_object(
              'available', v_available,
              'required', v_amount
            )::text;
  end if;

  select count(*) + 1 into v_seq
  from public.credit_reservations r
  where r.run_id = v_run.id;

  v_reservation_key :=
    'generation:' || v_run.id::text || ':reserve:' || v_seq::text;

  update public.credit_accounts a
  set reserved_credits = a.reserved_credits + v_amount,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = v_uid
  returning * into v_account;

  insert into public.credit_reservations (
    user_id, project_id, run_id, amount_credits, status, idempotency_key, reason
  ) values (
    v_uid,
    p_project_id,
    v_run.id,
    v_amount,
    'reserved',
    v_reservation_key,
    'Generation reservation'
  )
  returning * into v_reservation;

  insert into public.credit_ledger (
    user_id, project_id, run_id, reservation_id, operation,
    amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    v_uid,
    p_project_id,
    v_run.id,
    v_reservation.id,
    'generation_reserved',
    0,
    v_amount,
    v_account.balance_credits,
    v_account.reserved_credits,
    'reserve:' || v_reservation.id::text,
    'Credits held for a generation run',
    jsonb_build_object('amount', v_amount, 'model', left(coalesce(p_model, ''), 200))
  );

  return jsonb_build_object(
    'status', 'created',
    'run', to_jsonb(v_run),
    'reservation', to_jsonb(v_reservation),
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

grant execute on function public.create_generation_job(text, text, text, text, text) to service_role;

revoke all on function public.create_generation_job_with_credits(uuid, text, text, text, text, text, bigint) from public;
revoke all on function public.create_generation_job_with_credits(uuid, text, text, text, text, text, bigint) from anon;
revoke all on function public.create_generation_job_with_credits(uuid, text, text, text, text, text, bigint) from authenticated;
grant execute on function public.create_generation_job_with_credits(uuid, text, text, text, text, text, bigint) to service_role;

comment on function public.create_generation_job_with_credits(uuid, text, text, text, text, text, bigint) is
  'Service-role-only atomic credit-aware admission. The database policy supplies the price, the project owner is rechecked, and job plus reservation commit together.';

-- ── 11. Settlement and release ──────────────────────────────────────────────

/**
 * Consume the live hold of a COMPLETED run. Owner or service role.
 *
 * Consuming twice is a no-op, not a second deduction: only `reserved` rows are
 * settled and the account update is part of the same transaction.
 */
create or replace function public.settle_generation_reservation(
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_run public.project_runs;
  v_reservation public.credit_reservations;
  v_account public.credit_accounts;
begin
  if v_uid is null and auth.role() is distinct from 'service_role' then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_owner := public.credit_run_owner(p_run_id);
  if auth.role() is distinct from 'service_role' and v_owner is distinct from v_uid then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.credit_reservations r
  where r.run_id = p_run_id and r.status = 'reserved'
  limit 1
  for update;

  if not found then
    return jsonb_build_object('status', 'noop', 'reason', 'no_live_reservation');
  end if;

  /**
   * ⚠️ ONLY A PROVEN SUCCESS SETTLES. A cancellation or failure that won the
   * run row must never be charged.
   */
  if v_run.finished_at is null or v_run.status <> 'done' or v_run.stage <> 'completed' then
    return jsonb_build_object('status', 'noop', 'reason', 'run_not_completed');
  end if;

  select * into v_account from public.lock_credit_account(v_reservation.user_id);

  if v_account.reserved_credits < v_reservation.amount_credits
    or v_account.balance_credits < v_reservation.amount_credits then
    raise exception 'CREDIT_ACCOUNT_INCONSISTENT' using errcode = 'P0001';
  end if;

  update public.credit_accounts a
  set balance_credits = a.balance_credits - v_reservation.amount_credits,
      reserved_credits = a.reserved_credits - v_reservation.amount_credits,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = v_reservation.user_id
  returning * into v_account;

  update public.credit_reservations r
  set status = 'consumed',
      consumed_credits = r.amount_credits,
      settled_at = now()
  where r.id = v_reservation.id
  returning * into v_reservation;

  insert into public.credit_ledger (
    user_id, project_id, run_id, reservation_id, operation,
    amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    v_reservation.user_id,
    v_reservation.project_id,
    v_reservation.run_id,
    v_reservation.id,
    'generation_consumed',
    -v_reservation.amount_credits,
    -v_reservation.amount_credits,
    v_account.balance_credits,
    v_account.reserved_credits,
    'settle:' || v_reservation.id::text,
    'Credits consumed by a completed generation run',
    jsonb_build_object('amount', v_reservation.amount_credits)
  );

  return jsonb_build_object(
    'status', 'settled',
    'amount', v_reservation.amount_credits,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

revoke all on function public.settle_generation_reservation(uuid) from public;
revoke all on function public.settle_generation_reservation(uuid) from anon;
grant execute on function public.settle_generation_reservation(uuid) to authenticated, service_role;

comment on function public.settle_generation_reservation(uuid) is
  'Consume the live hold of a completed run exactly once. Owner or service role; a terminal failure/cancellation never settles.';

/**
 * Release the live hold of a terminal, NOT-successful run. The trusted worker
 * or a server-side owner-checked terminal handler is the only caller.
 */
create or replace function public.release_generation_reservation(
  p_run_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.project_runs;
  v_reservation public.credit_reservations;
  v_account public.credit_accounts;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_reservation
  from public.credit_reservations r
  where r.run_id = p_run_id and r.status = 'reserved'
  limit 1
  for update;

  if not found then
    return jsonb_build_object('status', 'noop', 'reason', 'no_live_reservation');
  end if;

  if v_run.finished_at is null or v_run.status = 'done' then
    return jsonb_build_object('status', 'noop', 'reason', 'run_not_failed');
  end if;

  select * into v_account from public.lock_credit_account(v_reservation.user_id);

  if v_account.reserved_credits < v_reservation.amount_credits then
    raise exception 'CREDIT_ACCOUNT_INCONSISTENT' using errcode = 'P0001';
  end if;

  update public.credit_accounts a
  set reserved_credits = a.reserved_credits - v_reservation.amount_credits,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = v_reservation.user_id
  returning * into v_account;

  update public.credit_reservations r
  set status = 'released',
      released_credits = r.amount_credits,
      settled_at = now(),
      reason = left(coalesce(p_reason, r.reason), 500)
  where r.id = v_reservation.id
  returning * into v_reservation;

  insert into public.credit_ledger (
    user_id, project_id, run_id, reservation_id, operation,
    amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    v_reservation.user_id,
    v_reservation.project_id,
    v_reservation.run_id,
    v_reservation.id,
    'generation_released',
    0,
    -v_reservation.amount_credits,
    v_account.balance_credits,
    v_account.reserved_credits,
    'release:' || v_reservation.id::text,
    left(coalesce(p_reason, 'Reservation released after a terminal failure'), 500),
    jsonb_build_object('amount', v_reservation.amount_credits)
  );

  return jsonb_build_object(
    'status', 'released',
    'amount', v_reservation.amount_credits,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

revoke all on function public.release_generation_reservation(uuid, text) from public;
revoke all on function public.release_generation_reservation(uuid, text) from anon;
revoke all on function public.release_generation_reservation(uuid, text) from authenticated;
grant execute on function public.release_generation_reservation(uuid, text) to service_role;

comment on function public.release_generation_reservation(uuid, text) is
  'Service-role-only release of a terminal failed/cancelled/interrupted run exactly once. A completed run is never released.';

create or replace function public.finish_credit_generation_run(
  p_user_id uuid,
  p_project_id text,
  p_run_id uuid,
  p_status text,
  p_stage text,
  p_error_code text default null,
  p_error_message text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.project_runs;
  v_policy public.credit_project_policies;
  v_release jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status not in ('error', 'cancelled')
    or (p_status = 'cancelled' and p_stage <> 'cancelled')
    or (p_status = 'error' and p_stage not in ('failed', 'interrupted')) then
    raise exception 'INVALID_TERMINAL_STATE' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = p_user_id
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('mavly:credit-policy'),
    hashtext(p_project_id)
  );
  select * into v_policy
  from public.credit_project_policies policy
  where policy.project_id = p_project_id and policy.enabled;
  if not found then
    return jsonb_build_object('status', 'not_credit_project');
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id and r.project_id = p_project_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_run.finished_at is not null then
    return jsonb_build_object('status', 'already_terminal');
  end if;
  if v_run.dispatch_mode <> 'worker' then
    raise exception 'CREDIT_WORKER_REQUIRED' using errcode = '42501';
  end if;

  update public.project_runs r
  set status = case when p_status = 'cancelled' then 'error' else p_status end,
      stage = p_stage,
      finished_at = now(),
      last_progress_at = now(),
      cancellation_requested_at = case
        when p_status = 'cancelled' then coalesce(r.cancellation_requested_at, now())
        else r.cancellation_requested_at
      end,
      error_code = left(nullif(btrim(coalesce(p_error_code, '')), ''), 120),
      error_message = left(nullif(coalesce(p_error_message, ''), ''), 2000)
  where r.id = p_run_id
  returning * into v_run;

  v_release := public.release_generation_reservation(p_run_id, p_reason);
  if coalesce(v_release ->> 'status', '') not in ('released', 'noop') then
    raise exception 'CREDIT_RELEASE_FAILED' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', p_status,
    'run_id', v_run.id,
    'release', v_release ->> 'status'
  );
end;
$$;

revoke all on function public.finish_credit_generation_run(uuid, text, uuid, text, text, text, text, text) from public;
revoke all on function public.finish_credit_generation_run(uuid, text, uuid, text, text, text, text, text) from anon;
revoke all on function public.finish_credit_generation_run(uuid, text, uuid, text, text, text, text, text) from authenticated;
grant execute on function public.finish_credit_generation_run(uuid, text, uuid, text, text, text, text, text) to service_role;

comment on function public.finish_credit_generation_run(uuid, text, uuid, text, text, text, text, text) is
  'Service-role-only owner-checked failure/cancellation transition for a credit project. The terminal state and reservation release commit atomically.';

-- ── 12. Refund (service role only) ──────────────────────────────────────────

/**
 * Refund part or all of a CONSUMED hold. Service role only: this is an operator
 * / support action, never something a user can trigger to recover a charge.
 *
 * Idempotent on (user, key). Without a key one is derived from the reservation
 * and requested amount, so an identical retry cannot apply the same refund
 * twice. Separate intentional partial refunds should supply distinct keys.
 */
create or replace function public.refund_generation_reservation(
  p_run_id uuid,
  p_amount_credits bigint default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.credit_reservations;
  v_account public.credit_accounts;
  v_amount bigint;
  v_remaining bigint;
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 200), '');
  v_existing public.credit_ledger;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.credit_reservations r
  where r.run_id = p_run_id and r.status = 'consumed'
  order by r.settled_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('status', 'noop', 'reason', 'no_consumed_reservation');
  end if;

  v_remaining := v_reservation.amount_credits - v_reservation.refunded_credits;
  if v_remaining <= 0 then
    return jsonb_build_object('status', 'noop', 'reason', 'already_refunded');
  end if;

  v_amount := coalesce(p_amount_credits, v_remaining);
  if v_amount < 1 or v_amount > v_remaining then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;

  v_key := coalesce(
    v_key,
    'refund:' || v_reservation.id::text || ':amount:' || v_amount::text
  );

  select * into v_existing
  from public.credit_ledger l
  where l.user_id = v_reservation.user_id and l.idempotency_key = v_key;

  if found then
    if v_existing.operation <> 'generation_refunded'
      or v_existing.reservation_id is distinct from v_reservation.id
      or v_existing.amount_credits is distinct from v_amount then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '22000';
    end if;
    return jsonb_build_object('status', 'existing', 'amount', v_existing.amount_credits);
  end if;

  select * into v_account from public.lock_credit_account(v_reservation.user_id);

  update public.credit_accounts a
  set balance_credits = a.balance_credits + v_amount,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = v_reservation.user_id
  returning * into v_account;

  update public.credit_reservations r
  set refunded_credits = r.refunded_credits + v_amount
  where r.id = v_reservation.id
  returning * into v_reservation;

  insert into public.credit_ledger (
    user_id, project_id, run_id, reservation_id, operation,
    amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    v_reservation.user_id,
    v_reservation.project_id,
    v_reservation.run_id,
    v_reservation.id,
    'generation_refunded',
    v_amount,
    0,
    v_account.balance_credits,
    v_account.reserved_credits,
    v_key,
    left(coalesce(p_reason, 'Refund of consumed generation credits'), 500),
    jsonb_build_object('amount', v_amount)
  );

  return jsonb_build_object(
    'status', 'refunded',
    'amount', v_amount,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

revoke all on function public.refund_generation_reservation(uuid, bigint, text, text) from public;
revoke all on function public.refund_generation_reservation(uuid, bigint, text, text) from anon;
revoke all on function public.refund_generation_reservation(uuid, bigint, text, text) from authenticated;
grant execute on function public.refund_generation_reservation(uuid, bigint, text, text) to service_role;

comment on function public.refund_generation_reservation(uuid, bigint, text, text) is
  'Service-role-only audited refund of consumed credits. Idempotent per (user, key) and bounded by the reservation amount.';

-- ── 13. Balance read ────────────────────────────────────────────────────────

create or replace function public.get_credit_account()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_account public.credit_accounts;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_account
  from public.credit_accounts a
  where a.user_id = v_uid;

  if not found then
    return jsonb_build_object(
      'exists', false,
      'balance', 0,
      'reserved', 0,
      'available', 0
    );
  end if;

  return jsonb_build_object(
    'exists', true,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits,
    'available', v_account.balance_credits - v_account.reserved_credits
  );
end;
$$;

revoke all on function public.get_credit_account() from public;
revoke all on function public.get_credit_account() from anon;
grant execute on function public.get_credit_account() to authenticated;

-- ── 14. Usage recording ─────────────────────────────────────────────────────

-- A JSON token/cost field may be null, a number or a numeric string. Anything
-- else is unknown (NULL), never zero.
create or replace function public.credit_json_number(payload jsonb, p_key text)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := nullif(btrim(coalesce(payload ->> p_key, '')), '');
begin
  if v_text is null then
    return null;
  end if;
  begin
    return v_text::numeric;
  exception when others then
    return null;
  end;
end;
$$;

revoke all on function public.credit_json_number(jsonb, text) from public;
revoke all on function public.credit_json_number(jsonb, text) from anon;
revoke all on function public.credit_json_number(jsonb, text) from authenticated;

create index if not exists credit_reservations_live_created_idx
  on public.credit_reservations (created_at)
  where status = 'reserved';

/**
 * One usage row per provider attempt of a generation run.
 *
 * ⚠️ EVERY FIELD IS DERIVED FROM `project_runs.provider_attempts`, which the
 * server pipeline writes. The caller supplies only the run id, so a browser
 * cannot invent tokens, a model or a cost. Re-running it is safe.
 */
create or replace function public.record_ai_usage_attempts(
  p_run_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.project_runs;
  v_owner uuid;
  v_attempt jsonb;
  v_index integer;
  v_row_count integer;
  v_inserted integer := 0;
  v_model text;
  v_prompt bigint;
  v_completion bigint;
  v_reasoning bigint;
  v_total bigint;
  v_cached_read bigint;
  v_cached_write bigint;
  v_actual numeric;
  v_estimate numeric;
  v_rate_version text;
  v_error text;
  v_usage_source text;
  v_cost_source text;
  v_status text;
  v_uncertain boolean;
begin
  if v_uid is null and auth.role() is distinct from 'service_role' then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_run from public.project_runs r where r.id = p_run_id;
  if not found then
    return 0;
  end if;

  v_owner := public.credit_run_owner(p_run_id);
  if auth.role() is distinct from 'service_role' and v_owner is distinct from v_uid then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_owner is null then
    return 0;
  end if;

  if jsonb_typeof(v_run.provider_attempts) is distinct from 'array' then
    return 0;
  end if;

  for v_attempt, v_index in
    select value, ordinality::integer
    from jsonb_array_elements(v_run.provider_attempts) with ordinality
    order by ordinality
  loop
    v_model := coalesce(
      nullif(v_attempt ->> 'model', ''),
      nullif(v_attempt ->> 'requestedModel', ''),
      nullif(v_run.model, ''),
      'unknown'
    );
    v_error := nullif(v_attempt ->> 'errorCode', '');
    v_prompt := public.credit_json_number(v_attempt, 'promptTokens')::bigint;
    v_completion := public.credit_json_number(v_attempt, 'completionTokens')::bigint;
    v_reasoning := public.credit_json_number(v_attempt, 'reasoningTokens')::bigint;
    v_total := public.credit_json_number(v_attempt, 'totalTokens')::bigint;
    v_cached_read := public.credit_json_number(v_attempt, 'cachedReadTokens')::bigint;
    v_cached_write := public.credit_json_number(v_attempt, 'cachedWriteTokens')::bigint;
    v_actual := public.credit_json_number(v_attempt, 'costUsd');

    if v_actual is not null and v_actual < 0 then
      v_actual := null;
    end if;

    v_usage_source := case
      when v_prompt is not null or v_completion is not null or v_total is not null
        or v_reasoning is not null or v_actual is not null
      then 'provider'
      else 'unavailable'
    end;

    select e.estimated_cost_usd, e.rate_version
    into v_estimate, v_rate_version
    from public.ai_estimate_cost_usd(v_model, v_prompt, v_completion, v_cached_read) e;

    v_uncertain := v_error in ('TIMEOUT', 'NETWORK');

    if v_actual is not null then
      v_cost_source := 'provider_reported';
      v_status := 'reconciled';
    elsif v_uncertain then
      v_cost_source := case when v_estimate is not null then 'rate_card' else 'unavailable' end;
      v_status := 'uncertain';
    elsif v_estimate is not null then
      v_cost_source := 'rate_card';
      v_status := 'unreconciled';
    else
      v_cost_source := 'unavailable';
      v_status := 'unavailable';
    end if;

    insert into public.ai_usage_attempts (
      attempt_key, user_id, project_id, run_id, role, task_key, attempt_index,
      provider, model, requested_model, provider_request_id,
      prompt_tokens, completion_tokens, cached_read_tokens, cached_write_tokens,
      reasoning_tokens, total_tokens, usage_source,
      estimated_cost_usd, actual_cost_usd, cost_source, rate_version,
      reconciliation_status, uncertain, metadata
    ) values (
      'run:' || v_run.id::text || ':attempt:' || v_index::text,
      v_owner,
      v_run.project_id,
      v_run.id,
      nullif(v_attempt ->> 'phase', ''),
      'generation',
      coalesce(nullif(public.credit_json_number(v_attempt, 'attempt'), 0)::integer, v_index),
      'openrouter',
      v_model,
      nullif(v_attempt ->> 'requestedModel', ''),
      nullif(v_attempt ->> 'providerRequestId', ''),
      v_prompt,
      v_completion,
      v_cached_read,
      v_cached_write,
      v_reasoning,
      v_total,
      v_usage_source,
      v_estimate,
      v_actual,
      v_cost_source,
      v_rate_version,
      v_status,
      v_uncertain,
      jsonb_build_object(
        'phase', nullif(v_attempt ->> 'phase', ''),
        'status', public.credit_json_number(v_attempt, 'status'),
        'finishReason', nullif(v_attempt ->> 'finishReason', ''),
        'errorCode', v_error
      )
    )
    on conflict (attempt_key) do nothing;

    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  return v_inserted;
end;
$$;

revoke all on function public.record_ai_usage_attempts(uuid) from public;
revoke all on function public.record_ai_usage_attempts(uuid) from anon;
grant execute on function public.record_ai_usage_attempts(uuid) to authenticated, service_role;

comment on function public.record_ai_usage_attempts(uuid) is
  'Derive one usage row per provider attempt from the server-written run row. Owner or service role; idempotent per attempt.';

/**
 * One orchestration role call. Service role only: the worker records what the
 * provider reported for a planner/UI-UX/repair call. A cost the provider did
 * not report stays NULL unless an operator rate card exists.
 */
create or replace function public.record_ai_usage_attempt(
  p_attempt_key text,
  p_user_id uuid,
  p_project_id text,
  p_workflow_id uuid,
  p_role text,
  p_task_key text,
  p_attempt_index integer,
  p_model text,
  p_provider text default 'openrouter',
  p_requested_model text default null,
  p_provider_request_id text default null,
  p_prompt_tokens bigint default null,
  p_completion_tokens bigint default null,
  p_cached_read_tokens bigint default null,
  p_cached_write_tokens bigint default null,
  p_reasoning_tokens bigint default null,
  p_total_tokens bigint default null,
  p_actual_cost_usd numeric default null,
  p_uncertain boolean default false,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := nullif(left(btrim(coalesce(p_attempt_key, '')), 300), '');
  v_actual numeric := p_actual_cost_usd;
  v_estimate numeric;
  v_rate_version text;
  v_usage_source text;
  v_cost_source text;
  v_status text;
  v_rows integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_key is null or p_user_id is null or p_project_id is null
    or p_workflow_id is null or p_model is null then
    raise exception 'INVALID_USAGE_ATTEMPT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = p_user_id
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_actual is not null and v_actual < 0 then
    v_actual := null;
  end if;

  v_usage_source := case
    when p_prompt_tokens is not null or p_completion_tokens is not null
      or p_total_tokens is not null or p_reasoning_tokens is not null
      or v_actual is not null
    then 'provider'
    else 'unavailable'
  end;

  select e.estimated_cost_usd, e.rate_version
  into v_estimate, v_rate_version
  from public.ai_estimate_cost_usd(p_model, p_prompt_tokens, p_completion_tokens, p_cached_read_tokens) e;

  if v_actual is not null then
    v_cost_source := 'provider_reported';
    v_status := 'reconciled';
  elsif coalesce(p_uncertain, false) then
    v_cost_source := case when v_estimate is not null then 'rate_card' else 'unavailable' end;
    v_status := 'uncertain';
  elsif v_estimate is not null then
    v_cost_source := 'rate_card';
    v_status := 'unreconciled';
  else
    v_cost_source := 'unavailable';
    v_status := 'unavailable';
  end if;

  insert into public.ai_usage_attempts (
    attempt_key, user_id, project_id, workflow_id, role, task_key, attempt_index,
    provider, model, requested_model, provider_request_id,
    prompt_tokens, completion_tokens, cached_read_tokens, cached_write_tokens,
    reasoning_tokens, total_tokens, usage_source,
    estimated_cost_usd, actual_cost_usd, cost_source, rate_version,
    reconciliation_status, uncertain, metadata
  ) values (
    v_key, p_user_id, p_project_id, p_workflow_id,
    left(nullif(btrim(coalesce(p_role, '')), ''), 40),
    left(nullif(btrim(coalesce(p_task_key, '')), ''), 80),
    coalesce(p_attempt_index, 1),
    left(p_model, 200),
    left(coalesce(p_provider, 'openrouter'), 40),
    left(p_requested_model, 200),
    left(p_provider_request_id, 200),
    p_prompt_tokens, p_completion_tokens, p_cached_read_tokens, p_cached_write_tokens,
    p_reasoning_tokens, p_total_tokens, v_usage_source,
    v_estimate, v_actual, v_cost_source, v_rate_version,
    v_status, coalesce(p_uncertain, false),
    case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end
  )
  on conflict (attempt_key) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.record_ai_usage_attempt(
  text, uuid, text, uuid, text, text, integer, text, text, text, text,
  bigint, bigint, bigint, bigint, bigint, bigint, numeric, boolean, jsonb
) from public;
revoke all on function public.record_ai_usage_attempt(
  text, uuid, text, uuid, text, text, integer, text, text, text, text,
  bigint, bigint, bigint, bigint, bigint, bigint, numeric, boolean, jsonb
) from anon;
revoke all on function public.record_ai_usage_attempt(
  text, uuid, text, uuid, text, text, integer, text, text, text, text,
  bigint, bigint, bigint, bigint, bigint, bigint, numeric, boolean, jsonb
) from authenticated;
grant execute on function public.record_ai_usage_attempt(
  text, uuid, text, uuid, text, text, integer, text, text, text, text,
  bigint, bigint, bigint, bigint, bigint, bigint, numeric, boolean, jsonb
) to service_role;

comment on function public.record_ai_usage_attempt(
  text, uuid, text, uuid, text, text, integer, text, text, text, text,
  bigint, bigint, bigint, bigint, bigint, bigint, numeric, boolean, jsonb
) is
  'Service-role-only per-role usage row. Provider-reported cost and tokens are recorded verbatim; unknown cost stays NULL.';

-- ── 15. Recovery / reconciliation ───────────────────────────────────────────

/**
 * Release holds whose run row no longer exists.
 *
 * A project delete cascades its runs, and a hold is keyed by run id rather than
 * a foreign key (the run may be gone while the hold still owes an accounting
 * entry). Without this sweep such a hold would reduce `available` forever.
 *
 * Service role only, bounded, and it only ever reverses a hold whose run is
 * genuinely absent and which is older than the grace window.
 */
create or replace function public.release_orphaned_credit_reservations(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_rec record;
  v_res public.credit_reservations;
  v_account public.credit_accounts;
  v_released integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  for v_rec in
    select res.id
    from public.credit_reservations res
    where res.status = 'reserved'
      and res.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.project_runs r where r.id = res.run_id
      )
    order by res.created_at asc
    limit v_limit
  loop
    select * into v_res
    from public.credit_reservations r
    where r.id = v_rec.id
    for update;

    -- Re-check under the lock: another tick may have settled or released it.
    if not found or v_res.status <> 'reserved' then
      continue;
    end if;
    if exists (select 1 from public.project_runs r where r.id = v_res.run_id) then
      continue;
    end if;

    select * into v_account from public.lock_credit_account(v_res.user_id);

    if v_account.reserved_credits < v_res.amount_credits then
      -- Inconsistent account: leave it for an operator rather than guess.
      continue;
    end if;

    update public.credit_accounts a
    set reserved_credits = a.reserved_credits - v_res.amount_credits,
        version = a.version + 1,
        updated_at = now()
    where a.user_id = v_res.user_id
    returning * into v_account;

    update public.credit_reservations r
    set status = 'released',
        released_credits = r.amount_credits,
        settled_at = now(),
        reason = 'Released because the generation run no longer exists'
    where r.id = v_res.id
    returning * into v_res;

    insert into public.credit_ledger (
      user_id, project_id, run_id, reservation_id, operation,
      amount_credits, reserved_delta_credits,
      balance_after_credits, reserved_after_credits,
      idempotency_key, reason, metadata
    ) values (
      v_res.user_id,
      v_res.project_id,
      v_res.run_id,
      v_res.id,
      'generation_released',
      0,
      -v_res.amount_credits,
      v_account.balance_credits,
      v_account.reserved_credits,
      'release:' || v_res.id::text,
      'Released because the generation run no longer exists',
      jsonb_build_object('amount', v_res.amount_credits, 'orphaned', true)
    );

    v_released := v_released + 1;
  end loop;

  return v_released;
end;
$$;

revoke all on function public.release_orphaned_credit_reservations(integer) from public;
revoke all on function public.release_orphaned_credit_reservations(integer) from anon;
revoke all on function public.release_orphaned_credit_reservations(integer) from authenticated;
grant execute on function public.release_orphaned_credit_reservations(integer) to service_role;

comment on function public.release_orphaned_credit_reservations(integer) is
  'Service-role-only bounded release of holds whose run row was deleted. Never touches a hold whose run still exists.';

/**
 * Owner-scoped settlement recovery. Called by the owner's balance read, so a
 * crash between "run completed" and "credits settled" is repaired the next time
 * the workspace loads. It only ever applies what the terminal run state already
 * dictates, and it is bounded.
 */
create or replace function public.reconcile_owner_credits()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_rec record;
  v_settled integer := 0;
  v_released integer := 0;
  v_usage integer := 0;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  for v_rec in
    select res.run_id
    from public.credit_reservations res
    join public.project_runs r on r.id = res.run_id
    where res.user_id = v_uid
      and res.status = 'reserved'
      and r.finished_at is not null
      and r.status = 'done'
      and r.stage = 'completed'
    order by res.created_at asc
    limit 25
  loop
    begin
      perform public.settle_generation_reservation(v_rec.run_id);
      v_settled := v_settled + 1;
    exception when others then
      -- Bounded best effort: the worker sweep retries a row this read could not fix.
      null;
    end;
  end loop;

  for v_rec in
    select r.id
    from public.project_runs r
    join public.projects p on p.project_id = r.project_id
    where p.user_id = v_uid
      and r.finished_at is not null
      and jsonb_typeof(r.provider_attempts) = 'array'
      and jsonb_array_length(r.provider_attempts) > 0
      and not exists (
        select 1 from public.ai_usage_attempts a where a.run_id = r.id
      )
    order by r.finished_at desc
    limit 10
  loop
    begin
      v_usage := v_usage + public.record_ai_usage_attempts(v_rec.id);
    exception when others then
      null;
    end;
  end loop;

  return jsonb_build_object(
    'settled', v_settled,
    'released', v_released,
    'usageRows', v_usage
  );
end;
$$;

revoke all on function public.reconcile_owner_credits() from public;
revoke all on function public.reconcile_owner_credits() from anon;
grant execute on function public.reconcile_owner_credits() to authenticated;

comment on function public.reconcile_owner_credits() is
  'Owner-scoped, bounded repair of reservations whose run already reached a terminal state. Never charges a failed run.';

/**
 * Worker-scoped sweep. The durable worker calls this once per tick, so an
 * inline or worker crash between the terminal run write and settlement is
 * repaired without a user session.
 */
create or replace function public.maintain_credit_reservations(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_rec record;
  v_settled integer := 0;
  v_released integer := 0;
  v_usage integer := 0;
  v_orphans integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- A deleted project cascades its runs; the hold would otherwise never settle.
  v_orphans := public.release_orphaned_credit_reservations(v_limit);

  for v_rec in
    select res.run_id
    from public.credit_reservations res
    join public.project_runs r on r.id = res.run_id
    where res.status = 'reserved'
      and r.finished_at is not null
    order by res.created_at asc
    limit v_limit
  loop
    begin
      if exists (
        select 1 from public.project_runs r
        where r.id = v_rec.run_id
          and r.status = 'done'
          and r.stage = 'completed'
      ) then
        perform public.settle_generation_reservation(v_rec.run_id);
        v_settled := v_settled + 1;
      else
        perform public.release_generation_reservation(
          v_rec.run_id,
          'Released by the durable worker sweep'
        );
        v_released := v_released + 1;
      end if;
    exception when others then
      null;
    end;
  end loop;

  for v_rec in
    select r.id
    from public.project_runs r
    where r.finished_at is not null
      and jsonb_typeof(r.provider_attempts) = 'array'
      and jsonb_array_length(r.provider_attempts) > 0
      and not exists (
        select 1 from public.ai_usage_attempts a where a.run_id = r.id
      )
    order by r.finished_at desc
    limit v_limit
  loop
    begin
      v_usage := v_usage + public.record_ai_usage_attempts(v_rec.id);
    exception when others then
      null;
    end;
  end loop;

  return jsonb_build_object(
    'settled', v_settled,
    'released', v_released,
    'orphansReleased', v_orphans,
    'usageRows', v_usage
  );
end;
$$;

revoke all on function public.maintain_credit_reservations(integer) from public;
revoke all on function public.maintain_credit_reservations(integer) from anon;
revoke all on function public.maintain_credit_reservations(integer) from authenticated;
grant execute on function public.maintain_credit_reservations(integer) to service_role;

comment on function public.maintain_credit_reservations(integer) is
  'Service-role-only bounded sweep: settle completed runs, release terminal failures, backfill usage rows.';

revoke all on function public.credit_schema_version() from public;
revoke all on function public.credit_schema_version() from anon;
grant execute on function public.credit_schema_version() to authenticated, service_role;

-- ── 16. Credit-aware resume ─────────────────────────────────────────────────

/**
 * Re-open a failed/interrupted run AND hold credits for the continuation.
 *
 * ⚠️ A RESUME IS A NEW ATTEMPT, SO IT NEEDS A NEW HOLD ONLY WHEN THE PREVIOUS
 * ONE WAS RELEASED. A live hold is reused (a duplicate resume request charges
 * nothing); a consumed hold means the run completed and is not resumable.
 *
 * The reserve step raises `INSUFFICIENT_CREDITS`, which rolls the run reopen
 * back — a resumed run can never start unpaid.
 */
create or replace function public.resume_generation_job_with_credits(
  p_user_id uuid,
  p_project_id text,
  p_run_id uuid,
  p_amount_credits bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_credits constant bigint := 100000;
  v_uid uuid := p_user_id;
  v_result jsonb;
  v_status text;
  v_run public.project_runs;
  v_live public.credit_reservations;
  v_account public.credit_accounts;
  v_reservation public.credit_reservations;
  v_policy public.credit_project_policies;
  v_available bigint;
  v_amount bigint;
  v_seq integer;
  v_released jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'INVALID_USER' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtext('mavly:credit-policy'),
    hashtext(p_project_id)
  );
  select * into v_policy
  from public.credit_project_policies policy
  where policy.project_id = p_project_id and policy.enabled;
  if not found then
    raise exception 'CREDIT_POLICY_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  if p_amount_credits is distinct from v_policy.generation_cost_credits then
    raise exception 'CREDIT_POLICY_MISMATCH' using errcode = 'P0001';
  end if;
  v_amount := v_policy.generation_cost_credits;
  if v_amount is null or v_amount < 1 or v_amount > c_max_credits then
    raise exception 'INVALID_CREDIT_AMOUNT' using errcode = '22023';
  end if;

  perform set_config('request.jwt.claim.sub', v_uid::text, true);

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id and r.project_id = p_project_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_resumable');
  end if;
  if v_run.dispatch_mode <> 'worker' then
    return jsonb_build_object('status', 'not_resumable', 'reason', 'worker_required');
  end if;

  select * into v_live
  from public.credit_reservations r
  where r.run_id = p_run_id and r.status = 'reserved'
  limit 1;

  if found then
    /**
     * ⚠️ A RUN HOLDS AT MOST ONE LIVE RESERVATION (partial unique index on
     * run_id where status = 'reserved'). The run row is locked above, so this
     * branch cannot race another resume.
     */
    if v_run.finished_at is null then
      -- Already queued/running: a duplicate resume must not start (or charge)
      -- a second execution.
      return jsonb_build_object('status', 'not_resumable', 'reason', 'run_active');
    end if;

    /**
     * The run is terminal but its hold was never released (a crash between the
     * terminal run write and the release). Close it in this transaction first:
     * the reopened run needs a single live hold, and a second hold would be
     * rejected by the index and roll the resume back. If it cannot be released
     * the resume is refused rather than silently holding twice.
     */
    v_released := public.release_generation_reservation(
      p_run_id,
      'Released before a resumed attempt'
    );
    if coalesce(v_released ->> 'status', '') <> 'released'
      and not (v_run.status = 'done' and v_run.stage = 'completed') then
      return jsonb_build_object(
        'status', 'not_resumable',
        'reason', coalesce(v_released ->> 'reason', 'reservation_busy')
      );
    end if;
  end if;

  perform set_config('mavly.credit_resume_project_id', p_project_id, true);
  v_result := public.resume_generation_job(p_project_id, p_run_id);
  v_status := v_result ->> 'status';
  if v_status <> 'resumed' then
    return v_result;
  end if;

  v_run := jsonb_populate_record(null::public.project_runs, v_result -> 'run');

  select * into v_account
  from public.lock_credit_account(v_uid);

  v_available := v_account.balance_credits - v_account.reserved_credits;
  if v_available < v_amount then
    raise exception 'INSUFFICIENT_CREDITS'
      using errcode = 'P0001',
            detail = jsonb_build_object(
              'available', v_available,
              'required', v_amount
            )::text;
  end if;

  select count(*) + 1 into v_seq
  from public.credit_reservations r
  where r.run_id = v_run.id;

  update public.credit_accounts a
  set reserved_credits = a.reserved_credits + v_amount,
      version = a.version + 1,
      updated_at = now()
  where a.user_id = v_uid
  returning * into v_account;

  insert into public.credit_reservations (
    user_id, project_id, run_id, amount_credits, status, idempotency_key, reason
  ) values (
    v_uid,
    p_project_id,
    v_run.id,
    v_amount,
    'reserved',
    'generation:' || v_run.id::text || ':resume:' || v_seq::text,
    'Resume reservation'
  )
  returning * into v_reservation;

  insert into public.credit_ledger (
    user_id, project_id, run_id, reservation_id, operation,
    amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits,
    idempotency_key, reason, metadata
  ) values (
    v_uid,
    p_project_id,
    v_run.id,
    v_reservation.id,
    'generation_reserved',
    0,
    v_amount,
    v_account.balance_credits,
    v_account.reserved_credits,
    'reserve:' || v_reservation.id::text,
    'Credits held for a resumed generation run',
    jsonb_build_object('amount', v_amount, 'resume', true)
  );

  return jsonb_build_object(
    'status', 'resumed',
    'run', to_jsonb(v_run),
    'reservation', to_jsonb(v_reservation),
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits
  );
end;
$$;

grant execute on function public.resume_generation_job(text, uuid) to service_role;

revoke all on function public.resume_generation_job_with_credits(uuid, text, uuid, bigint) from public;
revoke all on function public.resume_generation_job_with_credits(uuid, text, uuid, bigint) from anon;
revoke all on function public.resume_generation_job_with_credits(uuid, text, uuid, bigint) from authenticated;
grant execute on function public.resume_generation_job_with_credits(uuid, text, uuid, bigint) to service_role;

comment on function public.resume_generation_job_with_credits(uuid, text, uuid, bigint) is
  'Service-role-only owner-checked resume: database policy supplies the price, the run stays worker-dispatched, and reopening plus reservation are atomic.';

commit;
