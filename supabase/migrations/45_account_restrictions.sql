-- ═══════════════════════════════════════════════════════════════════════════
-- 45_account_restrictions.sql — auditable admin account block / unblock
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADDITIVE AND NON-DESTRUCTIVE. Apply after 44. It creates one new table, one
-- new read function and one schema marker. It alters no existing table, drops
-- nothing, and touches no customer project, credit, payment or generation row.
--
-- ═══ WHY A NEW TABLE IS REQUIRED ═══
--
-- Supabase Auth already stores the ENFORCED state: `auth.users.banned_until`.
-- That is the single source of truth for "may this account sign in", and this
-- migration deliberately does not duplicate it — there is no second
-- `is_blocked` column anywhere, because two status systems drift apart.
--
-- What `auth.users` cannot answer is WHO restricted the account, WHY, and WHEN,
-- and what the previous state was. That history is what an audit trail is for,
-- and nothing in migrations 01–44 records it. This table holds only that
-- history; it is never the authority on whether an account is blocked.
--
-- ═══ WHAT THIS DOES NOT DO ═══
--
--   · It does not ban or unban anyone. The server route performs the Supabase
--     Auth admin call and then records the event here.
--   · It does not store a password, token, secret or service-role key.
--   · It does not delete or alter any customer data on block OR unblock.
--   · It grants no new privilege to `anon` or `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Append-only restriction audit trail ─────────────────────────────────

create table if not exists public.account_restriction_events (
  id uuid primary key default gen_random_uuid(),

  /** The account that was blocked or unblocked. */
  target_user_id uuid not null references auth.users (id) on delete cascade,

  /** The administrator who performed the action. Never client-supplied. */
  actor_user_id uuid not null references auth.users (id) on delete cascade,
  /** The actor's email at the time of the action, for a readable audit trail. */
  actor_email text,

  /** 'blocked' or 'unblocked'. */
  action text not null check (action in ('blocked', 'unblocked')),

  /**
   * The operator-supplied reason. Kept because the blocked user may be shown it
   * and because an auditor will ask. Bounded so it cannot be used as storage.
   */
  reason text check (reason is null or char_length(reason) <= 500),

  /**
   * The enforced state BEFORE this action, copied from auth.users.banned_until.
   * `null` means the account was not restricted. Recorded so a reviewer can
   * reconstruct the sequence without replaying every row.
   */
  previous_banned_until timestamptz,
  /** The enforced state AFTER this action. */
  resulting_banned_until timestamptz,

  created_at timestamptz not null default now()
);

comment on table public.account_restriction_events is
  'Append-only audit trail for administrator account block/unblock actions. The ENFORCED state lives in auth.users.banned_until; this table records who changed it, why and when. Rows are never updated or deleted by the application.';

comment on column public.account_restriction_events.previous_banned_until is
  'auth.users.banned_until as it was before this action. NULL means the account was unrestricted at that moment.';

create index if not exists account_restriction_events_target_idx
  on public.account_restriction_events (target_user_id, created_at desc);

create index if not exists account_restriction_events_created_idx
  on public.account_restriction_events (created_at desc);

-- ── 2. RLS: readable by admins only, writable by nobody ────────────────────
--
-- The application writes this table through the service-role client inside the
-- server route, which bypasses RLS by design. There is deliberately NO insert,
-- update or delete policy: an authenticated session can never forge or erase an
-- audit record, not even an admin's.

alter table public.account_restriction_events enable row level security;

drop policy if exists "account_restriction_events_admin_select"
  on public.account_restriction_events;
create policy "account_restriction_events_admin_select"
  on public.account_restriction_events
  for select
  to authenticated
  using (public.current_user_is_admin());

revoke all on table public.account_restriction_events from public, anon;
grant select on table public.account_restriction_events to authenticated;

-- ── 3. The enforcement read path ───────────────────────────────────────────
--
-- ⚠️ THIS IS THE FUNCTION THE APPLICATION CALLS ON EVERY PROTECTED REQUEST.
--
-- It answers one question about the CALLER only: "is my own account currently
-- restricted?" It takes no argument, so it can never be used to inspect another
-- account — the same shape as `current_user_is_admin()`.
--
-- It reads `auth.users.banned_until`, which is the state Supabase Auth itself
-- enforces. That is what makes an ALREADY-ISSUED access token stoppable: the
-- token stays cryptographically valid until it expires, but every protected
-- request asks this function, and the answer changes the moment an admin blocks
-- the account. No cached client-side flag is trusted.

create or replace function public.current_user_is_restricted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = (select auth.uid())
      and u.banned_until is not null
      and u.banned_until > now()
  );
$$;

comment on function public.current_user_is_restricted() is
  'True only when the CALLER (auth.uid()) has an active ban in auth.users. Takes no arguments, so it can never describe another user. Used to stop already-issued access tokens from reaching protected routes.';

revoke all on function public.current_user_is_restricted() from public;
revoke all on function public.current_user_is_restricted() from anon;
grant execute on function public.current_user_is_restricted() to authenticated;
grant execute on function public.current_user_is_restricted() to service_role;

-- ── 4. Schema marker / preflight ───────────────────────────────────────────

create or replace function public.account_restriction_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 45;
$$;

revoke all on function public.account_restriction_schema_version() from public;
revoke all on function public.account_restriction_schema_version() from anon;
grant execute on function public.account_restriction_schema_version()
  to authenticated, service_role;

comment on function public.account_restriction_schema_version() is
  'Account restriction schema marker. 45 means the audit table and current_user_is_restricted() are installed.';

commit;
