-- Mavly — Phase 10 lifecycle observability correction.
--
-- Apply after 29_multi_agent_orchestration.sql. This migration is additive:
-- existing workflow/task rows remain readable and the worker remains the only
-- writer of lifecycle metadata. It makes an absent specialist distinguishable
-- from an explicitly ineligible or skipped role.

begin;

do $$
declare
  v_base integer;
begin
  if to_regprocedure('public.multi_agent_schema_version()') is null then
    raise exception 'MULTI_AGENT_LIFECYCLE_PREREQUISITE_MISSING: migration 29_multi_agent_orchestration.sql is required';
  end if;
  execute 'select public.multi_agent_schema_version()' into v_base;
  if v_base < 29 then
    raise exception 'MULTI_AGENT_LIFECYCLE_PREREQUISITE_MISSING: migration 29_multi_agent_orchestration.sql is outdated';
  end if;
end
$$;

alter table public.agent_tasks
  add column if not exists eligible boolean not null default true,
  add column if not exists eligibility_reason text not null default 'legacy_workflow_record',
  add column if not exists scheduled boolean not null default false,
  add column if not exists scheduled_at timestamptz,
  add column if not exists schedule_reason text,
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists output_produced boolean not null default false,
  add column if not exists output_consumed boolean not null default false,
  add column if not exists duration_ms bigint,
  add column if not exists skip_reason text,
  add column if not exists failure_reason text,
  add column if not exists retry_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agent_tasks'::regclass
      and conname = 'agent_tasks_lifecycle_reason_length_check'
  ) then
    alter table public.agent_tasks
      add constraint agent_tasks_lifecycle_reason_length_check
      check (
        char_length(eligibility_reason) between 1 and 200
        and (schedule_reason is null or char_length(schedule_reason) between 1 and 200)
        and (skip_reason is null or char_length(skip_reason) between 1 and 500)
        and (failure_reason is null or char_length(failure_reason) between 1 and 500)
        and (provider is null or provider ~ '^[A-Za-z0-9._:-]{1,80}$')
        and (model is null or model ~ '^[A-Za-z0-9._:/-]{1,160}$')
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.agent_tasks'::regclass
      and conname = 'agent_tasks_lifecycle_bounds_check'
  ) then
    alter table public.agent_tasks
      add constraint agent_tasks_lifecycle_bounds_check
      check (
        (duration_ms is null or duration_ms between 0 and 2147483647)
        and retry_count between 0 and 1000
      );
  end if;
end
$$;

-- Preserve truthful information that can be derived from legacy rows without
-- pretending to know which downstream stage consumed an old output.
update public.agent_tasks
   set output_produced = (output is not null),
       scheduled = (started_at is not null or status in ('queued', 'running', 'completed', 'failed')),
       scheduled_at = coalesce(scheduled_at, started_at),
       schedule_reason = coalesce(
         schedule_reason,
         case when started_at is null then null else 'legacy_workflow_record' end
       ),
       duration_ms = coalesce(
         duration_ms,
         case
           when started_at is not null and finished_at is not null
             then greatest(0, (extract(epoch from (finished_at - started_at)) * 1000)::bigint)
           else null
         end
       ),
       skip_reason = coalesce(
         skip_reason,
         case when status = 'skipped' then coalesce(error_summary, 'legacy_skipped') else null end
       ),
       failure_reason = coalesce(
         failure_reason,
         case when status = 'failed' then coalesce(error_summary, error_class, 'legacy_failed') else null end
       ),
       retry_count = greatest(retry_count, attempt - 1);

create index if not exists agent_tasks_workflow_scheduled_idx
  on public.agent_tasks (workflow_id, scheduled_at desc);

grant select (
  eligible, eligibility_reason, scheduled, scheduled_at, schedule_reason, provider, model,
  output_produced, output_consumed, duration_ms, skip_reason, failure_reason,
  retry_count
) on public.agent_tasks to authenticated;

comment on column public.agent_tasks.eligible is
  'Whether the role was eligible under the workflow policy; false is an explicit skip, not an absent agent.';
comment on column public.agent_tasks.output_consumed is
  'Worker-written downstream handoff fact. A produced output is not assumed to be consumed.';

create or replace function public.multi_agent_lifecycle_schema_version()
returns integer
language sql
stable
as $$
  select 58;
$$;

comment on function public.multi_agent_lifecycle_schema_version() is
  'Schema marker for explicit seven-role lifecycle and output-consumption metadata.';

revoke all on function public.multi_agent_lifecycle_schema_version() from public, anon;
grant execute on function public.multi_agent_lifecycle_schema_version() to authenticated, service_role;

commit;
