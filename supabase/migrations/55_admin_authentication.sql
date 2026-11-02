-- Mavly — strict admin identity registry and bounded admin sessions.
--
-- Additive and non-destructive. Apply after migration 54.
--
-- The existing admin_allowlist remains for compatibility with older deployments,
-- but it is no longer an authority. Admin access is bound to the real Supabase
-- Auth UUID and to a durable, fixed-lifetime admin session below.

begin;

-- ── 1. The administrator registry ───────────────────────────────────────────

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  -- Verified snapshot. The auth.users row remains the live identity authority.
  email text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint admin_users_email_normalized
    check (email = lower(btrim(email))),
  constraint admin_users_email_shape
    check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  -- This deployment intentionally has one explicitly approved administrator.
  -- Changing the approved identity requires a reviewed migration.
  constraint admin_users_approved_email
    check (email = 'aliarmanali5588@gmail.com')
);

create unique index if not exists admin_users_singleton
  on public.admin_users ((true));

comment on table public.admin_users is
  'Server-managed admin registry. A row is valid only for the matching confirmed auth.users UUID and email.';
comment on column public.admin_users.user_id is
  'Primary administrator identity. Never supplied by a browser request.';
comment on column public.admin_users.email is
  'Lowercased verified email snapshot; auth.users.email is checked on every authorization decision.';

alter table public.admin_users enable row level security;
revoke all on table public.admin_users from public, anon, authenticated;

-- ── 2. Durable fixed-lifetime admin sessions ─────────────────────────────────

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Supabase Auth's stable session_id claim, not a browser timestamp or token.
  auth_session_id text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  constraint admin_sessions_expiry_after_creation
    check (expires_at > created_at),
  constraint admin_sessions_auth_session_id_shape
    check (length(auth_session_id) between 8 and 200)
);

create index if not exists admin_sessions_user_idx
  on public.admin_sessions (user_id, expires_at desc);
create index if not exists admin_sessions_active_idx
  on public.admin_sessions (user_id, auth_session_id)
  where revoked_at is null;

comment on table public.admin_sessions is
  'Admin-only session grants. Expiry is anchored to the successful admin authentication and is never extended by refresh activity.';

alter table public.admin_sessions enable row level security;
revoke all on table public.admin_sessions from public, anon, authenticated;

-- ── 3. Safe bootstrap for the one approved identity ─────────────────────────

/**
 * Register the existing confirmed Auth account, if it exists.
 *
 * This never creates an auth.users row and never invents a UUID. The migration
 * also performs this insert immediately, so an already-created approved
 * account is registered during deployment. The service-role-only function is a
 * repeatable operator bootstrap for the case where the legitimate account is
 * confirmed after this migration has already been applied.
 */
create or replace function public.bootstrap_admin_user()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
begin
  select u.*
    into v_user
    from auth.users u
   where lower(btrim(u.email)) = 'aliarmanali5588@gmail.com'
   order by u.created_at asc
   limit 1;

  if not found
     or v_user.email_confirmed_at is null
     or v_user.deleted_at is not null
     or (v_user.banned_until is not null and v_user.banned_until > now()) then
    return false;
  end if;

  insert into public.admin_users (user_id, email, is_active)
  values (v_user.id, lower(btrim(v_user.email)), true)
  on conflict (user_id) do nothing;

  return true;
end;
$$;

revoke all on function public.bootstrap_admin_user() from public, anon, authenticated;
grant execute on function public.bootstrap_admin_user() to service_role;

select public.bootstrap_admin_user();

-- ── 4. Current caller status and session lifecycle ──────────────────────────

/**
 * Return the caller's own admin state. The value contains no email, UUID or
 * registry detail and cannot be used to query another account.
 *
 * `expired` also revokes the expired row. The eight-hour window is deliberately
 * not sliding: `last_seen_at` is telemetry only and never changes expires_at.
 */
create or replace function public.current_user_admin_status()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_session_id text := nullif((select auth.jwt() ->> 'session_id'), '');
  v_is_registered boolean;
  v_has_session boolean;
  v_is_expired boolean;
begin
  if v_user_id is null then
    return 'unauthenticated';
  end if;

  select exists (
    select 1
      from auth.users u
      join public.admin_users a on a.user_id = u.id
     where u.id = v_user_id
       and a.is_active
       and a.email = lower(btrim(u.email))
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  ) into v_is_registered;

  if not v_is_registered then
    update public.admin_sessions
       set revoked_at = coalesce(revoked_at, now())
     where user_id = v_user_id
       and revoked_at is null;
    return 'unauthorized';
  end if;

  if v_auth_session_id is null then
    return 'needs_login';
  end if;

  select exists (
    select 1
      from public.admin_sessions s
     where s.user_id = v_user_id
       and s.auth_session_id = v_auth_session_id
       and s.revoked_at is null
       and s.expires_at > now()
  ) into v_has_session;

  if v_has_session then
    update public.admin_sessions
       set last_seen_at = now()
     where user_id = v_user_id
       and auth_session_id = v_auth_session_id
       and revoked_at is null
       and expires_at > now();
    return 'active';
  end if;

  select exists (
    select 1
      from public.admin_sessions s
     where s.user_id = v_user_id
       and s.auth_session_id = v_auth_session_id
  ) into v_is_expired;

  if v_is_expired then
    update public.admin_sessions
       set revoked_at = coalesce(revoked_at, now())
     where user_id = v_user_id
       and auth_session_id = v_auth_session_id
       and revoked_at is null;
    return 'expired';
  end if;

  return 'needs_login';
end;
$$;

comment on function public.current_user_admin_status() is
  'Returns only the current caller state: unauthenticated, unauthorized, needs_login, active or expired.';

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users u
      join public.admin_users a on a.user_id = u.id
      join public.admin_sessions s
        on s.user_id = u.id
       and s.auth_session_id = nullif((select auth.jwt() ->> 'session_id'), '')
     where u.id = (select auth.uid())
       and a.is_active
       and a.email = lower(btrim(u.email))
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
       and s.revoked_at is null
       and s.expires_at > now()
  );
$$;

comment on function public.current_user_is_admin() is
  'Side-effect-free predicate for stable admin RPCs. True only for the current confirmed Auth UUID in admin_users with an unexpired, unrevoked admin_sessions row.';

/** Start or renew a fixed eight-hour grant after a successful admin login. */
create or replace function public.start_admin_session()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_auth_session_id text := nullif((select auth.jwt() ->> 'session_id'), '');
  v_auth_session_created_at timestamptz;
  v_expires_at timestamptz := now() + interval '8 hours';
begin
  if v_user_id is null or v_auth_session_id is null then
    raise exception 'admin session requires an authenticated Supabase session'
      using errcode = '42501';
  end if;

  select lower(btrim(u.email)) into v_email
    from auth.users u
   where u.id = v_user_id
     and u.email_confirmed_at is not null
     and u.deleted_at is null
     and (u.banned_until is null or u.banned_until <= now());

  if v_email is null or not exists (
    select 1
      from public.admin_users a
     where a.user_id = v_user_id
       and a.email = v_email
       and a.is_active
  ) then
    raise exception 'admin access is not authorized' using errcode = '42501';
  end if;

  /**
   * A refresh token can keep an Auth session alive indefinitely. It may not
   * revive an expired eight-hour admin grant. Supabase stores the creation time
   * of the Auth session separately from token refreshes, so only a genuinely
   * fresh sign-in can start a new admin grant.
   */
  select s.created_at into v_auth_session_created_at
    from auth.sessions s
   where s.id::text = v_auth_session_id
     and s.user_id = v_user_id;

  if v_auth_session_created_at is null
     or v_auth_session_created_at <= now() - interval '10 minutes' then
    raise exception 'fresh admin authentication required' using errcode = '42501';
  end if;

  insert into public.admin_sessions (
    user_id, auth_session_id, created_at, expires_at, revoked_at, last_seen_at
  )
  values (v_user_id, v_auth_session_id, now(), v_expires_at, null, now())
  on conflict (auth_session_id) do update
    set user_id = excluded.user_id,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        revoked_at = null,
        last_seen_at = excluded.last_seen_at;

  return true;
end;
$$;

/** Revoke only the current caller's current admin grant. */
create or replace function public.revoke_current_admin_session()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.admin_sessions
     set revoked_at = coalesce(revoked_at, now())
   where user_id = auth.uid()
     and auth_session_id = nullif((select auth.jwt() ->> 'session_id'), '')
     and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.current_user_admin_status() from public, anon;
grant execute on function public.current_user_admin_status() to authenticated, service_role;
revoke all on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated, service_role;
revoke all on function public.start_admin_session() from public, anon;
grant execute on function public.start_admin_session() to authenticated;
revoke all on function public.revoke_current_admin_session() from public, anon;
grant execute on function public.revoke_current_admin_session() to authenticated;

create or replace function public.admin_auth_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 55;
$$;

revoke all on function public.admin_auth_schema_version() from public, anon;
grant execute on function public.admin_auth_schema_version() to authenticated, service_role;

commit;

-- Operator fallback when the legitimate account was created or confirmed after
-- this migration was applied (run with the Supabase service role only):
--   select public.bootstrap_admin_user();
-- It returns false until the exact approved Auth email exists and is confirmed.
