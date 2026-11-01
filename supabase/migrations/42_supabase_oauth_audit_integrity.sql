-- Mavly — Supabase OAuth audit integrity hardening.
--
-- ═══ WHY THIS MIGRATION EXISTS ══════════════════════════════════════════════
--
-- Migration 40 shipped `record_supabase_oauth_audit` as an owner-callable
-- SECURITY DEFINER RPC. That made the audit table self-reported: any authenticated
-- owner could insert rows claiming an action was `allowed` or `refused`, and could
-- insert rows for actions Mavly never performed. An audit trail a subject can
-- forge is not an audit trail, and it cannot be used as evidence of what Mavly
-- did with a customer database.
--
-- This migration makes the trail append-only and server-authored:
--
--   1. Direct INSERT/UPDATE/DELETE on the audit table is revoked from every
--      application role. Only the SECURITY DEFINER functions may write.
--   2. The owner-callable write RPC is DROPPED. Nothing in the application
--      calls it any more; the broker records audit rows through the
--      service-role path below.
--   3. A service-role-only `record_supabase_oauth_audit_server` is added for the
--      trusted server path. `AGENTS.md` confines the service-role client to the
--      worker and trusted entrypoints, so this RPC is deliberately NOT granted
--      to `authenticated`.
--   4. UPDATE and DELETE are refused outright, so a row cannot be edited or
--      removed after the fact.
--   5. Owner READ visibility is preserved: a user may still see the audit rows
--      for their own projects, which is what the UI needs.
--
-- ⚠️ ADDITIVE AND NON-DESTRUCTIVE. No column is dropped or retyped, no existing
-- row is deleted, and migration 40's tables and other RPCs are untouched. It is
-- safe to apply while the previous application version is deployed: the old
-- write path stops working, and the new one is available immediately.
--
-- Apply after migration 40 (and after 41, which does not touch these objects).

begin;

-- ── 1. Take direct write access away from every application role ────────────

revoke insert, update, delete, truncate on public.supabase_oauth_audit
  from public, anon, authenticated;

-- Owner read stays. RLS already restricts rows to the owner.
grant select on public.supabase_oauth_audit to authenticated;

-- ── 2. Remove the owner-callable forge path ────────────────────────────────

drop function if exists public.record_supabase_oauth_audit(text, text, text, text, text, jsonb);

-- ── 3. The server-authored append path ─────────────────────────────────────

/**
 * Append an audit row from the trusted server path.
 *
 * ⚠️ SERVICE-ROLE ONLY. The grant below is to `service_role` and nothing else.
 * A browser session cannot call this, which is the whole point: the audit trail
 * records what Mavly did, so only Mavly may write it.
 *
 * ⚠️ THE OWNER IS DERIVED FROM THE PROJECT, NOT PASSED IN. The caller supplies a
 * project id; `user_id` comes from `public.projects`. That means a row can never
 * be attributed to an account that does not own the project.
 *
 * ⚠️ METADATA IS COUNTS AND IDENTIFIERS ONLY. This function does not enforce
 * that (it cannot know), but it does refuse an oversized payload and any
 * metadata that is not a JSON object, so a caller cannot smuggle a statement or
 * a result set into a column the owner can read.
 */
create or replace function public.record_supabase_oauth_audit_server(
  p_mavly_project_id text,
  p_supabase_project_ref text,
  p_action text,
  p_outcome text,
  p_reason_code text,
  p_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_mavly_project_id is null or length(p_mavly_project_id) = 0 then
    raise exception using errcode = '22023', message = 'project id required';
  end if;
  if p_action is null or length(p_action) = 0 or length(p_action) > 64 then
    raise exception using errcode = '22023', message = 'invalid action';
  end if;
  if p_outcome is null
     or p_outcome not in ('allowed', 'refused', 'failed', 'pending_approval') then
    raise exception using errcode = '22023', message = 'invalid outcome';
  end if;
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception using errcode = '22023', message = 'metadata must be an object';
  end if;
  -- Bounded, so a caller cannot park a statement or a result set in the trail.
  if p_metadata is not null and length(p_metadata::text) > 2000 then
    raise exception using errcode = '22023', message = 'metadata too large';
  end if;

  select p.user_id into v_owner
    from public.projects p
   where p.project_id = p_mavly_project_id;

  if v_owner is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;

  insert into public.supabase_oauth_audit (
    user_id, mavly_project_id, supabase_project_ref, action, outcome, reason_code, metadata
  )
  values (
    v_owner,
    p_mavly_project_id,
    p_supabase_project_ref,
    p_action,
    p_outcome,
    left(coalesce(p_reason_code, ''), 64),
    coalesce(p_metadata, '{}'::jsonb)
  );
  return true;
end;
$$;

revoke all on function public.record_supabase_oauth_audit_server(text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_supabase_oauth_audit_server(text, text, text, text, text, jsonb)
  to service_role;

-- ── 4. Append-only at the database level ───────────────────────────────────

/**
 * ⚠️ A TRIGGER, NOT JUST A REVOKE. A future grant or a service-role mistake could
 * re-open UPDATE/DELETE; this refuses the operation regardless of who asks. The
 * audit trail is the one table that must never be rewritten.
 */
create or replace function public.supabase_oauth_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'supabase_oauth_audit is append-only';
end;
$$;

revoke all on function public.supabase_oauth_audit_append_only()
  from public, anon, authenticated;

drop trigger if exists supabase_oauth_audit_no_update on public.supabase_oauth_audit;
create trigger supabase_oauth_audit_no_update
  before update or delete on public.supabase_oauth_audit
  for each row execute function public.supabase_oauth_audit_append_only();

drop trigger if exists supabase_oauth_audit_no_truncate on public.supabase_oauth_audit;
create trigger supabase_oauth_audit_no_truncate
  before truncate on public.supabase_oauth_audit
  for each statement execute function public.supabase_oauth_audit_append_only();

-- ── 5. Schema marker ───────────────────────────────────────────────────────

/**
 * Lets the application detect that this hardening is installed and fail closed
 * with a clear code rather than silently writing an unauthenticated trail.
 */
create or replace function public.supabase_oauth_audit_schema_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select 2;
$$;
revoke all on function public.supabase_oauth_audit_schema_version()
  from public, anon;
grant execute on function public.supabase_oauth_audit_schema_version()
  to authenticated, service_role;

comment on function public.record_supabase_oauth_audit_server(text, text, text, text, text, jsonb) is
  'Service-role-only append of a secret-free Supabase OAuth audit row. Owner is derived from the project, never passed in.';
comment on table public.supabase_oauth_audit is
  'Append-only, secret-free audit of brokered Supabase actions. Written only by the trusted server path; UPDATE, DELETE and TRUNCATE are refused by trigger.';

commit;
