-- Mavly — user profiles
--
-- One row per signed-in user, created automatically when the provider
-- (Google / GitHub) creates the matching `auth.users` row.
--
-- Access rules:
--   * RLS is enabled on the table.
--   * A signed-in user may SELECT and UPDATE only their own row.
--   * There is no policy for `anon`, and no policy that exposes other rows.
--
-- The table is deliberately thin. Business data (which Mavly project belongs
-- to which user) is NOT part of this migration — see the note at the bottom.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per Mavly user, keyed by the Supabase auth user id.';

alter table public.profiles enable row level security;

-- ── Policies ────────────────────────────────────────────────────────────────
-- Dropped first so the file can be applied twice without failing.

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ── Keep updated_at honest ──────────────────────────────────────────────────

create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_profiles_updated_at on public.profiles;
create trigger on_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_profiles_updated_at();

-- ── Create the profile when the user signs up ───────────────────────────────
--
-- `security definer` + a fixed `search_path` + fully qualified names: the
-- function may only ever insert the row of the user that was just created.
-- The insert is conflict-safe, so re-running it never creates a duplicate.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    nullif(
      coalesce(
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name'
      ),
      ''
    ),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- NEXT PHASE (not implemented here): project ownership.
--
-- The API key in this app is account-wide, so every project the key owns is
-- currently visible to every caller. Making projects belong to a user needs
-- a second table (for example `public.projects` with an `owner_id` column
-- pointing at `auth.users.id`), a backfill of the existing projects, and
-- ownership checks on every project-scoped API route. That work belongs to
-- the route-hardening phase, not to this authentication migration.
-- ─────────────────────────────────────────────────────────────────────────────
