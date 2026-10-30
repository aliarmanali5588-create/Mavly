-- ═══ 36 — INLINE → DURABLE WORKER HAND-OFF ══════════════════════════════════
--
-- WHY THIS NEEDS A NEW FUNCTION
--
-- The inline `after()` path has one wall-clock budget and one automatic
-- continuation. A large project can exhaust it with verified checkpoints still
-- queued, and today that is a terminal failure even when the durable worker
-- could finish the remaining paths from those checkpoints. None of the existing
-- transitions can express "move this LIVE run onto the worker queue":
--
--   · `resume_generation_job` (16) is the only owner-facing queue transition and
--     it deliberately PRESERVES `dispatch_mode`, so resuming an inline run stays
--     inline. It also only accepts `failed`/`interrupted` rows, never a live one.
--   · `dispatch_mode`, `stage`, `next_attempt_at`, `job_attempt`, `lease_token`
--     and the enqueue timestamps are worker-owned. Migration 16 revokes the
--     table-wide UPDATE grant and grants the authenticated role an explicit
--     column list that excludes every one of them — on purpose, so an owner
--     cannot forge a lease, reset an attempt budget or fabricate a queue entry.
--   · `claim_generation_job` is `service_role`-only, and the inline path never
--     holds the service-role client.
--
-- So exactly one new, narrowly-scoped, ownership-checked function is required.
-- It is additive: no column, table, policy or grant is removed or redefined, and
-- no existing RPC changes behaviour.
--
-- WHAT THIS FUNCTION CANNOT DO
--
--   · It cannot hand off a run that has no persisted manifest and no verified
--     checkpoint, because the worker would then restart from zero. It refuses.
--   · It cannot hand off a run another attempt now owns: the caller must present
--     the exact `claimed_at` it claimed with (`claimRun`), which is the same
--     fence the inline path already uses for every write.
--   · It cannot hand off a finished, cancelled or already-worker run.
--   · It cannot be repeated: the first successful hand-off sets
--     `dispatch_mode = 'worker'`, and every later call returns `already_worker`.
--     A resume of that run therefore keeps using the worker path.
--
-- ⚠️ COHORT MEMBERSHIP IS NOT CHECKABLE IN SQL. It lives in the deployment's
-- `MAVLY_GENERATION_WORKER_PROJECTS`. The worker claims with
-- `p_project_ids = cohort`, so a hand-off for a project outside the cohort would
-- never be claimed. The TypeScript caller MUST therefore only call this function
-- when `dispatchModeForProject(projectId) === 'worker'`; that precondition is
-- enforced in `src/lib/mavly/run-agent.ts` and is the reason this function takes
-- no cohort argument (a browser-supplied one would be forgeable).

begin;

create or replace function public.handoff_generation_job(
  p_project_id text,
  p_run_id uuid,
  p_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_run public.project_runs;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  -- Same non-enumerating ownership rule as every other owner RPC.
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_run
  from public.project_runs r
  where r.id = p_run_id
    and r.project_id = p_project_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_run.finished_at is not null
     or v_run.stage in ('completed', 'failed', 'cancelled', 'interrupted') then
    return jsonb_build_object('status', 'not_handoffable', 'stage', v_run.stage);
  end if;

  if v_run.cancellation_requested_at is not null then
    return jsonb_build_object('status', 'cancelled');
  end if;

  if v_run.dispatch_mode = 'worker' then
    return jsonb_build_object('status', 'already_worker');
  end if;

  -- The inline attempt must PROVE it still owns the run. A stale `after()`
  -- invocation that lost its claim cannot hand over someone else's execution.
  if p_claimed_at is null
     or v_run.claimed_at is null
     or v_run.claimed_at <> p_claimed_at then
    return jsonb_build_object('status', 'claim_mismatch');
  end if;

  -- ⚠️ NO PROGRESS, NO HAND-OFF. The worker resumes from the persisted manifest
  -- plus verified batch checkpoints; handing over a run without them would make
  -- it start again from zero, which is exactly what this feature must not do.
  if v_run.generation_manifest is null
     or coalesce(v_run.checkpoint_count, 0) < 1 then
    return jsonb_build_object('status', 'no_checkpoint_progress');
  end if;

  update public.project_runs r
  set dispatch_mode = 'worker',
      status = 'init',
      stage = 'retry_wait',
      next_attempt_at = now(),
      enqueued_at = coalesce(r.enqueued_at, now()),
      -- The inline attempt is over: release its claim so the worker's own claim
      -- is the only thing fencing this run.
      claimed_at = null,
      heartbeat_at = now(),
      last_progress_at = now(),
      lease_token = null,
      lease_expires_at = null,
      worker_id = null,
      -- A fresh durable attempt budget for the work that remains. Provider usage
      -- counters are cumulative for the run and are deliberately untouched.
      job_attempt = 0,
      last_error_class = 'inline_deadline_handoff',
      last_error_summary =
        'The inline execution window was exhausted; the run was handed to the durable worker to finish the remaining paths from its checkpoints.'
  where r.id = p_run_id
  returning * into v_run;

  return jsonb_build_object(
    'status', 'handed_off',
    'stage', v_run.stage,
    'dispatchMode', v_run.dispatch_mode,
    'checkpoints', v_run.checkpoint_count
  );
end;
$$;

revoke all on function public.handoff_generation_job(text, uuid, timestamptz) from public;
revoke all on function public.handoff_generation_job(text, uuid, timestamptz) from anon;
grant execute on function public.handoff_generation_job(text, uuid, timestamptz) to authenticated;

comment on function public.handoff_generation_job(text, uuid, timestamptz) is
  'Owner-only, claim-fenced hand-off of a LIVE inline run to the durable worker queue. Refuses without persisted manifest + verified checkpoints, and cannot be repeated.';

commit;
