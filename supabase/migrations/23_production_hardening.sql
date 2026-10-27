-- Mavly — Phase 7: durable integration rate limits
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Phase 6's payment gateway enforced a best-effort, per-process window. In a
-- multi-instance/serverless deployment that is not a real ceiling: each cold
-- start and each instance has its own counter. This migration adds one small,
-- durable table and one SECURITY DEFINER RPC, called by the gateway route after
-- it has authenticated the project API key and the server-only RPC hash.
--
-- ═══ WHAT IT IS NOT ══════════════════════════════════════════════════════════
--
--   · It does not touch payment state; it only counts attempts.
--   · It is not a webhook limiter. Provider webhooks must not be dropped: they
--     are deduplicated by their signed-body digest and may be retried.
--   · It does not replace the provider's own rate limits; it is a Mavly-side
--     guardrail against one project exhausting provider capacity or a runaway
--     generated-app loop.
--
-- ═══ LIMITS (FIXED IN THE FUNCTION, NOT CALLER-SUPPLIED) ════════════════════
--
--   order_create    30 attempts / 60 s / integration (= project + provider)
--   payment_verify  60 attempts / 60 s / integration
--
-- The limits are fixed in SQL so a caller with a valid API key cannot raise
-- them. Changing them requires a forward migration.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Apply after 21 (business integrations) and 22. Additive; it creates a new
-- table/function and does not alter Phase 1–6 objects. The gateway fails closed
-- with a 503 while this RPC is missing, so apply it before enabling the Phase 6
-- cohort in an environment that will serve payment orders.

begin;

-- ── 1. Durable counters ─────────────────────────────────────────────────────

create table if not exists public.integration_rate_limits (
  integration_id uuid not null
    references public.project_integrations (id) on delete cascade,
  operation text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (integration_id, operation, window_start),
  constraint integration_rate_limits_operation_check
    check (operation in ('order_create', 'payment_verify')),
  constraint integration_rate_limits_count_check
    check (count between 0 and 1000000)
);

comment on table public.integration_rate_limits is
  'Durable per-integration attempt counters for the payment gateway. No secret, payment or personal data. Bounded cleanup keeps only recent windows.';
comment on column public.integration_rate_limits.operation is
  'order_create or payment_verify; limits are fixed in consume_integration_rate_limit().';

create index if not exists integration_rate_limits_window_idx
  on public.integration_rate_limits (window_start);

alter table public.integration_rate_limits enable row level security;
revoke all on public.integration_rate_limits from public;
revoke all on public.integration_rate_limits from anon;
revoke all on public.integration_rate_limits from authenticated;
-- No policy and no grant: only the definer function below reads or writes it.

-- ── 2. Atomic consume RPC ──────────────────────────────────────────────────

create or replace function public.consume_integration_rate_limit(
  p_key_hash text,
  p_provider text,
  p_rpc_hash text,
  p_operation text
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_integration uuid;
  v_limit integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
  v_retry integer;
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
  if p_operation not in ('order_create', 'payment_verify') then
    raise exception 'invalid rate-limit operation' using errcode = '22023';
  end if;

  -- The route has already authenticated; this repeats the exact gateway
  -- predicates so the RPC cannot be used with a bare API-key hash.
  select i.id
    into v_integration
    from public.project_api_keys k
    join public.project_integrations i
      on i.project_id = k.project_id
     and i.provider = p_provider
   where k.key_hash = p_key_hash
     and k.revoked_at is null
     and k.env in ('live', 'both')
     and k.scopes ? 'integrations:*'
     and i.rpc_secret_hash = p_rpc_hash;

  if v_integration is null then
    return;
  end if;

  v_limit := case p_operation when 'order_create' then 30 else 60 end;
  v_window_seconds := 60;

  v_window_start := to_timestamp(
    (
      floor(extract(epoch from clock_timestamp()) / v_window_seconds) * v_window_seconds
    )::double precision
  );
  v_retry := greatest(
    1,
    ceil(extract(epoch from (
      v_window_start + make_interval(secs => v_window_seconds) - clock_timestamp()
    )))
  );

  insert into public.integration_rate_limits (
    integration_id, operation, window_start, count, updated_at
  ) values (
    v_integration, p_operation, v_window_start, 1, now()
  )
  on conflict (integration_id, operation, window_start)
  do update set
    -- Keep the stored value bounded even under a flood; it is only used to
    -- decide allowed/blocked and to report the remaining budget.
    count = least(public.integration_rate_limits.count + 1, v_limit + 1),
    updated_at = now()
  returning count into v_count;

  -- Bounded cleanup: old windows are irrelevant and must not grow forever.
  delete from public.integration_rate_limits r
   where r.ctid in (
     select x.ctid
       from public.integration_rate_limits x
      where x.window_start < clock_timestamp() - interval '1 hour'
      limit 50
   );

  update public.project_api_keys k
     set last_used_at = now()
   where k.key_hash = p_key_hash
     and k.revoked_at is null;

  return query
    select
      v_count <= v_limit,
      greatest(0, v_limit - least(v_count, v_limit)),
      case when v_count <= v_limit then 0 else v_retry end;
end;
$$;

comment on function public.consume_integration_rate_limit(text, text, text, text) is
  'Atomically consumes one fixed-window attempt for an authenticated payment integration. Fixed limits: order_create 30/60s, payment_verify 60/60s. No secret or payment data is stored.';

revoke all on function public.consume_integration_rate_limit(text, text, text, text) from public;
grant execute on function public.consume_integration_rate_limit(text, text, text, text) to anon, authenticated;

-- ── 3. Recover a stale webhook event ───────────────────────────────────────
--
-- Phase 6's recorder only retried `failed` events. A handler that applied the
-- payment state but could not finish its audit row (or crashed mid-processing)
-- left the event `received`; the provider's next retry was acknowledged as a
-- duplicate and the event stayed stuck forever. This forward replacement keeps
-- concurrent duplicates safe inside a short window, then reclaims an abandoned
-- `received` row so the signed retry can finish it. Payment transitions remain
-- idempotent and `gateway_finish_webhook_event` still only accepts `received`.

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

  if v_status = 'failed' then
    update public.project_integration_events e
       set status = 'received', error_code = null, processed_at = null,
           received_at = clock_timestamp()
     where e.id = v_id;
    return query select v_id, 'received'::text, true;
  end if;

  if v_status = 'received'
     and exists (
       select 1 from public.project_integration_events e
       where e.id = v_id
         and e.received_at < clock_timestamp() - interval '2 minutes'
     ) then
    -- The original handler is no longer plausibly running. Refresh the audit
    -- timestamp and let this signed retry finish the event.
    update public.project_integration_events e
       set received_at = clock_timestamp()
     where e.id = v_id;
    return query select v_id, 'received'::text, true;
  end if;

  return query select v_id, v_status, false;
end;
$$;

revoke all on function public.gateway_record_webhook_event(uuid, text, text, text, text) from public;
grant execute on function public.gateway_record_webhook_event(uuid, text, text, text, text) to anon, authenticated;

-- ── 4. Schema marker ────────────────────────────────────────────────────────

create or replace function public.production_hardening_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 23;
$$;

revoke all on function public.production_hardening_schema_version() from public;
revoke all on function public.production_hardening_schema_version() from anon;
grant execute on function public.production_hardening_schema_version() to authenticated, service_role;

comment on function public.production_hardening_schema_version() is
  'Phase 7 schema marker. 23 means the durable integration rate-limit table/RPC and the stale webhook-event recovery are installed.';

commit;
