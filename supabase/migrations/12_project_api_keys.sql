-- Mavly — project API keys
--
-- Project-scoped API keys for authenticating requests to project APIs.
-- Keys are hashed server-side (SHA-256); plaintext returned only once on creation/rotation.
-- RLS requires ownership through public.projects.
--
-- Additive and idempotent.

create table if not exists public.project_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  key_last4 text not null,
  scopes jsonb not null default '[]'::jsonb,
  env text not null check (env in ('live', 'dev', 'both')),
  managed text check (managed in ('app', 'env')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

comment on table public.project_api_keys is
  'Hashed project API keys. Plaintext never stored; shown once on create/rotate.';
comment on column public.project_api_keys.key_hash is
  'SHA-256 hex digest of the plaintext key. Never return to clients.';
comment on column public.project_api_keys.managed is
  'If set, this is a system-managed key (app/env).';

create unique index if not exists project_api_keys_hash_key
  on public.project_api_keys (key_hash);

create index if not exists project_api_keys_project_id_idx
  on public.project_api_keys (project_id);
create index if not exists project_api_keys_user_id_idx
  on public.project_api_keys (user_id);

alter table public.project_api_keys enable row level security;

drop policy if exists "project_api_keys_select_own" on public.project_api_keys;
create policy "project_api_keys_select_own"
  on public.project_api_keys
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_api_keys.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_api_keys_insert_own" on public.project_api_keys;
create policy "project_api_keys_insert_own"
  on public.project_api_keys
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_api_keys.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_api_keys_update_own" on public.project_api_keys;
create policy "project_api_keys_update_own"
  on public.project_api_keys
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_api_keys.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_api_keys.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_api_keys_delete_own" on public.project_api_keys;
create policy "project_api_keys_delete_own"
  on public.project_api_keys
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_api_keys.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.project_api_keys from anon;
revoke all on public.project_api_keys from authenticated;

grant select (id, project_id, user_id, name, key_prefix, key_last4, scopes, env, managed, created_at, last_used_at, revoked_at)
  on public.project_api_keys to authenticated;
grant insert (id, project_id, user_id, name, key_prefix, key_hash, key_last4, scopes, env, managed, created_at, last_used_at, revoked_at)
  on public.project_api_keys to authenticated;
grant update (name, scopes, env, revoked_at, last_used_at)
  on public.project_api_keys to authenticated;
grant delete on public.project_api_keys to authenticated;
