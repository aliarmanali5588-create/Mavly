-- Mavly — GitHub integration
--
-- Three tables:
--   · github_connections            — one OAuth connection per Mavly user. The
--                                     tokens are ciphertext; the columns say
--                                     so.
--   · github_oauth_states           — the short-lived, single-use state rows of
--                                     the authorization-code + PKCE flow.
--   · github_repository_connections — which repository and branch a Mavly
--                                     project is connected to.
--
-- ⚠️ NOTHING HERE IS A CREDENTIAL IN PLAINTEXT. The access token and the
-- refresh token are encrypted by the server before they reach these tables.
--
-- ⚠️ THE REPOSITORY CONNECTION IS SCOPED TO A PROJECT, NOT TO A NAME. The
-- GitHub repository id (a number that never changes) is the identity; the
-- owner/name pair is kept for display and for building URLs.
--
-- Additive and idempotent. It does not change public.projects, the
-- authentication flow, or the existing project id shape.

-- ── The user's GitHub connection ───────────────────────────────────────────

create table if not exists public.github_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  granted_scope text,
  github_user_id bigint,
  github_login text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.github_connections is
  'One GitHub App authorization per Mavly user. The tokens are ciphertext; the encryption key is server-only.';
comment on column public.github_connections.access_token_ciphertext is
  'AES-256-GCM ciphertext. Never expose or log this value.';
comment on column public.github_connections.github_user_id is
  'The immutable numeric GitHub user id of the authorized account.';

alter table public.github_connections enable row level security;

drop policy if exists "github_connections_select_own" on public.github_connections;
create policy "github_connections_select_own"
  on public.github_connections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "github_connections_insert_own" on public.github_connections;
create policy "github_connections_insert_own"
  on public.github_connections
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "github_connections_update_own" on public.github_connections;
create policy "github_connections_update_own"
  on public.github_connections
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "github_connections_delete_own" on public.github_connections;
create policy "github_connections_delete_own"
  on public.github_connections
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.github_connections from anon;
grant select, insert, update, delete on public.github_connections to authenticated;

-- ── OAuth flow state ────────────────────────────────────────────────────────
--
-- The browser receives an unpredictable state value. Only its SHA-256 hash is
-- stored, and the PKCE code verifier is encrypted. A row is consumed with a
-- single DELETE ... RETURNING, so a replayed callback finds nothing.

create table if not exists public.github_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  code_verifier_ciphertext text not null,
  return_to text not null default '/dashboard',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

comment on table public.github_oauth_states is
  'Short-lived, single-use GitHub OAuth PKCE state. Rows are deleted when the callback consumes them.';

create index if not exists github_oauth_states_user_id_idx
  on public.github_oauth_states (user_id);
create index if not exists github_oauth_states_expires_at_idx
  on public.github_oauth_states (expires_at);

alter table public.github_oauth_states enable row level security;

drop policy if exists "github_oauth_states_select_own" on public.github_oauth_states;
create policy "github_oauth_states_select_own"
  on public.github_oauth_states
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "github_oauth_states_insert_own" on public.github_oauth_states;
create policy "github_oauth_states_insert_own"
  on public.github_oauth_states
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "github_oauth_states_delete_own" on public.github_oauth_states;
create policy "github_oauth_states_delete_own"
  on public.github_oauth_states
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.github_oauth_states from anon;
grant select, insert, delete on public.github_oauth_states to authenticated;

-- ── The project's connected repository ──────────────────────────────────────

create table if not exists public.github_repository_connections (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  /** GitHub's immutable numeric repository id. The identity. */
  repository_id bigint not null,
  owner_login text not null,
  owner_type text not null default 'User',
  repository_name text not null,
  repository_full_name text not null,
  default_branch text not null default 'main',
  /** The branch Mavly pushes to and imports from. */
  branch text not null,
  /** The commit of the branch Mavly last synced with. */
  last_synced_commit_sha text,
  /** The commit Mavly last created on that branch. */
  last_pushed_commit_sha text,
  last_pushed_at timestamptz,
  /** The paths Mavly pushed last time — the only ones it may delete. */
  last_pushed_paths jsonb not null default '[]'::jsonb,
  sync_status text not null default 'connected'
    check (sync_status in ('connected', 'pushing', 'conflict', 'error')),
  sync_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id)
);

comment on table public.github_repository_connections is
  'The GitHub repository and branch one Mavly project is connected to. One row per project.';
comment on column public.github_repository_connections.last_pushed_paths is
  'The paths Mavly pushed last time. Only these may be removed by a later push.';
comment on column public.github_repository_connections.sync_status is
  'A safe summary of the last synchronization: connected, pushing, conflict or error.';

create index if not exists github_repository_connections_user_idx
  on public.github_repository_connections (user_id);
create index if not exists github_repository_connections_repository_idx
  on public.github_repository_connections (repository_id);

alter table public.github_repository_connections enable row level security;

-- ⚠️ THE PROJECT ROW IS PART OF THE POLICY, NOT JUST THE USER. A connection
-- row is only visible when the caller owns the project it points at, so a
-- repository connection cannot outlive or cross a project's ownership.

drop policy if exists "github_repository_connections_select_own" on public.github_repository_connections;
create policy "github_repository_connections_select_own"
  on public.github_repository_connections
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = github_repository_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "github_repository_connections_insert_own" on public.github_repository_connections;
create policy "github_repository_connections_insert_own"
  on public.github_repository_connections
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = github_repository_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "github_repository_connections_update_own" on public.github_repository_connections;
create policy "github_repository_connections_update_own"
  on public.github_repository_connections
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = github_repository_connections.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = github_repository_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "github_repository_connections_delete_own" on public.github_repository_connections;
create policy "github_repository_connections_delete_own"
  on public.github_repository_connections
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = github_repository_connections.project_id
        and p.user_id = (select auth.uid())
    )
  );

revoke all on public.github_repository_connections from anon;
grant select, insert, update, delete on public.github_repository_connections to authenticated;
