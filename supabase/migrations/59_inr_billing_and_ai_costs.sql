-- Mavly — INR financial hardening for platform billing and AI usage.
--
-- Additive. Apply after 57_platform_billing.sql and the repository's migration
-- 58 files. Historical provider amounts
-- and legacy USD diagnostic columns are retained; new financial reporting uses
-- explicit INR paise snapshots only.

begin;

create or replace function public.billing_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$ select 59; $$;

-- Global checkout uses Dodo, but active commercial prices and Mavly's
-- authoritative financial records remain INR-only. Legacy inactive USD rows
-- are retained for historical compatibility.
alter table public.price_catalog
  drop constraint if exists price_catalog_product_key;
alter table public.price_catalog
  add constraint price_catalog_product_key
  unique (version_id, product_id, market, billing_interval);

alter table public.price_catalog
  drop constraint if exists price_catalog_currency_check;
drop trigger if exists price_catalog_immutable on public.price_catalog;
drop trigger if exists price_catalog_versions_immutable on public.price_catalog_versions;
update public.price_catalog global_row
set currency = 'INR',
    amount_minor = india_row.amount_minor,
    credits = india_row.credits,
    project_limit = india_row.project_limit,
    active = true,
    approved = true
from public.price_catalog india_row
where global_row.market = 'global'
  and global_row.currency = 'USD'
  and india_row.version_id = global_row.version_id
  and india_row.product_id = global_row.product_id
  and india_row.billing_interval = global_row.billing_interval
  and india_row.market = 'india'
  and india_row.currency = 'INR';
alter table public.price_catalog
  add constraint price_catalog_currency_check
  check (currency = 'INR' or (market = 'global' and currency = 'USD' and not active and not approved));

insert into public.price_catalog (
  version_id, product_id, product_type, plan_id, market, currency,
  billing_interval, amount_minor, credits, project_limit, active, approved
)
select v.id, seed.product_id, 'credit_pack', null, 'india', 'INR',
  'one_time', seed.amount_minor, seed.credits, null, true, true
from public.price_catalog_versions v
cross join (values
  ('starter-pack', 19900::bigint, 90::bigint),
  ('growth-pack', 29900::bigint, 300::bigint),
  ('power-pack', 79900::bigint, 1000::bigint)
) as seed(product_id, amount_minor, credits)
where v.version = '2026-11-03-inr-initial'
on conflict (version_id, product_id, market, billing_interval) do nothing;

insert into public.price_catalog (
  version_id, product_id, product_type, plan_id, market, currency,
  billing_interval, amount_minor, credits, project_limit, active, approved
)
select
  p.version_id, p.product_id, p.product_type, p.plan_id, 'global', 'INR',
  p.billing_interval, p.amount_minor, p.credits, p.project_limit, true, true
from public.price_catalog p
where p.market = 'india'
  and p.currency = 'INR'
  and p.active
  and p.approved
on conflict (version_id, product_id, market, billing_interval) do nothing;

drop trigger if exists price_catalog_immutable on public.price_catalog;
drop trigger if exists price_catalog_versions_immutable on public.price_catalog_versions;
create trigger price_catalog_immutable before update or delete on public.price_catalog
for each row execute function public.billing_catalog_reject_mutation();
create trigger price_catalog_versions_immutable before update or delete on public.price_catalog_versions
for each row execute function public.billing_catalog_reject_mutation();

alter table public.platform_payments
  add column if not exists amount_inr_paise bigint,
  add column if not exists provider_amount_minor bigint,
  add column if not exists provider_currency text,
  add column if not exists provider_subscription_id text,
  add column if not exists inr_rate_source text,
  add column if not exists inr_rate_version text;

alter table public.platform_payments
  drop constraint if exists platform_payments_amount_inr_non_negative;
alter table public.platform_payments
  add constraint platform_payments_amount_inr_non_negative
  check (amount_inr_paise is null or amount_inr_paise > 0);

create unique index if not exists platform_payments_provider_subscription_idx
  on public.platform_payments(provider, provider_subscription_id)
  where provider_subscription_id is not null;

create or replace function public.billing_attach_payment_provider(
  p_payment_id uuid,
  p_provider_order_id text default null,
  p_provider_payment_id text default null,
  p_provider_session_id text default null,
  p_provider_customer_id text default null,
  p_provider_subscription_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.platform_payments;
  v_sub public.subscriptions;
  v_price public.price_catalog;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_payment
  from public.platform_payments
  where id = p_payment_id
  for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_payment.status not in ('pending', 'processing') then
    return jsonb_build_object('status', 'existing', 'payment', to_jsonb(v_payment));
  end if;

  update public.platform_payments
  set provider_order_id = coalesce(p_provider_order_id, provider_order_id),
      provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
      provider_session_id = coalesce(p_provider_session_id, provider_session_id),
      provider_customer_id = coalesce(p_provider_customer_id, provider_customer_id),
      provider_subscription_id = coalesce(p_provider_subscription_id, provider_subscription_id),
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
      status = 'processing'
  where id = p_payment_id
  returning * into v_payment;

  if p_provider_customer_id is not null then
    insert into public.provider_customers(user_id, provider, provider_customer_id, market)
    values (v_payment.user_id, v_payment.provider, p_provider_customer_id, v_payment.market)
    on conflict (user_id, provider) do update
      set provider_customer_id = excluded.provider_customer_id;
  end if;

  if v_payment.product_type = 'subscription' and p_provider_subscription_id is not null then
    select p.* into v_price
    from public.price_catalog p
    join public.price_catalog_versions v on v.id = p.version_id
    where p.product_id = v_payment.product_id
      and v.version = v_payment.catalog_version
    limit 1;
    insert into public.subscriptions(
      user_id, plan_id, provider, provider_subscription_id,
      provider_customer_id, market, currency
    ) values (
      v_payment.user_id, v_payment.product_id, v_payment.provider,
      p_provider_subscription_id, p_provider_customer_id,
      v_payment.market, v_payment.currency
    )
    on conflict (provider, provider_subscription_id) do update
      set provider_customer_id = coalesce(excluded.provider_customer_id, subscriptions.provider_customer_id)
    returning * into v_sub;
  end if;
  return jsonb_build_object('status', 'attached', 'payment', to_jsonb(v_payment), 'subscription', to_jsonb(v_sub));
end;
$$;

revoke all on function public.billing_attach_payment_provider(uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.billing_attach_payment_provider(uuid, text, text, text, text, text, jsonb)
  to service_role;

create or replace function public.billing_attach_subscription_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'active' then
    update public.platform_payments
    set status = case when status in ('pending', 'processing', 'authorized') then 'paid' else status end,
        paid_at = coalesce(paid_at, now())
    where provider = new.provider
      and provider_subscription_id = new.provider_subscription_id;
  end if;
  return new;
end;
$$;

revoke all on function public.billing_attach_subscription_payment() from public, anon, authenticated;
drop trigger if exists subscriptions_sync_platform_payment on public.subscriptions;
create trigger subscriptions_sync_platform_payment
after insert or update of status on public.subscriptions
for each row execute function public.billing_attach_subscription_payment();

create or replace function public.billing_create_payment(
  p_user_id uuid,
  p_product_id text,
  p_market text,
  p_interval text,
  p_idempotency_key text,
  p_provider text,
  p_currency text,
  p_catalog_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_price public.price_catalog;
  v_payment public.platform_payments;
  v_catalog_version text;
  v_key text := left(btrim(coalesce(p_idempotency_key, '')), 200);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null or v_key = '' then
    raise exception 'INVALID_BILLING_REQUEST' using errcode = '22023';
  end if;
   if p_provider not in ('razorpay', 'dodo')
      or p_market not in ('india', 'global')
      or (p_market = 'india' and p_currency <> 'INR')
      or p_currency <> 'INR' then
    raise exception 'BILLING_ROUTE_MISMATCH' using errcode = 'P0001';
  end if;
  if (p_market = 'india' and p_provider <> 'razorpay')
     or (p_market = 'global' and p_provider <> 'dodo') then
    raise exception 'BILLING_ROUTE_MISMATCH' using errcode = 'P0001';
  end if;

   select p, v.version into v_price, v_catalog_version
  from public.price_catalog p
  join public.price_catalog_versions v
    on v.id = p.version_id
   and v.status = 'active'
  where p.product_id = p_product_id
    and p.market = p_market
    and p.billing_interval = p_interval
     and p.currency = p_currency
    and p.active
    and p.approved
     and (p_catalog_version is null or v.version = p_catalog_version)
  limit 1;
  if not found or v_price.amount_minor is null then
    raise exception 'PRICE_NOT_CONFIGURED' using errcode = 'P0001';
  end if;

  select * into v_payment
  from public.platform_payments
  where user_id = p_user_id and idempotency_key = v_key
  for update;
  if found then
    if v_payment.product_id <> p_product_id
       or v_payment.amount_minor <> v_price.amount_minor
       or v_payment.market <> p_market
       or v_payment.provider <> p_provider
       or v_payment.currency <> p_currency then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '22000';
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'payment', to_jsonb(v_payment),
      'credits', v_price.credits,
      'providerProductId', coalesce(v_price.razorpay_product_id, v_price.dodo_product_id)
    );
  end if;

  insert into public.platform_payments (
    user_id, provider, product_type, product_id, amount_minor, amount_inr_paise,
    currency, market, catalog_version, idempotency_key
  ) values (
    p_user_id, p_provider, v_price.product_type, v_price.product_id,
    v_price.amount_minor,
    case when v_price.currency = 'INR' then v_price.amount_minor else null end,
    v_price.currency, v_price.market,
    v_catalog_version, v_key
  ) returning * into v_payment;

  return jsonb_build_object(
    'status', 'created',
    'payment', to_jsonb(v_payment),
    'credits', v_price.credits,
    'providerProductId', coalesce(v_price.razorpay_product_id, v_price.dodo_product_id)
  );
end;
$$;

revoke all on function public.billing_create_payment(uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.billing_create_payment(uuid, text, text, text, text, text, text, text)
  to service_role;

create or replace function public.billing_mark_payment_failed(
  p_payment_id uuid,
  p_reason text default 'provider_checkout_failed'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.platform_payments;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.platform_payments
  set status = 'failed',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('failureReason', left(coalesce(p_reason, 'provider_checkout_failed'), 120))
  where id = p_payment_id and status in ('pending', 'processing')
  returning * into v_payment;
  if not found then
    select * into v_payment from public.platform_payments where id = p_payment_id;
  end if;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', v_payment.status, 'payment', to_jsonb(v_payment));
end;
$$;

revoke all on function public.billing_mark_payment_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_mark_payment_failed(uuid, text) to service_role;

-- Provider-native amount/currency is diagnostic reconciliation data. INR is the
-- only value used for Mavly revenue, refunds, margin and entitlement accounting.
alter table public.platform_payments
  add column if not exists amount_inr_paise bigint,
  add column if not exists provider_amount_minor bigint,
  add column if not exists provider_currency text,
  add column if not exists inr_rate_source text,
  add column if not exists inr_rate_version text;

update public.platform_payments
set amount_inr_paise = amount_minor
where amount_inr_paise is null and currency = 'INR';

alter table public.invoices
  add column if not exists amount_inr_paise bigint,
  add column if not exists provider_amount_minor bigint,
  add column if not exists provider_currency text;

alter table public.billing_refunds
  add column if not exists amount_inr_paise bigint,
  add column if not exists provider_amount_minor bigint,
  add column if not exists provider_currency text,
  add column if not exists idempotency_key text;

alter table public.billing_refunds
  drop constraint if exists billing_refunds_amount_inr_non_negative;
alter table public.billing_refunds
  add constraint billing_refunds_amount_inr_non_negative
  check (amount_inr_paise is null or amount_inr_paise > 0);

create unique index if not exists billing_refunds_idempotency_idx
  on public.billing_refunds(idempotency_key)
  where idempotency_key is not null;

create or replace function public.snapshot_billing_refund_inr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.currency = 'INR' then
    new.amount_inr_paise := new.amount_minor;
    new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
    new.provider_currency := coalesce(new.provider_currency, new.currency);
  end if;
  return new;
end;
$$;

revoke all on function public.snapshot_billing_refund_inr() from public, anon, authenticated;
drop trigger if exists billing_refunds_inr_snapshot on public.billing_refunds;
create trigger billing_refunds_inr_snapshot
before insert or update on public.billing_refunds
for each row execute function public.snapshot_billing_refund_inr();

alter table public.billing_reconciliation
  add column if not exists expected_inr_paise bigint,
  add column if not exists actual_inr_paise bigint;

create or replace function public.snapshot_platform_payment_inr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'paid' and new.currency = 'INR' then
    new.amount_inr_paise := new.amount_minor;
    new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
    new.provider_currency := coalesce(new.provider_currency, new.currency);
    new.inr_rate_source := coalesce(new.inr_rate_source, 'provider_currency_inr');
    new.inr_rate_version := coalesce(new.inr_rate_version, 'identity');
  end if;
  return new;
end;
$$;

revoke all on function public.snapshot_platform_payment_inr() from public, anon, authenticated;
drop trigger if exists platform_payments_inr_snapshot on public.platform_payments;
create trigger platform_payments_inr_snapshot
before insert or update on public.platform_payments
for each row execute function public.snapshot_platform_payment_inr();

-- Explicit exchange-rate records are optional. A non-INR provider event is
-- never granted or reported as INR without one of these operator/audited rows.
create table if not exists public.billing_inr_exchange_rates (
  id uuid primary key default gen_random_uuid(),
  from_currency text not null,
  to_currency text not null default 'INR',
  inr_paise_per_provider_minor numeric(30,12) not null,
  source text not null,
  version text not null,
  effective_from timestamptz not null,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint billing_inr_exchange_rate_currency check (from_currency <> 'INR' and to_currency = 'INR'),
  constraint billing_inr_exchange_rate_positive check (inr_paise_per_provider_minor > 0),
  unique (from_currency, effective_from, version)
);

alter table public.billing_inr_exchange_rates enable row level security;
revoke all on public.billing_inr_exchange_rates from public, anon, authenticated;
grant select, insert, update, delete on public.billing_inr_exchange_rates to service_role;

create or replace function public.billing_inr_amount_for_provider(
  p_currency text,
  p_amount_minor bigint,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_currency text := upper(nullif(btrim(coalesce(p_currency, '')), ''));
  v_rate public.billing_inr_exchange_rates;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_amount_minor is null or p_amount_minor < 0 or v_currency is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  if v_currency = 'INR' then
    return jsonb_build_object('ok', true, 'amountInrPaise', p_amount_minor, 'source', 'provider_currency_inr', 'rateVersion', 'identity');
  end if;
  select * into v_rate
  from public.billing_inr_exchange_rates
  where from_currency = v_currency
    and effective_from <= coalesce(p_at, now())
  order by effective_from desc
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'rate_missing', 'currency', v_currency);
  end if;
  return jsonb_build_object(
    'ok', true,
    'amountInrPaise', round(p_amount_minor::numeric * v_rate.inr_paise_per_provider_minor)::bigint,
    'source', 'provider_currency_converted',
    'rateVersion', v_rate.version
  );
end;
$$;

revoke all on function public.billing_inr_amount_for_provider(text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.billing_inr_amount_for_provider(text, bigint, timestamptz)
  to service_role;

-- Re-define the snapshots after the exchange-rate table exists so approved
-- non-INR provider settlements can be reported in INR only when an explicit
-- operator/audited rate is available.
create or replace function public.snapshot_platform_payment_inr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fx public.billing_inr_exchange_rates;
begin
  if new.status = 'paid' then
    if new.currency = 'INR' then
      new.amount_inr_paise := new.amount_minor;
      new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
      new.provider_currency := coalesce(new.provider_currency, new.currency);
      new.inr_rate_source := coalesce(new.inr_rate_source, 'provider_currency_inr');
      new.inr_rate_version := coalesce(new.inr_rate_version, 'identity');
    else
      select * into v_fx from public.billing_inr_exchange_rates
      where from_currency = new.currency and effective_from <= coalesce(new.paid_at, now())
      order by effective_from desc limit 1;
      if found then
        new.amount_inr_paise := round(new.amount_minor * v_fx.inr_paise_per_provider_minor)::bigint;
        new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
        new.provider_currency := coalesce(new.provider_currency, new.currency);
        new.inr_rate_source := 'provider_currency_converted';
        new.inr_rate_version := v_fx.version;
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.snapshot_billing_refund_inr()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fx public.billing_inr_exchange_rates;
begin
  if new.currency = 'INR' then
    new.amount_inr_paise := new.amount_minor;
    new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
    new.provider_currency := coalesce(new.provider_currency, new.currency);
  else
    select * into v_fx from public.billing_inr_exchange_rates
    where from_currency = new.currency and effective_from <= now()
    order by effective_from desc limit 1;
    if found then
      new.amount_inr_paise := round(new.amount_minor * v_fx.inr_paise_per_provider_minor)::bigint;
      new.provider_amount_minor := coalesce(new.provider_amount_minor, new.amount_minor);
      new.provider_currency := coalesce(new.provider_currency, new.currency);
    end if;
  end if;
  return new;
end;
$$;

-- ── INR AI rate card and usage snapshots ─────────────────────────────────────

alter table public.ai_cost_rates
  add column if not exists input_inr_paise_per_million numeric(30,12),
  add column if not exists output_inr_paise_per_million numeric(30,12),
  add column if not exists cached_input_inr_paise_per_million numeric(30,12),
  add column if not exists currency text not null default 'INR';

alter table public.ai_cost_rates
  drop constraint if exists ai_cost_rates_currency_check;
alter table public.ai_cost_rates
  add constraint ai_cost_rates_currency_check check (currency = 'INR');

alter table public.ai_usage_attempts
  add column if not exists estimated_cost_inr_paise numeric(30,6),
  add column if not exists actual_cost_inr_paise numeric(30,6),
  add column if not exists cost_currency text not null default 'INR',
  add column if not exists inr_cost_source text,
  add column if not exists inr_rate_version text;

alter table public.ai_usage_attempts
  drop constraint if exists ai_usage_attempts_inr_cost_non_negative;
alter table public.ai_usage_attempts
  add constraint ai_usage_attempts_inr_cost_non_negative
  check ((estimated_cost_inr_paise is null or estimated_cost_inr_paise >= 0)
    and (actual_cost_inr_paise is null or actual_cost_inr_paise >= 0));

alter table public.project_runs
  add column if not exists reported_cost_inr_paise numeric(30,6),
  add column if not exists cost_currency text not null default 'INR',
  add column if not exists inr_cost_source text;

alter table public.agent_workflows
  add column if not exists reported_cost_inr_paise numeric(30,6),
  add column if not exists cost_currency text not null default 'INR',
  add column if not exists inr_cost_source text;

create or replace function public.refresh_ai_usage_inr_cost()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate public.ai_cost_rates;
  v_fx public.billing_inr_exchange_rates;
  v_prompt bigint := greatest(coalesce(new.prompt_tokens, 0), 0);
  v_cached bigint := least(greatest(coalesce(new.cached_read_tokens, 0), 0), v_prompt);
  v_completion bigint := greatest(coalesce(new.completion_tokens, 0), 0);
  v_estimated numeric;
  v_actual numeric;
begin
  select * into v_rate
  from public.ai_cost_rates
  where model = new.model
    and input_inr_paise_per_million is not null
    and output_inr_paise_per_million is not null
  order by effective_from desc
  limit 1;

  if found then
    v_estimated := round((
      (v_prompt - v_cached) * v_rate.input_inr_paise_per_million
      + v_cached * coalesce(v_rate.cached_input_inr_paise_per_million, v_rate.input_inr_paise_per_million)
      + v_completion * v_rate.output_inr_paise_per_million
    ) / 1000000, 6);
  end if;

  -- OpenRouter's legacy provider-reported value is USD diagnostic metadata.
  -- Convert it only when an explicit, versioned INR rate exists; otherwise the
  -- authoritative INR value remains NULL/unknown.
  if new.actual_cost_usd is not null then
    select * into v_fx
    from public.billing_inr_exchange_rates
    where from_currency = 'USD'
      and effective_from <= coalesce(new.created_at, now())
    order by effective_from desc
    limit 1;
    if found then
      v_actual := round(new.actual_cost_usd * v_fx.inr_paise_per_provider_minor, 6);
      new.inr_cost_source := 'provider_reported_converted';
      new.inr_rate_version := v_fx.version;
    end if;
  end if;

  new.estimated_cost_inr_paise := v_estimated;
  new.actual_cost_inr_paise := v_actual;
  new.cost_currency := 'INR';
  if v_actual is not null then
    new.inr_cost_source := coalesce(new.inr_cost_source, 'provider_reported_converted');
  elsif v_estimated is not null then
    new.inr_cost_source := 'rate_card';
    new.inr_rate_version := coalesce(new.inr_rate_version, v_rate.version);
  elsif new.inr_cost_source is null then
    new.inr_cost_source := 'unavailable';
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_ai_usage_inr_cost() from public, anon, authenticated;
drop trigger if exists ai_usage_attempts_inr_cost on public.ai_usage_attempts;
create trigger ai_usage_attempts_inr_cost
before insert or update on public.ai_usage_attempts
for each row execute function public.refresh_ai_usage_inr_cost();

-- Re-project historical rows through the same trigger. Missing rate-card or FX
-- inputs remain NULL and therefore remain explicitly unknown.
update public.ai_usage_attempts
set metadata = metadata;

-- Attribute successful generation debits to billing lots without changing the
-- authoritative credit account. Free/subscription lots are consumed before a
-- purchase lot, so an unused purchased lot remains refundable only while its
-- own balance and the account's available balance support that refund.
create or replace function public.billing_consume_credit_lots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remaining bigint := greatest(-new.amount_credits, 0);
  v_lot public.billing_credit_lots;
  v_take bigint;
begin
  if new.operation <> 'generation_consumed' or v_remaining = 0 or new.run_id is null then
    return new;
  end if;

  for v_lot in
    select l.*
    from public.billing_credit_lots l
    where l.user_id = new.user_id and l.remaining_credits > 0
    order by case l.source_kind
      when 'free' then 1
      when 'subscription_grant' then 2
      when 'admin_adjustment' then 3
      when 'purchase' then 4
      else 5
    end, l.created_at, l.id
    for update
  loop
    exit when v_remaining = 0;
    v_take := least(v_remaining, v_lot.remaining_credits);
    update public.billing_credit_lots
    set remaining_credits = remaining_credits - v_take
    where id = v_lot.id;
    insert into public.billing_credit_lot_consumptions(lot_id, run_id, credits)
    values (v_lot.id, new.run_id, v_take)
    on conflict (lot_id, run_id) do update set credits = billing_credit_lot_consumptions.credits + excluded.credits;
    v_remaining := v_remaining - v_take;
  end loop;

  return new;
end;
$$;

revoke all on function public.billing_consume_credit_lots() from public, anon, authenticated;
drop trigger if exists billing_credit_lots_consume_on_generation on public.credit_ledger;
create trigger billing_credit_lots_consume_on_generation
after insert on public.credit_ledger
for each row execute function public.billing_consume_credit_lots();

-- The free tier is a one-time platform grant, not a browser-side default. It is
-- created lazily on the first authenticated balance read and is idempotent.
create or replace function public.billing_ensure_free_credits()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.billing_credit_lots;
  v_account public.credit_accounts;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_existing
  from public.billing_credit_lots
  where user_id = v_uid and source_kind = 'free' and source_id = 'free-initial'
  for update;
  if found then return jsonb_build_object('status', 'existing', 'credits', v_existing.granted_credits); end if;

  perform pg_advisory_xact_lock(hashtext('mavly:credit:' || v_uid::text));
  select * into v_existing
  from public.billing_credit_lots
  where user_id = v_uid and source_kind = 'free' and source_id = 'free-initial'
  for update;
  if found then return jsonb_build_object('status', 'existing', 'credits', v_existing.granted_credits); end if;

  select * into v_account from public.lock_credit_account(v_uid);
  update public.credit_accounts
  set balance_credits = balance_credits + 10, version = version + 1, updated_at = now()
  where user_id = v_uid returning * into v_account;
  insert into public.billing_credit_lots(user_id, source_kind, source_id, granted_credits, remaining_credits)
  values (v_uid, 'free', 'free-initial', 10, 10)
  returning * into v_existing;
  insert into public.credit_ledger(
    user_id, operation, amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits, idempotency_key,
    reason, metadata
  ) values (
    v_uid, 'grant', 10, 0, v_account.balance_credits, v_account.reserved_credits,
    'billing:free:free-initial', 'Free tier one-time credits',
    jsonb_build_object('source', 'free_tier', 'currency', 'INR')
  );
  return jsonb_build_object('status', 'applied', 'credits', 10);
end;
$$;

revoke all on function public.billing_ensure_free_credits() from public, anon;
grant execute on function public.billing_ensure_free_credits() to authenticated, service_role;

create or replace function public.get_credit_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_account public.credit_accounts;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  perform public.billing_ensure_free_credits();
  select * into v_account from public.credit_accounts where user_id = v_uid;
  if not found then
    return jsonb_build_object('exists', false, 'balance', 0, 'reserved', 0, 'available', 0);
  end if;
  return jsonb_build_object(
    'exists', true,
    'balance', v_account.balance_credits,
    'reserved', v_account.reserved_credits,
    'available', v_account.balance_credits - v_account.reserved_credits
  );
end;
$$;

revoke all on function public.get_credit_account() from public, anon;
grant execute on function public.get_credit_account() to authenticated;

create or replace function public.billing_user_entitlements()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions;
  v_account public.credit_accounts;
  v_monthly bigint;
  v_purchased bigint;
  v_free bigint;
  v_projects bigint;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  perform public.billing_ensure_free_credits();
  select * into v_sub from public.subscriptions
  where user_id = v_uid and status in ('active', 'past_due')
  order by current_period_end desc nulls last, created_at desc limit 1;
  select * into v_account from public.credit_accounts where user_id = v_uid;
  select coalesce(sum(remaining_credits), 0) into v_monthly
  from public.billing_credit_lots
  where user_id = v_uid and source_kind = 'subscription_grant'
    and (period_end is null or period_end > now());
  select coalesce(sum(remaining_credits), 0) into v_purchased
  from public.billing_credit_lots where user_id = v_uid and source_kind = 'purchase';
  select coalesce(sum(remaining_credits), 0) into v_free
  from public.billing_credit_lots where user_id = v_uid and source_kind in ('free', 'admin_adjustment');
  select count(*) into v_projects from public.projects where user_id = v_uid;
  return jsonb_build_object(
    'planId', coalesce(v_sub.plan_id, 'free'),
    'projectLimit', case when v_sub.id is null then 1 else (
      select project_limit from public.price_catalog p
      join public.price_catalog_versions v on v.id = p.version_id
      where p.product_id = v_sub.plan_id and p.market = v_sub.market and p.active and p.approved
      order by v.created_at desc limit 1
    ) end,
    'projectsUsed', v_projects,
    'monthlyCredits', v_monthly,
    'purchasedCredits', v_purchased,
    'freeCredits', v_free,
    'availableCredits', coalesce(v_account.balance_credits - v_account.reserved_credits, 0),
    'subscriptionStatus', v_sub.status,
    'currentPeriodEnd', v_sub.current_period_end,
    'features', jsonb_build_object(
      'paidPlan', v_sub.id is not null,
      'sourceExport', v_sub.id is not null,
      'customDomains', v_sub.id is not null,
      'githubSync', v_sub.plan_id in ('creator', 'pro')
    )
  );
end; $$;
revoke all on function public.billing_user_entitlements() from public, anon;
grant execute on function public.billing_user_entitlements() to authenticated;

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
    'generation_consumed', 'generation_released', 'generation_refunded',
    'purchase', 'subscription_grant', 'refund'
  ) then
    raise exception 'admin_credit_ledger: invalid operation' using errcode = '22023';
  end if;

  with filtered as (
    select l.id, l.user_id, l.project_id, l.run_id, l.operation,
      l.amount_credits, l.reserved_delta_credits, l.balance_after_credits,
      l.reserved_after_credits, l.status, l.reason, l.created_at,
      coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Unknown') as user_name,
      u.email as user_email
    from public.credit_ledger l
    join auth.users u on u.id = l.user_id
    left join public.profiles pr on pr.id = l.user_id
    where (v_operation = 'all' or l.operation = v_operation)
      and (v_search is null or strpos(lower(coalesce(u.email, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(pr.full_name, '')), lower(v_search)) > 0
        or strpos(l.id::text, v_search) > 0
        or strpos(lower(coalesce(l.project_id, '')), lower(v_search)) > 0
        or strpos(lower(coalesce(l.reason, '')), lower(v_search)) > 0)
  ), page_rows as (
    select * from filtered order by created_at desc, id desc limit v_limit offset v_offset
  )
  select (select count(*) from filtered), coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', page_rows.id, 'userId', page_rows.user_id, 'userName', page_rows.user_name,
      'userEmail', page_rows.user_email, 'projectId', page_rows.project_id, 'runId', page_rows.run_id,
      'operation', page_rows.operation, 'amount', page_rows.amount_credits,
      'reservedDelta', page_rows.reserved_delta_credits, 'balanceAfter', page_rows.balance_after_credits,
      'reservedAfter', page_rows.reserved_after_credits, 'status', page_rows.status,
      'reason', page_rows.reason, 'createdAt', page_rows.created_at
    ) order by page_rows.created_at desc, page_rows.id desc) from page_rows
  ), '[]'::jsonb) into v_total, v_rows;

  select jsonb_build_object(
    'issued', coalesce(sum(l.amount_credits) filter (where l.operation in ('grant', 'admin_adjustment', 'purchase', 'subscription_grant') and l.amount_credits > 0), 0),
    'purchased', coalesce(sum(l.amount_credits) filter (where l.operation = 'purchase' and l.amount_credits > 0), 0),
    'subscription', coalesce(sum(l.amount_credits) filter (where l.operation = 'subscription_grant' and l.amount_credits > 0), 0),
    'operator', coalesce(sum(l.amount_credits) filter (where l.operation in ('grant', 'admin_adjustment') and l.amount_credits > 0), 0),
    'consumed', coalesce(-sum(l.amount_credits) filter (where l.operation = 'generation_consumed'), 0),
    'refunded', coalesce(sum(l.amount_credits) filter (where l.operation in ('generation_refunded', 'refund')), 0),
    'outstanding', coalesce(sum(a.balance_credits - a.reserved_credits), 0),
    'reserved', coalesce(sum(a.reserved_credits), 0),
    'wallets', coalesce(count(*) filter (where a.balance_credits > 0), 0),
    'reversed', coalesce((select count(*) from public.credit_ledger l2 where l2.status = 'reversed'), 0),
    'transactions', (select count(*) from public.credit_ledger)
  ) into v_summary
  from public.credit_accounts a;

  return jsonb_build_object('rows', v_rows, 'total', coalesce(v_total, 0), 'limit', v_limit,
    'offset', v_offset, 'operation', v_operation, 'search', v_search, 'summary', v_summary);
end;
$$;

revoke all on function public.admin_credit_ledger(text, text, integer, integer) from public, anon;
grant execute on function public.admin_credit_ledger(text, text, integer, integer) to authenticated, service_role;

create or replace function public.admin_ai_usage_inr(
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
  v_attempts jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_ai_usage_inr: not authorized' using errcode = '42501';
  end if;
  if p_period not in ('7d', '30d', '3m', 'ytd') then
    raise exception 'admin_ai_usage_inr: invalid period' using errcode = '22023';
  end if;
  v_start := case p_period
    when '7d' then v_now - interval '7 days'
    when '30d' then v_now - interval '30 days'
    when '3m' then v_now - interval '90 days'
    else date_trunc('year', v_now at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
  end;

  with filtered as (
    select a.*, coalesce(nullif(a.model, ''), 'unknown') as display_model
    from public.ai_usage_attempts a
    where a.created_at >= v_start and a.created_at < v_now
      and (v_model is null or a.model = v_model)
  )
  select jsonb_build_object(
    'requests', count(distinct coalesce(run_id, workflow_id)),
    'completed', count(distinct run_id) filter (where exists (select 1 from public.project_runs r where r.id = filtered.run_id and r.status = 'done' and r.stage = 'completed')),
    'failed', count(distinct run_id) filter (where exists (select 1 from public.project_runs r where r.id = filtered.run_id and r.status = 'error')),
    'cancelled', count(distinct run_id) filter (where exists (select 1 from public.project_runs r where r.id = filtered.run_id and r.stage = 'cancelled')),
    'active', count(distinct run_id) filter (where exists (select 1 from public.project_runs r where r.id = filtered.run_id and r.finished_at is null)),
    'tokens', coalesce(sum(total_tokens), 0),
    'promptTokens', coalesce(sum(prompt_tokens), 0),
    'completionTokens', coalesce(sum(completion_tokens), 0),
    'costInrPaise', sum(actual_cost_inr_paise),
    'estimatedCostInrPaise', sum(estimated_cost_inr_paise),
    'costKnownRuns', count(*) filter (where actual_cost_inr_paise is not null),
    'costUnknownRuns', count(*) filter (where actual_cost_inr_paise is null),
    'durationP50', null,
    'durationP95', null,
    'costUsd', null
  ) into v_summary
  from filtered;

  with filtered as (
    select a.*, coalesce(nullif(a.model, ''), 'unknown') as display_model
    from public.ai_usage_attempts a
    where a.created_at >= v_start and a.created_at < v_now
      and (v_model is null or a.model = v_model)
  ), grouped as (
    select display_model as model, count(*) as requests,
      count(*) filter (where a.reconciliation_status = 'reconciled') as completed,
      count(*) filter (where a.reconciliation_status in ('uncertain', 'unavailable')) as failed,
      coalesce(sum(total_tokens), 0) as tokens,
      coalesce(sum(prompt_tokens), 0) as prompt_tokens,
      coalesce(sum(completion_tokens), 0) as completion_tokens,
      sum(actual_cost_inr_paise) as cost_inr_paise,
      sum(estimated_cost_inr_paise) as estimated_cost_inr_paise,
      count(*) filter (where actual_cost_inr_paise is not null) as cost_known_runs,
      count(*) filter (where actual_cost_inr_paise is null) as cost_unknown_runs
    from filtered a
    group by display_model
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'model', model, 'requests', requests, 'completed', completed, 'failed', failed,
    'tokens', tokens, 'promptTokens', prompt_tokens, 'completionTokens', completion_tokens,
    'costInrPaise', cost_inr_paise, 'estimatedCostInrPaise', estimated_cost_inr_paise,
    'costKnownRuns', cost_known_runs, 'costUnknownRuns', cost_unknown_runs,
    'durationP50', null, 'durationP95', null, 'costUsd', null
  ) order by requests desc, model), '[]'::jsonb)
  into v_models
  from grouped;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'model', a.model, 'provider', a.provider, 'role', a.role,
    'taskKey', a.task_key, 'attemptIndex', a.attempt_index,
    'promptTokens', a.prompt_tokens, 'completionTokens', a.completion_tokens,
    'totalTokens', a.total_tokens, 'usageSource', a.usage_source,
    'estimatedCostInrPaise', a.estimated_cost_inr_paise,
    'actualCostInrPaise', a.actual_cost_inr_paise,
    'inrCostSource', a.inr_cost_source,
    'estimatedCostUsd', null, 'actualCostUsd', null,
    'costSource', case when a.actual_cost_inr_paise is not null then 'provider_reported' when a.estimated_cost_inr_paise is not null then 'rate_card' else 'unavailable' end,
    'reconciliationStatus', a.reconciliation_status, 'uncertain', a.uncertain,
    'createdAt', a.created_at
  ) order by a.created_at desc), '[]'::jsonb)
  into v_attempts
  from (
    select a.*
    from public.ai_usage_attempts a
    where a.created_at >= v_start and a.created_at < v_now
      and (v_model is null or a.model = v_model)
    order by a.created_at desc
    limit v_limit offset v_offset
  ) a;

  return jsonb_build_object(
    'period', p_period,
    'window', jsonb_build_object('start', v_start, 'end', v_now),
    'summary', v_summary,
    'models', v_models,
    'modelTotal', jsonb_array_length(v_models),
    'attempts', v_attempts,
    'attemptsAvailable', true
  );
end;
$$;

revoke all on function public.admin_ai_usage_inr(text, text, integer, integer) from public, anon;
grant execute on function public.admin_ai_usage_inr(text, text, integer, integer) to authenticated, service_role;

create or replace function public.billing_begin_unused_refund(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.platform_payments;
  v_lot public.billing_credit_lots;
  v_refund public.billing_refunds;
  v_key text := left(nullif(btrim(coalesce(p_idempotency_key, '')), ''), 200);
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_key is null then raise exception 'INVALID_REFUND_REQUEST' using errcode = '22023'; end if;
  select * into v_refund from public.billing_refunds where idempotency_key = v_key for update;
  if found then return jsonb_build_object('status', 'existing', 'refund', to_jsonb(v_refund)); end if;
  select * into v_payment from public.platform_payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_payment.product_type <> 'credit_pack' or v_payment.status <> 'paid' then
    raise exception 'REFUND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  select * into v_lot
  from public.billing_credit_lots
  where user_id = v_payment.user_id and source_kind = 'purchase' and source_id = v_payment.id::text
  for update;
  if not found or v_lot.remaining_credits <> v_lot.granted_credits then
    raise exception 'REFUND_REQUIRES_MANUAL_REVIEW' using errcode = 'P0001';
  end if;
  insert into public.billing_refunds(
    payment_id, provider, amount_minor, amount_inr_paise, currency,
    status, credits_reversed, policy_status, idempotency_key
  ) values (
    v_payment.id, v_payment.provider, v_payment.amount_minor, v_payment.amount_inr_paise,
    'INR', 'pending', 0, 'pending', v_key
  ) returning * into v_refund;
  return jsonb_build_object(
    'status', 'created',
    'refund', to_jsonb(v_refund),
    'providerPaymentId', v_payment.provider_payment_id,
    'provider', v_payment.provider,
    'amountInrPaise', v_payment.amount_inr_paise,
    'reason', left(coalesce(p_reason, 'Unused credit purchase refund'), 500)
  );
end;
$$;

revoke all on function public.billing_begin_unused_refund(uuid, text, text) from public, anon, authenticated;
grant execute on function public.billing_begin_unused_refund(uuid, text, text) to service_role;

create or replace function public.billing_complete_unused_refund(
  p_refund_id uuid,
  p_provider_refund_id text default null,
  p_provider_amount_minor bigint default null,
  p_provider_currency text default null,
  p_succeeded boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.billing_refunds;
  v_payment public.platform_payments;
  v_lot public.billing_credit_lots;
  v_account public.credit_accounts;
  v_existing_succeeded public.billing_refunds;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_refund from public.billing_refunds where id = p_refund_id for update;
  if not found then raise exception 'REFUND_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_refund.status = 'succeeded' then return jsonb_build_object('status', 'existing', 'refund', to_jsonb(v_refund)); end if;
  if not coalesce(p_succeeded, false) then
    update public.billing_refunds set status = 'failed', completed_at = now() where id = v_refund.id returning * into v_refund;
    return jsonb_build_object('status', 'failed', 'refund', to_jsonb(v_refund));
  end if;
  if p_provider_currency is not null and upper(p_provider_currency) <> 'INR' then
    raise exception 'REFUND_CURRENCY_REQUIRES_RECONCILIATION' using errcode = 'P0001';
  end if;
  if p_provider_amount_minor is not null and p_provider_amount_minor <> v_refund.amount_inr_paise then
    raise exception 'REFUND_AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select * into v_payment from public.platform_payments where id = v_refund.payment_id for update;
  select * into v_lot from public.billing_credit_lots
  where user_id = v_payment.user_id and source_kind = 'purchase' and source_id = v_payment.id::text
  for update;
  if not found then
    select * into v_existing_succeeded
    from public.billing_refunds
    where payment_id = v_payment.id
      and status = 'succeeded'
      and id <> v_refund.id
    order by completed_at desc nulls last, created_at desc
    limit 1;
    if found then
      update public.billing_refunds
      set status = 'succeeded',
          provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
          provider_amount_minor = coalesce(p_provider_amount_minor, provider_amount_minor),
          provider_currency = coalesce(upper(p_provider_currency), provider_currency),
          amount_inr_paise = coalesce(amount_inr_paise, v_existing_succeeded.amount_inr_paise),
          credits_reversed = v_existing_succeeded.credits_reversed,
          policy_status = 'applied',
          completed_at = coalesce(completed_at, now())
      where id = v_refund.id
      returning * into v_refund;
      return jsonb_build_object('status', 'existing', 'refund', to_jsonb(v_refund));
    end if;
  end if;
  if not found or v_lot.remaining_credits <> v_lot.granted_credits then
    raise exception 'REFUND_REQUIRES_MANUAL_REVIEW' using errcode = 'P0001';
  end if;
  select * into v_account from public.lock_credit_account(v_payment.user_id);
  if v_account.balance_credits - v_account.reserved_credits < v_lot.remaining_credits then
    raise exception 'REFUND_CREDITS_NO_LONGER_AVAILABLE' using errcode = 'P0001';
  end if;
  update public.credit_accounts
  set balance_credits = balance_credits - v_lot.remaining_credits,
      version = version + 1, updated_at = now()
  where user_id = v_payment.user_id returning * into v_account;
  update public.billing_credit_lots
  set remaining_credits = 0
  where id = v_lot.id;
  insert into public.credit_ledger(
    user_id, operation, amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits, idempotency_key,
    reason, metadata
  ) values (
    v_payment.user_id, 'refund', -v_lot.granted_credits, 0,
    v_account.balance_credits, v_account.reserved_credits,
    'billing:refund:' || v_refund.id::text, 'Unused purchased credits refunded',
    jsonb_build_object('source', 'platform_payment_refund', 'paymentId', v_payment.id, 'refundId', v_refund.id, 'currency', 'INR')
  );
  update public.billing_refunds
  set status = 'succeeded', provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
      provider_amount_minor = coalesce(p_provider_amount_minor, provider_amount_minor),
      provider_currency = coalesce(upper(p_provider_currency), provider_currency),
      credits_reversed = v_lot.granted_credits, policy_status = 'applied', completed_at = now()
  where id = v_refund.id returning * into v_refund;
  update public.platform_payments set status = 'refunded', refunded_at = now() where id = v_payment.id;
  return jsonb_build_object('status', 'succeeded', 'refund', to_jsonb(v_refund));
end;
$$;

revoke all on function public.billing_complete_unused_refund(uuid, text, bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.billing_complete_unused_refund(uuid, text, bigint, text, boolean) to service_role;

-- Keep the existing settlement state machine, but normalize provider amounts at
-- this boundary. An event in a non-INR provider currency is accepted only when
-- an explicit, versioned INR rate can reproduce the catalog amount. Otherwise
-- no credits are granted and the webhook is retried for operator resolution.
create or replace function public.billing_process_webhook_inr(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_event_hash text,
  p_provider_order_id text default null,
  p_provider_payment_id text default null,
  p_provider_session_id text default null,
  p_provider_customer_id text default null,
  p_provider_subscription_id text default null,
  p_amount_minor bigint default null,
  p_currency text default null,
  p_provider_status text default null,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_provider_invoice_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_currency text := upper(nullif(btrim(coalesce(p_currency, '')), ''));
  v_amount_inr bigint := p_amount_minor;
  v_rate public.billing_inr_exchange_rates;
  v_payment public.platform_payments;
  v_result jsonb;
  v_transaction text := coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_currency is null then v_currency := 'INR'; end if;

  if p_amount_minor is not null and v_currency <> 'INR' then
    select * into v_rate
    from public.billing_inr_exchange_rates
    where from_currency = v_currency
      and effective_from <= now()
    order by effective_from desc
    limit 1;
    if not found then
      select * into v_payment
      from public.platform_payments p
      where p.provider = p_provider
        and ((p_provider_payment_id is not null and p.provider_payment_id = p_provider_payment_id)
          or (p_provider_order_id is not null and p.provider_order_id = p_provider_order_id)
          or (p_provider_session_id is not null and p.provider_session_id = p_provider_session_id)
          or (p_metadata ? 'mavlyPaymentId' and p.id::text = p_metadata ->> 'mavlyPaymentId'))
      limit 1;
      if found then
        if not exists (
          select 1 from public.billing_reconciliation r
          where r.provider = p_provider
            and r.provider_transaction_id = v_transaction
            and r.discrepancy_type = 'currency_requires_inr_rate'
            and r.status <> 'resolved'
        ) then
          insert into public.billing_reconciliation(
            provider, provider_transaction_id, internal_payment_id,
            expected_amount_minor, actual_amount_minor, expected_currency,
            actual_currency, expected_inr_paise, actual_inr_paise,
            discrepancy_type, status, details
          ) values (
            p_provider, v_transaction, v_payment.id, v_payment.amount_minor,
            p_amount_minor, 'INR', v_currency, v_payment.amount_minor, null,
            'currency_requires_inr_rate', 'manual_review',
            jsonb_build_object('eventId', p_event_id, 'rateRequired', true)
          );
        end if;
      end if;
      insert into public.billing_webhook_events(
        provider, provider_event_id, event_type, event_hash,
        processing_status, failure_reason, processed_at
      ) values (
        p_provider, left(p_event_id, 200), left(p_event_type, 120),
        left(p_event_hash, 128), 'failed', 'inr_rate_required', now()
      )
      on conflict (provider, provider_event_id) do update
        set processing_status = 'failed', failure_reason = 'inr_rate_required', processed_at = now();
      return jsonb_build_object('status', 'reconciliation_required', 'reason', 'inr_rate_required');
    end if;
    v_amount_inr := round(p_amount_minor::numeric * v_rate.inr_paise_per_provider_minor)::bigint;
  end if;

  v_result := public.billing_process_webhook(
    p_provider, p_event_id, p_event_type, p_event_hash,
    p_provider_order_id, p_provider_payment_id, p_provider_session_id,
    p_provider_customer_id, p_provider_subscription_id, v_amount_inr, 'INR',
    p_provider_status, p_period_start, p_period_end, p_provider_invoice_id,
    p_metadata
  );

  select * into v_payment
  from public.platform_payments p
  where p.provider = p_provider
    and ((p_provider_payment_id is not null and p.provider_payment_id = p_provider_payment_id)
      or (p_provider_order_id is not null and p.provider_order_id = p_provider_order_id)
      or (p_provider_session_id is not null and p.provider_session_id = p_provider_session_id)
      or (p_metadata ? 'mavlyPaymentId' and p.id::text = p_metadata ->> 'mavlyPaymentId'))
  limit 1;
  if found and p_amount_minor is not null then
    update public.platform_payments
    set amount_inr_paise = v_amount_inr,
        provider_amount_minor = p_amount_minor,
        provider_currency = v_currency,
        inr_rate_source = case when v_currency = 'INR' then 'provider_currency_inr' else 'audited_exchange_rate' end,
        inr_rate_version = case when v_currency = 'INR' then 'identity' else v_rate.version end
    where id = v_payment.id;
    update public.billing_reconciliation
    set expected_inr_paise = v_payment.amount_minor,
        actual_inr_paise = v_amount_inr,
        actual_amount_minor = p_amount_minor,
        actual_currency = v_currency,
        details = details || jsonb_build_object('inrRateVersion', case when v_currency = 'INR' then 'identity' else v_rate.version end)
    where provider = p_provider
      and provider_transaction_id = v_transaction
      and status <> 'resolved';
  end if;
  update public.billing_refunds
  set amount_inr_paise = v_amount_inr,
      provider_amount_minor = p_amount_minor,
      provider_currency = v_currency
  where provider = p_provider and provider_refund_id = p_event_id;
  return v_result;
end;
$$;

revoke all on function public.billing_process_webhook_inr(text, text, text, text, text, text, text, text, text, bigint, text, text, timestamptz, timestamptz, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.billing_process_webhook_inr(text, text, text, text, text, text, text, text, text, bigint, text, text, timestamptz, timestamptz, text, jsonb)
  to service_role;

-- INR-only admin billing projection. Provider-native amounts remain available
-- on the payment row for reconciliation, never as platform revenue.
create or replace function public.admin_billing_overview(
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null,
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_summary jsonb;
  v_payments jsonb;
  v_subscriptions jsonb;
  v_refunds jsonb;
  v_reconciliation jsonb;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_billing_overview: not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'grossRevenueInrPaise', coalesce(sum(p.amount_inr_paise) filter (where p.status in ('paid', 'refunded', 'partially_refunded')), 0),
    'refundsInrPaise', coalesce((select sum(r.amount_inr_paise) from public.billing_refunds r where r.status = 'succeeded'), 0),
    'netCollectedRevenueInrPaise', coalesce(sum(p.amount_inr_paise) filter (where p.status in ('paid', 'refunded', 'partially_refunded')), 0)
      - coalesce((select sum(r.amount_inr_paise) from public.billing_refunds r where r.status = 'succeeded'), 0),
    'actualAiCostInrPaise', (select sum(a.actual_cost_inr_paise) from public.ai_usage_attempts a),
    'estimatedAiCostInrPaise', (select sum(a.estimated_cost_inr_paise) from public.ai_usage_attempts a),
    'successfulPayments', count(*) filter (where p.status = 'paid'),
    'failedPayments', count(*) filter (where p.status = 'failed'),
    'pendingPayments', count(*) filter (where p.status in ('pending', 'processing', 'authorized')),
    'refundedPayments', count(*) filter (where p.status in ('refunded', 'partially_refunded')),
    'activeSubscriptions', (select count(*) from public.subscriptions s where s.status = 'active'),
    'pastDueSubscriptions', (select count(*) from public.subscriptions s where s.status = 'past_due'),
    'cancelledSubscriptions', (select count(*) from public.subscriptions s where s.status = 'cancelled'),
    'creditPackPurchases', count(*) filter (where p.status = 'paid' and p.product_type = 'credit_pack'),
    'subscriptionPayments', count(*) filter (where p.status = 'paid' and p.product_type = 'subscription'),
    'creditsAllocated', (select coalesce(sum(l.granted_credits), 0) from public.billing_credit_lots l),
    'openReconciliationIssues', (select count(*) from public.billing_reconciliation r where r.status in ('open', 'investigating', 'manual_review'))
  ) into v_summary
  from public.platform_payments p;

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_payments
  from (
    select p.id, p.user_id as "userId", u.email, p.product_id as "productId",
      p.product_type as "productType", p.provider, p.market,
      p.currency,
      p.amount_inr_paise as "amountInrPaise", p.provider_amount_minor as "providerAmountMinor",
      p.provider_currency as "providerCurrency", p.status, p.created_at as "createdAt", p.paid_at as "paidAt"
    from public.platform_payments p
    join auth.users u on u.id = p.user_id
    where (p_status = 'all' or p.status = p_status)
      and (v_search is null or u.email ilike '%' || v_search || '%'
        or p.id::text ilike '%' || v_search || '%'
        or coalesce(p.provider_payment_id, '') ilike '%' || v_search || '%')
    order by p.created_at desc
    limit v_limit offset v_offset
  ) page;

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_subscriptions
  from (
    select s.id, s.user_id as "userId", u.email, s.plan_id as "planId", s.provider,
      s.market, s.status, s.current_period_end as "currentPeriodEnd",
      s.cancel_at as "cancelAt", s.cancelled_at as "cancelledAt"
    from public.subscriptions s
    join auth.users u on u.id = s.user_id
    order by s.updated_at desc
    limit v_limit offset v_offset
  ) page;

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_refunds
  from (
    select r.id, r.payment_id as "paymentId", r.provider,
      r.provider_refund_id as "providerRefundId", r.amount_inr_paise as "amountInrPaise",
      r.status, r.policy_status as "policyStatus", r.created_at as "createdAt"
    from public.billing_refunds r
    order by r.created_at desc
    limit v_limit offset v_offset
  ) page;

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_reconciliation
  from (
    select r.id, r.provider, r.provider_transaction_id as "providerTransactionId",
      r.internal_payment_id as "internalPaymentId", r.expected_inr_paise as "expectedInrPaise",
      r.actual_inr_paise as "actualInrPaise", r.discrepancy_type as "discrepancyType",
      r.status, r.created_at as "createdAt"
    from public.billing_reconciliation r
    order by r.created_at desc
    limit v_limit offset v_offset
  ) page;

  return jsonb_build_object(
    'summary', v_summary,
    'payments', v_payments,
    'subscriptions', v_subscriptions,
    'refunds', v_refunds,
    'reconciliation', v_reconciliation
  );
end;
$$;

revoke all on function public.admin_billing_overview(integer, integer, text, text) from public, anon;
grant execute on function public.admin_billing_overview(integer, integer, text, text) to authenticated, service_role;

commit;
