-- Mavly platform billing: market routing, catalog, providers, settlement,
-- subscriptions, entitlements, reconciliation and admin reporting.
--
-- Additive. Apply after migration 56. Customer-app payment tables under
-- project_integrations are intentionally not touched.

begin;

create or replace function public.billing_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$ select 57; $$;

-- ── Billing identity ─────────────────────────────────────────────────────────

create table if not exists public.billing_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  country_code text,
  verification_status text not null default 'unresolved',
  country_source text,
  verified_at timestamptz,
  market_locked_at timestamptz,
  last_trusted_country text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_profiles_country_shape check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint billing_profiles_trusted_country_shape check (last_trusted_country is null or last_trusted_country ~ '^[A-Z]{2}$'),
  constraint billing_profiles_status_check check (verification_status in ('unresolved', 'pending', 'verified', 'rejected')),
  constraint billing_profiles_source_check check (country_source is null or country_source in ('operator', 'document', 'provider', 'account'))
);

alter table public.billing_profiles enable row level security;
drop policy if exists billing_profiles_select_own on public.billing_profiles;
create policy billing_profiles_select_own on public.billing_profiles
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.billing_profiles from public, anon;
revoke insert, update, delete on public.billing_profiles from authenticated;
grant select on public.billing_profiles to authenticated;
grant select, insert, update, delete on public.billing_profiles to service_role;

create or replace function public.billing_profile_updated_at()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists billing_profiles_updated_at on public.billing_profiles;
create trigger billing_profiles_updated_at before update on public.billing_profiles
for each row execute function public.billing_profile_updated_at();

-- ── Immutable catalog ────────────────────────────────────────────────────────

create table if not exists public.price_catalog_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null default 'active',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint price_catalog_versions_status_check check (status in ('draft', 'active', 'retired'))
);

create table if not exists public.price_catalog (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.price_catalog_versions(id),
  product_id text not null,
  product_type text not null,
  plan_id text,
  market text not null,
  currency text not null,
  billing_interval text not null,
  amount_minor bigint,
  credits bigint,
  project_limit integer,
  active boolean not null default false,
  approved boolean not null default false,
  razorpay_product_id text,
  dodo_product_id text,
  created_at timestamptz not null default now(),
  constraint price_catalog_product_type_check check (product_type in ('subscription', 'credit_pack')),
  constraint price_catalog_market_check check (market in ('india', 'global')),
  constraint price_catalog_currency_check check ((market = 'india' and currency = 'INR') or (market = 'global' and currency = 'USD')),
  constraint price_catalog_interval_check check ((product_type = 'credit_pack' and billing_interval = 'one_time') or (product_type = 'subscription' and billing_interval in ('monthly', 'yearly'))),
  constraint price_catalog_amount_check check (amount_minor is null or amount_minor > 0),
  constraint price_catalog_credits_check check (credits is null or credits > 0),
  constraint price_catalog_project_limit_check check (project_limit is null or project_limit > 0),
  constraint price_catalog_product_key unique (version_id, product_id, billing_interval)
);

create unique index if not exists price_catalog_one_active_product
  on public.price_catalog (product_id, market, billing_interval)
  where active and approved;
create index if not exists price_catalog_market_active_idx
  on public.price_catalog (market, currency, active, approved);

alter table public.price_catalog_versions enable row level security;
alter table public.price_catalog enable row level security;
revoke all on public.price_catalog_versions, public.price_catalog from public, anon, authenticated;
grant select on public.price_catalog_versions, public.price_catalog to service_role;

create or replace function public.billing_catalog_reject_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'BILLING_CATALOG_IMMUTABLE' using errcode = 'P0001';
end; $$;
drop trigger if exists price_catalog_versions_immutable on public.price_catalog_versions;
create trigger price_catalog_versions_immutable before update or delete on public.price_catalog_versions
for each row execute function public.billing_catalog_reject_mutation();
drop trigger if exists price_catalog_immutable on public.price_catalog;
create trigger price_catalog_immutable before update or delete on public.price_catalog
for each row execute function public.billing_catalog_reject_mutation();

insert into public.price_catalog_versions(version, status, approved_at)
values ('2026-11-03-inr-initial', 'active', now())
on conflict (version) do nothing;

insert into public.price_catalog (
  version_id, product_id, product_type, plan_id, market, currency, billing_interval,
  amount_minor, credits, project_limit, active, approved
)
select v.id, seed.product_id, seed.product_type, seed.plan_id, 'india', 'INR', seed.billing_interval,
       seed.amount_minor, seed.credits, seed.project_limit, true, true
from public.price_catalog_versions v
cross join (values
  ('starter', 'subscription', 'starter', 'monthly', 39900::bigint, 100::bigint, 5),
  ('creator', 'subscription', 'creator', 'monthly', 59900::bigint, 200::bigint, 15),
  ('pro', 'subscription', 'pro', 'monthly', 199900::bigint, 600::bigint, 50),
  ('starter-pack', 'credit_pack', null, 'one_time', 19900::bigint, 90::bigint, null),
  ('growth-pack', 'credit_pack', null, 'one_time', 29900::bigint, 300::bigint, null),
  ('power-pack', 'credit_pack', null, 'one_time', 79900::bigint, 1000::bigint, null)
) as seed(product_id, product_type, plan_id, billing_interval, amount_minor, credits, project_limit)
where v.version = '2026-11-03-inr-initial'
on conflict (version_id, product_id, billing_interval) do nothing;

-- Global identifiers exist for routing and approval workflow, but remain
-- inactive until an authorized USD price and Dodo product mapping is installed.
insert into public.price_catalog (
  version_id, product_id, product_type, plan_id, market, currency, billing_interval,
  amount_minor, credits, project_limit, active, approved
)
select v.id, seed.product_id, seed.product_type, seed.plan_id, 'global', 'USD', seed.billing_interval,
       null, seed.credits, seed.project_limit, false, false
from public.price_catalog_versions v
cross join (values
  ('starter', 'subscription', 'starter', 'monthly', 100::bigint, 5),
  ('creator', 'subscription', 'creator', 'monthly', 200::bigint, 15),
  ('pro', 'subscription', 'pro', 'monthly', 600::bigint, 50),
  ('starter-pack', 'credit_pack', null, 'one_time', 90::bigint, null),
  ('growth-pack', 'credit_pack', null, 'one_time', 300::bigint, null),
  ('power-pack', 'credit_pack', null, 'one_time', 1000::bigint, null)
) as seed(product_id, product_type, plan_id, billing_interval, credits, project_limit)
where v.version = '2026-11-03-inr-initial'
on conflict (version_id, product_id, billing_interval) do nothing;

insert into public.price_catalog (
  version_id, product_id, product_type, plan_id, market, currency, billing_interval,
  amount_minor, credits, project_limit, active, approved
)
select v.id, 'free', 'subscription', 'free', 'india', 'INR', 'monthly',
       null, 10, 1, true, true
from public.price_catalog_versions v
where v.version = '2026-11-03-inr-initial'
on conflict (version_id, product_id, billing_interval) do nothing;

-- ── Provider records ─────────────────────────────────────────────────────────

create table if not exists public.provider_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_customer_id text not null,
  market text not null,
  created_at timestamptz not null default now(),
  constraint provider_customers_provider_check check (provider in ('razorpay', 'dodo')),
  constraint provider_customers_market_check check (market in ('india', 'global')),
  unique (provider, provider_customer_id),
  unique (user_id, provider)
);

create table if not exists public.platform_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null,
  provider_order_id text,
  provider_payment_id text,
  provider_session_id text,
  provider_subscription_id text,
  provider_customer_id text,
  product_type text not null,
  product_id text not null,
  amount_minor bigint not null,
  currency text not null,
  market text not null,
  catalog_version text not null,
  status text not null default 'pending',
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  constraint platform_payments_provider_check check (provider in ('razorpay', 'dodo')),
  constraint platform_payments_product_type_check check (product_type in ('subscription', 'credit_pack')),
  constraint platform_payments_currency_check check (currency in ('INR', 'USD')),
  constraint platform_payments_market_check check (market in ('india', 'global')),
  constraint platform_payments_status_check check (status in ('pending', 'processing', 'authorized', 'paid', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'disputed')),
  constraint platform_payments_amount_positive check (amount_minor > 0),
  unique (user_id, idempotency_key)
);

create unique index if not exists platform_payments_provider_order_idx
  on public.platform_payments(provider, provider_order_id) where provider_order_id is not null;
create unique index if not exists platform_payments_provider_payment_idx
  on public.platform_payments(provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists platform_payments_provider_session_idx
  on public.platform_payments(provider, provider_session_id) where provider_session_id is not null;
create unique index if not exists platform_payments_provider_subscription_idx
  on public.platform_payments(provider, provider_subscription_id) where provider_subscription_id is not null;
create index if not exists platform_payments_user_created_idx on public.platform_payments(user_id, created_at desc);
create index if not exists platform_payments_status_idx on public.platform_payments(status, created_at desc);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  plan_id text not null,
  provider text not null,
  provider_subscription_id text not null,
  provider_customer_id text,
  market text not null,
  currency text not null,
  status text not null default 'pending',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_provider_check check (provider in ('razorpay', 'dodo')),
  constraint subscriptions_market_check check (market in ('india', 'global')),
  constraint subscriptions_currency_check check (currency in ('INR', 'USD')),
  constraint subscriptions_status_check check (status in ('pending', 'active', 'past_due', 'cancelled', 'expired', 'failed', 'refunded')),
  unique (provider, provider_subscription_id)
);
create index if not exists subscriptions_user_status_idx on public.subscriptions(user_id, status);
create index if not exists subscriptions_period_idx on public.subscriptions(current_period_end);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  payment_id uuid references public.platform_payments(id) on delete set null,
  provider text not null,
  provider_invoice_id text,
  provider_payment_id text,
  amount_minor bigint not null,
  currency text not null,
  status text not null default 'pending',
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (provider, provider_invoice_id)
);

create table if not exists public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  event_hash text not null,
  processing_status text not null default 'received',
  failure_reason text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint billing_webhook_provider_check check (provider in ('razorpay', 'dodo')),
  constraint billing_webhook_status_check check (processing_status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  unique (provider, provider_event_id),
  unique (provider, event_hash)
);
create index if not exists billing_webhook_status_idx on public.billing_webhook_events(processing_status, received_at);

create table if not exists public.billing_reconciliation (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_transaction_id text,
  internal_payment_id uuid references public.platform_payments(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  expected_amount_minor bigint,
  actual_amount_minor bigint,
  expected_currency text,
  actual_currency text,
  discrepancy_type text not null,
  status text not null default 'open',
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint billing_reconciliation_status_check check (status in ('open', 'investigating', 'resolved', 'manual_review'))
);
create index if not exists billing_reconciliation_status_idx on public.billing_reconciliation(status, created_at desc);

create table if not exists public.billing_reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_transaction_id text not null,
  payment_id uuid references public.platform_payments(id) on delete set null,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_transaction_id),
  constraint billing_reconciliation_job_status_check check (status in ('queued', 'processing', 'succeeded', 'failed'))
);
create index if not exists billing_reconciliation_jobs_queue_idx on public.billing_reconciliation_jobs(status, available_at);
alter table public.billing_reconciliation_jobs enable row level security;
revoke all on public.billing_reconciliation_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.billing_reconciliation_jobs to service_role;

create table if not exists public.subscription_entitlements (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  monthly_credits bigint not null,
  project_limit integer not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (subscription_id, period_start),
  constraint subscription_entitlement_status_check check (status in ('active', 'expired', 'revoked')),
  constraint subscription_entitlement_credits_check check (monthly_credits >= 0),
  constraint subscription_entitlement_period_check check (period_end > period_start)
);

create table if not exists public.billing_credit_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null,
  source_id text not null,
  period_start timestamptz,
  period_end timestamptz,
  granted_credits bigint not null,
  remaining_credits bigint not null,
  created_at timestamptz not null default now(),
  constraint billing_credit_lot_source_check check (source_kind in ('free', 'purchase', 'subscription_grant', 'admin_adjustment')),
  constraint billing_credit_lot_amount_check check (granted_credits > 0 and remaining_credits >= 0 and remaining_credits <= granted_credits),
  unique (user_id, source_kind, source_id)
);
create index if not exists billing_credit_lots_user_idx on public.billing_credit_lots(user_id, source_kind, created_at);

create table if not exists public.billing_credit_lot_consumptions (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.billing_credit_lots(id) on delete restrict,
  run_id uuid references public.project_runs(id) on delete set null,
  credits bigint not null,
  created_at timestamptz not null default now(),
  unique (lot_id, run_id)
);

create table if not exists public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.platform_payments(id) on delete restrict,
  provider text not null,
  provider_refund_id text,
  amount_minor bigint not null,
  currency text not null,
  status text not null default 'pending',
  credits_reversed bigint not null default 0,
  policy_status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (provider, provider_refund_id),
  constraint billing_refunds_status_check check (status in ('pending', 'succeeded', 'failed')),
  constraint billing_refunds_policy_check check (policy_status in ('pending', 'applied', 'manual_review', 'not_applicable'))
);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.provider_customers enable row level security;
alter table public.platform_payments enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
alter table public.billing_reconciliation enable row level security;
alter table public.subscription_entitlements enable row level security;
alter table public.billing_credit_lots enable row level security;
alter table public.billing_credit_lot_consumptions enable row level security;
alter table public.billing_refunds enable row level security;
alter table public.billing_webhook_events enable row level security;

revoke all on provider_customers, platform_payments, subscriptions, invoices, billing_reconciliation,
  subscription_entitlements, billing_credit_lots, billing_credit_lot_consumptions, billing_refunds,
  billing_webhook_events from public, anon;
grant select on provider_customers, platform_payments, subscriptions, invoices, subscription_entitlements,
  billing_credit_lots, billing_credit_lot_consumptions, billing_refunds to authenticated;
grant select, insert, update, delete on provider_customers, platform_payments, subscriptions, invoices,
  billing_reconciliation, subscription_entitlements, billing_credit_lots, billing_credit_lot_consumptions,
  billing_refunds, billing_webhook_events to service_role;

create policy provider_customers_read_own on public.provider_customers for select to authenticated using ((select auth.uid()) = user_id);
create policy platform_payments_read_own on public.platform_payments for select to authenticated using ((select auth.uid()) = user_id);
create policy subscriptions_read_own on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy invoices_read_own on public.invoices for select to authenticated using ((select auth.uid()) = user_id);
create policy subscription_entitlements_read_own on public.subscription_entitlements for select to authenticated using ((select auth.uid()) = user_id);
create policy billing_credit_lots_read_own on public.billing_credit_lots for select to authenticated using ((select auth.uid()) = user_id);
create policy billing_credit_lot_consumptions_read_own on public.billing_credit_lot_consumptions for select to authenticated using (exists (select 1 from public.billing_credit_lots l where l.id = lot_id and l.user_id = (select auth.uid())));
create policy billing_refunds_read_own on public.billing_refunds for select to authenticated using (exists (select 1 from public.platform_payments p where p.id = payment_id and p.user_id = (select auth.uid())));

create or replace function public.billing_subscription_updated_at()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists subscriptions_updated_at on public.subscriptions;
create trigger subscriptions_updated_at before update on public.subscriptions
for each row execute function public.billing_subscription_updated_at();

create or replace function public.billing_subscription_provider_immutable()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.provider is distinct from new.provider or old.market is distinct from new.market
     or old.currency is distinct from new.currency or old.provider_subscription_id is distinct from new.provider_subscription_id then
    raise exception 'BILLING_SUBSCRIPTION_PROVIDER_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end; $$;
drop trigger if exists subscriptions_provider_immutable on public.subscriptions;
create trigger subscriptions_provider_immutable before update on public.subscriptions
for each row execute function public.billing_subscription_provider_immutable();

-- The existing generation ledger remains authoritative. These additional
-- operations are only for platform billing funding/compensation entries.
alter table public.credit_ledger drop constraint if exists credit_ledger_operation_check;
alter table public.credit_ledger add constraint credit_ledger_operation_check check (operation in (
  'grant', 'admin_adjustment', 'generation_reserved', 'generation_consumed',
  'generation_released', 'generation_refunded', 'purchase', 'topup',
  'subscription_grant', 'refund'
));

-- ── Server-only RPCs ─────────────────────────────────────────────────────────

create or replace function public.billing_set_profile(
  p_user_id uuid, p_country_code text, p_source text, p_status text default 'verified'
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_country text := upper(btrim(coalesce(p_country_code, ''))); v_row public.billing_profiles;
begin
  if auth.role() is distinct from 'service_role' and not public.current_user_is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_country !~ '^[A-Z]{2}$' or p_source not in ('operator', 'document', 'provider', 'account') then
    raise exception 'INVALID_BILLING_PROFILE' using errcode = '22023';
  end if;
  insert into public.billing_profiles(user_id, country_code, verification_status, country_source, verified_at, market_locked_at)
  values (p_user_id, v_country, p_status, p_source, case when p_status = 'verified' then now() else null end, now())
  on conflict (user_id) do update set country_code = excluded.country_code,
    verification_status = excluded.verification_status, country_source = excluded.country_source,
    verified_at = excluded.verified_at, market_locked_at = coalesce(public.billing_profiles.market_locked_at, now());
  select * into v_row from public.billing_profiles where user_id = p_user_id;
  return jsonb_build_object('userId', v_row.user_id, 'countryCode', v_row.country_code,
    'verificationStatus', v_row.verification_status, 'countrySource', v_row.country_source);
end; $$;
revoke all on function public.billing_set_profile(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.billing_set_profile(uuid, text, text, text) to service_role;

create or replace function public.admin_set_billing_profile(
  p_user_id uuid, p_country_code text, p_source text default 'operator'
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_result jsonb; v_actor uuid := auth.uid();
begin
  if not public.current_user_is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  v_result := public.billing_set_profile(p_user_id, p_country_code, p_source, 'verified');
  insert into public.admin_audit_log(actor_user_id, actor_email, action, target_type, target_id, metadata)
  select v_actor, u.email, 'billing.profile_verified', 'user', p_user_id::text,
    jsonb_build_object('countryCode', upper(btrim(p_country_code)), 'source', p_source)
  from auth.users u where u.id = v_actor;
  return v_result;
end; $$;
revoke all on function public.admin_set_billing_profile(uuid, text, text) from public, anon;
grant execute on function public.admin_set_billing_profile(uuid, text, text) to authenticated, service_role;

create or replace function public.billing_create_payment(
  p_user_id uuid, p_product_id text, p_market text, p_interval text, p_idempotency_key text,
  p_provider text, p_currency text, p_catalog_version text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_price public.price_catalog; v_payment public.platform_payments; v_key text := left(btrim(coalesce(p_idempotency_key, '')), 200); v_catalog_version text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_user_id is null or v_key = '' then raise exception 'INVALID_BILLING_REQUEST' using errcode = '22023'; end if;
  select p.* into v_price from public.price_catalog p
  join public.price_catalog_versions v on v.id = p.version_id and v.status = 'active'
  where p.product_id = p_product_id and p.market = p_market and p.billing_interval = p_interval
    and p.currency = p_currency and p.active and p.approved and (p_catalog_version is null or v.version = p_catalog_version)
  order by v.created_at desc limit 1;
  if not found or v_price.amount_minor is null then raise exception 'PRICE_NOT_CONFIGURED' using errcode = 'P0001'; end if;
  select v.version into v_catalog_version from public.price_catalog_versions v where v.id = v_price.version_id;
  if (p_market = 'india' and (p_provider <> 'razorpay' or p_currency <> 'INR'))
     or (p_market = 'global' and (p_provider <> 'dodo' or p_currency <> 'USD')) then
    raise exception 'BILLING_ROUTE_MISMATCH' using errcode = 'P0001';
  end if;
  select * into v_payment from public.platform_payments where user_id = p_user_id and idempotency_key = v_key for update;
  if found then
    if v_payment.product_id <> p_product_id or v_payment.amount_minor <> v_price.amount_minor then raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '22000'; end if;
    return jsonb_build_object('status', 'existing', 'payment', to_jsonb(v_payment), 'credits', v_price.credits);
  end if;
  insert into public.platform_payments(user_id, provider, product_type, product_id, amount_minor, currency, market, catalog_version, idempotency_key)
  values (p_user_id, p_provider, v_price.product_type, v_price.product_id, v_price.amount_minor, v_price.currency, v_price.market, v_catalog_version, v_key)
  returning * into v_payment;
  return jsonb_build_object('status', 'created', 'payment', to_jsonb(v_payment), 'credits', v_price.credits,
    'providerProductId', coalesce(v_price.razorpay_product_id, v_price.dodo_product_id));
end; $$;
revoke all on function public.billing_create_payment(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.billing_create_payment(uuid, text, text, text, text, text, text, text) to service_role;

create or replace function public.billing_attach_payment_provider(
  p_payment_id uuid, p_provider_order_id text default null, p_provider_payment_id text default null,
  p_provider_session_id text default null, p_provider_customer_id text default null,
  p_provider_subscription_id text default null, p_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_payment public.platform_payments; v_sub public.subscriptions; v_price public.price_catalog;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_payment from public.platform_payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_payment.status not in ('pending', 'processing') then return jsonb_build_object('status', 'existing', 'payment', to_jsonb(v_payment)); end if;
  update public.platform_payments set provider_order_id = coalesce(p_provider_order_id, provider_order_id),
    provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id), provider_session_id = coalesce(p_provider_session_id, provider_session_id),
    provider_subscription_id = coalesce(p_provider_subscription_id, provider_subscription_id),
    provider_customer_id = coalesce(p_provider_customer_id, provider_customer_id),
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    status = 'processing'
  where id = p_payment_id returning * into v_payment;
  if p_provider_customer_id is not null then
    insert into public.provider_customers(user_id, provider, provider_customer_id, market)
    values (v_payment.user_id, v_payment.provider, p_provider_customer_id, v_payment.market)
    on conflict (user_id, provider) do update set provider_customer_id = excluded.provider_customer_id;
  end if;
  if v_payment.product_type = 'subscription' and p_provider_subscription_id is not null then
    select p.* into v_price from public.price_catalog p join public.price_catalog_versions v on v.id = p.version_id
    where p.product_id = v_payment.product_id and v.version = v_payment.catalog_version limit 1;
    insert into public.subscriptions(user_id, plan_id, provider, provider_subscription_id, provider_customer_id, market, currency)
    values (v_payment.user_id, v_payment.product_id, v_payment.provider, p_provider_subscription_id, p_provider_customer_id, v_payment.market, v_payment.currency)
    on conflict (provider, provider_subscription_id) do update set provider_customer_id = coalesce(excluded.provider_customer_id, subscriptions.provider_customer_id)
    returning * into v_sub;
  end if;
  return jsonb_build_object('status', 'attached', 'payment', to_jsonb(v_payment), 'subscription', to_jsonb(v_sub));
end; $$;
revoke all on function public.billing_attach_payment_provider(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.billing_attach_payment_provider(uuid, text, text, text, text, text, jsonb) to service_role;

create or replace function public.billing_mark_payment_failed(
  p_payment_id uuid,
  p_reason text default 'provider_checkout_failed'
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_payment public.platform_payments;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update public.platform_payments
  set status = 'failed', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('failureReason', left(coalesce(p_reason, 'provider_checkout_failed'), 120))
  where id = p_payment_id and status in ('pending', 'processing') returning * into v_payment;
  if not found then select * into v_payment from public.platform_payments where id = p_payment_id; end if;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', v_payment.status, 'payment', to_jsonb(v_payment));
end; $$;
revoke all on function public.billing_mark_payment_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_mark_payment_failed(uuid, text) to service_role;

create or replace function public.billing_grant_credit_lot(
  p_user_id uuid, p_source_kind text, p_source_id text, p_amount bigint,
  p_period_start timestamptz default null, p_period_end timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_account public.credit_accounts; v_lot public.billing_credit_lots; v_existing public.billing_credit_lots; v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_user_id is null or p_amount < 1 or p_source_kind not in ('free', 'purchase', 'subscription_grant', 'admin_adjustment') then raise exception 'INVALID_CREDIT_GRANT' using errcode = '22023'; end if;
  select * into v_existing from public.billing_credit_lots where user_id = p_user_id and source_kind = p_source_kind and source_id = p_source_id for update;
  if found then return jsonb_build_object('status', 'existing', 'lot', to_jsonb(v_existing)); end if;
  perform pg_advisory_xact_lock(hashtext('mavly:credit:' || p_user_id::text));
  select * into v_account from public.lock_credit_account(p_user_id);
  update public.credit_accounts set balance_credits = balance_credits + p_amount, version = version + 1, updated_at = now()
  where user_id = p_user_id returning * into v_account;
  insert into public.billing_credit_lots(user_id, source_kind, source_id, period_start, period_end, granted_credits, remaining_credits)
  values (p_user_id, p_source_kind, p_source_id, p_period_start, p_period_end, p_amount, p_amount) returning * into v_lot;
  v_key := 'billing:' || p_source_kind || ':' || p_source_id;
  insert into public.credit_ledger(user_id, operation, amount_credits, reserved_delta_credits, balance_after_credits, reserved_after_credits, idempotency_key, reason, metadata)
  values (p_user_id, case when p_source_kind = 'purchase' then 'purchase' when p_source_kind = 'subscription_grant' then 'subscription_grant' else 'grant' end,
    p_amount, 0, v_account.balance_credits, v_account.reserved_credits, v_key, 'Platform billing credit grant', jsonb_build_object('source', p_source_kind, 'sourceId', p_source_id));
  return jsonb_build_object('status', 'applied', 'lot', to_jsonb(v_lot), 'balance', v_account.balance_credits);
end; $$;
revoke all on function public.billing_grant_credit_lot(uuid, text, text, bigint, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_grant_credit_lot(uuid, text, text, bigint, timestamptz, timestamptz) to service_role;

drop function if exists public.billing_reverse_credit_lot(uuid, text, bigint);
create function public.billing_reverse_credit_lot(
  p_user_id uuid,
  p_refund_id text,
  p_amount bigint,
  p_lot_source_id text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account public.credit_accounts;
  v_remaining bigint := p_amount;
  v_purchase_available bigint;
  v_lot record;
  v_lot_source text := coalesce(p_lot_source_id, p_refund_id);
  v_key text := 'refund:' || p_refund_id;
begin
  if auth.role() is distinct from 'service_role' and not public.current_user_is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null or nullif(btrim(p_refund_id), '') is null or p_amount < 1 then
    raise exception 'INVALID_REFUND_AMOUNT' using errcode = '22023';
  end if;
  if exists (select 1 from public.credit_ledger where user_id = p_user_id and idempotency_key = v_key) then
    return jsonb_build_object('status', 'existing');
  end if;

  perform pg_advisory_xact_lock(hashtext('mavly:credit:' || p_user_id::text));
  select * into v_account from public.lock_credit_account(p_user_id);
  if v_account.balance_credits - v_account.reserved_credits < p_amount then
    return jsonb_build_object('status', 'manual_review', 'reason', 'credits_already_consumed');
  end if;

  select coalesce(sum(remaining_credits), 0) into v_purchase_available
  from public.billing_credit_lots
  where user_id = p_user_id and source_kind = 'purchase'
    and source_id = v_lot_source and remaining_credits > 0;
  if v_purchase_available < p_amount then
    return jsonb_build_object('status', 'manual_review', 'reason', 'credit_lot_not_available');
  end if;

  for v_lot in
    select * from public.billing_credit_lots
    where user_id = p_user_id and source_kind = 'purchase'
      and source_id = v_lot_source and remaining_credits > 0
    order by created_at desc, id desc
    for update
  loop
    exit when v_remaining <= 0;
    update public.billing_credit_lots
    set remaining_credits = remaining_credits - least(remaining_credits, v_remaining)
    where id = v_lot.id;
    v_remaining := v_remaining - least(v_lot.remaining_credits, v_remaining);
  end loop;

  update public.credit_accounts
  set balance_credits = balance_credits - p_amount, version = version + 1, updated_at = now()
  where user_id = p_user_id returning * into v_account;
  insert into public.credit_ledger(user_id, operation, amount_credits, reserved_delta_credits,
    balance_after_credits, reserved_after_credits, idempotency_key, reason, metadata)
  values (p_user_id, 'refund', -p_amount, 0, v_account.balance_credits,
    v_account.reserved_credits, v_key, 'Platform payment refund credit reversal',
    jsonb_build_object('source', 'billing_refund', 'sourceId', v_lot_source, 'refundId', p_refund_id));
  return jsonb_build_object('status', 'applied', 'credits', p_amount, 'balance', v_account.balance_credits);
end; $$;
revoke all on function public.billing_reverse_credit_lot(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.billing_reverse_credit_lot(uuid, text, bigint, text) to service_role;

create or replace function public.billing_process_webhook(
  p_provider text, p_event_id text, p_event_type text, p_event_hash text,
  p_provider_order_id text default null, p_provider_payment_id text default null, p_provider_session_id text default null,
  p_provider_customer_id text default null, p_provider_subscription_id text default null,
  p_amount_minor bigint default null, p_currency text default null, p_provider_status text default null,
  p_period_start timestamptz default null, p_period_end timestamptz default null,
  p_provider_invoice_id text default null, p_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event public.billing_webhook_events; v_payment public.platform_payments; v_sub public.subscriptions;
  v_price public.price_catalog; v_entitlement public.subscription_entitlements; v_grant jsonb; v_refund_credits bigint; v_refund_status jsonb;
  v_success boolean := p_provider_status in ('captured', 'paid', 'succeeded', 'active', 'charged', 'completed', 'processed', 'refunded')
    or (p_event_type like '%refund%' and p_provider_status is not null);
  v_period_start timestamptz := coalesce(p_period_start, now());
  v_period_end timestamptz := coalesce(p_period_end, v_period_start + interval '1 month');
begin
  if auth.role() is distinct from 'service_role'
     and not (p_event_type like '%refund%' and public.current_user_is_admin()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_provider not in ('razorpay', 'dodo') or nullif(btrim(p_event_id), '') is null or nullif(btrim(p_event_hash), '') is null then raise exception 'INVALID_WEBHOOK' using errcode = '22023'; end if;
  select * into v_event from public.billing_webhook_events where provider = p_provider and provider_event_id = p_event_id for update;
  if not found then
    insert into public.billing_webhook_events(provider, provider_event_id, event_type, event_hash, processing_status)
    values (p_provider, left(p_event_id, 200), left(p_event_type, 120), left(p_event_hash, 128), 'processing') returning * into v_event;
  elsif v_event.event_hash <> left(p_event_hash, 128) then
    update public.billing_webhook_events set processing_status = 'failed', failure_reason = 'event_hash_mismatch', processed_at = now() where id = v_event.id;
    return jsonb_build_object('status', 'rejected', 'reason', 'event_hash_mismatch');
  elsif v_event.processing_status = 'processed' then
    return jsonb_build_object('status', 'duplicate', 'eventId', v_event.id);
  else
    update public.billing_webhook_events set processing_status = 'processing', failure_reason = null where id = v_event.id returning * into v_event;
  end if;

  select * into v_payment from public.platform_payments p
  where p.provider = p_provider and (
    (p_provider_payment_id is not null and p.provider_payment_id = p_provider_payment_id)
    or (p_provider_order_id is not null and p.provider_order_id = p_provider_order_id)
    or (p_provider_session_id is not null and p.provider_session_id = p_provider_session_id)
    or (p_provider_subscription_id is not null and p.provider_subscription_id = p_provider_subscription_id)
  ) limit 1 for update;
  if not found and p_metadata ? 'mavlyPaymentId' then
    select * into v_payment from public.platform_payments p
    where p.id::text = p_metadata ->> 'mavlyPaymentId' and p.provider = p_provider for update;
  end if;

  if found then
    select p.* into v_price from public.price_catalog p join public.price_catalog_versions v on v.id = p.version_id
    where p.product_id = v_payment.product_id and v.version = v_payment.catalog_version limit 1;
    if not found then
      insert into public.billing_reconciliation(provider, provider_transaction_id, internal_payment_id, discrepancy_type, status, details)
      values (p_provider, coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id), v_payment.id, 'catalog_missing', 'manual_review', jsonb_build_object('productId', v_payment.product_id, 'catalogVersion', v_payment.catalog_version));
      update public.billing_webhook_events set processing_status = 'failed', failure_reason = 'catalog_missing', processed_at = now() where id = v_event.id;
      return jsonb_build_object('status', 'rejected', 'reason', 'catalog_missing');
    end if;
    if p_amount_minor is not null and p_amount_minor <> v_payment.amount_minor then
      insert into public.billing_reconciliation(provider, provider_transaction_id, internal_payment_id, expected_amount_minor, actual_amount_minor, expected_currency, actual_currency, discrepancy_type, status)
      values (p_provider, coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id), v_payment.id, v_payment.amount_minor, p_amount_minor, v_payment.currency, p_currency, 'amount_mismatch', 'manual_review');
      update public.billing_webhook_events set processing_status = 'failed', failure_reason = 'amount_mismatch', processed_at = now() where id = v_event.id;
      return jsonb_build_object('status', 'rejected', 'reason', 'amount_mismatch');
    end if;
    if p_currency is not null and upper(p_currency) <> v_payment.currency then
      insert into public.billing_reconciliation(provider, provider_transaction_id, internal_payment_id, expected_amount_minor, actual_amount_minor, expected_currency, actual_currency, discrepancy_type, status)
      values (p_provider, coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id), v_payment.id, v_payment.amount_minor, p_amount_minor, v_payment.currency, p_currency, 'currency_mismatch', 'manual_review');
      update public.billing_webhook_events set processing_status = 'failed', failure_reason = 'currency_mismatch', processed_at = now() where id = v_event.id;
      return jsonb_build_object('status', 'rejected', 'reason', 'currency_mismatch');
    end if;
    if v_success then
      update public.platform_payments set status = case
          when p_event_type like '%refund%' and coalesce(p_amount_minor, v_payment.amount_minor) < v_payment.amount_minor then 'partially_refunded'
          when p_event_type like '%refund%' then 'refunded'
          else 'paid' end,
        provider_payment_id = coalesce(provider_payment_id, p_provider_payment_id), provider_order_id = coalesce(provider_order_id, p_provider_order_id),
        provider_session_id = coalesce(provider_session_id, p_provider_session_id), provider_customer_id = coalesce(provider_customer_id, p_provider_customer_id), paid_at = coalesce(paid_at, now())
      where id = v_payment.id returning * into v_payment;
      if v_payment.product_type = 'credit_pack' and p_event_type not like '%refund%' then
        v_grant := public.billing_grant_credit_lot(v_payment.user_id, 'purchase', v_payment.id::text, v_price.credits);
      elsif v_payment.product_type = 'credit_pack' and p_event_type like '%refund%' then
        v_refund_credits := floor((coalesce(p_amount_minor, v_payment.amount_minor)::numeric / v_payment.amount_minor::numeric) * coalesce(v_price.credits, 0))::bigint;
        insert into public.billing_refunds(payment_id, provider, provider_refund_id, amount_minor, currency, status, policy_status, credits_reversed, completed_at)
        values (v_payment.id, p_provider, p_event_id, coalesce(p_amount_minor, v_payment.amount_minor), v_payment.currency, 'succeeded', 'pending', 0, now())
        on conflict (provider, provider_refund_id) do nothing;
        if v_refund_credits > 0 then
          v_refund_status := public.billing_reverse_credit_lot(v_payment.user_id, p_event_id, v_refund_credits, v_payment.id::text);
        else
          v_refund_status := jsonb_build_object('status', 'not_applicable');
        end if;
        update public.billing_refunds set
          policy_status = case
            when v_refund_status ->> 'status' = 'applied' then 'applied'
            when v_refund_status ->> 'status' = 'not_applicable' then 'not_applicable'
            else 'manual_review' end,
          credits_reversed = case when v_refund_status ->> 'status' = 'applied' then v_refund_credits else 0 end
        where provider = p_provider and provider_refund_id = p_event_id;
        v_grant := v_refund_status;
      end if;
    else
      update public.platform_payments set status = case when p_provider_status in ('cancelled', 'expired') then 'cancelled' else 'failed' end where id = v_payment.id returning * into v_payment;
    end if;
  end if;

  if p_provider_subscription_id is not null then
    select * into v_sub from public.subscriptions where provider = p_provider and provider_subscription_id = p_provider_subscription_id for update;
    if not found and v_payment.id is not null and v_payment.product_type = 'subscription' then
      insert into public.subscriptions(user_id, plan_id, provider, provider_subscription_id, provider_customer_id, market, currency)
      values (v_payment.user_id, v_payment.product_id, v_payment.provider, p_provider_subscription_id, p_provider_customer_id, v_payment.market, v_payment.currency)
      on conflict (provider, provider_subscription_id) do update set provider_customer_id = coalesce(excluded.provider_customer_id, subscriptions.provider_customer_id)
      returning * into v_sub;
    end if;
    if found then
      update public.subscriptions set status = case
        when p_event_type like '%past_due%' or p_event_type like '%pending%' or p_event_type like '%on_hold%' then 'past_due'
        when p_event_type like '%cancel%' then 'cancelled'
        when p_event_type like '%expire%' or p_event_type like '%complete%' then 'expired'
        when p_event_type like '%fail%' then 'failed'
        when v_success then 'active' else status end,
        current_period_start = coalesce(p_period_start, current_period_start), current_period_end = coalesce(p_period_end, current_period_end),
        cancelled_at = case when p_event_type like '%cancel%' then coalesce(cancelled_at, now()) else cancelled_at end
      where id = v_sub.id returning * into v_sub;
      if v_success and (p_event_type like '%active%' or p_event_type like '%renew%' or p_event_type like '%charged%' or p_event_type like '%activated%') then
        select p.* into v_price from public.price_catalog p join public.price_catalog_versions v on v.id = p.version_id
        where p.product_id = v_sub.plan_id and p.market = v_sub.market and p.billing_interval = 'monthly' and p.active and p.approved limit 1;
        if found then
          insert into public.subscription_entitlements(subscription_id, user_id, plan_id, period_start, period_end, monthly_credits, project_limit)
          values (v_sub.id, v_sub.user_id, v_sub.plan_id, v_period_start, v_period_end, coalesce(v_price.credits, 0), coalesce(v_price.project_limit, 1))
          on conflict (subscription_id, period_start) do nothing returning * into v_entitlement;
          if found and v_entitlement.monthly_credits > 0 then
            v_grant := public.billing_grant_credit_lot(v_sub.user_id, 'subscription_grant', v_entitlement.id::text, v_entitlement.monthly_credits, v_entitlement.period_start, v_entitlement.period_end);
          end if;
        end if;
      end if;
    end if;
  end if;

  update public.billing_webhook_events set processing_status = case when v_payment.id is null and v_sub.id is null then 'ignored' else 'processed' end,
    processed_at = now() where id = v_event.id;
  if v_payment.id is not null and coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id) is not null then
    insert into public.billing_reconciliation_jobs(provider, provider_transaction_id, payment_id)
    values (p_provider, coalesce(p_provider_payment_id, p_provider_order_id, p_provider_session_id), v_payment.id)
    on conflict (provider, provider_transaction_id) do nothing;
  end if;
  return jsonb_build_object('status', case when v_payment.id is null and v_sub.id is null then 'ignored' else 'processed' end,
    'paymentId', v_payment.id, 'subscriptionId', v_sub.id, 'grant', v_grant);
end; $$;
revoke all on function public.billing_process_webhook(text, text, text, text, text, text, text, text, text, bigint, text, text, timestamptz, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.billing_process_webhook(text, text, text, text, text, text, text, text, text, bigint, text, text, timestamptz, timestamptz, text, jsonb) to service_role;

create or replace function public.claim_billing_reconciliation_job(p_worker_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.billing_reconciliation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_job from public.billing_reconciliation_jobs
  where status = 'queued' and available_at <= now()
  order by available_at, created_at
  limit 1 for update skip locked;
  if not found then return null; end if;
  update public.billing_reconciliation_jobs set status = 'processing', attempts = attempts + 1,
    lease_expires_at = now() + interval '2 minutes', updated_at = now()
  where id = v_job.id returning * into v_job;
  return to_jsonb(v_job);
end; $$;
revoke all on function public.claim_billing_reconciliation_job(text) from public, anon, authenticated;
grant execute on function public.claim_billing_reconciliation_job(text) to service_role;

create or replace function public.complete_billing_reconciliation_job(p_job_id uuid, p_status text, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job public.billing_reconciliation_jobs;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status not in ('succeeded', 'failed', 'queued') then raise exception 'INVALID_RECONCILIATION_STATUS' using errcode = '22023'; end if;
  update public.billing_reconciliation_jobs set status = p_status,
    available_at = case when p_status = 'queued' then now() + least(attempts * interval '30 seconds', interval '10 minutes') else available_at end,
    lease_expires_at = null, last_error = left(p_error, 500), updated_at = now()
  where id = p_job_id returning * into v_job;
  return to_jsonb(v_job);
end; $$;
revoke all on function public.complete_billing_reconciliation_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_billing_reconciliation_job(uuid, text, text) to service_role;

create or replace function public.billing_mark_webhook_failed(p_provider text, p_event_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update public.billing_webhook_events set processing_status = 'failed', failure_reason = left(coalesce(p_reason, 'processing_failed'), 500) where provider = p_provider and provider_event_id = p_event_id;
  return jsonb_build_object('status', 'failed');
end; $$;
revoke all on function public.billing_mark_webhook_failed(text, text, text) from public, anon, authenticated;
grant execute on function public.billing_mark_webhook_failed(text, text, text) to service_role;

create or replace function public.billing_user_entitlements()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_sub public.subscriptions; v_account public.credit_accounts; v_monthly bigint; v_purchased bigint; v_free bigint; v_projects bigint;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  select * into v_sub from public.subscriptions where user_id = v_uid and status in ('active', 'past_due') order by current_period_end desc nulls last, created_at desc limit 1;
  select * into v_account from public.credit_accounts where user_id = v_uid;
  select coalesce(sum(remaining_credits), 0) into v_monthly from public.billing_credit_lots where user_id = v_uid and source_kind = 'subscription_grant' and (period_end is null or period_end > now());
  select coalesce(sum(remaining_credits), 0) into v_purchased from public.billing_credit_lots where user_id = v_uid and source_kind = 'purchase';
  select coalesce(sum(remaining_credits), 0) into v_free from public.billing_credit_lots where user_id = v_uid and source_kind in ('free', 'admin_adjustment');
  select count(*) into v_projects from public.projects where user_id = v_uid;
  return jsonb_build_object(
    'planId', coalesce(v_sub.plan_id, 'free'),
    'projectLimit', case when v_sub.id is null then 1 else (select project_limit from public.price_catalog p join public.price_catalog_versions v on v.id = p.version_id where p.product_id = v_sub.plan_id and p.market = v_sub.market and p.active and p.approved order by v.created_at desc limit 1) end,
    'projectsUsed', v_projects,
    'monthlyCredits', v_monthly, 'purchasedCredits', v_purchased, 'freeCredits', v_free,
    'availableCredits', coalesce(v_account.balance_credits - v_account.reserved_credits, 0),
    'subscriptionStatus', v_sub.status, 'currentPeriodEnd', v_sub.current_period_end,
    'features', jsonb_build_object('paidPlan', v_sub.id is not null, 'sourceExport', v_sub.id is not null, 'customDomains', v_sub.id is not null, 'githubSync', v_sub.plan_id in ('creator', 'pro'))
  );
end; $$;
revoke all on function public.billing_user_entitlements() from public, anon;
grant execute on function public.billing_user_entitlements() to authenticated;

-- Database trigger: the UI and route are convenience layers; concurrent project
-- creation is enforced here. A provider outage never widens a user's limits.
create or replace function public.billing_project_limit_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_limit integer; v_used bigint; v_sub public.subscriptions;
begin
  if auth.role() = 'service_role' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('mavly:billing-project-limit:' || new.user_id::text));
  select * into v_sub from public.subscriptions where user_id = new.user_id and status in ('active', 'past_due') order by current_period_end desc nulls last limit 1;
  if not found then
    v_limit := 1;
  else
    select p.project_limit into v_limit from public.price_catalog p join public.price_catalog_versions v on v.id = p.version_id
    where p.product_id = v_sub.plan_id and p.market = v_sub.market and p.active and p.approved order by v.created_at desc limit 1;
    v_limit := coalesce(v_limit, 1);
  end if;
  select count(*) into v_used from public.projects where user_id = new.user_id;
  if v_used >= v_limit then raise exception 'PROJECT_LIMIT_REACHED' using errcode = 'P0001'; end if;
  return new;
end; $$;
revoke all on function public.billing_project_limit_guard() from public, anon, authenticated;
drop trigger if exists projects_billing_project_limit on public.projects;
create trigger projects_billing_project_limit before insert on public.projects
for each row execute function public.billing_project_limit_guard();

-- ── Admin read models ────────────────────────────────────────────────────────

create or replace function public.admin_billing_overview(
  p_limit integer default 50, p_offset integer default 0, p_search text default null, p_status text default 'all'
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_payments jsonb; v_subscriptions jsonb; v_refunds jsonb; v_reconciliation jsonb; v_summary jsonb; v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_offset integer := greatest(coalesce(p_offset, 0), 0); v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.current_user_is_admin() then raise exception 'admin_billing_overview: not authorized' using errcode = '42501'; end if;
  select jsonb_build_object(
    'totalVerifiedRevenueMinor', coalesce(sum(amount_minor) filter (where status = 'paid'), 0),
    'inrRevenueMinor', coalesce(sum(amount_minor) filter (where status = 'paid' and currency = 'INR'), 0),
    'usdRevenueMinor', coalesce(sum(amount_minor) filter (where status = 'paid' and currency = 'USD'), 0),
    'successfulPayments', count(*) filter (where status = 'paid'),
    'failedPayments', count(*) filter (where status = 'failed'),
    'refundedPayments', count(*) filter (where status in ('refunded', 'partially_refunded')),
    'activeSubscriptions', (select count(*) from public.subscriptions where status = 'active'),
    'pastDueSubscriptions', (select count(*) from public.subscriptions where status = 'past_due'),
    'cancelledSubscriptions', (select count(*) from public.subscriptions where status = 'cancelled'),
    'creditPackPurchases', count(*) filter (where status = 'paid' and product_type = 'credit_pack'),
    'subscriptionPayments', count(*) filter (where status = 'paid' and product_type = 'subscription'),
    'openReconciliationIssues', (select count(*) from public.billing_reconciliation where status in ('open', 'investigating', 'manual_review'))
  ) into v_summary from public.platform_payments;
  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_payments from (
    select p.id, p.user_id as "userId", u.email, p.product_id as "productId", p.product_type as "productType", p.provider, p.market, p.currency, p.amount_minor as "amountMinor", p.status, p.created_at as "createdAt", p.paid_at as "paidAt"
    from public.platform_payments p join auth.users u on u.id = p.user_id
    where (p_status = 'all' or p.status = p_status) and (v_search is null or u.email ilike '%' || v_search || '%' or p.id::text ilike '%' || v_search || '%' or coalesce(p.provider_payment_id, '') ilike '%' || v_search || '%')
    order by p.created_at desc limit v_limit offset v_offset
  ) page;
  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_subscriptions from (
    select s.id, s.user_id as "userId", u.email, s.plan_id as "planId", s.provider, s.market, s.currency, s.status, s.current_period_end as "currentPeriodEnd", s.cancel_at as "cancelAt", s.cancelled_at as "cancelledAt"
    from public.subscriptions s join auth.users u on u.id = s.user_id order by s.updated_at desc limit v_limit offset v_offset
  ) page;
  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_refunds from (
    select r.id, r.payment_id as "paymentId", r.provider, r.provider_refund_id as "providerRefundId", r.amount_minor as "amountMinor", r.currency, r.status, r.policy_status as "policyStatus", r.created_at as "createdAt"
    from public.billing_refunds r order by r.created_at desc limit v_limit offset v_offset
  ) page;
  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_reconciliation from (
    select r.id, r.provider, r.provider_transaction_id as "providerTransactionId", r.internal_payment_id as "internalPaymentId", r.expected_amount_minor as "expectedAmountMinor", r.actual_amount_minor as "actualAmountMinor", r.expected_currency as "expectedCurrency", r.actual_currency as "actualCurrency", r.discrepancy_type as "discrepancyType", r.status, r.created_at as "createdAt"
    from public.billing_reconciliation r order by r.created_at desc limit v_limit offset v_offset
  ) page;
  return jsonb_build_object('summary', v_summary, 'payments', v_payments, 'subscriptions', v_subscriptions, 'refunds', v_refunds, 'reconciliation', v_reconciliation);
end; $$;
revoke all on function public.admin_billing_overview(integer, integer, text, text) from public, anon;
grant execute on function public.admin_billing_overview(integer, integer, text, text) to authenticated, service_role;

create or replace function public.admin_billing_payment_for_refund(p_payment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_payment public.platform_payments;
begin
  if not public.current_user_is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_payment from public.platform_payments where id = p_payment_id;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_payment.id, 'provider', v_payment.provider, 'providerPaymentId', v_payment.provider_payment_id,
    'providerOrderId', v_payment.provider_order_id, 'amountMinor', v_payment.amount_minor, 'currency', v_payment.currency,
    'status', v_payment.status, 'userId', v_payment.user_id, 'productType', v_payment.product_type);
end; $$;
revoke all on function public.admin_billing_payment_for_refund(uuid) from public, anon;
grant execute on function public.admin_billing_payment_for_refund(uuid) to authenticated, service_role;

commit;
