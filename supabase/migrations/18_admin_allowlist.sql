-- Mavly — admin allowlist: one verified email, one database-side authority
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- `/adminsh/auth` and `/adminsh/dashboard` currently have NO database-backed
-- authorization: the sign-in button is a local `setTimeout` and the dashboard
-- is a static mock. This migration adds only the database half of a real gate.
--
-- It does NOT change any page, route, API handler, OAuth flow or environment.
-- Until the application calls `public.current_user_is_admin()` server-side, the
-- admin pages remain unguarded. This file makes a correct guard POSSIBLE; it
-- does not install one.
--
-- There is no existing role column, role enum, permissions table or allowlist
-- in this schema (migrations 01–17), so this adds a dedicated allowlist. It is
-- deliberately NOT a flag on `public.profiles`: that table's
-- `profiles_update_own` policy lets any signed-in user UPDATE their own row, so
-- an admin flag stored there would be self-grantable.
--
-- ═══ THE RULE ════════════════════════════════════════════════════════════════
--
--   Exactly one address is authorized:
--
--     aliarmanali5588@gmail.com
--
-- Authority is resolved from the TRUSTED identity in `auth.users` — the row
-- that Supabase Auth itself owns and that `auth.uid()` points at — never from
-- a request body, a cookie, `raw_user_meta_data` / `raw_app_meta_data`, an
-- `app_metadata.role` claim, or anything the browser can write.
--
-- ═══ PREREQUISITE (operator action, not performed here) ══════════════════════
--
-- The authorized address must already exist in Supabase Auth AND be confirmed
-- (`auth.users.email_confirmed_at is not null`). This migration creates no
-- fake user, no user id and no password. If the row does not exist yet, this
-- migration still applies cleanly and the function simply returns `false` for
-- everyone until that person signs in and confirms the address.
--
-- Google / GitHub OAuth sign-in sets `email_confirmed_at`, so the normal Mavly
-- OAuth flow satisfies this. Keep the project's "Confirm email" setting enabled
-- in case email/password sign-up is ever turned on; an unconfirmed address must
-- never become an administrator.
--
-- ═══ SECURITY MODEL ══════════════════════════════════════════════════════════
--
--   · `public.admin_allowlist` is deny-by-default: RLS is enabled with NO
--     policies, and anon/authenticated have no table privilege at all. Ordinary
--     users cannot read it, insert themselves into it, or delete the real admin.
--   · Only a verified `auth.users` identity whose normalized email matches the
--     allowlist row qualifies. An allowlist row by itself grants nothing.
--   · `public.current_user_is_admin()` is the single read path. It is
--     `security definer` (the authenticated role cannot read `auth.users`),
--     `stable`, and runs with an EMPTY `search_path`, with every object
--     schema-qualified. It takes no arguments, so a caller cannot ask about
--     somebody else.
--   · The function is executable by `authenticated` and `service_role` only —
--     never by `anon`/PUBLIC. `authenticated` is enough because the check is
--     always about the caller's own session.
--   · RLS is enabled but NOT forced: the definer function must still be able to
--     read the table as its owner. Forcing RLS here would silently pin the
--     function to `false`.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and idempotent. Apply AFTER migration 17. It touches no existing
-- object, relaxes no existing policy, and deletes nothing. Re-running it
-- changes nothing. Apply it yourself; nothing here is applied automatically.
--
-- If the allowlist ever contains an unexpected row, this migration aborts
-- instead of quietly leaving the wrong person authorized (see step 3).

begin;

-- ── 1. The allowlist table ──────────────────────────────────────────────────

create table if not exists public.admin_allowlist (
  -- Normalized (lowercase, trimmed) address. PRIMARY KEY = one row per address.
  email text primary key,
  note text,
  created_at timestamptz not null default now(),

  -- Store only normalized values, so the function's `lower(btrim(...))` can
  -- never miss a row because of casing or stray whitespace.
  constraint admin_allowlist_email_normalized
    check (email = lower(btrim(email))),

  -- A coarse shape check. `auth.users.email` is the real authority; this only
  -- keeps obviously malformed junk out of the list.
  constraint admin_allowlist_email_shape
    check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

comment on table public.admin_allowlist is
  'Deny-by-default admin allowlist. One normalized email per row; a row grants nothing without a matching, confirmed auth.users identity. RLS is enabled with no policies, so only the current_user_is_admin() definer function can read it.';
comment on column public.admin_allowlist.email is
  'Lowercased, trimmed email. Compared against lower(btrim(auth.users.email)) of the caller.';
comment on column public.admin_allowlist.note is
  'Free-text operator note. Never used for authorization.';

-- A second admin row is rejected by the data layer, not just by convention.
-- Product decision: exactly ONE administrator. Adding another requires a new
-- migration that drops this index on purpose.
create unique index if not exists admin_allowlist_singleton
  on public.admin_allowlist ((true));

-- ── 2. The seed ─────────────────────────────────────────────────────────────

-- Untargeted `on conflict` on purpose: it must also absorb a singleton-index
-- collision (an unexpected pre-existing row), so the explicit check in step 3 —
-- not a raw unique-violation error — is what reports the problem.
insert into public.admin_allowlist (email, note)
values ('aliarmanali5588@gmail.com', 'Authorized Mavly administrator.')
on conflict do nothing;

-- ── 3. Fail closed if the list is anything other than the one address ───────

do $$
declare
  c_authorized constant text := 'aliarmanali5588@gmail.com';
  v_emails text[];
begin
  select array_agg(a.email order by a.email)
    into v_emails
  from public.admin_allowlist a;

  if v_emails is distinct from array[c_authorized] then
    raise exception
      'ADMIN_ALLOWLIST_UNEXPECTED: expected exactly [%], found %',
      c_authorized,
      coalesce(v_emails::text, '[]')
      using errcode = '23514';
  end if;
end;
$$;

-- ── 4. Lock the table down ──────────────────────────────────────────────────

alter table public.admin_allowlist enable row level security;

-- RLS enabled + zero policies = no row is visible or writable to a client role.
-- Supabase grants table privileges to anon/authenticated by default, so they
-- must be revoked explicitly; `enable row level security` alone is not enough.
revoke all on table public.admin_allowlist from public;
revoke all on table public.admin_allowlist from anon;
revoke all on table public.admin_allowlist from authenticated;

-- No policy and no grant is created for any client role on purpose. Only the
-- table owner (the role that applied this migration) can read or write it, and
-- the definer function below reads it as that owner.

-- ── 5. The only read path: "is the current session the admin?" ──────────────

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
-- Empty search_path: every reference below is schema-qualified, so a caller
-- cannot shadow `auth`, `public` or any function used here.
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.admin_allowlist a
      on a.email = lower(btrim(u.email))
    where u.id = (select auth.uid())          -- caller's verified identity
      and u.email_confirmed_at is not null     -- address proven, not just typed
      and u.deleted_at is null                 -- not a soft-deleted account
      and (u.banned_until is null or u.banned_until <= now()) -- not banned
  );
$$;

comment on function public.current_user_is_admin() is
  'True only when the CALLER (auth.uid()) is a confirmed, non-deleted, non-banned auth.users row whose normalized email is in public.admin_allowlist. Takes no arguments, so it can never describe another user.';

revoke all on function public.current_user_is_admin() from public;
revoke all on function public.current_user_is_admin() from anon;
grant execute on function public.current_user_is_admin() to authenticated;
grant execute on function public.current_user_is_admin() to service_role;

-- ── 6. Schema marker / preflight ────────────────────────────────────────────

create or replace function public.admin_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 18;
$$;

revoke all on function public.admin_schema_version() from public;
revoke all on function public.admin_schema_version() from anon;
grant execute on function public.admin_schema_version() to authenticated, service_role;

comment on function public.admin_schema_version() is
  'Admin allowlist schema marker. 18 means the allowlist and current_user_is_admin() are installed.';

commit;

-- ═══ OPERATOR NOTES (not executed) ═══════════════════════════════════════════
--
-- 1. Confirm the authorized identity exists and is confirmed:
--
--      select id, email, email_confirmed_at, deleted_at, banned_until
--      from auth.users
--      where lower(btrim(email)) = 'aliarmanali5588@gmail.com';
--
--    `email_confirmed_at` must be non-null. If this returns no row, that person
--    has not signed in yet — do not hand-insert an auth user.
--
-- 2. Prove the allowlist can never hold a second address:
--
--      select email from public.admin_allowlist;           -- exactly one row
--      insert into public.admin_allowlist (email)
--      values ('someone@else.test');                       -- must FAIL
--
-- 3. Prove a client cannot read or write it. With the anon or authenticated
--    role (`set role authenticated;` in the SQL editor), both must fail:
--
--      select * from public.admin_allowlist;
--      insert into public.admin_allowlist (email) values ('x@y.test');
--
-- 4. From a signed-in session, the only meaningful check is:
--
--      select public.current_user_is_admin();
--
--    It is true for the authorized, confirmed account and false for everyone
--    else, including anon.
--
-- 5. NOT covered here: `/adminsh/*` pages, middleware and API routes stay
--    unguarded until application code calls this function server-side (and
--    `/api/*` enforcement uses it too). A migration cannot protect a page.
