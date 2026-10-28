-- Mavly — Phase 10: multi-agent orchestration and deployment approval
--
-- ═══ WHAT THIS IS ═══════════════════════════════════════════════════════════
--
-- A durable record of how one EXISTING `project_runs` job was decomposed into
-- specialist tasks, plus the deployment-proposal approval gate. It is not a
-- second queue and not a second generation pipeline:
--
--   · `project_runs` remains the only generation job and lease owner;
--   · `agent_workflows` is 1:1 with a run (unique `run_id`);
--   · `agent_tasks` records dependencies, attempts and validated outputs;
--   · `agent_workflow_events` is a bounded audit trail;
--   · `deployment_proposals` binds an owner approval to a server-derived target,
--     snapshot and source hash.
--
-- ═══ WHO WRITES ═════════════════════════════════════════════════════════════
--
-- The generation worker writes workflows/tasks/events with its confined
-- service-role client after it re-verifies the project owner. The authenticated
-- role has SELECT only. The one owner-facing mutation is
-- `cancel_agent_workflow()`, a SECURITY DEFINER function that checks ownership.
--
-- `deployment_proposals` has no authenticated INSERT/UPDATE grant at all:
-- create/approve/revoke/consume are owner-checked SECURITY DEFINER RPCs. The
-- consume RPC is atomic and re-checks project, target, snapshot and source hash,
-- so one approval cannot deploy different bytes or be used twice.
--
-- ═══ TRUTHFULNESS ═══════════════════════════════════════════════════════════
--
-- A task's `output` is data supplied by the orchestrator, not proof. `skipped`
-- and `failed` are distinct from `completed`; a model assertion is never stored
-- as a passed verification. There is no table for "verified" here at all: the
-- existing `project_verifications` remains the only verification authority.
--
-- ═══ ROLLOUT ════════════════════════════════════════════════════════════════
--
-- Additive and non-destructive. Apply after 28 and after 26 (for the Android
-- profile). Nothing is read or written until `MAVLY_MULTI_AGENT_ENABLED` plus an
-- explicit `MAVLY_MULTI_AGENT_PROJECTS` cohort is configured (and the durable
-- generation worker is ready). The deployment gate is independent:
-- `MAVLY_DEPLOYMENT_APPROVAL_REQUIRED=1` enables it platform-wide.
--
-- See `docs/architecture/phase-10-multi-agent-orchestration.md` and
-- `docs/runbooks/multi-agent-orchestration.md`.

begin;

-- ── 1. Workflows (1:1 with project_runs) ────────────────────────────────────

create table if not exists public.agent_workflows (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  run_id uuid not null unique references public.project_runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  state text not null default 'queued' check (state in (
    'queued',
    'planning',
    'executing',
    'verifying',
    'waiting_for_dependency',
    'retrying',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled'
  )),
  complexity text not null default 'standard' check (complexity in (
    'simple', 'standard', 'complex'
  )),
  prompt_excerpt text not null default '' check (char_length(prompt_excerpt) <= 500),
  plan_context text,
  design_directives text,
  summary text,
  error_class text,
  provider_calls integer not null default 0 check (provider_calls between 0 and 1000),
  repair_attempts integer not null default 0 check (repair_attempts between 0 and 100),
  reported_cost_usd numeric(12, 6) check (reported_cost_usd is null or reported_cost_usd >= 0),
  cost_known boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_workflows_plan_context_check
    check (plan_context is null or char_length(plan_context) <= 12000),
  constraint agent_workflows_design_directives_check
    check (design_directives is null or char_length(design_directives) <= 12000),
  constraint agent_workflows_summary_check
    check (summary is null or char_length(summary) <= 2000),
  constraint agent_workflows_error_class_check
    check (error_class is null or error_class ~ '^[A-Za-z0-9._:-]{1,80}$')
);

comment on table public.agent_workflows is
  'One durable multi-agent workflow per generation run. Worker-written; owner-readable; never a second job queue.';
comment on column public.agent_workflows.state is
  'Workflow phase. awaiting_approval means a deployment proposal needs the owner, not that anything was deployed.';

create index if not exists agent_workflows_project_created_idx
  on public.agent_workflows (project_id, created_at desc);

create index if not exists agent_workflows_state_idx
  on public.agent_workflows (state)
  where state not in ('completed', 'failed', 'cancelled');

-- ── 2. Tasks ────────────────────────────────────────────────────────────────

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.agent_workflows (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  task_key text not null check (task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  role text not null check (role in (
    'planner', 'ui_ux', 'coding', 'qa', 'repair', 'security', 'deployment'
  )),
  kind text not null check (kind in (
    'plan', 'design_review', 'implement', 'verify', 'repair', 'security_review',
    'deployment_proposal'
  )),
  title text not null check (char_length(title) between 1 and 200),
  status text not null default 'pending' check (status in (
    'pending',
    'waiting_for_dependency',
    'queued',
    'running',
    'completed',
    'failed',
    'skipped',
    'cancelled'
  )),
  depends_on jsonb not null default '[]'::jsonb,
  writes_files boolean not null default false,
  required boolean not null default true,
  max_attempts integer not null default 1 check (max_attempts between 1 and 5),
  attempt integer not null default 0 check (attempt between 0 and 1000),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  output jsonb,
  error_class text,
  error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_tasks_workflow_key_key unique (workflow_id, task_key),
  constraint agent_tasks_depends_on_check
    check (jsonb_typeof(depends_on) = 'array' and pg_column_size(depends_on) <= 4096),
  constraint agent_tasks_output_check
    check (output is null or (jsonb_typeof(output) = 'object' and pg_column_size(output) <= 131072)),
  constraint agent_tasks_error_class_check
    check (error_class is null or error_class ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint agent_tasks_error_summary_check
    check (error_summary is null or char_length(error_summary) <= 2000)
);

comment on table public.agent_tasks is
  'Specialist tasks for one workflow. Dependencies are explicit; only the coding task may write project files.';

create index if not exists agent_tasks_workflow_status_idx
  on public.agent_tasks (workflow_id, status);

create index if not exists agent_tasks_project_idx
  on public.agent_tasks (project_id, created_at desc);

-- ── 3. Bounded audit events ─────────────────────────────────────────────────

create table if not exists public.agent_workflow_events (
  id bigint generated by default as identity primary key,
  workflow_id uuid not null references public.agent_workflows (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  task_key text,
  kind text not null check (kind ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  message text not null check (char_length(message) between 1 and 500),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint agent_workflow_events_data_check
    check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 8192)
);

comment on table public.agent_workflow_events is
  'Bounded workflow audit trail. Never contains prompts, file content, credentials or provider bodies.';

create index if not exists agent_workflow_events_workflow_idx
  on public.agent_workflow_events (workflow_id, id desc);

-- ── 4. Deployment proposals (the human approval gate) ───────────────────────

create table if not exists public.deployment_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  workflow_id uuid references public.agent_workflows (id) on delete set null,
  run_id uuid references public.project_runs (id) on delete set null,
  target text not null check (target in ('static', 'fullstack')),
  snapshot_id uuid references public.project_snapshots (id) on delete set null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  runtime_profile text,
  verification_id uuid references public.project_verifications (id) on delete set null,
  status text not null default 'proposed' check (status in (
    'proposed', 'approved', 'revoked', 'consumed', 'expired'
  )),
  summary jsonb not null default '{}'::jsonb,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  constraint deployment_proposals_summary_check
    check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 16384),
  constraint deployment_proposals_approved_check
    check (
      (status <> 'approved' and status <> 'consumed')
      or (approved_at is not null and approved_by is not null)
    ),
  constraint deployment_proposals_consumed_check
    check (status <> 'consumed' or consumed_at is not null),
  constraint deployment_proposals_revoked_check
    check (status <> 'revoked' or revoked_at is not null),
  constraint deployment_proposals_expiry_check
    check (expires_at > created_at)
);

comment on table public.deployment_proposals is
  'Owner-approved deployment artifacts. A proposal is not a deployment; the deploy path consumes an approved row atomically.';

create index if not exists deployment_proposals_project_created_idx
  on public.deployment_proposals (project_id, created_at desc);

create index if not exists deployment_proposals_pending_idx
  on public.deployment_proposals (project_id, expires_at)
  where status = 'approved' and consumed_at is null and revoked_at is null;

-- ── 5. RLS: owner reads only; the worker bypasses RLS ───────────────────────

alter table public.agent_workflows enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_workflow_events enable row level security;
alter table public.deployment_proposals enable row level security;

drop policy if exists "agent_workflows_select_own" on public.agent_workflows;
create policy "agent_workflows_select_own"
  on public.agent_workflows
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = agent_workflows.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "agent_tasks_select_own" on public.agent_tasks;
create policy "agent_tasks_select_own"
  on public.agent_tasks
  for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.project_id = agent_tasks.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "agent_workflow_events_select_own" on public.agent_workflow_events;
create policy "agent_workflow_events_select_own"
  on public.agent_workflow_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.project_id = agent_workflow_events.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "deployment_proposals_select_own" on public.deployment_proposals;
create policy "deployment_proposals_select_own"
  on public.deployment_proposals
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = deployment_proposals.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- ── 6. Least privilege ──────────────────────────────────────────────────────

revoke all on public.agent_workflows from public, anon, authenticated;
revoke all on public.agent_tasks from public, anon, authenticated;
revoke all on public.agent_workflow_events from public, anon, authenticated;
revoke all on public.deployment_proposals from public, anon, authenticated;

grant select (
  id, project_id, run_id, user_id, state, complexity, prompt_excerpt,
  plan_context, design_directives, summary, error_class, provider_calls,
  repair_attempts, reported_cost_usd, cost_known, started_at, finished_at,
  created_at, updated_at
) on public.agent_workflows to authenticated;

grant select (
  id, workflow_id, project_id, task_key, role, kind, title, status, depends_on,
  writes_files, required, max_attempts, attempt, idempotency_key, output,
  error_class, error_summary, started_at, finished_at, created_at, updated_at
) on public.agent_tasks to authenticated;

grant select (
  id, workflow_id, project_id, task_key, kind, message, data, created_at
) on public.agent_workflow_events to authenticated;

grant select (
  id, project_id, user_id, workflow_id, run_id, target, snapshot_id,
  source_hash, runtime_profile, verification_id, status, summary, approved_by,
  approved_at, expires_at, consumed_at, revoked_at, revoked_reason, created_at
) on public.deployment_proposals to authenticated;

grant all on public.agent_workflows to service_role;
grant all on public.agent_tasks to service_role;
grant all on public.agent_workflow_events to service_role;
grant all on public.deployment_proposals to service_role;

grant usage, select on sequence public.agent_workflow_events_id_seq to service_role;

-- ── 7. Owner cancellation (the only authenticated workflow mutation) ────────

create or replace function public.cancel_agent_workflow(
  p_project_id text,
  p_workflow_id uuid,
  p_summary text default 'Cancelled by the project owner.'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_workflow public.agent_workflows%rowtype;
  v_finished timestamptz := now();
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

  select w.* into v_workflow
    from public.agent_workflows w
   where w.id = p_workflow_id
     and w.project_id = p_project_id
     and w.user_id = v_uid
   for update;

  if v_workflow.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'No such workflow exists.');
  end if;
  if v_workflow.state in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'ok', false,
      'code', 'validation',
      'error', 'This workflow already reached a terminal state.'
    );
  end if;

  update public.agent_workflows w
     set state = 'cancelled',
         summary = left(coalesce(p_summary, 'Cancelled by the project owner.'), 500),
         finished_at = v_finished,
         updated_at = v_finished
   where w.id = v_workflow.id;

  update public.agent_tasks t
     set status = 'cancelled',
         finished_at = v_finished,
         updated_at = v_finished
   where t.workflow_id = v_workflow.id
     and t.status in ('pending', 'waiting_for_dependency', 'queued', 'running', 'failed');

  insert into public.agent_workflow_events (workflow_id, project_id, kind, message)
  values (v_workflow.id, p_project_id, 'workflow.cancelled', 'The workflow was cancelled by the project owner.');

  return jsonb_build_object('ok', true, 'workflowId', v_workflow.id);
end;
$$;

revoke all on function public.cancel_agent_workflow(text, uuid, text) from public, anon;
grant execute on function public.cancel_agent_workflow(text, uuid, text) to authenticated, service_role;

-- ── 8. Proposal lifecycle (owner-checked, atomic) ───────────────────────────

create or replace function public.create_deployment_proposal(
  p_project_id text,
  p_target text,
  p_snapshot_id uuid,
  p_source_hash text,
  p_runtime_profile text,
  p_verification_id uuid,
  p_workflow_id uuid,
  p_run_id uuid,
  p_summary jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.deployment_proposals%rowtype;
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
  if p_target is null or p_target not in ('static', 'fullstack') then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'Unknown deployment target.');
  end if;
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'Invalid source hash.');
  end if;
  if p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'Invalid approval expiry.');
  end if;
  if p_snapshot_id is not null and not exists (
    select 1 from public.project_snapshots s
    where s.id = p_snapshot_id and s.project_id = p_project_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'That snapshot does not belong to this project.');
  end if;
  if p_verification_id is not null and not exists (
    select 1 from public.project_verifications v
    where v.id = p_verification_id and v.project_id = p_project_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'That verification does not belong to this project.');
  end if;
  if p_workflow_id is not null and not exists (
    select 1 from public.agent_workflows w
    where w.id = p_workflow_id and w.project_id = p_project_id and w.user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'That workflow does not belong to this project.');
  end if;
  if p_run_id is not null and not exists (
    select 1 from public.project_runs r
    where r.id = p_run_id and r.project_id = p_project_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'That run does not belong to this project.');
  end if;
  if p_summary is not null and jsonb_typeof(p_summary) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'The proposal summary must be an object.');
  end if;

  insert into public.deployment_proposals (
    project_id, user_id, workflow_id, run_id, target, snapshot_id, source_hash,
    runtime_profile, verification_id, status, summary, expires_at
  ) values (
    p_project_id, v_uid, p_workflow_id, p_run_id, p_target, p_snapshot_id,
    p_source_hash, nullif(p_runtime_profile, ''), p_verification_id, 'proposed',
    coalesce(p_summary, '{}'::jsonb), p_expires_at
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'proposal', to_jsonb(v_row));
end;
$$;

revoke all on function public.create_deployment_proposal(
  text, text, uuid, text, text, uuid, uuid, uuid, jsonb, timestamptz
) from public, anon;
grant execute on function public.create_deployment_proposal(
  text, text, uuid, text, text, uuid, uuid, uuid, jsonb, timestamptz
) to authenticated;

create or replace function public.approve_deployment_proposal(
  p_proposal_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.deployment_proposals%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select p.* into v_row
    from public.deployment_proposals p
   where p.id = p_proposal_id
     and p.user_id = v_uid
   for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'No such deployment proposal exists.');
  end if;
  if v_row.status = 'revoked' or v_row.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked', 'error', 'That proposal was revoked.');
  end if;
  if v_row.consumed_at is not null or v_row.status = 'consumed' then
    return jsonb_build_object('ok', false, 'code', 'consumed', 'error', 'That proposal was already used.');
  end if;
  if v_row.expires_at <= now() then
    update public.deployment_proposals set status = 'expired' where id = v_row.id;
    return jsonb_build_object('ok', false, 'code', 'expired', 'error', 'That proposal has expired. Create a fresh one.');
  end if;
  if v_row.status = 'approved' and v_row.approved_at is not null then
    return jsonb_build_object('ok', true, 'proposal', to_jsonb(v_row));
  end if;

  update public.deployment_proposals
     set status = 'approved', approved_by = v_uid, approved_at = now()
   where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'proposal', to_jsonb(v_row));
end;
$$;

revoke all on function public.approve_deployment_proposal(uuid) from public, anon;
grant execute on function public.approve_deployment_proposal(uuid) to authenticated;

create or replace function public.revoke_deployment_proposal(
  p_proposal_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.deployment_proposals%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select p.* into v_row
    from public.deployment_proposals p
   where p.id = p_proposal_id
     and p.user_id = v_uid
   for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'No such deployment proposal exists.');
  end if;
  if v_row.consumed_at is not null or v_row.status = 'consumed' then
    return jsonb_build_object('ok', false, 'code', 'consumed', 'error', 'That proposal was already used and cannot be revoked.');
  end if;

  update public.deployment_proposals
     set status = 'revoked',
         revoked_at = now(),
         revoked_reason = left(coalesce(p_reason, ''), 500)
   where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'proposal', to_jsonb(v_row));
end;
$$;

revoke all on function public.revoke_deployment_proposal(uuid, text) from public, anon;
grant execute on function public.revoke_deployment_proposal(uuid, text) to authenticated;

/**
 * The single atomic claim. The deploy path has already re-derived the artifact
 * from current server state; this function refuses any mismatch, expiry, reuse
 * or foreign project. A provider failure after this call burns the approval by
 * design: the owner must approve a fresh one.
 */
create or replace function public.consume_deployment_approval(
  p_approval_id uuid,
  p_project_id text,
  p_target text,
  p_snapshot_id uuid,
  p_source_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.deployment_proposals%rowtype;
  v_consumed timestamptz := now();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select p.* into v_row
    from public.deployment_proposals p
   where p.id = p_approval_id
     and p.user_id = v_uid
   for update;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'error', 'No such deployment approval exists.');
  end if;
  if v_row.project_id is distinct from p_project_id then
    return jsonb_build_object('ok', false, 'code', 'mismatch', 'error', 'That approval belongs to a different project.');
  end if;
  if v_row.target is distinct from p_target then
    return jsonb_build_object('ok', false, 'code', 'mismatch', 'error', 'That approval is for a different deployment target.');
  end if;
  if v_row.snapshot_id is distinct from p_snapshot_id then
    return jsonb_build_object('ok', false, 'code', 'mismatch', 'error', 'That approval is for a different source snapshot.');
  end if;
  if v_row.source_hash is distinct from p_source_hash then
    return jsonb_build_object('ok', false, 'code', 'mismatch', 'error', 'The project source changed after approval. Create a new proposal.');
  end if;
  if v_row.status = 'revoked' or v_row.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'revoked', 'error', 'That deployment approval was revoked.');
  end if;
  if v_row.consumed_at is not null or v_row.status = 'consumed' then
    return jsonb_build_object('ok', false, 'code', 'consumed', 'error', 'That deployment approval was already used.');
  end if;
  if v_row.status <> 'approved' or v_row.approved_at is null then
    return jsonb_build_object('ok', false, 'code', 'validation', 'error', 'The deployment proposal has not been approved by the project owner.');
  end if;
  if v_row.expires_at <= now() then
    update public.deployment_proposals set status = 'expired' where id = v_row.id;
    return jsonb_build_object('ok', false, 'code', 'expired', 'error', 'That deployment approval has expired.');
  end if;

  update public.deployment_proposals
     set status = 'consumed', consumed_at = v_consumed
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'consumedAt', v_consumed);
end;
$$;

revoke all on function public.consume_deployment_approval(uuid, text, text, uuid, text) from public, anon;
grant execute on function public.consume_deployment_approval(uuid, text, text, uuid, text) to authenticated;

-- ── 9. Schema marker ────────────────────────────────────────────────────────

create or replace function public.multi_agent_schema_version()
returns integer
language sql
stable
as $$
  select 29;
$$;

comment on function public.multi_agent_schema_version() is
  'Schema marker for Phase 10 multi-agent orchestration and deployment approval.';

revoke all on function public.multi_agent_schema_version() from public, anon;
grant execute on function public.multi_agent_schema_version() to authenticated, service_role;

commit;
