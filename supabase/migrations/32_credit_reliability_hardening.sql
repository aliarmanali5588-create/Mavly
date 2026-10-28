begin;

-- ── Schema markers ──────────────────────────────────────────────────────────

create or replace function public.credit_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 32;
$$;

create or replace function public.generation_worker_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 32;
$$;

revoke all on function public.credit_schema_version() from public, anon;
grant execute on function public.credit_schema_version() to authenticated, service_role;
revoke all on function public.generation_worker_schema_version() from public, anon;
grant execute on function public.generation_worker_schema_version() to authenticated, service_role;

comment on function public.credit_schema_version() is
  'Credit schema marker. 32 includes lock-order, atomic terminal accounting and durable provider-attempt hardening.';
comment on function public.generation_worker_schema_version() is
  'Worker schema marker. 32 is required for fenced durable provider-attempt tracking and atomic credit settlement.';

-- ── Consistent admission lock order ─────────────────────────────────────────
--
-- The only cross-project admission mutex is acquired before the policy and run
-- rows. Its wrappers below take it before invoking migration 31 RPCs, whose
-- policy/run locks are then acquired in a consistent order. Run-state triggers
-- must not take a project lock after a caller already owns a run row lock.

create or replace function public.guard_credit_project_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));

  if tg_op = 'UPDATE' and old.project_id is distinct from new.project_id then
    raise exception 'CREDIT_POLICY_PROJECT_IMMUTABLE' using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.credit_reservations reservation
      where reservation.project_id = old.project_id
        and reservation.status = 'reserved'
    ) then
      raise exception 'CREDIT_POLICY_HAS_LIVE_RESERVATIONS' using errcode = 'P0001';
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
    raise exception 'CREDIT_POLICY_ACTIVE_RUNS_EXIST' using errcode = 'P0001';
  end if;

  if new.enabled and exists (
    select 1
    from public.credit_reservations reservation
    where reservation.project_id = new.project_id
      and reservation.status = 'reserved'
      and reservation.amount_credits <> new.generation_cost_credits
  ) then
    raise exception 'CREDIT_POLICY_RESERVATION_MISMATCH' using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE'
    and (
      (old.enabled and not new.enabled)
      or old.generation_cost_credits is distinct from new.generation_cost_credits
    )
    and exists (
      select 1 from public.credit_reservations reservation
      where reservation.project_id = old.project_id
        and reservation.status = 'reserved'
    ) then
    raise exception 'CREDIT_POLICY_HAS_LIVE_RESERVATIONS' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.guard_credit_project_run_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_credit_enabled boolean;
begin
  select policy.enabled into v_credit_enabled
  from public.credit_project_policies policy
  where policy.project_id = new.project_id;

  if not coalesce(v_credit_enabled, false) then
    return new;
  end if;

  if auth.role() is distinct from 'service_role' then
    raise exception 'CREDIT_RUN_STATE_SERVER_ONLY' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.dispatch_mode is distinct from 'worker'
      or current_setting('mavly.credit_admission_project_id', true)
        is distinct from new.project_id then
      raise exception 'CREDIT_RESERVATION_REQUIRED' using errcode = '42501';
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
      raise exception 'CREDIT_RESERVATION_REQUIRED' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_credit_project_policy() from public, anon, authenticated;
revoke all on function public.guard_credit_project_run_state() from public, anon, authenticated;

/**
 * Take the generation mutex before migration 31's policy lock and run work.
 * The old function remains the implementation; direct invocation is disabled
 * so a rolling application cannot use its former inverted lock order.
 */
create or replace function public.create_generation_job_with_credits_ordered(
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
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));
  return public.create_generation_job_with_credits(
    p_user_id,
    p_project_id,
    p_model,
    p_prompt,
    p_idempotency_key,
    p_dispatch_mode,
    p_amount_credits
  );
end;
$$;

create or replace function public.resume_generation_job_with_credits_ordered(
  p_user_id uuid,
  p_project_id text,
  p_run_id uuid,
  p_amount_credits bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('mavly:create_generation_job'));
  return public.resume_generation_job_with_credits(
    p_user_id,
    p_project_id,
    p_run_id,
    p_amount_credits
  );
end;
$$;

revoke all on function public.create_generation_job_with_credits_ordered(
  uuid, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.create_generation_job_with_credits_ordered(
  uuid, text, text, text, text, text, bigint
) to service_role;
revoke all on function public.resume_generation_job_with_credits_ordered(
  uuid, text, uuid, bigint
) from public, anon, authenticated;
grant execute on function public.resume_generation_job_with_credits_ordered(
  uuid, text, uuid, bigint
) to service_role;
revoke execute on function public.create_generation_job_with_credits(
  uuid, text, text, text, text, text, bigint
) from service_role;
revoke execute on function public.resume_generation_job_with_credits(
  uuid, text, uuid, bigint
) from service_role;

-- ── Atomic terminal settlement/release ──────────────────────────────────────

create or replace function public.settle_credit_terminal_run()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if old.finished_at is not null or new.finished_at is null then
    return new;
  end if;

  if not exists (
    select 1 from public.credit_reservations reservation
    where reservation.run_id = new.id and reservation.status = 'reserved'
  ) then
    return new;
  end if;

  if new.status = 'done' and new.stage = 'completed' then
    v_result := public.settle_generation_reservation(new.id);
    if coalesce(v_result ->> 'status', '') not in ('settled', 'noop') then
      raise exception 'CREDIT_TERMINAL_SETTLEMENT_FAILED' using errcode = 'P0001';
    end if;
  elsif new.status = 'error' and new.stage in ('failed', 'cancelled', 'interrupted') then
    v_result := public.release_generation_reservation(
      new.id,
      'Released atomically with terminal run transition'
    );
    if coalesce(v_result ->> 'status', '') not in ('released', 'noop') then
      raise exception 'CREDIT_TERMINAL_RELEASE_FAILED' using errcode = 'P0001';
    end if;
  else
    raise exception 'INVALID_CREDIT_TERMINAL_STATE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.credit_reservations reservation
    where reservation.run_id = new.id and reservation.status = 'reserved'
  ) then
    raise exception 'CREDIT_TERMINAL_RESERVATION_REMAINS' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.settle_credit_terminal_run() from public, anon, authenticated;
drop trigger if exists project_runs_credit_terminal_settlement on public.project_runs;
create trigger project_runs_credit_terminal_settlement
  after update of status, stage, finished_at on public.project_runs
  for each row
  when (old.finished_at is null and new.finished_at is not null)
  execute function public.settle_credit_terminal_run();

-- ── Durable provider attempt lifecycle ──────────────────────────────────────
--
-- An uncertain usage row is committed before the provider call. The response
-- updates that same row by UUID, so a lost database response can be retried
-- without creating duplicate usage. Only the transaction that inserts the
-- marker receives `started`; a repeated start returns `existing` and callers
-- must not dispatch it again. A started row remains uncertain after a worker
-- crash or an ambiguous provider timeout.

create or replace function public.begin_ai_provider_attempt(
  p_attempt_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_user_id uuid,
  p_project_id text,
  p_workflow_id uuid,
  p_role text,
  p_task_key text,
  p_attempt_index integer,
  p_phase text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.project_runs;
  v_owner uuid;
  v_key text := 'provider:' || p_attempt_id::text;
  v_existing public.ai_usage_attempts;
  v_inserted integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_attempt_id is null or p_run_id is null or p_lease_token is null
    or p_user_id is null or nullif(btrim(coalesce(p_project_id, '')), '') is null
    or nullif(btrim(coalesce(p_model, '')), '') is null
    or p_attempt_index is null or p_attempt_index < 1
    or nullif(btrim(coalesce(p_role, '')), '') is null
    or nullif(btrim(coalesce(p_task_key, '')), '') is null
    or nullif(btrim(coalesce(p_phase, '')), '') is null then
    raise exception 'INVALID_PROVIDER_ATTEMPT' using errcode = '22023';
  end if;

  select p.user_id into v_owner
  from public.projects p
  where p.project_id = p_project_id;
  if v_owner is distinct from p_user_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id and r.project_id = p_project_id
  for share;
  if not found or v_run.dispatch_mode <> 'worker'
    or v_run.finished_at is not null
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null
    or v_run.lease_expires_at <= now() then
    raise exception 'GENERATION_LEASE_LOST' using errcode = 'P0001';
  end if;

  if p_workflow_id is not null and not exists (
    select 1 from public.agent_workflows workflow
    where workflow.id = p_workflow_id
      and workflow.run_id = p_run_id
      and workflow.project_id = p_project_id
  ) then
    raise exception 'INVALID_PROVIDER_ATTEMPT_WORKFLOW' using errcode = '22023';
  end if;

  insert into public.ai_usage_attempts (
    attempt_key, user_id, project_id, run_id, workflow_id, role, task_key,
    attempt_index, provider, model, requested_model, usage_source, cost_source,
    reconciliation_status, uncertain, metadata
  ) values (
    v_key,
    p_user_id,
    p_project_id,
    p_run_id,
    p_workflow_id,
    left(p_role, 40),
    left(p_task_key, 80),
    p_attempt_index,
    'openrouter',
    left(p_model, 200),
    left(p_model, 200),
    'unavailable',
    'unavailable',
    'uncertain',
    true,
    jsonb_build_object(
      'providerAttemptId', p_attempt_id,
      'phase', left(p_phase, 40),
      'dispatchState', 'dispatching'
    )
  )
  on conflict (attempt_key) do nothing;
  get diagnostics v_inserted = row_count;

  select * into v_existing
  from public.ai_usage_attempts usage
  where usage.attempt_key = v_key;
  if not found
    or v_existing.run_id is distinct from p_run_id
    or v_existing.user_id is distinct from p_user_id
    or v_existing.project_id is distinct from p_project_id
    or v_existing.workflow_id is distinct from p_workflow_id
    or v_existing.role is distinct from left(p_role, 40)
    or v_existing.task_key is distinct from left(p_task_key, 80)
    or v_existing.attempt_index is distinct from p_attempt_index
    or v_existing.requested_model is distinct from left(p_model, 200)
    or (v_existing.metadata ->> 'phase') is distinct from left(p_phase, 40) then
    raise exception 'PROVIDER_ATTEMPT_ID_CONFLICT' using errcode = '22000';
  end if;

  return jsonb_build_object(
    'status',
    case when v_inserted = 1 then 'started' else 'existing' end
  );
end;
$$;

create or replace function public.complete_ai_provider_attempt(
  p_attempt_id uuid,
  p_run_id uuid,
  p_model text,
  p_provider_request_id text,
  p_status integer,
  p_finish_reason text,
  p_prompt_tokens bigint,
  p_completion_tokens bigint,
  p_cached_read_tokens bigint,
  p_cached_write_tokens bigint,
  p_reasoning_tokens bigint,
  p_total_tokens bigint,
  p_error_code text,
  p_retry_after_ms bigint,
  p_actual_cost_usd numeric,
  p_uncertain boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_usage_attempts;
  v_actual numeric := p_actual_cost_usd;
  v_estimate numeric;
  v_rate_version text;
  v_usage_source text;
  v_cost_source text;
  v_reconciliation text;
  v_error text := left(nullif(btrim(coalesce(p_error_code, '')), ''), 120);
  v_uncertain boolean := coalesce(p_uncertain, false)
    or v_error in ('TIMEOUT', 'NETWORK', 'UNKNOWN');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_attempt_id is null or p_run_id is null then
    raise exception 'INVALID_PROVIDER_ATTEMPT' using errcode = '22023';
  end if;

  select * into v_row
  from public.ai_usage_attempts usage
  where usage.attempt_key = 'provider:' || p_attempt_id::text
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_row.run_id is distinct from p_run_id then
    raise exception 'PROVIDER_ATTEMPT_ID_CONFLICT' using errcode = '22000';
  end if;
  if v_row.metadata ->> 'dispatchState' is distinct from 'dispatching' then
    return jsonb_build_object('status', 'existing');
  end if;

  if v_actual is not null and v_actual < 0 then
    v_actual := null;
  end if;
  if coalesce(p_prompt_tokens, 0) < 0
    or coalesce(p_completion_tokens, 0) < 0
    or coalesce(p_cached_read_tokens, 0) < 0
    or coalesce(p_cached_write_tokens, 0) < 0
    or coalesce(p_reasoning_tokens, 0) < 0
    or coalesce(p_total_tokens, 0) < 0 then
    raise exception 'INVALID_PROVIDER_USAGE' using errcode = '22023';
  end if;

  select e.estimated_cost_usd, e.rate_version
  into v_estimate, v_rate_version
  from public.ai_estimate_cost_usd(
    coalesce(nullif(p_model, ''), v_row.model),
    p_prompt_tokens,
    p_completion_tokens,
    p_cached_read_tokens
  ) e;

  v_usage_source := case
    when p_prompt_tokens is not null or p_completion_tokens is not null
      or p_total_tokens is not null or p_reasoning_tokens is not null
      or v_actual is not null then 'provider'
    else 'unavailable'
  end;
  if v_actual is not null then
    v_cost_source := 'provider_reported';
    v_reconciliation := 'reconciled';
  elsif v_uncertain then
    v_cost_source := case when v_estimate is not null then 'rate_card' else 'unavailable' end;
    v_reconciliation := 'uncertain';
  elsif v_estimate is not null then
    v_cost_source := 'rate_card';
    v_reconciliation := 'unreconciled';
  else
    v_cost_source := 'unavailable';
    v_reconciliation := 'unavailable';
  end if;

  update public.ai_usage_attempts usage
  set model = left(coalesce(nullif(p_model, ''), usage.model), 200),
      provider_request_id = left(nullif(p_provider_request_id, ''), 200),
      prompt_tokens = p_prompt_tokens,
      completion_tokens = p_completion_tokens,
      cached_read_tokens = p_cached_read_tokens,
      cached_write_tokens = p_cached_write_tokens,
      reasoning_tokens = p_reasoning_tokens,
      total_tokens = p_total_tokens,
      usage_source = v_usage_source,
      estimated_cost_usd = v_estimate,
      actual_cost_usd = v_actual,
      cost_source = v_cost_source,
      rate_version = v_rate_version,
      reconciliation_status = v_reconciliation,
      uncertain = v_uncertain,
      metadata = coalesce(usage.metadata, '{}'::jsonb) || jsonb_build_object(
        'dispatchState', 'result_received',
        'status', p_status,
        'finishReason', left(nullif(p_finish_reason, ''), 120),
        'errorCode', v_error,
        'retryAfterMs', p_retry_after_ms
      )
  where usage.id = v_row.id;

  return jsonb_build_object('status', 'completed');
end;
$$;

revoke all on function public.begin_ai_provider_attempt(
  uuid, uuid, uuid, uuid, text, uuid, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.begin_ai_provider_attempt(
  uuid, uuid, uuid, uuid, text, uuid, text, text, integer, text, text
) to service_role;
revoke all on function public.complete_ai_provider_attempt(
  uuid, uuid, text, text, integer, text, bigint, bigint, bigint, bigint, bigint,
  bigint, text, bigint, numeric, boolean
) from public, anon, authenticated;
grant execute on function public.complete_ai_provider_attempt(
  uuid, uuid, text, text, integer, text, bigint, bigint, bigint, bigint, bigint,
  bigint, text, bigint, numeric, boolean
) to service_role;

-- Reconciliation RPCs that derive from owner-editable run metadata are
-- service-role-only. Owner balance reconciliation still settles terminal holds
-- but never accepts or creates model usage data.
revoke all on function public.record_ai_usage_attempts(uuid) from public, anon, authenticated;
grant execute on function public.record_ai_usage_attempts(uuid) to service_role;

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
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  for v_rec in
    select reservation.run_id
    from public.credit_reservations reservation
    join public.project_runs run on run.id = reservation.run_id
    where reservation.user_id = v_uid
      and reservation.status = 'reserved'
      and run.finished_at is not null
      and run.status = 'done'
      and run.stage = 'completed'
    order by reservation.created_at asc
    limit 25
  loop
    begin
      perform public.settle_generation_reservation(v_rec.run_id);
      v_settled := v_settled + 1;
    exception when others then
      null;
    end;
  end loop;

  return jsonb_build_object('settled', v_settled, 'released', 0, 'usageRows', 0);
end;
$$;

revoke all on function public.reconcile_owner_credits() from public, anon;
grant execute on function public.reconcile_owner_credits() to authenticated;

-- If the completion RPC's response is lost, the worker's later run-row
-- reconciliation can complete its pre-dispatch marker. The legacy inserter
-- must not create a second usage row for that same provider call.
create or replace function public.reconcile_provider_attempt_before_legacy_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ordinal integer;
  v_attempt jsonb;
  v_provider_attempt_id uuid;
  v_metadata jsonb;
begin
  if new.run_id is null
    or new.attempt_key !~ ('^run:' || new.run_id::text || ':attempt:[0-9]+$') then
    return new;
  end if;

  v_ordinal := right(new.attempt_key, length(new.attempt_key) - length(
    'run:' || new.run_id::text || ':attempt:'
  ))::integer;
  select item.value into v_attempt
  from public.project_runs run
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(run.provider_attempts) = 'array' then run.provider_attempts
      else '[]'::jsonb
    end
  ) with ordinality item(value, ordinal)
  where run.id = new.run_id
    and item.ordinal = v_ordinal;
  if not found then
    return new;
  end if;

  v_metadata := v_attempt;
  if coalesce(v_metadata ->> 'providerAttemptId', '') !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    return new;
  end if;
  v_provider_attempt_id := (v_metadata ->> 'providerAttemptId')::uuid;

  if exists (
    select 1 from public.ai_usage_attempts usage
    where usage.attempt_key = 'provider:' || v_provider_attempt_id::text
  ) then
    perform public.complete_ai_provider_attempt(
      v_provider_attempt_id,
      new.run_id,
      nullif(v_metadata ->> 'model', ''),
      nullif(v_metadata ->> 'providerRequestId', ''),
      public.credit_json_number(v_metadata, 'status')::integer,
      nullif(v_metadata ->> 'finishReason', ''),
      public.credit_json_number(v_metadata, 'promptTokens')::bigint,
      public.credit_json_number(v_metadata, 'completionTokens')::bigint,
      public.credit_json_number(v_metadata, 'cachedReadTokens')::bigint,
      public.credit_json_number(v_metadata, 'cachedWriteTokens')::bigint,
      public.credit_json_number(v_metadata, 'reasoningTokens')::bigint,
      public.credit_json_number(v_metadata, 'totalTokens')::bigint,
      nullif(v_metadata ->> 'errorCode', ''),
      public.credit_json_number(v_metadata, 'retryAfterMs')::bigint,
      public.credit_json_number(v_metadata, 'costUsd'),
      v_metadata ->> 'errorCode' in ('TIMEOUT', 'NETWORK', 'UNKNOWN')
        or public.credit_json_number(v_metadata, 'status') is null
    );
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_provider_attempt_before_legacy_insert()
  from public, anon, authenticated;
drop trigger if exists ai_usage_provider_attempt_dedup on public.ai_usage_attempts;
create trigger ai_usage_provider_attempt_dedup
  before insert on public.ai_usage_attempts
  for each row execute function public.reconcile_provider_attempt_before_legacy_insert();

-- Keep the worker's bounded accounting recovery, but scope run-derived usage to
-- enabled credit policies. Also revisit a run when its durable provider marker
-- is still dispatching, so persisted result metadata can complete that same row.
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

  v_orphans := public.release_orphaned_credit_reservations(v_limit);

  for v_rec in
    select reservation.run_id
    from public.credit_reservations reservation
    join public.project_runs run on run.id = reservation.run_id
    where reservation.status = 'reserved'
      and run.finished_at is not null
    order by reservation.created_at asc
    limit v_limit
  loop
    begin
      if exists (
        select 1 from public.project_runs run
        where run.id = v_rec.run_id
          and run.status = 'done'
          and run.stage = 'completed'
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
    select run.id
    from public.project_runs run
    where run.finished_at is not null
      and jsonb_array_length(
        case
          when jsonb_typeof(run.provider_attempts) = 'array'
            then run.provider_attempts
          else '[]'::jsonb
        end
      ) > 0
      and exists (
        select 1
        from public.credit_project_policies policy
        where policy.project_id = run.project_id
          and policy.enabled
      )
      and (
        not exists (
          select 1 from public.ai_usage_attempts usage
          where usage.run_id = run.id
        )
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(run.provider_attempts) = 'array'
                then run.provider_attempts
              else '[]'::jsonb
            end
          ) attempt(value)
          where (attempt.value ->> 'providerAttemptId') ~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
            and exists (
              select 1
              from public.ai_usage_attempts usage
              where usage.attempt_key =
                'provider:' || lower(attempt.value ->> 'providerAttemptId')
                and usage.metadata ->> 'dispatchState' = 'dispatching'
            )
        )
      )
    order by run.finished_at desc
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

revoke all on function public.maintain_credit_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.maintain_credit_reservations(integer) to service_role;

comment on function public.maintain_credit_reservations(integer) is
  'Service-role-only bounded credit recovery. Run-derived usage is limited to enabled credit policies and reconciles incomplete durable provider attempts.';

commit;
