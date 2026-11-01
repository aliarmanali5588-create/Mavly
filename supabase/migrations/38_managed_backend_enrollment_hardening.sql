-- Managed backend enrollment — production hardening (migration 38).
--
-- Migration 37 introduced the enrollment registry and a CONDITIONAL execution-time
-- guard: the guard applied only when an enrollment row existed, so a deployment
-- still on the legacy `MAVLY_MANAGED_BACKENDS_PROJECTS` list kept working byte for
-- byte. That was the right shape for a first migration and the wrong shape for
-- production, because "no row" silently meant "allowed".
--
-- This migration adds the three things that make strict authorization safe to turn
-- on, and none of them change an existing function signature:
--
--   1. `backfill_managed_backend_enrollments()` — idempotent, dry-run-first
--      backfill of existing `project_managed_backends` rows into the registry.
--      It never writes to `project_managed_backends`, never touches a Neon
--      project, and never overwrites an operator decision.
--
--   2. A coverage read + a strict-authorization switch. Strict mode is a
--      DATABASE fact, not an environment variable, because the enforcement lives
--      in SQL and an env var cannot be read there. The switch REFUSES to enable
--      while any live backend lacks an enrollment row.
--
--   3. Strict-aware guards in every provisioning/configuration gate, including
--      `claim_managed_backend`, which previously had no authorization notion at
--      all — it would create a registry row for any owner-verified project.
--
-- ⚠️ NOTHING HERE DELETES CUSTOMER DATA. There is no DROP, TRUNCATE or DELETE of
-- a backend row, an enrollment row, a Neon project or an application table. The
-- only writes are inserts into the enrollment registry, inserts into its
-- append-only audit trail, and an update of a single boolean control row.
--
-- ⚠️ APPLYING THIS MIGRATION DOES NOT ENABLE STRICT MODE. The default is
-- `strict_authorization = false`, which preserves migration 37's conditional
-- behavior exactly. Strict mode is enabled by an explicit, audited, coverage-
-- checked administrative call after the backfill has run.

begin;
-- ── 1. The strict-authorization control row ─────────────────────────────────

/**
 * A singleton control row. `id` is a boolean constrained to true, which is the
 * cheapest way to make "there is exactly one row" a database invariant rather
 * than a convention.
 *
 * `strict_authorization = false` (the default) means: a missing enrollment row
 * does not deny, which is migration 37's compatibility behavior. `true` means:
 * a missing enrollment row DENIES new provisioning and configuration.
 */
create table if not exists public.managed_backend_enrollment_policy (
  id boolean primary key default true check (id),
  strict_authorization boolean not null default false,
  strict_activated_at timestamptz,
  strict_activated_by uuid,
  updated_at timestamptz not null default now()
);
comment on table public.managed_backend_enrollment_policy is
  'Singleton control row for managed-backend enrollment enforcement. strict_authorization=false preserves the legacy compatibility path; true denies any project without an approved enrollment row.';
comment on column public.managed_backend_enrollment_policy.strict_authorization is
  'When true, a missing enrollment row denies new provisioning and configuration. Never enabled automatically; requires a coverage-checked administrative call.';
insert into public.managed_backend_enrollment_policy (id, strict_authorization)
values (true, false)
on conflict (id) do nothing;
alter table public.managed_backend_enrollment_policy enable row level security;
revoke all on public.managed_backend_enrollment_policy from public, anon, authenticated;
/**
 * The single authorization predicate every SQL gate calls.
 *
 * Read it as: "if a row exists, it must be approved; if no row exists, only a
 * non-strict deployment may proceed."
 *
 * ⚠️ FAILS CLOSED. If the control row is somehow missing, `coalesce(..., true)`
 * makes the deployment behave as strict rather than silently permissive.
 */
create or replace function public.managed_backend_enrollment_permits(
  p_project_id text,
  p_project_created_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select e.status = 'approved'
        from public.project_managed_backend_enrollments e
       where e.project_id = p_project_id
         and e.project_created_at = p_project_created_at
    ),
    not coalesce(
      (
        select p.strict_authorization
          from public.managed_backend_enrollment_policy p
         where p.id
      ),
      true
    )
  ); $$;
comment on function public.managed_backend_enrollment_permits(text, timestamptz) is
  'The one authorization predicate: an existing row must be approved; a missing row is permitted only outside strict mode. Fails closed if the control row is absent.';
revoke all on function public.managed_backend_enrollment_permits(text, timestamptz)
  from public, anon, authenticated;
-- ── 2. Backfill: existing backends → enrollment registry ────────────────────

/**
 * ═══ BACKFILL DESIGN ════════════════════════════════════════════════════════
 *
 * Every existing `project_managed_backends` row represents a project that was
 * authorized under the legacy static allowlist. Turning on strict mode without
 * enrolling those projects would strand live databases: the worker would refuse
 * to configure a backend that already exists and already has customer data.
 *
 * So the backfill's job is narrow and conservative:
 *
 *   · VERIFY the project still exists AND the incarnation still matches. A
 *     reused slug with a different `projects.created_at` is a different subject
 *     and is REJECTED, never inherited.
 *   · VERIFY the owner still matches. A registry row whose `user_id` disagrees
 *     with `projects.user_id` is ambiguous and is REJECTED.
 *   · PRESERVE what exists. `ready`/`provisioned`/`configuring`/`provisioning`
 *     and even `failed` become `approved`, because the project was authorized
 *     and may legitimately retry.
 *   · REFUSE to guess. `outcome_unknown` (a Neon create may or may not have
 *     landed) and `cleanup_pending` become `pending`, not `approved`, so an
 *     operator makes the call.
 *   · NEVER overwrite a decision. An existing approved/revoked/suspended/
 *     rejected row is returned untouched. Only a `pending` row is promoted, and
 *     only when this run classifies the project as eligible.
 *
 * Idempotent: a second run finds every previously-written row and reports it as
 * already enrolled. `p_dry_run` defaults to TRUE so the first call an operator
 * makes cannot change anything.
 *
 * ⚠️ IT NEVER WRITES TO `project_managed_backends`. The backend lifecycle is not
 * this function's business, and a backfill must not be able to alter, downgrade
 * or delete a customer database.
 */
create or replace function public.backfill_managed_backend_enrollments(
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dry boolean := coalesce(p_dry_run, true); v_row record; v_class text; v_reason text; v_existing_status text; v_existing_id uuid; v_scanned integer := 0; v_eligible integer := 0; v_already integer := 0; v_skipped integer := 0; v_rejected integer := 0; v_inserted integer := 0; v_promoted integer := 0; v_reasons jsonb := '{}'::jsonb; v_rejected_samples jsonb := '[]'::jsonb; begin
  if not (public.current_user_is_admin() or auth.role() = 'service_role') then
    raise exception using errcode = '42501', message = 'administrator required'; end if; for v_row in
    select b.project_id,
           b.project_created_at,
           b.user_id as backend_user_id,
           b.status as backend_status,
           p.user_id as project_user_id
      from public.project_managed_backends b
      left join public.projects p
        on p.project_id = b.project_id
       and p.created_at = b.project_created_at
     order by b.created_at, b.project_id
  loop
    v_scanned := v_scanned + 1; v_existing_status := null; v_existing_id := null; /**
     * Classification. Order matters: an invalid subject is rejected before its
     * backend status is even considered, so a `ready` row for a deleted project
     * can never be approved.
     */
    if v_row.project_user_id is null then
      /**
       * ⚠️ TWO DISTINCT REJECTIONS, NOT ONE. The join matches on
       * (project_id, created_at), so a NULL here means EITHER the project is
       * gone OR the slug was reused by a new incarnation. They are different
       * operator problems — "this project was deleted" versus "this registry row
       * belongs to a previous incarnation of a live project" — and collapsing
       * them into one code makes the backfill report unreadable. The existence
       * probe is scoped to project_id only, so it answers "does the subject
       * exist at all" without reintroducing the incarnation match.
       */
      if exists (
        select 1 from public.projects p2 where p2.project_id = v_row.project_id
      ) then
        v_class := 'rejected'; v_reason := 'backfill_incarnation_mismatch';
      else
        v_class := 'rejected'; v_reason := 'backfill_project_missing';
      end if; elsif v_row.backend_user_id is distinct from v_row.project_user_id then
      v_class := 'rejected'; v_reason := 'backfill_owner_mismatch'; elsif v_row.backend_status in ('outcome_unknown', 'cleanup_pending') then
      v_class := 'skipped'; v_reason := case v_row.backend_status
        when 'outcome_unknown' then 'backfill_outcome_unknown'
        else 'backfill_cleanup_pending'
      end; elsif v_row.backend_status = 'failed' then
      v_class := 'eligible'; v_reason := 'backfill_failed_backend'; else
      -- provisioning | provisioned | configuring | ready
      v_class := 'eligible'; v_reason := 'backfill_existing_backend'; end if; select e.status, e.id into v_existing_status, v_existing_id
      from public.project_managed_backend_enrollments e
     where e.project_id = v_row.project_id
       and e.project_created_at = v_row.project_created_at; if v_existing_status is not null then
      /**
       * ⚠️ AN OPERATOR DECISION IS NEVER OVERWRITTEN BY A BACKFILL.
       */
      if v_existing_status in ('approved', 'revoked', 'suspended', 'rejected') then
        v_already := v_already + 1; continue; end if; -- Existing `pending`: promote only when this run says eligible.
      if v_existing_status = 'pending' then
        if v_class = 'eligible' then
          v_eligible := v_eligible + 1; if not v_dry then
            update public.project_managed_backend_enrollments e
               set status = 'approved',
                   source = 'migration',
                   reason_code = v_reason,
                   cohort = coalesce(e.cohort, 'allowlisted'),
                   policy_version = '1',
                   enrolled_at = coalesce(e.enrolled_at, now()),
                   updated_at = now()
             where e.id = v_existing_id; perform public.record_managed_backend_enrollment_event(
              v_existing_id, v_row.project_id, v_row.project_created_at,
              'managed_backend.enrollment.approved', 'pending', 'approved',
              'allowlisted', '1', v_reason, null, 'backfill'
            ); v_promoted := v_promoted + 1; end if; elsif v_class = 'skipped' then
          v_skipped := v_skipped + 1; else
          v_rejected := v_rejected + 1; end if; continue; end if; -- Any other stored status is not a state this migration writes.
      v_already := v_already + 1; continue; end if; if v_class = 'rejected' then
      v_rejected := v_rejected + 1; v_reasons := jsonb_set(
        v_reasons, array[v_reason],
        to_jsonb(coalesce((v_reasons ->> v_reason)::integer, 0) + 1), true
      ); if jsonb_array_length(v_rejected_samples) < 20 then
        v_rejected_samples := v_rejected_samples || jsonb_build_object(
          'projectId', v_row.project_id,
          'projectCreatedAt', v_row.project_created_at,
          'backendStatus', v_row.backend_status,
          'reason', v_reason
        ); end if; continue; end if; if v_class = 'skipped' then
      v_skipped := v_skipped + 1; if not v_dry then
        insert into public.project_managed_backend_enrollments (
          project_id, project_created_at, user_id, status, source, reason_code,
          cohort, policy_version
        )
        values (
          v_row.project_id, v_row.project_created_at, v_row.project_user_id,
          'pending', 'migration', v_reason, 'allowlisted', '1'
        )
        on conflict (project_id, project_created_at) do nothing; select e.id into v_existing_id
          from public.project_managed_backend_enrollments e
         where e.project_id = v_row.project_id
           and e.project_created_at = v_row.project_created_at; if v_existing_id is not null then
          perform public.record_managed_backend_enrollment_event(
            v_existing_id, v_row.project_id, v_row.project_created_at,
            'managed_backend.enrollment.requested', null, 'pending',
            'allowlisted', '1', v_reason, null, 'backfill'
          ); end if; v_inserted := v_inserted + 1; end if; continue; end if; -- eligible, no existing row
    v_eligible := v_eligible + 1; if not v_dry then
      insert into public.project_managed_backend_enrollments (
        project_id, project_created_at, user_id, status, source, reason_code,
        cohort, policy_version, enrolled_at
      )
      values (
        v_row.project_id, v_row.project_created_at, v_row.project_user_id,
        'approved', 'migration', v_reason, 'allowlisted', '1', now()
      )
      on conflict (project_id, project_created_at) do nothing; select e.id into v_existing_id
        from public.project_managed_backend_enrollments e
       where e.project_id = v_row.project_id
         and e.project_created_at = v_row.project_created_at; if v_existing_id is not null then
        perform public.record_managed_backend_enrollment_event(
          v_existing_id, v_row.project_id, v_row.project_created_at,
          'managed_backend.enrollment.approved', null, 'approved',
          'allowlisted', '1', v_reason, null, 'backfill'
        ); end if; v_inserted := v_inserted + 1; end if; end loop; return jsonb_build_object(
    'dryRun', v_dry,
    'scanned', v_scanned,
    'eligible', v_eligible,
    'alreadyEnrolled', v_already,
    'skipped', v_skipped,
    'rejected', v_rejected,
    'inserted', v_inserted,
    'promoted', v_promoted,
    'rejectedReasons', v_reasons,
    'rejectedSamples', v_rejected_samples,
    'policyVersion', '1',
    'completedAt', now()
  ); end; $$;
comment on function public.backfill_managed_backend_enrollments(boolean) is
  'Idempotent, dry-run-first backfill of existing managed backends into the enrollment registry. Never writes to project_managed_backends and never overwrites an operator decision.';
revoke all on function public.backfill_managed_backend_enrollments(boolean)
  from public, anon, authenticated;
grant execute on function public.backfill_managed_backend_enrollments(boolean)
  to authenticated, service_role;
-- ── 3. Coverage: the gate in front of strict mode ───────────────────────────

/**
 * "Can strict mode be enabled yet?" answered with counts instead of an opinion.
 *
 * `uncovered` counts LIVE backends (the project and incarnation still exist) with
 * no enrollment row. Those are exactly the projects strict mode would strand, so
 * the switch below refuses while this is non-zero.
 *
 * `orphaned` counts backends whose project is gone. They can never provision
 * again — `claim_managed_backend` resolves the owner from `public.projects` — so
 * they are reported for visibility and deliberately NOT required to be covered.
 */
create or replace function public.managed_backend_enrollment_coverage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer; v_live integer; v_covered integer; v_uncovered integer; v_orphaned integer; v_approved integer; v_strict boolean; v_samples jsonb; begin
  if not (public.current_user_is_admin() or auth.role() = 'service_role') then
    raise exception using errcode = '42501', message = 'administrator required'; end if; select count(*) into v_total from public.project_managed_backends; select count(*) into v_live
    from public.project_managed_backends b
    join public.projects p
      on p.project_id = b.project_id
     and p.created_at = b.project_created_at; select count(*) into v_covered
    from public.project_managed_backends b
    join public.projects p
      on p.project_id = b.project_id
     and p.created_at = b.project_created_at
   where exists (
     select 1 from public.project_managed_backend_enrollments e
      where e.project_id = b.project_id
        and e.project_created_at = b.project_created_at
   ); v_uncovered := v_live - v_covered; v_orphaned := v_total - v_live; select count(*) into v_approved
    from public.project_managed_backend_enrollments e
   where e.status = 'approved'; select coalesce(p.strict_authorization, true) into v_strict
    from public.managed_backend_enrollment_policy p
   where p.id; select coalesce(jsonb_agg(sample), '[]'::jsonb) into v_samples
    from (
      select jsonb_build_object(
               'projectId', b.project_id,
               'projectCreatedAt', b.project_created_at,
               'backendStatus', b.status
             ) as sample
        from public.project_managed_backends b
        join public.projects p
          on p.project_id = b.project_id
         and p.created_at = b.project_created_at
       where not exists (
         select 1 from public.project_managed_backend_enrollments e
          where e.project_id = b.project_id
            and e.project_created_at = b.project_created_at
       )
       order by b.created_at
       limit 20
    ) samples; return jsonb_build_object(
    'totalBackends', v_total,
    'liveBackends', v_live,
    'coveredBackends', v_covered,
    'uncoveredBackends', v_uncovered,
    'orphanedBackends', v_orphaned,
    'approvedEnrollments', v_approved,
    'strictAuthorization', coalesce(v_strict, true),
    'readyForStrict', v_uncovered = 0,
    'uncoveredSamples', v_samples
  ); end; $$;
comment on function public.managed_backend_enrollment_coverage() is
  'Coverage report gating strict authorization: how many live managed backends still lack an enrollment row.';
revoke all on function public.managed_backend_enrollment_coverage()
  from public, anon, authenticated;
grant execute on function public.managed_backend_enrollment_coverage()
  to authenticated, service_role;
/**
 * ═══ THE STRICT-MODE SWITCH ═════════════════════════════════════════════════
 *
 * Enabling strict mode is refused while any live backend is uncovered. That is
 * the whole point: strict mode is not a configuration preference, it is a claim
 * that every existing project has been accounted for, and this function will not
 * let an operator make that claim falsely.
 *
 * Disabling is always allowed — it is the rollback path.
 */
create or replace function public.set_managed_backend_strict_authorization(
  p_enabled boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid(); v_uncovered integer; begin
  if not public.current_user_is_admin() then
    raise exception using errcode = '42501', message = 'administrator required'; end if; if p_enabled is null then
    raise exception using errcode = '22023', message = 'enabled is required'; end if; if p_reason is not null and length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'reason is too long'; end if; if p_enabled then
    select count(*) into v_uncovered
      from public.project_managed_backends b
      join public.projects p
        on p.project_id = b.project_id
       and p.created_at = b.project_created_at
     where not exists (
       select 1 from public.project_managed_backend_enrollments e
        where e.project_id = b.project_id
          and e.project_created_at = b.project_created_at
     ); if v_uncovered > 0 then
      raise exception using errcode = 'P0001',
        message = format(
          'strict authorization refused: %s live managed backend(s) have no enrollment row. Run backfill_managed_backend_enrollments(false) first.',
          v_uncovered
        ); end if; end if; update public.managed_backend_enrollment_policy
     set strict_authorization = p_enabled,
         strict_activated_at = case when p_enabled then now() else strict_activated_at end,
         strict_activated_by = case when p_enabled then v_actor else strict_activated_by end,
         updated_at = now()
   where id; return jsonb_build_object(
    'strictAuthorization', p_enabled,
    'changedAt', now(),
    'uncoveredBackends', coalesce(v_uncovered, 0),
    'reason', p_reason
  ); end; $$;
comment on function public.set_managed_backend_strict_authorization(boolean, text) is
  'Administrator-only, audited strict-authorization switch. Refuses to enable while any live managed backend lacks an enrollment row.';
revoke all on function public.set_managed_backend_strict_authorization(boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_managed_backend_strict_authorization(boolean, text)
  to authenticated, service_role;
-- ── 4. Strict-aware guards in every gate ────────────────────────────────────

/**
 * ═══ authorize_managed_backend_provisioning — THE REPORTED GATE ═════════════
 *
 * Migration 37's version returned `enrollment_missing` for a project with no row
 * and left the caller to decide whether that was fatal. That is exactly the
 * ambiguity strict mode removes, so this version consults the shared predicate
 * and reports `not_enrolled_strict` when strict mode denies a missing row.
 *
 * The signature and the `last_authorized_at` stamp are unchanged. The stamp is
 * only written on an authorized read, so it never records an authorization that
 * did not happen.
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
  v_project_created_at timestamptz; v_row public.project_managed_backend_enrollments%rowtype; v_strict boolean; begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required'; end if; select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id
    and p.user_id = p_user_id; if not found then
    return query select false, 'project_not_owned'::text, null::text, null::timestamptz; return; end if; select coalesce(p.strict_authorization, true) into v_strict
  from public.managed_backend_enrollment_policy p
  where p.id; select * into v_row
  from public.project_managed_backend_enrollments e
  where e.project_id = p_project_id
    and e.project_created_at = v_project_created_at; if not found then
    /**
     * ⚠️ THE STRICT-MODE DIFFERENCE. Outside strict mode a missing row is the
     * legacy path and the caller proceeds. Inside strict mode it is a denial,
     * reported with its own reason so the run blocks truthfully.
     */
    if coalesce(v_strict, true) then
      return query select
        false, 'not_enrolled_strict'::text, null::text, v_project_created_at; return; end if; return query select
      false, 'enrollment_missing'::text, null::text, v_project_created_at; return; end if; if v_row.user_id is distinct from p_user_id then
    return query select
      false, 'owner_mismatch'::text, v_row.status, v_project_created_at; return; end if; if v_row.status <> 'approved' then
    return query select
      false,
      case v_row.status
        when 'revoked' then 'revoked_by_operator'
        when 'suspended' then 'suspended_by_operator'
        when 'rejected' then 'rejected_by_operator'
        else 'enrollment_missing'
      end::text,
      v_row.status,
      v_project_created_at; return; end if; update public.project_managed_backend_enrollments e
  set last_authorized_at = now(), updated_at = now()
  where e.id = v_row.id; return query select true, 'eligible'::text, v_row.status, v_project_created_at; end; $$;
revoke all on function public.authorize_managed_backend_provisioning(text, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_managed_backend_provisioning(text, uuid)
  to service_role;
/**
 * ═══ WHY claim_managed_backend IS REDEFINED HERE ════════════════════════════
 *
 * Migration 37 guarded `mark_managed_backend_create_started` and
 * `begin_managed_backend_configuration`, but NOT `claim_managed_backend` — the
 * function that actually creates the registry row and hands back a lease. A
 * project with no enrollment could therefore still be claimed, and only failed
 * one step later. Under strict mode that is the wrong order: the first gate a
 * worker touches must be the one that refuses.
 *
 * The signature is unchanged. The body is migration 35's body plus one guard.
 */
create or replace function public.claim_managed_backend(
  p_project_id text,
  p_user_id uuid,
  p_lease_token uuid,
  p_region_id text,
  p_lease_seconds integer default 90
)
returns table (
  claim_status text,
  neon_project_id text,
  region_id text,
  connection_uri_ciphertext text,
  creation_attempted boolean,
  project_created_at timestamptz,
  registry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.project_managed_backends%rowtype;
  v_project_created_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception using errcode = '22023', message = 'invalid lease duration';
  end if;
  if p_lease_token is null or p_region_id is null
    or p_region_id !~ '^[a-z0-9]+(-[a-z0-9]+){1,5}$' then
    raise exception using errcode = '22023', message = 'invalid claim parameters';
  end if;
  select p.created_at into v_project_created_at
  from public.projects p
  where p.project_id = p_project_id and p.user_id = p_user_id
  for key share;
  if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  /**
   * ⚠️ THE FIRST GATE. A project with no enrollment row is refused here under
   * strict mode, before a registry row is created and before a lease exists.
   * Outside strict mode a missing row still permits, which is the legacy path.
   */
  if not public.managed_backend_enrollment_permits(p_project_id, v_project_created_at) then
    return query select
      'not_authorized'::text, null::text, null::text, null::text, false,
      v_project_created_at, null::uuid;
    return;
  end if;

  insert into public.project_managed_backends (
    project_id, project_created_at, user_id, region_id, lease_token,
    lease_expires_at
  )
  values (
    p_project_id, v_project_created_at, p_user_id, p_region_id, p_lease_token,
    now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (project_id, project_created_at) do nothing;

  select * into v_row
  from public.project_managed_backends b
  where b.project_id = p_project_id
    and b.project_created_at = v_project_created_at
  for update;

  if v_row.user_id is distinct from p_user_id then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  -- A provisioned or ready database is reused. Re-provisioning a ready row
  -- would silently downgrade it to `provisioned` and lose schema readiness.
  if v_row.status in ('provisioned', 'ready') then
    return query select
      'provisioned'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  -- Configuration is a separate lease; while it is alive this is busy.
  if v_row.status = 'configuring' then
    if v_row.config_lease_expires_at is not null
      and v_row.config_lease_expires_at > now() then
      return query select
        'busy'::text, v_row.neon_project_id, v_row.region_id,
        null::text, v_row.creation_attempted, v_row.project_created_at,
        v_row.id;
      return;
    end if;
    -- An expired configuration lease is safe to resume: the schema steps are
    -- idempotent and the ledger records what already committed.
    return query select
      'provisioned'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  -- A row awaiting an owner-approved cleanup is never resurrected implicitly.
  if v_row.status = 'cleanup_pending' then
    return query select
      'busy'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  if v_row.lease_token = p_lease_token then
    return query select
      'claimed'::text, v_row.neon_project_id, v_row.region_id,
      v_row.connection_uri_ciphertext, v_row.creation_attempted,
      v_row.project_created_at, v_row.id;
    return;
  end if;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > now() then
    return query select
      'busy'::text, v_row.neon_project_id, v_row.region_id,
      null::text, v_row.creation_attempted, v_row.project_created_at,
      v_row.id;
    return;
  end if;

  update public.project_managed_backends b
  set status = 'provisioning',
      region_id = case when b.creation_attempted then b.region_id else p_region_id end,
      lease_token = p_lease_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      error_code = null,
      updated_at = now()
  where b.project_id = p_project_id
    and b.project_created_at = v_project_created_at
  returning b.* into v_row;

  if not found then
    return query select
      'busy'::text, null::text, null::text, null::text, false,
      v_project_created_at, null::uuid;
    return;
  end if;
  return query select
    'claimed'::text,
    v_row.neon_project_id, v_row.region_id,
    v_row.connection_uri_ciphertext, v_row.creation_attempted,
    v_row.project_created_at, v_row.id;
end;
$$;
revoke all on function public.claim_managed_backend(text, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_managed_backend(text, uuid, uuid, text, integer)
  to service_role;
/**
 * ═══ mark_managed_backend_create_started — THE LAST GATE BEFORE NEON ════════
 *
 * Migration 37 made the guard conditional on a row existing. It now calls the
 * shared predicate, so strict mode denies a missing row too. Still lease-fenced:
 * a stale worker fails here regardless of enrollment.
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_project_created_at is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease parameters';
  end if;

  if not public.managed_backend_enrollment_permits(p_project_id, p_project_created_at) then
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
 * ═══ begin_managed_backend_configuration — THE SCHEMA GATE ══════════════════
 *
 * Applying a schema writes into the customer database, so it is a separate act
 * from creating it and gets its own check.
 *
 * ⚠️ THE BODY IS MIGRATION 35'S, UNCHANGED, PLUS ONE GUARD. Its own lease
 * semantics (`config_lease_token` / `config_lease_expires_at`, the 5-minute
 * window, the `busy` returns for provisioning/outcome_unknown/cleanup_pending)
 * are load-bearing and are reproduced here verbatim. Only the authorization
 * check is new.
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
  v_row public.project_managed_backends%rowtype; begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required'; end if; if p_lease_token is null then
    raise exception using errcode = '22023', message = 'invalid lease token'; end if; select b.* into v_row
  from public.project_managed_backends b
  join public.projects p
    on p.project_id = b.project_id
   and p.created_at = b.project_created_at
   and p.user_id = p_user_id
  where b.project_id = p_project_id
    and b.user_id = p_user_id
  order by b.created_at desc
  limit 1
  for update of b; if not found then
    raise exception using errcode = '42501', message = 'project owner mismatch'; end if; /**
   * ⚠️ THE GUARD. Placed AFTER the row is locked and BEFORE any state change, so
   * a revoked project cannot enter `configuring` at all. The row's own
   * `project_created_at` is used, which is the incarnation the lease belongs to.
   */
  if not public.managed_backend_enrollment_permits(p_project_id, v_row.project_created_at) then
    raise exception using errcode = '42501', message = 'enrollment not authorized';
  end if;

  if v_row.status in ('provisioning', 'outcome_unknown', 'cleanup_pending') then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  if v_row.neon_project_id is null or v_row.connection_uri_ciphertext is null
    or v_row.connection_verified_at is null then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, null::text,
      v_row.region_id, null::text;
    return;
  end if;

  if v_row.config_lease_expires_at is not null
    and v_row.config_lease_expires_at > now()
    and v_row.config_lease_token is distinct from p_lease_token then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  update public.project_managed_backends b
  set status = 'configuring',
      config_lease_token = p_lease_token,
      config_lease_expires_at = now() + interval '5 minutes',
      last_step = 'schema',
      error_code = null,
      updated_at = now()
  where b.id = v_row.id
  returning b.* into v_row;

  if not found then
    return query select
      'busy'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
      v_row.region_id, null::text;
    return;
  end if;

  return query select
    'claimed'::text, v_row.id, v_row.project_created_at, v_row.neon_project_id,
    v_row.region_id, v_row.connection_uri_ciphertext;
end;
$$;
revoke all on function public.begin_managed_backend_configuration(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_managed_backend_configuration(text, uuid, uuid)
  to service_role;
/**
 * ═══ record_managed_backend_migration — THE MID-RUN STOP SIGNAL ═════════════
 *
 * Migration 35's body, unchanged, plus the guard. The schema runner applies every
 * step inside ONE transaction, so this cannot un-commit DDL that already
 * committed — but it CAN stop the sanitized mirror from recording further steps,
 * and the runner's commit-time recheck is what actually prevents the commit.
 *
 * Returning false is already tolerated by the caller as a mirror failure, so this
 * is a truthful, non-corrupting signal rather than an exception mid-run.
 */
create or replace function public.record_managed_backend_migration(
  p_project_id text,
  p_project_created_at timestamptz,
  p_lease_token uuid,
  p_step_name text,
  p_checksum text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if p_step_name is null or p_step_name !~ '^[a-z0-9:_-]{1,64}$'
    or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid migration metadata';
  end if;

  if not public.managed_backend_enrollment_permits(p_project_id, p_project_created_at) then
    return false;
  end if;

  select b.id into v_id
  from public.project_managed_backends b
  where b.project_id = p_project_id
    and b.project_created_at = p_project_created_at
    and b.status = 'configuring'
    and b.config_lease_token = p_lease_token
    and b.config_lease_expires_at > now();

  if v_id is null then
    return false;
  end if;

  insert into public.project_managed_backend_migrations (
    registry_id, project_id, user_id, step_name, checksum
  )
  select v_id, b.project_id, b.user_id, p_step_name, p_checksum
  from public.project_managed_backends b
  where b.id = v_id
  on conflict (registry_id, step_name, checksum) do nothing;

  return true;
end;
$$;
revoke all on function public.record_managed_backend_migration(text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_managed_backend_migration(text, timestamptz, uuid, text, text)
  to service_role;
/**
 * ═══ DELIBERATELY UNGUARDED: complete_* and fail_* ══════════════════════════
 *
 * `complete_managed_backend`, `complete_managed_backend_configuration`,
 * `fail_managed_backend` and `fail_managed_backend_configuration` record what
 * ACTUALLY HAPPENED. Blocking them would not undo a committed schema; it would
 * leave a row stuck in `configuring` with an expired lease, which the next claim
 * would resume and re-fail forever. Recording reality is not an authorization
 * decision, so these keep their migration 30/35 bodies unchanged.
 */

-- ── 5. Schema marker ────────────────────────────────────────────────────────

create or replace function public.managed_backend_schema_version()
returns integer
language sql
stable
as $$ select 38 $$;
comment on function public.managed_backend_schema_version() is
  'Schema marker 38: enrollment backfill, coverage reporting, strict authorization switch and strict-aware provisioning gates.';
revoke all on function public.managed_backend_schema_version() from public;
revoke all on function public.managed_backend_schema_version() from anon;
grant execute on function public.managed_backend_schema_version()
  to authenticated, service_role;
commit;
