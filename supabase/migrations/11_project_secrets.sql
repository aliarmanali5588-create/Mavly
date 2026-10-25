-- Mavly — project secrets
--
-- One row per write-only secret for a project and environment. VALUES ARE
-- CIPHERTEXT produced by the server with AES-256-GCM; the key lives only in the
-- server environment (MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY). No plaintext value
-- is stored, returned by a list endpoint, or exposed to the browser.
--
-- Access rules:
--   * RLS is enabled and every policy requires both the owning user and an owned
--     public.projects row.
--   * anon gets nothing.
--   * The authenticated role may SELECT metadata columns but NOT
--     value_ciphertext, and may UPDATE only the mutable columns.
--   * There is no "read value" path in the application. A value can be replaced
--     but never retrieved.
--
-- ⚠️ This migration does not inject secrets into generated sites. Mavly
-- publishes static files and does not execute generated server code.
--
-- Additive and idempotent.

create table if not exists public.project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  secret_name text not null,
  environment text not null,
  value_ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_secrets_name_format check (
    char_length(secret_name) between 1 and 128
    and secret_name ~ '^[A-Za-z_][A-Za-z0-9_]*$'
  ),
  constraint project_secrets_environment_allowed check (
    environment in ('development', 'production', 'both')
  )
);

comment on table public.project_secrets is
  'Write-only project secrets. Values are AES-256-GCM ciphertext; the key is server-only.';
comment on column public.project_secrets.value_ciphertext is
  'Authenticated ciphertext bound to this row, project and user. Never return or log this value.';
comment on column public.project_secrets.environment is
  'development, production or both. Stored separation only; values are not injected into generated sites.';

-- A project cannot have two rows with the same name in the same environment.
-- The same name may exist separately for development and production.
create unique index if not exists project_secrets_name_environment_key
  on public.project_secrets (project_id, secret_name, environment);

create index if not exists project_secrets_project_id_idx
  on public.project_secrets (project_id);
create index if not exists project_secrets_user_id_idx
  on public.project_secrets (user_id);

alter table public.project_secrets enable row level security;

drop policy if exists "project_secrets_select_own" on public.project_secrets;
create policy "project_secrets_select_own"
  on public.project_secrets
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_secrets.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_secrets_insert_own" on public.project_secrets;
create policy "project_secrets_insert_own"
  on public.project_secrets
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_secrets.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_secrets_update_own" on public.project_secrets;
create policy "project_secrets_update_own"
  on public.project_secrets
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_secrets.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_secrets.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_secrets_delete_own" on public.project_secrets;
create policy "project_secrets_delete_own"
  on public.project_secrets
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_secrets.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- ── Least privilege ─────────────────────────────────────────────────────────
-- Table-level SELECT is revoked and replaced with a metadata-only column grant,
-- so the authenticated role cannot read ciphertext even by querying PostgREST
-- directly. Inserts accept ciphertext; updates can change only mutable columns.

revoke all on public.project_secrets from public;
revoke all on public.project_secrets from anon;
revoke all on public.project_secrets from authenticated;

grant select (id, project_id, user_id, secret_name, environment, created_at, updated_at)
  on public.project_secrets to authenticated;
grant insert (id, project_id, user_id, secret_name, environment, value_ciphertext, created_at, updated_at)
  on public.project_secrets to authenticated;
grant update (secret_name, environment, value_ciphertext, updated_at)
  on public.project_secrets to authenticated;
grant delete on public.project_secrets to authenticated;
