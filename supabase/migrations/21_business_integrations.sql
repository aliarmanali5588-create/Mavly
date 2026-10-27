-- Mavly — Phase 6: business integrations (payments)
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- A generated application may need a real business provider (initially
-- Razorpay). Its credentials must not live in browser code, one project must
-- never reach another project's provider account, and a payment must only be
-- fulfilled after a signature-verified checkout callback or webhook.
--
-- ═══ WHAT IS ADDED ═══════════════════════════════════════════════════════════
--
--   1. `project_integrations` — per-project provider metadata. It stores NO
--      credential value: the three Razorpay credentials live as encrypted rows
--      in `project_secrets` (same AES-256-GCM mechanism and server-only key),
--      and this table only names them.
--   2. `project_integration_payments` — one row per order, with local
--      idempotency and the provider order/payment ids. `paid` is the only state
--      the generated app may fulfil from.
--   3. `project_integration_events` — provider webhook events, unique per
--      integration + provider event id, so a redelivery is processed once.
--   4. SECURITY DEFINER RPCs:
--        · owner RPCs verify `auth.uid()` and project ownership;
--        · gateway RPCs authenticate a hashed project API key that carries the
--          existing `integrations:*` scope and then read ciphertext only for
--          that key's own project;
--        · webhook RPCs resolve an unguessable per-integration token (the
--          token alone grants nothing: the signed body is the authentication).
--      The authenticated role has NO INSERT/UPDATE/DELETE grant on these
--      tables; every write goes through a fenced RPC.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Apply after 11 (project secrets) and 12 (project API keys). Nothing runs until
-- the operator sets `MAVLY_BUSINESS_INTEGRATIONS_ENABLED=on` and an explicit
-- `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS` cohort.
--
-- ADDITIVE AND IDEMPOTENT. Does not alter `projects`, `project_secrets`,
-- `project_api_keys` or any Phase 1–5 table.

begin;

-- ── 1. Per-project provider metadata ────────────────────────────────────────

create table if not exists public.project_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  provider text not null,
  enabled boolean not null default false,
  status text not null default 'configured',
  config jsonb not null default '{}'::jsonb,
  webhook_token text not null unique,
  credential_secret_names text[] not null default '{}'::text[],
  -- sha256(MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET). The anon-callable webhook
  -- write RPCs require this hash; without the server-only secret an anon caller
  -- cannot record or apply an event. The hash is never in the owner SELECT list.
  rpc_secret_hash text not null,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_integrations_category_check
    check (category in ('payments')),
  constraint project_integrations_provider_check
    check (provider in ('razorpay')),
  constraint project_integrations_status_check
    check (status in ('configured', 'verified', 'error', 'disabled')),
  constraint project_integrations_webhook_token_check
    check (webhook_token ~ '^whk_[a-f0-9]{48}$'),
  constraint project_integrations_config_object
    check (jsonb_typeof(config) = 'object'),
  constraint project_integrations_last_error_length
    check (last_error is null or length(last_error) <= 300),
  constraint project_integrations_credential_names_check
    check (array_length(credential_secret_names, 1) between 1 and 10),
  constraint project_integrations_rpc_hash_check
    check (rpc_secret_hash ~ '^[a-f0-9]{64}$')
);

comment on table public.project_integrations is
  'Per-project business-integration metadata. Credentials are encrypted project_secrets; this table only names them.';
comment on column public.project_integrations.webhook_token is
  'Unguessable webhook path identifier. It grants nothing without a provider-signed body and is kept stable across disable/re-enable.';
comment on column public.project_integrations.credential_secret_names is
  'The project_secrets names the adapter may read. No value or ciphertext is stored here.';
comment on column public.project_integrations.rpc_secret_hash is
  'SHA-256 of the server-only business-integrations RPC secret. Required by the anon-callable webhook write RPCs; never returned to a client.';

create unique index if not exists project_integrations_project_provider_key
  on public.project_integrations (project_id, provider);
create index if not exists project_integrations_user_idx
  on public.project_integrations (user_id);

-- ── 2. Payment orders ───────────────────────────────────────────────────────

create table if not exists public.project_integration_payments (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null
    references public.project_integrations (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_order_id text,
  provider_payment_id text,
  idempotency_key text not null,
  receipt text not null,
  amount_minor bigint not null,
  currency text not null,
  status text not null default 'creating',
  failure_code text,
  notes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint project_integration_payments_provider_check
    check (provider in ('razorpay')),
  constraint project_integration_payments_amount_check
    check (amount_minor between 1 and 5000000000),
  constraint project_integration_payments_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint project_integration_payments_status_check
    check (status in (
      'creating', 'created', 'pending', 'authorized', 'paid',
      'failed', 'cancelled', 'expired', 'unknown'
    )),
  constraint project_integration_payments_idempotency_check
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  constraint project_integration_payments_receipt_check
    check (receipt ~ '^[A-Za-z0-9._:-]{1,40}$'),
  constraint project_integration_payments_failure_code_check
    check (failure_code is null or failure_code ~ '^[a-z_]{3,40}$'),
  constraint project_integration_payments_notes_object
    check (jsonb_typeof(notes) = 'object' and length(notes::text) <= 4000),
  constraint project_integration_payments_order_format
    check (provider_order_id is null or provider_order_id ~ '^order_[A-Za-z0-9]{6,64}$'),
  constraint project_integration_payments_payment_format
    check (provider_payment_id is null or provider_payment_id ~ '^pay_[A-Za-z0-9]{6,64}$'),
  constraint project_integration_payments_paid_at_check
    check (status <> 'paid' or paid_at is not null)
);

comment on table public.project_integration_payments is
  'Payment orders created through the Mavly integration gateway. No card or bank data is stored.';
comment on column public.project_integration_payments.status is
  'paid is written only from a signature-verified callback/webhook (or an authoritative provider read behind a verified callback).';

create unique index if not exists project_integration_payments_order_key
  on public.project_integration_payments (provider_order_id)
  where provider_order_id is not null;
create unique index if not exists project_integration_payments_payment_key
  on public.project_integration_payments (provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists project_integration_payments_idempotency_key
  on public.project_integration_payments (integration_id, idempotency_key);
create unique index if not exists project_integration_payments_receipt_key
  on public.project_integration_payments (integration_id, receipt);
create index if not exists project_integration_payments_project_idx
  on public.project_integration_payments (project_id, created_at desc);

-- ── 3. Webhook events ───────────────────────────────────────────────────────

create table if not exists public.project_integration_events (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null
    references public.project_integrations (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload_sha256 text not null,
  status text not null default 'received',
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint project_integration_events_provider_check
    check (provider in ('razorpay')),
  constraint project_integration_events_status_check
    check (status in ('received', 'processed', 'ignored', 'failed')),
  constraint project_integration_events_event_id_check
    check (length(provider_event_id) between 1 and 128),
  constraint project_integration_events_type_check
    check (provider_event_id ~ '^[A-Za-z0-9._:-]+$' and length(event_type) between 1 and 80),
  constraint project_integration_events_digest_check
    check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  constraint project_integration_events_error_check
    check (error_code is null or error_code ~ '^[a-z_]{3,40}$')
);

comment on table public.project_integration_events is
  'Minimal webhook audit state. The raw body is not stored; only a SHA-256 digest and the event type are kept.';

-- ⚠️ THE UNIQUE KEY IS THE SIGNED BODY DIGEST, NOT THE HEADER EVENT ID.
-- Razorpay's HMAC covers the body only; the event-id header is unsigned. Keying
-- idempotency on the header would let a captured body be replayed with a new
-- header. The digest is covered by the signature and is stable across retries.
create unique index if not exists project_integration_events_digest_key
  on public.project_integration_events (integration_id, payload_sha256);
create index if not exists project_integration_events_project_idx
  on public.project_integration_events (project_id, received_at desc);

-- ── 4. RLS and least-privilege grants ───────────────────────────────────────

alter table public.project_integrations enable row level security;
alter table public.project_integration_payments enable row level security;
alter table public.project_integration_events enable row level security;

drop policy if exists "project_integrations_select_own" on public.project_integrations;
create policy "project_integrations_select_own"
  on public.project_integrations
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_integrations.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_integration_payments_select_own" on public.project_integration_payments;
create policy "project_integration_payments_select_own"
  on public.project_integration_payments
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_integration_payments.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_integration_events_select_own" on public.project_integration_events;
create policy "project_integration_events_select_own"
  on public.project_integration_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.project_id = project_integration_events.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.project_integrations from public;
revoke all on public.project_integrations from anon;
revoke all on public.project_integrations from authenticated;

revoke all on public.project_integration_payments from public;
revoke all on public.project_integration_payments from anon;
revoke all on public.project_integration_payments from authenticated;

revoke all on public.project_integration_events from public;
revoke all on public.project_integration_events from anon;
revoke all on public.project_integration_events from authenticated;

grant select (
  id, project_id, category, provider, enabled, status, config,
  webhook_token, credential_secret_names, last_error, last_checked_at,
  created_at, updated_at
) on public.project_integrations to authenticated;
-- rpc_secret_hash is deliberately NOT granted to authenticated (or anyone):
-- only the SECURITY DEFINER webhook RPCs compare it.

grant select (
  id, integration_id, project_id, provider, provider_order_id,
  provider_payment_id, receipt, amount_minor, currency, status,
  failure_code, created_at, updated_at, paid_at
) on public.project_integration_payments to authenticated;

grant select (
  id, integration_id, project_id, provider, provider_event_id,
  event_type, payload_sha256, status, error_code, received_at, processed_at
) on public.project_integration_events to authenticated;

-- ── 5. Owner RPCs (auth.uid() ownership is verified inside each function) ────

create or replace function public.save_payment_integration(
  p_project_id text,
  p_provider text,
  p_key_id text,
  p_enabled boolean,
  p_secret_names text[],
  p_rpc_secret_hash text
)
returns table (
  integration_id uuid,
  provider text,
  enabled boolean,
  status text,
  webhook_token text,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_existed boolean;
  v_token text;
  v_mode text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;
  if p_provider <> 'razorpay' then
    raise exception 'unsupported provider' using errcode = '22023';
  end if;
  if p_key_id is null or p_key_id !~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$' then
    raise exception 'invalid key id' using errcode = '22023';
  end if;
  if p_rpc_secret_hash is null or p_rpc_secret_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid rpc secret hash' using errcode = '22023';
  end if;
  -- The adapter may read ONLY its own three names. Otherwise an owner could
  -- point the integration at an unrelated secret (e.g. DATABASE_URL) and the
  -- gateway would send it to Razorpay as a Basic credential.
  if p_secret_names is null
     or array_length(p_secret_names, 1) is distinct from 3
     or not (p_secret_names @> array[
       'RAZORPAY_KEY_ID',
       'RAZORPAY_KEY_SECRET',
       'RAZORPAY_WEBHOOK_SECRET'
     ]::text[]) then
    raise exception 'invalid credential names' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_secret_names) n
    where n !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
  ) then
    raise exception 'invalid credential name' using errcode = '22023';
  end if;

  v_mode := case when p_key_id like 'rzp_test_%' then 'test' else 'live' end;

  select exists (
    select 1 from public.project_integrations i
    where i.project_id = p_project_id and i.provider = p_provider
  ) into v_existed;

  if v_existed then
    update public.project_integrations i
       set enabled = p_enabled,
           status = case when p_enabled then 'configured' else 'disabled' end,
           config = coalesce(i.config, '{}'::jsonb)
                    || jsonb_build_object('keyId', p_key_id, 'mode', v_mode),
           credential_secret_names = p_secret_names,
           rpc_secret_hash = p_rpc_secret_hash,
           last_error = null,
           updated_at = now()
     where i.project_id = p_project_id and i.provider = p_provider;
  else
    v_token := 'whk_' || substr(
      replace(gen_random_uuid()::text, '-', '') ||
      replace(gen_random_uuid()::text, '-', ''),
      1, 48
    );
    insert into public.project_integrations (
      project_id, user_id, category, provider, enabled, status, config,
      webhook_token, credential_secret_names, rpc_secret_hash
    ) values (
      p_project_id, v_uid, 'payments', p_provider, p_enabled,
      case when p_enabled then 'configured' else 'disabled' end,
      jsonb_build_object('keyId', p_key_id, 'mode', v_mode),
      v_token, p_secret_names, p_rpc_secret_hash
    );
  end if;

  return query
    select i.id, i.provider, i.enabled, i.status, i.webhook_token, not v_existed
      from public.project_integrations i
     where i.project_id = p_project_id and i.provider = p_provider;
end;
$$;

comment on function public.save_payment_integration(text, text, text, boolean, text[], text) is
  'Owner-only. Stores non-secret provider metadata, credential names and the RPC-secret hash; credential values remain encrypted project_secrets.';

create or replace function public.mark_payment_integration_checked(
  p_project_id text,
  p_provider text,
  p_ok boolean,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_error is not null and length(p_error) > 300 then
    raise exception 'error message too long' using errcode = '22023';
  end if;
  update public.project_integrations i
     set status = case
           when not i.enabled then 'disabled'
           when p_ok then 'verified'
           else 'error'
         end,
         last_checked_at = now(),
         last_error = case when p_ok then null else coalesce(p_error, 'The provider check failed.') end,
         updated_at = now()
   where i.project_id = p_project_id
     and i.provider = p_provider
     and exists (
       select 1 from public.projects p
       where p.project_id = i.project_id and p.user_id = v_uid
     );
  if not found then
    raise exception 'integration not found' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.disable_payment_integration(
  p_project_id text,
  p_provider text
)
returns table (webhook_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  -- The webhook token is NOT rotated on disable. It is an identifier, not a
  -- credential (the signed body is), and keeping it stable means in-flight
  -- payments still reach the receiver and re-enabling needs no provider edit.
  update public.project_integrations i
     set enabled = false,
         status = 'disabled',
         last_checked_at = now(),
         updated_at = now()
   where i.project_id = p_project_id and i.provider = p_provider;

  if not found then
    raise exception 'integration not found' using errcode = '42501';
  end if;

  return query
    select i.webhook_token
      from public.project_integrations i
     where i.project_id = p_project_id and i.provider = p_provider;
end;
$$;

revoke all on function public.save_payment_integration(text, text, text, boolean, text[], text) from public;
revoke all on function public.save_payment_integration(text, text, text, boolean, text[], text) from anon;
grant execute on function public.save_payment_integration(text, text, text, boolean, text[], text) to authenticated;

revoke all on function public.mark_payment_integration_checked(text, text, boolean, text) from public;
revoke all on function public.mark_payment_integration_checked(text, text, boolean, text) from anon;
grant execute on function public.mark_payment_integration_checked(text, text, boolean, text) to authenticated;

-- Owner-side credential read for a connection test. Only the project owner can
-- call it, and it returns ciphertext (decrypted by the server route), never a
-- value to a browser.
create or replace function public.owner_payment_credentials(
  p_project_id text,
  p_provider text
)
returns table (
  secret_name text,
  secret_id uuid,
  value_ciphertext text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  return query
    select distinct on (psec.secret_name)
           psec.secret_name, psec.id, psec.value_ciphertext
      from public.project_secrets psec
      join public.project_integrations i
        on i.project_id = psec.project_id and i.provider = p_provider
     where psec.project_id = p_project_id
       and psec.user_id = v_uid
       and psec.secret_name = any(i.credential_secret_names)
       and psec.environment in ('production', 'both')
     order by psec.secret_name,
              case psec.environment when 'production' then 0 else 1 end;
end;
$$;

revoke all on function public.disable_payment_integration(text, text) from public;
revoke all on function public.disable_payment_integration(text, text) from anon;
grant execute on function public.disable_payment_integration(text, text) to authenticated;

revoke all on function public.owner_payment_credentials(text, text) from public;
revoke all on function public.owner_payment_credentials(text, text) from anon;
grant execute on function public.owner_payment_credentials(text, text) to authenticated;

-- ── 6. Gateway RPCs (hashed project API key + `integrations:*` scope) ───────
--
-- The key hash is SHA-256(plaintext). Possession of the plaintext is the
-- credential; the hash only selects the row. Every function repeats the scope,
-- revocation and ownership predicates itself.

create or replace function public.gateway_payment_context(
  p_key_hash text,
  p_provider text,
  p_rpc_hash text
)
returns table (
  integration_id uuid,
  project_id text,
  user_id uuid,
  enabled boolean,
  secret_name text,
  secret_id uuid,
  value_ciphertext text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_provider <> 'razorpay' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;

  update public.project_api_keys k
     set last_used_at = now()
   where k.key_hash = p_key_hash
     and k.revoked_at is null
     and k.env in ('live', 'both')
     and k.scopes ? 'integrations:*';

  return query
    select i.id,
           i.project_id,
           i.user_id,
           i.enabled,
           ps.secret_name,
           ps.id,
           ps.value_ciphertext
      from public.project_api_keys k
      join public.project_integrations i
        on i.project_id = k.project_id
       and i.provider = p_provider
       and i.rpc_secret_hash = p_rpc_hash
      left join lateral (
        select distinct on (psec.secret_name)
               psec.secret_name, psec.id, psec.value_ciphertext
          from public.project_secrets psec
         where psec.project_id = i.project_id
           and psec.user_id = k.user_id
           and psec.secret_name = any(i.credential_secret_names)
           and psec.environment in ('production', 'both')
         order by psec.secret_name,
                  case psec.environment when 'production' then 0 else 1 end
      ) ps on true
     where k.key_hash = p_key_hash
       and k.revoked_at is null
       and k.env in ('live', 'both')
       and k.scopes ? 'integrations:*';
end;
$$;

comment on function public.gateway_payment_context(text, text, text) is
  'Gateway authentication + encrypted credential read for one hashed key, its own project and the server RPC hash. Returns ciphertext only.';

create or replace function public.gateway_begin_payment(
  p_key_hash text,
  p_provider text,
  p_integration_id uuid,
  p_idempotency_key text,
  p_amount_minor bigint,
  p_currency text,
  p_notes jsonb,
  p_rpc_hash text
)
returns table (
  payment_id uuid,
  created boolean,
  status text,
  provider_order_id text,
  receipt text,
  amount_minor bigint,
  currency text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project text;
  v_user uuid;
  v_id uuid;
  v_inserted_id uuid;
  v_receipt text;
  v_created boolean := false;
  v_row public.project_integration_payments%rowtype;
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_provider <> 'razorpay' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 5000000000 then
    raise exception 'invalid amount' using errcode = '22023';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid currency' using errcode = '22023';
  end if;
  if p_notes is null or jsonb_typeof(p_notes) <> 'object' or length(p_notes::text) > 4000 then
    raise exception 'invalid notes' using errcode = '22023';
  end if;

  select i.project_id, i.user_id
    into v_project, v_user
    from public.project_api_keys k
    join public.project_integrations i
      on i.project_id = k.project_id
     and i.provider = p_provider
     and i.enabled
     and i.rpc_secret_hash = p_rpc_hash
   where k.key_hash = p_key_hash
     and k.revoked_at is null
     and k.env in ('live', 'both')
     and k.scopes ? 'integrations:*'
     and i.id = p_integration_id;

  if v_project is null then
    return;
  end if;

  v_id := gen_random_uuid();
  v_receipt := 'm' || replace(v_id::text, '-', '');

  insert into public.project_integration_payments (
    id, integration_id, project_id, user_id, provider,
    idempotency_key, receipt, amount_minor, currency, status, notes
  ) values (
    v_id, p_integration_id, v_project, v_user, p_provider,
    p_idempotency_key, v_receipt, p_amount_minor, p_currency, 'creating', p_notes
  )
  on conflict (integration_id, idempotency_key) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is not null then
    v_created := true;
    select * into v_row
      from public.project_integration_payments r
     where r.id = v_inserted_id;
  else
    select * into v_row
      from public.project_integration_payments r
     where r.integration_id = p_integration_id
       and r.idempotency_key = p_idempotency_key
     for update;

    -- A request that died while creating an order must not block this key
    -- forever. After a minute it is recorded as an interrupted failure.
    if v_row.status = 'creating'
       and v_row.provider_order_id is null
       and v_row.updated_at < now() - interval '1 minute' then
      update public.project_integration_payments r
         set status = 'failed',
             failure_code = 'provider_timeout',
             updated_at = now()
       where r.id = v_row.id
       returning * into v_row;
    end if;
  end if;

  return query select v_row.id, v_created, v_row.status, v_row.provider_order_id,
                      v_row.receipt, v_row.amount_minor, v_row.currency;
end;
$$;

create or replace function public.gateway_set_payment_order(
  p_payment_id uuid,
  p_key_hash text,
  p_provider_order_id text,
  p_rpc_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_found boolean := false;
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return false;
  end if;
  if p_provider_order_id is null or p_provider_order_id !~ '^order_[A-Za-z0-9]{6,64}$' then
    return false;
  end if;

  update public.project_integration_payments pay
     set provider_order_id = p_provider_order_id,
         status = 'created',
         updated_at = now()
   where pay.id = p_payment_id
     and pay.status = 'creating'
     and exists (
       select 1 from public.project_api_keys k
       join public.project_integrations i
         on i.project_id = k.project_id and i.id = pay.integration_id
       where k.key_hash = p_key_hash
         and k.revoked_at is null
         and k.env in ('live', 'both')
         and k.scopes ? 'integrations:*'
         and i.rpc_secret_hash = p_rpc_hash
     );
  v_found := found;

  -- If the update lost its response but the same order was already recorded,
  -- report success instead of failing a retry that has nothing left to do.
  if not v_found then
    select exists (
      select 1
        from public.project_integration_payments pay
       where pay.id = p_payment_id
         and pay.provider_order_id = p_provider_order_id
         and exists (
           select 1 from public.project_api_keys k
           join public.project_integrations i
             on i.project_id = k.project_id and i.id = pay.integration_id
           where k.key_hash = p_key_hash
             and k.revoked_at is null
             and k.env in ('live', 'both')
             and k.scopes ? 'integrations:*'
             and i.rpc_secret_hash = p_rpc_hash
         )
    ) into v_found;
  end if;

  return v_found;
end;
$$;

create or replace function public.gateway_fail_payment(
  p_payment_id uuid,
  p_key_hash text,
  p_failure_code text,
  p_rpc_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_failure_code is null or p_failure_code !~ '^[a-z_]{3,40}$' then
    return;
  end if;

  update public.project_integration_payments pay
     set status = 'failed',
         failure_code = p_failure_code,
         updated_at = now()
   where pay.id = p_payment_id
     and pay.status <> 'paid'
     and exists (
       select 1 from public.project_api_keys k
       join public.project_integrations i
         on i.project_id = k.project_id and i.id = pay.integration_id
       where k.key_hash = p_key_hash
         and k.revoked_at is null
         and k.env in ('live', 'both')
         and k.scopes ? 'integrations:*'
         and i.rpc_secret_hash = p_rpc_hash
     );
end;
$$;

create or replace function public.gateway_mark_payment(
  p_key_hash text,
  p_provider text,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_rpc_hash text
)
returns table (payment_id uuid, status text, matched boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_integration_payments%rowtype;
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_provider <> 'razorpay' then
    return;
  end if;
  if p_provider_order_id is null or p_provider_order_id !~ '^order_[A-Za-z0-9]{6,64}$' then
    return;
  end if;
  if p_provider_payment_id is not null
     and p_provider_payment_id !~ '^pay_[A-Za-z0-9]{6,64}$' then
    return;
  end if;
  if p_status not in ('pending', 'authorized', 'paid', 'failed') then
    return;
  end if;

  select * into v_row
    from public.project_integration_payments pay
   where pay.provider_order_id = p_provider_order_id
     and pay.provider = p_provider
     and exists (
       select 1 from public.project_api_keys k
       join public.project_integrations i
         on i.project_id = k.project_id and i.id = pay.integration_id
       where k.key_hash = p_key_hash
         and k.project_id = pay.project_id
         and k.revoked_at is null
         and k.env in ('live', 'both')
         and k.scopes ? 'integrations:*'
         and i.rpc_secret_hash = p_rpc_hash
     )
   for update;

  if v_row.id is null then
    return;
  end if;

  -- A verified callback may only confirm the order it belongs to, for the
  -- amount and currency that were created.
  if v_row.amount_minor <> p_amount_minor or v_row.currency <> p_currency then
    return query select v_row.id, v_row.status, false;
    return;
  end if;

  if p_status = 'paid' then
    if v_row.status <> 'paid' then
      update public.project_integration_payments pay
         set status = 'paid',
             provider_payment_id = coalesce(pay.provider_payment_id, p_provider_payment_id),
             failure_code = null,
             paid_at = coalesce(pay.paid_at, now()),
             updated_at = now()
       where pay.id = v_row.id
       returning * into v_row;
    end if;
  elsif v_row.status <> 'paid' and p_status = 'failed' then
    update public.project_integration_payments pay
       set status = 'failed',
           failure_code = coalesce(pay.failure_code, 'provider_rejected'),
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  elsif v_row.status <> 'paid' and p_status = 'authorized'
        and v_row.status in ('creating', 'created', 'pending', 'unknown') then
    update public.project_integration_payments pay
       set status = 'authorized',
           provider_payment_id = coalesce(pay.provider_payment_id, p_provider_payment_id),
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  elsif v_row.status in ('created', 'unknown') and p_status = 'pending' then
    update public.project_integration_payments pay
       set status = 'pending',
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  end if;

  return query select v_row.id, v_row.status, true;
end;
$$;

create or replace function public.gateway_payment_status(
  p_key_hash text,
  p_provider text,
  p_provider_order_id text,
  p_rpc_hash text
)
returns table (
  payment_id uuid,
  status text,
  provider_payment_id text,
  amount_minor bigint,
  currency text,
  failure_code text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_provider_order_id is null or p_provider_order_id !~ '^order_[A-Za-z0-9]{6,64}$' then
    return;
  end if;

  return query
    select pay.id, pay.status, pay.provider_payment_id, pay.amount_minor,
           pay.currency, pay.failure_code, pay.paid_at
      from public.project_integration_payments pay
     where pay.provider_order_id = p_provider_order_id
       and pay.provider = p_provider
       and exists (
         select 1 from public.project_api_keys k
         join public.project_integrations i
           on i.project_id = k.project_id and i.id = pay.integration_id
         where k.key_hash = p_key_hash
           and k.project_id = pay.project_id
           and k.revoked_at is null
           and k.env in ('live', 'both')
           and k.scopes ? 'integrations:*'
           and i.rpc_secret_hash = p_rpc_hash
       );
end;
$$;

revoke all on function public.gateway_payment_context(text, text, text) from public;
grant execute on function public.gateway_payment_context(text, text, text) to anon, authenticated;

revoke all on function public.gateway_begin_payment(text, text, uuid, text, bigint, text, jsonb, text) from public;
grant execute on function public.gateway_begin_payment(text, text, uuid, text, bigint, text, jsonb, text) to anon, authenticated;

revoke all on function public.gateway_set_payment_order(uuid, text, text, text) from public;
grant execute on function public.gateway_set_payment_order(uuid, text, text, text) to anon, authenticated;

revoke all on function public.gateway_fail_payment(uuid, text, text, text) from public;
grant execute on function public.gateway_fail_payment(uuid, text, text, text) to anon, authenticated;

revoke all on function public.gateway_mark_payment(text, text, text, text, text, bigint, text, text) from public;
grant execute on function public.gateway_mark_payment(text, text, text, text, text, bigint, text, text) to anon, authenticated;

revoke all on function public.gateway_payment_status(text, text, text, text) from public;
grant execute on function public.gateway_payment_status(text, text, text, text) to anon, authenticated;

-- ── 7. Webhook RPCs (unguessable token; the signature is the authority) ─────

create or replace function public.gateway_webhook_context(
  p_token text,
  p_provider text,
  p_rpc_hash text
)
returns table (
  integration_id uuid,
  project_id text,
  user_id uuid,
  secret_name text,
  secret_id uuid,
  value_ciphertext text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_token is null or p_token !~ '^whk_[a-f0-9]{48}$' then
    return;
  end if;
  if p_provider <> 'razorpay' then
    return;
  end if;
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;

  return query
    select i.id,
           i.project_id,
           i.user_id,
           ps.secret_name,
           ps.id,
           ps.value_ciphertext
      from public.project_integrations i
      left join lateral (
        select distinct on (psec.secret_name)
               psec.secret_name, psec.id, psec.value_ciphertext
          from public.project_secrets psec
         where psec.project_id = i.project_id
           and psec.user_id = i.user_id
           and psec.secret_name = any(i.credential_secret_names)
           and psec.environment in ('production', 'both')
         order by psec.secret_name,
                  case psec.environment when 'production' then 0 else 1 end
      ) ps on true
     where i.webhook_token = p_token
       and i.provider = p_provider
       and i.rpc_secret_hash = p_rpc_hash;
end;
$$;

create or replace function public.gateway_record_webhook_event(
  p_integration_id uuid,
  p_provider_event_id text,
  p_event_type text,
  p_payload_sha256 text,
  p_rpc_hash text
)
returns table (event_id uuid, current_status text, fresh boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_status text;
  v_project text;
begin
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if not exists (
    select 1 from public.project_integrations i
    where i.id = p_integration_id and i.rpc_secret_hash = p_rpc_hash
  ) then
    return;
  end if;
  if p_provider_event_id is null
     or p_provider_event_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_event_type is null or length(p_event_type) > 80 then
    raise exception 'invalid event type' using errcode = '22023';
  end if;
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid payload digest' using errcode = '22023';
  end if;

  select i.project_id into v_project
    from public.project_integrations i
   where i.id = p_integration_id;
  if v_project is null then
    return;
  end if;

  insert into public.project_integration_events (
    integration_id, project_id, provider, provider_event_id, event_type,
    payload_sha256, status
  ) values (
    p_integration_id, v_project, 'razorpay', p_provider_event_id, p_event_type,
    p_payload_sha256, 'received'
  )
  on conflict (integration_id, payload_sha256) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, 'received'::text, true;
    return;
  end if;

  select e.id, e.status into v_id, v_status
    from public.project_integration_events e
   where e.integration_id = p_integration_id
     and e.payload_sha256 = p_payload_sha256
   for update;

  -- A previous failed processing may be retried; a processed/ignored event is
  -- never re-applied.
  if v_status = 'failed' then
    update public.project_integration_events e
       set status = 'received', error_code = null, processed_at = null
     where e.id = v_id;
    return query select v_id, 'received'::text, true;
  else
    return query select v_id, v_status, false;
  end if;
end;
$$;

create or replace function public.gateway_finish_webhook_event(
  p_event_id uuid,
  p_status text,
  p_error_code text,
  p_rpc_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if p_status not in ('processed', 'ignored', 'failed') then
    raise exception 'invalid event status' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z_]{3,40}$' then
    raise exception 'invalid error code' using errcode = '22023';
  end if;

  update public.project_integration_events e
     set status = p_status,
         error_code = case when p_status = 'failed' then p_error_code else null end,
         processed_at = case when p_status = 'failed' then null else now() end
   where e.id = p_event_id
     and e.status = 'received'
     and exists (
       select 1 from public.project_integrations i
       where i.id = e.integration_id and i.rpc_secret_hash = p_rpc_hash
     );
end;
$$;

create or replace function public.gateway_apply_webhook_payment(
  p_integration_id uuid,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_status text,
  p_amount_minor bigint,
  p_currency text,
  p_rpc_hash text
)
returns table (payment_id uuid, status text, matched boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_integration_payments%rowtype;
begin
  if p_rpc_hash is null or p_rpc_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;
  if not exists (
    select 1 from public.project_integrations i
    where i.id = p_integration_id and i.rpc_secret_hash = p_rpc_hash
  ) then
    return;
  end if;
  if p_provider_order_id is null or p_provider_order_id !~ '^order_[A-Za-z0-9]{6,64}$' then
    return;
  end if;
  if p_provider_payment_id is not null
     and p_provider_payment_id !~ '^pay_[A-Za-z0-9]{6,64}$' then
    return;
  end if;
  if p_status not in ('pending', 'authorized', 'paid', 'failed') then
    return;
  end if;

  select * into v_row
    from public.project_integration_payments pay
   where pay.integration_id = p_integration_id
     and pay.provider_order_id = p_provider_order_id
   for update;

  if v_row.id is null then
    return;
  end if;

  if v_row.amount_minor <> p_amount_minor or v_row.currency <> p_currency then
    return query select v_row.id, v_row.status, false;
    return;
  end if;

  if p_status = 'paid' then
    if v_row.status <> 'paid' then
      update public.project_integration_payments pay
         set status = 'paid',
             provider_payment_id = coalesce(pay.provider_payment_id, p_provider_payment_id),
             failure_code = null,
             paid_at = coalesce(pay.paid_at, now()),
             updated_at = now()
       where pay.id = v_row.id
       returning * into v_row;
    end if;
  elsif v_row.status <> 'paid' and p_status = 'failed' then
    update public.project_integration_payments pay
       set status = 'failed',
           failure_code = coalesce(pay.failure_code, 'provider_rejected'),
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  elsif v_row.status <> 'paid' and p_status = 'authorized'
        and v_row.status in ('creating', 'created', 'pending', 'unknown') then
    update public.project_integration_payments pay
       set status = 'authorized',
           provider_payment_id = coalesce(pay.provider_payment_id, p_provider_payment_id),
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  elsif v_row.status in ('created', 'unknown') and p_status = 'pending' then
    update public.project_integration_payments pay
       set status = 'pending',
           updated_at = now()
     where pay.id = v_row.id
     returning * into v_row;
  end if;

  return query select v_row.id, v_row.status, true;
end;
$$;

revoke all on function public.gateway_webhook_context(text, text, text) from public;
grant execute on function public.gateway_webhook_context(text, text, text) to anon, authenticated;

revoke all on function public.gateway_record_webhook_event(uuid, text, text, text, text) from public;
grant execute on function public.gateway_record_webhook_event(uuid, text, text, text, text) to anon, authenticated;

revoke all on function public.gateway_finish_webhook_event(uuid, text, text, text) from public;
grant execute on function public.gateway_finish_webhook_event(uuid, text, text, text) to anon, authenticated;

revoke all on function public.gateway_apply_webhook_payment(uuid, text, text, text, bigint, text, text) from public;
grant execute on function public.gateway_apply_webhook_payment(uuid, text, text, text, bigint, text, text) to anon, authenticated;

-- ── 8. Schema marker / preflight ────────────────────────────────────────────

create or replace function public.business_integrations_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 21;
$$;

revoke all on function public.business_integrations_schema_version() from public;
revoke all on function public.business_integrations_schema_version() from anon;
grant execute on function public.business_integrations_schema_version() to authenticated, service_role;

comment on function public.business_integrations_schema_version() is
  'Business-integrations schema marker. 21 means the integration/payment/event tables and their fenced RPCs are installed.';

commit;
