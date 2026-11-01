-- ═══ MAVLY — MANAGED BACKEND ENROLLMENT REGISTRY (migration 37) ═════════════
--
-- ═══ WHAT THIS REPLACES ═════════════════════════════════════════════════════
--
-- Before this migration, the ONLY authorization for a managed Neon backend was
-- `MAVLY_MANAGED_BACKENDS_PROJECTS`: an operator pasted every eligible project
-- UUID into an environment variable. That does not scale past a handful of
-- customers, and it made "the id is in a list" the entire security story.
--
-- This migration adds the trusted, database-backed control plane that decides
-- whether a project may receive a managed backend at all.
--
-- ═══ THE TWO STATE MACHINES ARE SEPARATE, ON PURPOSE ════════════════════════
--
--   ENROLLMENT (this table)          BACKEND LIFECYCLE (migration 30/35)
--   ─────────────────────            ────────────────────────────────────
--   not_enrolled (no row)            not_required
--   pending                          pending_approval
--   approved                         provisioning
--   rejected                         provisioned
--   revoked                          configuring
--   suspended                        ready / failed / outcome_unknown
--                                    cleanup_pending
--
-- Enrollment answers "is this project ALLOWED to have a database?".
-- Lifecycle answers "what is the state of the database it has?".
--
-- They are never merged: a project can be `approved` with no database yet, or
-- have a `ready` database and later be `suspended`. Writing one into the other
-- would make revocation look like data loss and would make a provisioning
-- failure look like an authorization failure.
--
-- ═══ SECURITY MODEL ═════════════════════════════════════════════════════════
--
--   · Supabase is the authoritative Mavly control plane. Neon stores customer
--     application data and is NEVER consulted for an enrollment decision.
--   · `project_managed_backend_enrollments` is deny-by-default: RLS enabled with
--     NO policies, and anon/authenticated hold no table privilege. An owner
--     reads their own status through `managed_backend_enrollment_status()`.
--   · No authenticated client can approve, revoke, suspend or resume anything.
--     Those paths are `service_role`-only or gated on
--     `public.current_user_is_admin()` (migration 18), which resolves authority
--     from `auth.users` — never from a request body or a client-supplied flag.
--   · Every mutation function is `security definer` with an EMPTY `search_path`
--     and fully schema-qualified object references.
--   · The audit table is append-only: no UPDATE, no DELETE grant, and a trigger
--     refuses both even for a privileged role.
--
-- ═══ ROLLBACK ═══════════════════════════════════════════════════════════════
--
-- Additive and non-destructive. Dropping this migration's objects returns the
-- deployment to the static allowlist. It NEVER deletes a Neon project, a
-- customer row, or an existing `project_managed_backends` record. Revoking an
-- enrollment stops FUTURE provisioning; it does not touch existing data.
--
-- Apply AFTER 35. Nothing here is applied automatically.

begin;

-- ── 1. The enrollment registry ──────────────────────────────────────────────

create table if not exists public.project_managed_backend_enrollments (
  id uuid primary key default gen_random_uuid(),

  -- The Mavly project. `project_id` alone is NEVER authorization: every read and
  -- write below also matches the owner and the incarnation.
  project_id text not null,
  -- Bound to projects.created_at so a deleted-and-recreated slug is a DIFFERENT
  -- enrollment subject and cannot inherit the previous incarnation's approval.
  project_created_at timestamptz not null,
  user_id uuid references auth.users (id) on delete set null,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'revoked', 'suspended')),

  -- Where the decision came from. `policy` = the automatic policy engine;
  -- `admin` = an explicit administrative action; `legacy` = the static allowlist
  -- was honored during migration; `migration` = backfilled.
  source text not null default 'policy'
    check (source in ('policy', 'admin', 'legacy', 'migration')),

  -- The machine-readable reason, mirrored from the policy engine's vocabulary.
  reason_code text not null default 'eligible'
    check (reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),

  -- The rollout cohort the project landed in. NULL when the platform itself was
  -- not ready and no cohort was reached.
  cohort text
    check (cohort is null or cohort in (
      'disabled', 'internal', 'allowlisted', 'percentage', 'general_availability'
    )),

  -- The deterministic 0–99 rollout bucket, when the percentage policy ran.
  rollout_bucket smallint
    check (rollout_bucket is null or (rollout_bucket >= 0 and rollout_bucket < 100)),

  policy_version text not null default '1'
    check (policy_version ~ '^[0-9]{1,8}$'),

  -- Operator-supplied context for an administrative decision. Bounded and
  -- never rendered to the project owner.
  decision_note text
    check (decision_note is null or length(decision_note) <= 500),

  enrolled_at timestamptz,
  last_authorized_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
    check (revoked_reason is null or length(revoked_reason) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ⚠️ ONE ENROLLMENT PER PROJECT INCARNATION. This is the idempotency key: two
  -- simultaneous enrollment requests cannot create two rows, and a project
  -- cannot enter provisioning twice through this table.
  constraint project_managed_backend_enrollments_instance_key
    unique (project_id, project_created_at),

  -- An approved row must record when it was approved.
  constraint project_managed_backend_enrollments_approved_at_check
    check (status <> 'approved' or enrolled_at is not null),

  -- A revoked row must record when and why.
  constraint project_managed_backend_enrollments_revoked_at_check
    check (status <> 'revoked' or (revoked_at is not null and revoked_reason is not null))
);

comment on table public.project_managed_backend_enrollments is
  'Trusted enrollment registry: whether a project incarnation may receive a managed backend. Separate from the backend lifecycle in project_managed_backends.';
comment on column public.project_managed_backend_enrollments.project_created_at is
  'The projects.created_at of this incarnation. A recreated slug is a different enrollment subject.';
comment on column public.project_managed_backend_enrollments.rollout_bucket is
  'Deterministic 0-99 bucket from (salt, project_id, project_created_at). Stable across evaluations so a percentage change never reassigns an existing project.';
comment on column public.project_managed_backend_enrollments.policy_version is
  'The policy engine version that produced the decision. A mismatch forces re-evaluation rather than silent authorization.';

create index if not exists project_managed_backend_enrollments_status_idx
  on public.project_managed_backend_enrollments (status, updated_at desc);

create index if not exists project_managed_backend_enrollments_user_idx
  on public.project_managed_backend_enrollments (user_id, created_at desc);

-- ── 2. Append-only audit history ────────────────────────────────────────────

create table if not exists public.project_managed_backend_enrollment_events (
  id bigint generated always as identity primary key,
  enrollment_id uuid references public.project_managed_backend_enrollments (id)
    on delete cascade,
  project_id text not null,
  project_created_at timestamptz not null,
  -- The event name, matching the observability vocabulary.
  event text not null
    check (event ~ '^managed_backend\.(enrollment|cohort|authorization|provisioning)\.[a-z_]{2,48}$'),
  from_status text,
  to_status text,
  cohort text,
  policy_version text,
  reason_code text,
  -- The authenticated administrator who acted, when the action was manual.
  actor_user_id uuid,
  -- A bounded, non-sensitive detail string. Never a credential, never a URI.
  detail text check (detail is null or length(detail) <= 500),
  created_at timestamptz not null default now()
);

comment on table public.project_managed_backend_enrollment_events is
  'Append-only audit trail for enrollment decisions. No UPDATE or DELETE is granted to any role, and a trigger refuses both.';

create index if not exists project_managed_backend_enrollment_events_project_idx
  on public.project_managed_backend_enrollment_events (project_id, created_at desc);

create or replace function public.project_managed_backend_enrollment_events_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'enrollment audit history is append-only'
    using errcode = '42501';
end;
$$;

drop trigger if exists project_managed_backend_enrollment_events_no_update
  on public.project_managed_backend_enrollment_events;
create trigger project_managed_backend_enrollment_events_no_update
  before update or delete on public.project_managed_backend_enrollment_events
  for each row execute function public.project_managed_backend_enrollment_events_immutable();

-- ── 3. RLS and privileges: deny by default ──────────────────────────────────

alter table public.project_managed_backend_enrollments enable row level security;
alter table public.project_managed_backend_enrollment_events enable row level security;

-- No policies are created. RLS with zero policies denies every row to anon and
-- authenticated. Owners read their own projection through the RPC below.
revoke all on public.project_managed_backend_enrollments
  from public, anon, authenticated;
revoke all on public.project_managed_backend_enrollment_events
  from public, anon, authenticated;

-- ── 4. Internal helper: record an audit event ───────────────────────────────

create or replace function public.record_managed_backend_enrollment_event(
  p_enrollment_id uuid,
  p_project_id text,
  p_project_created_at timestamptz,
  p_event text,
  p_from_status text,
  p_to_status text,
  p_cohort text,
  p_policy_version text,
  p_reason_code text,
  p_actor_user_id uuid,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_managed_backend_enrollment_events (
    enrollment_id, project_id, project_created_at, event, from_status,
    to_status, cohort, policy_version, reason_code, actor_user_id, detail
  )
  values (
    p_enrollment_id, p_project_id, p_project_created_at, p_event, p_from_status,
    p_to_status, p_cohort, p_policy_version, p_reason_code, p_actor_user_id,
    p_detail
  );
end;
$$;

revoke all on function public.record_managed_backend_enrollment_event(
  uuid, text, timestamptz, text, text, text, text, text, text, uuid, text
) from public, anon, authenticated;

-- ── 5. Automatic enrollment (service_role only) ─────────────────────────────

/**
 * ═══ THE ENROLLMENT WRITE PATH ══════════════════════════════════════════════
 *
 * Called by trusted server code AFTER the policy engine has decided. It is
 * idempotent and it CANNOT resurrect an operator decision:
 *
 *   · an existing `revoked`, `suspended` or `rejected` row is returned unchanged
 *     and never downgraded to `approved` by a policy call;
 *   · an existing `approved` row is returned unchanged (grandfathering);
 *   · a `pending` row is promoted to `approved` only by this function.
 *
 * The owner and incarnation are verified against `public.projects` inside this
 * function, so a caller cannot enroll a project it does not own.
 */
create or replace function public.enroll_managed_backend(
  p_project_id text,
  p_user_id uuid,
  p_status text,
  p_reason_code text,
  p_cohort text,
  p_policy_version text,
  p_rollout_bucket smallint,
  p_source text default 'policy'
)
returns table (
  enrollment_status text,
  changed boolean,
  enrollment_id uuid,
  project_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_created_at timestamptz;
  v_row public.project_managed_backend_enrollments%rowtype;
  v_changed boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_status not in ('pending', 'approved') then
    -- Only the policy path may write these two states. Rejection, revocation and
    -- suspension are administrative actions with their own audited function.
    raise exception using errcode = '22023', message = 'invalid enrollment status';
  end if;
  if p_source not in ('policy', 'legacy', 'migration') then
    raise exception using errcode = '22023', message = 'invalid enrollment source';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception using errcode = '22023', message = 'invalid reason code';
  end if;
  if p_cohort is not null and p_cohort not in (
    'disabled', 'internal', 'allowlisted', 'percentage', 'general_availability'
  ) then
    raise exception using errcode = '22023', message = 'invalid cohort';
  end if;
  if p_rollout_bucket is not null and (p_rollout_bucket < 0 or p_rollout_bucket >= 100) then
    raise exception using errcode = '22023', message = 'invalid rollout bucket';
  end if;

  -- ⚠️ THE OWNER AND INCARNATION ARE RESOLVED HERE, NOT SUPPLIED BY THE CALLER.
  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id
    and p.user_id = p_user_id
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  insert into public.project_managed_backend_enrollments (
    project_id, project_created_at, user_id, status, source, reason_code,
    cohort, rollout_bucket, policy_version, enrolled_at
  )
  values (
    p_project_id, v_project_created_at, p_user_id, p_status, p_source,
    p_reason_code, p_cohort, p_rollout_bucket, p_policy_version,
    case when p_status = 'approved' then now() else null end
  )
  on conflict (project_id, project_created_at) do nothing;

  select * into v_row
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = v_project_created_at
  for update;

  if v_row.user_id is distinct from p_user_id then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  /**
   * ⚠️ AN OPERATOR DECISION IS FINAL UNTIL AN OPERATOR CHANGES IT. A revoked or
   * suspended project must never be silently re-approved because a generation
   * ran again. `rejected` is likewise sticky.
   */
  if v_row.status in ('revoked', 'suspended', 'rejected') then
    return query select
      v_row.status, false, v_row.id, v_row.project_created_at;
    return;
  end if;

  -- Already approved: grandfather it. Never re-evaluate, never re-stamp.
  if v_row.status = 'approved' then
    return query select
      v_row.status, false, v_row.id, v_row.project_created_at;
    return;
  end if;

  if v_row.status = 'pending' and p_status = 'approved' then
    update public.project_managed_backend_enrollments e
    set status = 'approved',
        source = p_source,
        reason_code = p_reason_code,
        cohort = coalesce(p_cohort, e.cohort),
        rollout_bucket = coalesce(p_rollout_bucket, e.rollout_bucket),
        policy_version = p_policy_version,
        enrolled_at = now(),
        updated_at = now()
    where e.id = v_row.id
    returning * into v_row;
    v_changed := true;

    perform public.record_managed_backend_enrollment_event(
      v_row.id, v_row.project_id, v_row.project_created_at,
      'managed_backend.enrollment.approved', 'pending', 'approved',
      v_row.cohort, v_row.policy_version, v_row.reason_code, null, null
    );
  elsif v_row.status = 'pending' then
    -- A pending row that is still pending: refresh the reason, change nothing else.
    update public.project_managed_backend_enrollments e
    set reason_code = p_reason_code,
        cohort = coalesce(p_cohort, e.cohort),
        rollout_bucket = coalesce(p_rollout_bucket, e.rollout_bucket),
        policy_version = p_policy_version,
        updated_at = now()
    where e.id = v_row.id
    returning * into v_row;
  end if;

  return query select
    v_row.status, v_changed, v_row.id, v_row.project_created_at;
end;
$$;

revoke all on function public.enroll_managed_backend(
  text, uuid, text, text, text, text, smallint, text
) from public, anon, authenticated;
grant execute on function public.enroll_managed_backend(
  text, uuid, text, text, text, text, smallint, text
) to service_role;

-- ── 6. Administrative controls (verified admin only) ────────────────────────

/**
 * ═══ ADMINISTRATIVE ENROLLMENT ACTIONS ══════════════════════════════════════
 *
 * Authority is `public.current_user_is_admin()`, which resolves the CALLER's own
 * identity from `auth.users`. There is no parameter for "am I an admin" and no
 * client-supplied role, so a forged request body cannot reach this path.
 *
 * Revocation and suspension stop FUTURE provisioning and reconfiguration. They
 * do NOT delete a Neon project, a customer row, or the backend registry record.
 */
create or replace function public.set_managed_backend_enrollment(
  p_project_id text,
  p_action text,
  p_reason text default null
)
returns table (
  enrollment_status text,
  changed boolean,
  enrollment_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_project_created_at timestamptz;
  v_row public.project_managed_backend_enrollments%rowtype;
  v_next text;
  v_event text;
  v_prev text;
begin
  if not public.current_user_is_admin() then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;
  if p_action not in ('approve', 'reject', 'suspend', 'revoke', 'resume') then
    raise exception using errcode = '22023', message = 'invalid enrollment action';
  end if;

  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id
  for key share;

  if not found then
    raise exception using errcode = '42P01', message = 'project not found';
  end if;

  select * into v_row
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = v_project_created_at
  for update;

  v_prev := case when found then v_row.status else null end;

  v_next := case p_action
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'suspend' then 'suspended'
    when 'revoke' then 'revoked'
    -- `resume` returns a suspended project to the policy's care. It never
    -- resurrects a revoked one: revocation is deliberate and needs `approve`.
    when 'resume' then 'pending'
  end;

  v_event := case p_action
    when 'approve' then 'managed_backend.enrollment.approved'
    when 'reject' then 'managed_backend.enrollment.rejected'
    when 'suspend' then 'managed_backend.enrollment.suspended'
    when 'revoke' then 'managed_backend.enrollment.revoked'
    when 'resume' then 'managed_backend.enrollment.resumed'
  end;

  if p_action = 'resume' and v_prev = 'revoked' then
    raise exception using errcode = '22023',
      message = 'a revoked enrollment cannot be resumed; approve it explicitly';
  end if;

  if v_row.id is null then
    -- No row yet: only `approve` makes sense, and it creates one.
    if p_action <> 'approve' then
      raise exception using errcode = '42P01', message = 'enrollment not found';
    end if;
    insert into public.project_managed_backend_enrollments (
      project_id, project_created_at, user_id, status, source, reason_code,
      cohort, policy_version, decision_note, enrolled_at
    )
    select p_project_id, v_project_created_at, p.user_id, 'approved', 'admin',
           'eligible', null, '1', p_reason, now()
    from public.projects p
    where p.project_id = p_project_id and p.created_at = v_project_created_at
    returning * into v_row;

    perform public.record_managed_backend_enrollment_event(
      v_row.id, v_row.project_id, v_row.project_created_at, v_event, null,
      'approved', null, v_row.policy_version, 'eligible', v_actor, p_reason
    );
    return query select v_row.status, true, v_row.id;
    return;
  end if;

  if v_row.status = v_next then
    return query select v_row.status, false, v_row.id;
    return;
  end if;

  update public.project_managed_backend_enrollments e
  set status = v_next,
      source = 'admin',
      decision_note = coalesce(p_reason, e.decision_note),
      enrolled_at = case
        when v_next = 'approved' then coalesce(e.enrolled_at, now())
        else e.enrolled_at
      end,
      revoked_at = case when v_next = 'revoked' then now() else e.revoked_at end,
      revoked_reason = case
        when v_next = 'revoked' then coalesce(p_reason, 'revoked by administrator')
        else e.revoked_reason
      end,
      updated_at = now()
  where e.id = v_row.id
  returning * into v_row;

  perform public.record_managed_backend_enrollment_event(
    v_row.id, v_row.project_id, v_row.project_created_at, v_event, v_prev,
    v_next, v_row.cohort, v_row.policy_version, v_row.reason_code, v_actor, p_reason
  );

  return query select v_row.status, true, v_row.id;
end;
$$;

revoke all on function public.set_managed_backend_enrollment(text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_managed_backend_enrollment(text, text, text)
  to authenticated, service_role;

-- ── 7. Reads ────────────────────────────────────────────────────────────────

/** Owner-scoped enrollment status. Never returns a salt, a note or an actor. */
create or replace function public.managed_backend_enrollment_status(
  p_project_id text
)
returns table (
  status text,
  cohort text,
  reason_code text,
  policy_version text,
  enrolled_at timestamptz,
  last_authorized_at timestamptz,
  project_created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  return query
    select e.status, e.cohort, e.reason_code, e.policy_version,
           e.enrolled_at, e.last_authorized_at, e.project_created_at
      from public.project_managed_backend_enrollments e
      join public.projects p
        on p.project_id = e.project_id
       and p.created_at = e.project_created_at
     where e.project_id = p_project_id
       and p.user_id = auth.uid()
       and e.user_id = auth.uid()
     limit 1;
end;
$$;

revoke all on function public.managed_backend_enrollment_status(text)
  from public, anon, authenticated;
grant execute on function public.managed_backend_enrollment_status(text)
  to authenticated, service_role;

/** Service-role read used by the worker and the enrollment service. */
create or replace function public.managed_backend_enrollment_lifecycle(
  p_project_id text,
  p_user_id uuid
)
returns table (
  status text,
  cohort text,
  reason_code text,
  policy_version text,
  project_created_at timestamptz,
  user_id uuid,
  enrolled_at timestamptz,
  last_authorized_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  return query
    select e.status, e.cohort, e.reason_code, e.policy_version,
           e.project_created_at, e.user_id, e.enrolled_at, e.last_authorized_at
      from public.project_managed_backend_enrollments e
     where e.project_id = p_project_id
       and e.user_id = p_user_id
     limit 1;
end;
$$;

revoke all on function public.managed_backend_enrollment_lifecycle(text, uuid)
  from public, anon, authenticated;
grant execute on function public.managed_backend_enrollment_lifecycle(text, uuid)
  to service_role;

/** Admin: the full audit history for one project. */
create or replace function public.managed_backend_enrollment_history(
  p_project_id text,
  p_limit integer default 50
)
returns table (
  event text,
  from_status text,
  to_status text,
  cohort text,
  reason_code text,
  detail text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.current_user_is_admin() then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = '22023', message = 'invalid limit';
  end if;

  return query
    select ev.event, ev.from_status, ev.to_status, ev.cohort, ev.reason_code,
           ev.detail, ev.created_at
      from public.project_managed_backend_enrollment_events ev
     where ev.project_id = p_project_id
     order by ev.created_at desc
     limit p_limit;
end;
$$;

revoke all on function public.managed_backend_enrollment_history(text, integer)
  from public, anon, authenticated;
grant execute on function public.managed_backend_enrollment_history(text, integer)
  to authenticated, service_role;

-- ── 8. Capacity counter ─────────────────────────────────────────────────────

/** How many projects are mid-provisioning right now. Service-role only. */
create or replace function public.count_active_managed_backend_provisions()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.project_managed_backends b
   where b.status in ('provisioning', 'configuring');
$$;

revoke all on function public.count_active_managed_backend_provisions()
  from public, anon, authenticated;
grant execute on function public.count_active_managed_backend_provisions()
  to service_role;

-- ── 9. Execution-time authorization gate ────────────────────────────────────

/**
 * ═══ THE WORKER'S INDEPENDENT RECHECK ═══════════════════════════════════════
 *
 * Called immediately before provisioning and before configuration. It reads the
 * LIVE enrollment row and the LIVE project row, so a revocation that landed
 * after the run was queued is observed here.
 *
 * Returns `authorized = false` with a reason instead of raising, so the caller
 * can report a truthful blocked state rather than a generic error.
 *
 * ⚠️ IT ALSO STAMPS `last_authorized_at`, which is the audit answer to "when was
 * this project last confirmed authorized?".
 */
create or replace function public.authorize_managed_backend_provisioning(
  p_project_id text,
  p_user_id uuid
)
returns table (
  authorized boolean,
  reason_code text,
  enrollment_status text,
  project_created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_created_at timestamptz;
  v_row public.project_managed_backend_enrollments%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id
    and p.user_id = p_user_id;

  if not found then
    return query select false, 'project_not_owned'::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_row
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = v_project_created_at;

  if not found then
    return query select
      false, 'enrollment_missing'::text, null::text, v_project_created_at;
    return;
  end if;

  if v_row.user_id is distinct from p_user_id then
    return query select
      false, 'owner_mismatch'::text, v_row.status, v_project_created_at;
    return;
  end if;

  if v_row.status <> 'approved' then
    return query select
      false,
      case v_row.status
        when 'revoked' then 'revoked_by_operator'
        when 'suspended' then 'suspended_by_operator'
        when 'rejected' then 'rejected_by_operator'
        else 'enrollment_missing'
      end::text,
      v_row.status,
      v_project_created_at;
    return;
  end if;

  update public.project_managed_backend_enrollments e
  set last_authorized_at = now(), updated_at = now()
  where e.id = v_row.id;

  return query select true, 'eligible'::text, v_row.status, v_project_created_at;
end;
$$;

revoke all on function public.authorize_managed_backend_provisioning(text, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_managed_backend_provisioning(text, uuid)
  to service_role;

-- ── 10. Close the time-of-check/time-of-use window ──────────────────────────

/**
 * ═══ WHY THESE TWO FUNCTIONS ARE REDEFINED ══════════════════════════════════
 *
 * `authorize_managed_backend_provisioning` above is a read. Between that read and
 * the actual Neon create call there is a window in which an administrator could
 * revoke the enrollment. The signatures of the two functions below are unchanged;
 * only a guard is added, so nothing else has to change.
 *
 * The guard is conditional: it applies ONLY when an enrollment row exists. A
 * deployment still on the legacy static allowlist has no rows, so its behavior
 * is byte-for-byte what it was. A registry deployment always has a row before
 * provisioning starts, so a revocation is honored at the last possible moment.
 *
 * ⚠️ `mark_managed_backend_create_started` is the LAST gate before the provider
 * call and already carries lease fencing, which makes it the correct place to
 * re-verify: a stale worker that lost its lease fails here regardless.
 */

create or replace function public.mark_managed_backend_create_started(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enrollment_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_project_created_at is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease parameters';
  end if;

  -- Enrollment guard: only enforced when a registry row exists.
  select e.status into v_enrollment_status
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = p_project_created_at;

  if found and v_enrollment_status <> 'approved' then
    return false;
  end if;

  update public.project_managed_backends b
  set creation_attempted = true, updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'provisioning'
    and b.lease_token = p_lease_token
    and b.lease_expires_at > now();
  return found;
end;
$$;

revoke all on function public.mark_managed_backend_create_started(text, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_managed_backend_create_started(text, timestamptz, uuid)
  to service_role;

/**
 * The configuration phase applies schema to a customer database, so it gets the
 * same guard. A revoked project must not have new tables written into it.
 */
create or replace function public.begin_managed_backend_configuration(
  p_project_id text,
  p_user_id uuid,
  p_lease_token uuid
)
returns table (
  claim_status text,
  registry_id uuid,
  project_created_at timestamptz,
  neon_project_id text,
  region_id text,
  connection_uri_ciphertext text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.project_managed_backends%rowtype;
  v_enrollment_status text;
  v_project_created_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease token';
  end if;

  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id
    and p.user_id = p_user_id
  for key share;

  if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  -- Enrollment guard: only enforced when a registry row exists.
  select e.status into v_enrollment_status
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = v_project_created_at;

  if found and v_enrollment_status <> 'approved' then
    raise exception using errcode = '42501', message = 'enrollment not authorized';
  end if;

  select * into v_row
  from public.project_managed_backends b
  where b.project_id = p_project_id
    and b.project_created_at = v_project_created_at
  for update;

  if not found then
    return query select
      'busy'::text, null::uuid, v_project_created_at, null::text, null::text, null::text;
    return;
  end if;

  if v_row.lease_token is not null
     and v_row.lease_token <> p_lease_token
     and v_row.lease_expires_at is not null
     and v_row.lease_expires_at > now() then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, null::text, null::text, null::text;
    return;
  end if;

  if v_row.neon_project_id is null or v_row.connection_uri_ciphertext is null then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, null::text, null::text, null::text;
    return;
  end if;

  update public.project_managed_backends b
  set status = 'configuring',
      lease_token = p_lease_token,
      lease_expires_at = now() + make_interval(secs => 240),
      error_code = null,
      updated_at = now()
  where b.id = v_row.id
  returning * into v_row;

  return query select
    'claimed'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
    v_row.region_id, v_row.connection_uri_ciphertext;
end;
$$;

revoke all on function public.begin_managed_backend_configuration(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_managed_backend_configuration(text, uuid, uuid)
  to service_role;

-- ── 11. Schema marker ───────────────────────────────────────────────────────

create or replace function public.managed_backend_schema_version()
returns integer
language sql
stable
as $$ select 37 $$;

comment on function public.managed_backend_schema_version() is
  'Schema marker 37: managed-backend enrollment registry, audit history, administrative controls and execution-time authorization.';

revoke all on function public.managed_backend_schema_version() from public;
revoke all on function public.managed_backend_schema_version() from anon;
grant execute on function public.managed_backend_schema_version()
  to authenticated, service_role;

commit;
