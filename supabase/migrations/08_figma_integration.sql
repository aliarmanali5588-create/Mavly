-- Mavly — Figma integration
--
-- One row per project whose agent may read Figma designs. The access token is
-- ciphertext produced by the server; the account columns are display metadata
-- returned to the owning browser.
--
-- ⚠️ THE TOKEN IS NEVER PLAINTEXT. The encryption key is
-- MAVLY_INTEGRATION_ENCRYPTION_KEY, which is server-only.
--
-- ⚠️ THE PROJECT ROW IS PART OF THE POLICY, NOT JUST THE USER. A connection is
-- only visible while the caller owns the project it belongs to.
--
-- Additive and idempotent. It does not change public.projects, the
-- authentication flow, or the existing project id shape.

create table if not exists public.figma_connections (
  project_id text primary key references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  access_token_ciphertext text not null,
  account_id text not null,
  account_handle text not null,
  account_email text,
  account_img_url text,
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.figma_connections is
  'One Figma personal access token per Mavly project. The token is ciphertext; the encryption key is server-only.';
comment on column public.figma_connections.access_token_ciphertext is
  'AES-256-GCM ciphertext bound to this project and user. Never expose or log this value.';
comment on column public.figma_connections.account_id is
  'The immutable Figma user id returned by GET /v1/me.';
comment on column public.figma_connections.last_verified_at is
  'The last successful live verification of the token against Figma.';

create index if not exists figma_connections_user_id_idx
  on public.figma_connections (user_id);

alter table public.figma_connections enable row level security;

drop policy if exists "figma_connections_select_own" on public.figma_connections;
create policy "figma_connections_select_own"
  on public.figma_connections
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = figma_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "figma_connections_insert_own" on public.figma_connections;
create policy "figma_connections_insert_own"
  on public.figma_connections
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = figma_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "figma_connections_update_own" on public.figma_connections;
create policy "figma_connections_update_own"
  on public.figma_connections
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = figma_connections.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = figma_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "figma_connections_delete_own" on public.figma_connections;
create policy "figma_connections_delete_own"
  on public.figma_connections
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = figma_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.figma_connections from anon;
grant select, insert, update, delete on public.figma_connections to authenticated;
