-- Mavly — Supabase OAuth: server-side selection session + audit owner authorization.
--
-- ═══ WHY THIS MIGRATION EXISTS ══════════════════════════════════════════════
--
-- Two gaps were left after migration 42.
--
-- 1. THE SELECTION STEP HAD NO SERVER-SIDE SESSION. Migration 42 (and the
--    callback change beside it) removed project refs and names from the callback
--    query string, which was the actual leak. But the picker then asked the
--    server for a list and posted back a bare ref, so "which connection is this
--    selection for" was implied by the Mavly project id alone. A short-lived,
--    single-use session makes that binding explicit: it names the authenticated
--    user AND the OAuth connection, expires in minutes, and is consumed by the
--    selection it authorizes.
--
-- 2. MIGRATION 42 MADE THE AUDIT WRITE PATH SERVICE-ROLE ONLY, WHICH THE
--    APPLICATION DOES NOT HAVE. `AGENTS.md` confines the service-role client to
--    the worker and trusted entrypoints, and the broker runs under the caller's
--    session client. The result was that every audit row failed to write and the
--    trail went missing rather than forged — better than forgeable, but still
--    not a trail.
--
--    This migration keeps the table append-only and server-authored, and adds ONE
--    narrow owner path: an authenticated caller may append an audit row only for
--    a project they own, and only with an action name from the broker's closed
--    action set. That closes cross-account forgery and arbitrary-action forgery.
--    It does NOT make the trail tamper-proof against the project's own owner
--    (see the residual risk note at the bottom).
--
-- ⚠️ ADDITIVE AND NON-DESTRUCTIVE. No column is dropped or retyped, no row is
-- deleted, and migrations 40/41/42 objects are preserved. Migration 42's
-- `record_supabase_oauth_audit_server` is replaced with a compatible signature,
-- so a deployment that has not yet applied this migration keeps working.
--
-- Apply after 42.

begin;

-- ── 1. The selection session ───────────────────────────────────────────────

/**
 * A short-lived, single-use authorization to finish a Supabase connection.
 *
 * ⚠️ IT IS BOUND TO BOTH THE USER AND THE CONNECTION. `user_id` is taken from
 * `auth.uid()` at creation, never from the caller, and `mavly_project_id` must
 * already have a connection row. A session for project A cannot authorize a
 * selection for project B, and it cannot be used by another account.
 *
 * ⚠️ IT CARRIES NO PROJECT DATA. No ref, no name, no token — only the Mavly
 * project id it belongs to. The project list is still derived server-side from
 * the encrypted token on every request, so this table is not a cache of customer
 * identifiers.
 */
create table if not exists public.supabase_oauth_selection_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mavly_project_id text not null references public.projects (project_id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Short on purpose: long enough to render a picker and choose, short enough
  -- that a leaked id is worthless.
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);

comment on table public.supabase_oauth_selection_sessions is
  'Short-lived single-use authorization to finish a Supabase project selection. Bound to (user, Mavly project); carries no project ref, name or token.';

create index if not exists supabase_oauth_selection_sessions_expiry_idx
  on public.supabase_oauth_selection_sessions (expires_at);

alter table public.supabase_oauth_selection_sessions enable row level security;

/**
 * ⚠️ NO DIRECT TABLE ACCESS AT ALL — not even SELECT. Every read and write goes
 * through the fenced RPCs below, so a session cannot be enumerated, extended or
 * forged with a table grant.
 */
revoke all on public.supabase_oauth_selection_sessions
  from public, anon, authenticated;

/** Open a selection session for a project the caller owns and has a connection for. */
create or replace function public.open_supabase_oauth_selection(p_mavly_project_id text)
returns table (selection_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_expires timestamptz;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  /**
   * ⚠️ A SESSION REQUIRES A CONNECTION ROW. Opening one for a project that never
   * started the OAuth flow would hand out an authorization to select a project
   * with no token behind it.
   */
  if not exists (
    select 1 from public.supabase_oauth_connections c
     where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id
  ) then
    raise exception using errcode = 'P0002', message = 'connection not found';
  end if;

  /**
   * Expired and consumed sessions are pruned opportunistically. They hold no
   * secret, so this is housekeeping, not a security control.
   */
  delete from public.supabase_oauth_selection_sessions s
   where s.user_id = v_user
     and (s.expires_at <= now() or s.consumed_at is not null);

  insert into public.supabase_oauth_selection_sessions (user_id, mavly_project_id)
  values (v_user, p_mavly_project_id)
  returning id, supabase_oauth_selection_sessions.expires_at into v_id, v_expires;

  return query select v_id, v_expires;
end;
$$;
revoke all on function public.open_supabase_oauth_selection(text)
  from public, anon;
grant execute on function public.open_supabase_oauth_selection(text)
  to authenticated;

/**
 * Is this session valid for this user and project? Read-only, and it does NOT
 * consume: the picker may be re-rendered before the user chooses.
 */
create or replace function public.check_supabase_oauth_selection(
  p_selection_id uuid,
  p_mavly_project_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  return exists (
    select 1 from public.supabase_oauth_selection_sessions s
     where s.id = p_selection_id
       and s.user_id = v_user
       and s.mavly_project_id = p_mavly_project_id
       and s.consumed_at is null
       and s.expires_at > now()
  );
end;
$$;
revoke all on function public.check_supabase_oauth_selection(uuid, text)
  from public, anon;
grant execute on function public.check_supabase_oauth_selection(uuid, text)
  to authenticated;

/**
 * Consume a session. Delete-returning so a replayed id finds nothing: the
 * selection it authorized can happen exactly once.
 */
create or replace function public.consume_supabase_oauth_selection(
  p_selection_id uuid,
  p_mavly_project_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_deleted integer;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  delete from public.supabase_oauth_selection_sessions s
   where s.id = p_selection_id
     and s.user_id = v_user
     and s.mavly_project_id = p_mavly_project_id
     and s.consumed_at is null
     and s.expires_at > now();

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;
revoke all on function public.consume_supabase_oauth_selection(uuid, text)
  from public, anon;
grant execute on function public.consume_supabase_oauth_selection(uuid, text)
  to authenticated;

-- ── 2. Audit write: keep it append-only, add a narrow owner path ───────────

/**
 * Append an audit row.
 *
 * ⚠️ TWO CALLERS, TWO RULES.
 *
 *   · `service_role` (the trusted server path) may append for any project. The
 *     owner is still derived from the project, never passed in.
 *   · `authenticated` may append ONLY for a project it owns. That is what makes
 *     the broker's session-client path work at all — and it is strictly narrower
 *     than migration 40's version, which let any authenticated caller write for
 *     any project they owned with any action name they liked.
 *
 * ⚠️ THE ACTION NAME IS CONSTRAINED TO THE BROKER'S CLOSED SET. A caller cannot
 * invent an action Mavly never performs, so the trail cannot be padded with
 * fabricated operations. `unknown` exists only for a refused action that failed
 * the allowlist check.
 *
 * ⚠️ THE OUTCOME IS STILL CALLER-ASSERTED. This function cannot know whether the
 * action really ran; it records what the server path reported. See the residual
 * risk note at the bottom of this file.
 *
 * ⚠️ METADATA IS COUNTS AND IDENTIFIERS ONLY, AND BOUNDED. A caller cannot park a
 * statement or a result set in a column the owner can read.
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
  v_caller uuid := auth.uid();
  v_role text := current_setting('request.jwt.claim.role', true);
begin
  if p_mavly_project_id is null or length(p_mavly_project_id) = 0 then
    raise exception using errcode = '22023', message = 'project id required';
  end if;
  if p_action is null
     or p_action not in (
       'list_organizations', 'list_projects', 'read_project_config',
       'read_schema', 'list_edge_functions', 'run_sql', 'unknown'
     ) then
    raise exception using errcode = '22023', message = 'invalid action';
  end if;
  if p_outcome is null
     or p_outcome not in ('allowed', 'refused', 'failed', 'pending_approval') then
    raise exception using errcode = '22023', message = 'invalid outcome';
  end if;
  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception using errcode = '22023', message = 'metadata must be an object';
  end if;
  if p_metadata is not null and length(p_metadata::text) > 2000 then
    raise exception using errcode = '22023', message = 'metadata too large';
  end if;

  select p.user_id into v_owner
    from public.projects p
   where p.project_id = p_mavly_project_id;

  if v_owner is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;

  /**
   * ⚠️ THE OWNER PATH IS EXPLICIT, NOT IMPLIED. A service-role call carries no
   * end-user identity, so it is recognized by its JWT role rather than by a null
   * `auth.uid()`. Everything else must be the project's owner.
   */
  if v_role is distinct from 'service_role' then
    if v_caller is null then
      raise exception using errcode = '42501', message = 'authentication required';
    end if;
    if v_owner <> v_caller then
      raise exception using errcode = '42501', message = 'project owner mismatch';
    end if;
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
  from public, anon;
grant execute on function public.record_supabase_oauth_audit_server(text, text, text, text, text, jsonb)
  to authenticated, service_role;

/**
 * ⚠️ THE APPEND-ONLY TRIGGERS FROM MIGRATION 42 ARE RE-ASSERTED HERE. Replacing
 * the function above does not touch them, but this migration is the one that
 * re-opens an owner write path, so it re-proves the guard is still installed.
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

-- ── 3. Schema marker ───────────────────────────────────────────────────────

/**
 * Lets the application detect that this hardening is installed. Bumped to 3 so a
 * deployment can tell 42 (service-role-only audit) from 43 (owner path + session).
 */
create or replace function public.supabase_oauth_audit_schema_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select 3;
$$;
revoke all on function public.supabase_oauth_audit_schema_version()
  from public, anon;
grant execute on function public.supabase_oauth_audit_schema_version()
  to authenticated, service_role;

comment on function public.record_supabase_oauth_audit_server(text, text, text, text, text, jsonb) is
  'Append-only, secret-free Supabase OAuth audit write. service_role may append for any project; authenticated only for a project it owns. Action names are constrained to the broker action set.';
comment on function public.open_supabase_oauth_selection(text) is
  'Opens a 10-minute single-use selection session bound to (authenticated user, Mavly project). Carries no project ref, name or token.';

commit;

-- ═══ RESIDUAL RISK, STATED PLAINLY ══════════════════════════════════════════
--
-- The owner path means a project's own owner can still append audit rows for
-- their own project claiming an action was `allowed` when it was not. That is a
-- deliberate trade: without it the broker cannot write any audit row at all,
-- because the application has no service-role client on the request path.
--
-- What is closed:
--   · cross-account forgery (owner check against public.projects);
--   · arbitrary action names (closed set);
--   · rewriting or deleting history (triggers, plus no UPDATE/DELETE grant);
--   · smuggling statement text or row values into the trail (object-only,
--     bounded metadata).
--
-- What is not closed: an owner misreporting the OUTCOME of an action on their own
-- project. Closing that fully requires the audit write to move to a service-role
-- client on the request path, which `AGENTS.md` does not currently permit. Until
-- then the trail is evidence of what Mavly *reported*, corroborated by the
-- upstream Supabase logs, not proof on its own.
