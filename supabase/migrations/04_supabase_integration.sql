-- Mavly — user-owned Supabase integration (Phase 1)
--
-- Stores one OAuth connection per Mavly user and the short-lived state rows
-- used by the authorization-code + PKCE flow. The OAuth access and refresh
-- tokens are encrypted by the server before they reach these tables; the
-- column names say ciphertext so a future change cannot mistake them for
-- plaintext. This migration performs no remote Supabase operation.
--
-- Additive and idempotent. It does not change public.projects: a user's
-- external Supabase project ref is intentionally stored separately from the
-- Mavly project_id.

create table if not exists public.supabase_integrations (
  user_id uuid primary key references auth.users (id) on delete cascade,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  access_token_expires_at timestamptz not null,
  selected_project_ref text,
  selected_project_name text,
  selected_organization_id text,
  selected_organization_slug text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.supabase_integrations is
  'One encrypted Supabase OAuth connection per Mavly user. Tokens are ciphertext; the encryption key is server-only.';
comment on column public.supabase_integrations.user_id is
  'The Mavly auth.users.id that owns this connection.';
comment on column public.supabase_integrations.access_token_ciphertext is
  'AES-256-GCM ciphertext. Never expose or log this value.';
comment on column public.supabase_integrations.selected_project_ref is
  'A Supabase project ref selected by the user. It is NOT a Mavly project_id.';

alter table public.supabase_integrations enable row level security;

drop policy if exists "supabase_integrations_select_own" on public.supabase_integrations;
create policy "supabase_integrations_select_own"
  on public.supabase_integrations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "supabase_integrations_insert_own" on public.supabase_integrations;
create policy "supabase_integrations_insert_own"
  on public.supabase_integrations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "supabase_integrations_update_own" on public.supabase_integrations;
create policy "supabase_integrations_update_own"
  on public.supabase_integrations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "supabase_integrations_delete_own" on public.supabase_integrations;
create policy "supabase_integrations_delete_own"
  on public.supabase_integrations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Anon has no policy and no grant: the browser never needs these rows.
revoke all on public.supabase_integrations from anon;
grant select, insert, update, delete on public.supabase_integrations to authenticated;

-- ── OAuth flow state ────────────────────────────────────────────────────────
--
-- The browser receives an unpredictable state value. Only its SHA-256 hash is
-- stored, and the PKCE code verifier is encrypted. A row is consumed with a
-- single DELETE ... RETURNING, so a replayed callback finds nothing.

create table if not exists public.supabase_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  code_verifier_ciphertext text not null,
  return_to text not null default '/dashboard',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

comment on table public.supabase_oauth_states is
  'Short-lived, single-use Supabase OAuth PKCE state. Rows are deleted when the callback consumes them.';

create index if not exists supabase_oauth_states_user_id_idx
  on public.supabase_oauth_states (user_id);
create index if not exists supabase_oauth_states_expires_at_idx
  on public.supabase_oauth_states (expires_at);

alter table public.supabase_oauth_states enable row level security;

drop policy if exists "supabase_oauth_states_select_own" on public.supabase_oauth_states;
create policy "supabase_oauth_states_select_own"
  on public.supabase_oauth_states
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "supabase_oauth_states_insert_own" on public.supabase_oauth_states;
create policy "supabase_oauth_states_insert_own"
  on public.supabase_oauth_states
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "supabase_oauth_states_delete_own" on public.supabase_oauth_states;
create policy "supabase_oauth_states_delete_own"
  on public.supabase_oauth_states
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.supabase_oauth_states from anon;
grant select, insert, delete on public.supabase_oauth_states to authenticated;
