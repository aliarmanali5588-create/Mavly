-- ═══════════════════════════════════════════════════════════════════════════
-- 66 — CLOUDFLARE GENERATION DISPATCH (additive, forward-only)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Mavly's generation queue is `public.project_runs` (migration 16). This
-- migration does NOT add a second job queue: it adds the smallest durable
-- record needed to start exactly one Cloudflare Workflow per dispatchable run
-- and to retry that dispatch safely after a crash.
--
--   · `generation_dispatch_outbox` is DISPATCH METADATA ONLY. It is created by
--     a trigger in the same transaction as the run INSERT, so a worker-dispatched
--     run can never exist without a dispatch record. It stores no prompt, no
--     generated source and no user content.
--   · `claim_generation_dispatch` leases at most N due rows with
--     `FOR UPDATE SKIP LOCKED`; a crash after Workflow creation is safe because
--     the Workflow instance id is derived from the run id, so a second create
--     is rejected by Cloudflare rather than starting a second execution.
--   · `claim_generation_run_for_workflow` leases ONE named run, so a Workflow
--     never executes a job that belongs to a different instance. It re-checks
--     ownership, dispatch mode, terminal state and cancellation, and it never
--     overwrites a live lease held by another attempt.
--   · `mark_generation_dispatch` records a successful create, or a bounded
--     retry with backoff; it never rewrites generation state.
--
-- Historical migrations are untouched. No customer row is deleted. RLS is
-- enabled with no policy: only `service_role` can read or write the ledger, and
-- only through the SECURITY DEFINER functions below.
--
-- ROLLBACK: drop the two functions, the trigger, the table and the marker
-- function. Runs already dispatched keep executing; only new dispatch stops.

-- ── dispatch ledger ─────────────────────────────────────────────────────────

create table if not exists public.generation_dispatch_outbox (
  run_id uuid primary key references public.project_runs (id) on delete cascade,
  workflow_id text not null,
  state text not null default 'pending'
    check (state in ('pending', 'dispatched', 'failed')),
  attempt_count integer not null default 0
    check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  dispatched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.generation_dispatch_outbox is
  'Dispatch metadata for Cloudflare Workflows, one row per worker-dispatched generation run. Not a second job queue: public.project_runs remains authoritative.';

create index if not exists generation_dispatch_outbox_due_idx
  on public.generation_dispatch_outbox (state, next_attempt_at);

alter table public.generation_dispatch_outbox enable row level security;

revoke all on table public.generation_dispatch_outbox from public;
revoke all on table public.generation_dispatch_outbox from anon;
revoke all on table public.generation_dispatch_outbox from authenticated;
grant select, insert, update, delete on table public.generation_dispatch_outbox to service_role;

-- ── enqueue in the run transaction ──────────────────────────────────────────

create or replace function public.enqueue_generation_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.dispatch_mode = 'worker' then
    insert into public.generation_dispatch_outbox (run_id, workflow_id)
    values (new.id, 'run-' || replace(new.id::text, '-', ''))
    on conflict (run_id) do nothing;
  end if;
  return new;
end;
$$;

comment on function public.enqueue_generation_dispatch() is
  'Creates the Cloudflare dispatch record in the same transaction as the run INSERT. A worker-dispatched run never exists without dispatch metadata.';

revoke all on function public.enqueue_generation_dispatch() from public;
revoke all on function public.enqueue_generation_dispatch() from anon;
revoke all on function public.enqueue_generation_dispatch() from authenticated;

drop trigger if exists project_runs_enqueue_generation_dispatch on public.project_runs;
create trigger project_runs_enqueue_generation_dispatch
  after insert on public.project_runs
  for each row
  execute function public.enqueue_generation_dispatch();

-- ── dispatcher claim ────────────────────────────────────────────────────────

create or replace function public.claim_generation_dispatch(
  p_limit integer default 10
)
returns table (
  run_id uuid,
  workflow_id text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
begin
  return query
  with due as (
    select o.run_id
      from public.generation_dispatch_outbox o
      join public.project_runs r on r.id = o.run_id
     where o.state in ('pending', 'failed')
       and o.next_attempt_at <= now()
       and o.attempt_count < 8
       and r.dispatch_mode = 'worker'
       and r.finished_at is null
       and r.stage in ('queued', 'retry_wait', 'validating')
       and r.cancellation_requested_at is null
     order by o.next_attempt_at asc
     for update of o skip locked
     limit v_limit
  )
  update public.generation_dispatch_outbox o
     set attempt_count = o.attempt_count + 1,
         updated_at = now()
    from due
   where o.run_id = due.run_id
  returning o.run_id, o.workflow_id, o.attempt_count;
end;
$$;

comment on function public.claim_generation_dispatch(integer) is
  'Leases at most p_limit due dispatch rows with FOR UPDATE SKIP LOCKED. Bounded to 25.';

revoke all on function public.claim_generation_dispatch(integer) from public;
revoke all on function public.claim_generation_dispatch(integer) from anon;
revoke all on function public.claim_generation_dispatch(integer) from authenticated;
grant execute on function public.claim_generation_dispatch(integer) to service_role;

-- ── dispatch acknowledgement ────────────────────────────────────────────────

create or replace function public.mark_generation_dispatch(
  p_run_id uuid,
  p_state text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text := case when p_state = 'dispatched' then 'dispatched' else 'failed' end;
begin
  update public.generation_dispatch_outbox o
     set state = v_state,
         dispatched_at = case when v_state = 'dispatched' then now() else o.dispatched_at end,
         last_error = case
           when v_state = 'dispatched' then null
           else left(coalesce(p_error, 'dispatch_failed'), 500)
         end,
         next_attempt_at = case
           when v_state = 'failed'
             then now() + make_interval(secs => least(300, 5 * greatest(o.attempt_count, 1) * greatest(o.attempt_count, 1)))
           else o.next_attempt_at
         end,
         updated_at = now()
   where o.run_id = p_run_id
     and not (o.state = 'dispatched' and v_state = 'failed');
  return found;
end;
$$;

comment on function public.mark_generation_dispatch(uuid, text, text) is
  'Records a Workflow create outcome. A dispatched row is never moved back to failed by a duplicate ack.';

revoke all on function public.mark_generation_dispatch(uuid, text, text) from public;
revoke all on function public.mark_generation_dispatch(uuid, text, text) from anon;
revoke all on function public.mark_generation_dispatch(uuid, text, text) from authenticated;
grant execute on function public.mark_generation_dispatch(uuid, text, text) to service_role;

-- ── run-targeted claim ──────────────────────────────────────────────────────

create or replace function public.claim_generation_run_for_workflow(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 420
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.project_runs;
  v_owner uuid;
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 420), 900));
  v_worker text := left(btrim(coalesce(p_worker_id, '')), 120);
  v_token uuid := gen_random_uuid();
begin
  if v_worker = '' then
    return jsonb_build_object('status', 'invalid', 'reason', 'missing_worker_id');
  end if;

  select * into v_run
    from public.project_runs
   where id = p_run_id
   for update;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  if v_run.dispatch_mode <> 'worker' then
    return jsonb_build_object('status', 'invalid', 'reason', 'not_worker_dispatched');
  end if;
  if v_run.finished_at is not null then
    return jsonb_build_object('status', 'empty');
  end if;
  if v_run.cancellation_requested_at is not null then
    return jsonb_build_object('status', 'invalid', 'reason', 'cancellation_requested');
  end if;
  if v_run.stage not in ('queued', 'retry_wait', 'validating') then
    return jsonb_build_object('status', 'invalid', 'reason', 'not_claimable_stage');
  end if;

  -- A live lease belongs to another attempt; never steal it.
  if v_run.lease_token is not null
     and v_run.lease_expires_at is not null
     and v_run.lease_expires_at > now()
     and v_run.claimed_at is not null
     and v_run.claimed_at > now() - make_interval(secs => v_lease) then
    return jsonb_build_object('status', 'invalid', 'reason', 'lease_held');
  end if;

  select p.user_id into v_owner
    from public.projects p
   where p.id = v_run.project_id;

  if v_owner is null then
    return jsonb_build_object('status', 'invalid', 'reason', 'owner_not_found');
  end if;

  update public.project_runs r
     set stage = 'validating',
         lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => v_lease),
         claimed_at = now(),
         worker_id = v_worker,
         heartbeat_at = now(),
         job_version = r.job_version + 1
   where r.id = p_run_id;

  return jsonb_build_object(
    'status', 'claimed',
    'user_id', v_owner,
    'run', jsonb_build_object(
      'id', v_run.id,
      'project_id', v_run.project_id,
      'prompt', v_run.prompt,
      'model', v_run.model,
      'stage', 'validating',
      'dispatch_mode', v_run.dispatch_mode,
      'trace_id', v_run.trace_id,
      'lease_token', v_token,
      'lease_expires_at', (now() + make_interval(secs => v_lease)),
      'claimed_at', now(),
      'job_attempt', greatest(coalesce(v_run.job_attempt, 1), 1),
      'max_attempts', greatest(coalesce(v_run.max_job_attempts, 3), 1)
    )
  );
end;
$$;

comment on function public.claim_generation_run_for_workflow(uuid, text, integer) is
  'Leases exactly one named run for one Cloudflare Workflow instance. Refuses a live lease, a non-worker run, a terminal run and a cancelled run.';

revoke all on function public.claim_generation_run_for_workflow(uuid, text, integer) from public;
revoke all on function public.claim_generation_run_for_workflow(uuid, text, integer) from anon;
revoke all on function public.claim_generation_run_for_workflow(uuid, text, integer) from authenticated;
grant execute on function public.claim_generation_run_for_workflow(uuid, text, integer) to service_role;

-- ── schema marker ───────────────────────────────────────────────────────────

create or replace function public.cloudflare_generation_dispatch_schema_version()
returns integer
language sql
immutable
as $$ select 66 $$;

comment on function public.cloudflare_generation_dispatch_schema_version() is
  'Schema marker 66: Cloudflare generation dispatch ledger and run-targeted claim.';

revoke all on function public.cloudflare_generation_dispatch_schema_version() from public;
revoke all on function public.cloudflare_generation_dispatch_schema_version() from anon;
grant execute on function public.cloudflare_generation_dispatch_schema_version() to service_role;
