-- Mavly — project ownership (route-hardening phase, step 1 of 5)
--
-- One row per Totalum project this deployment recognises as belonging to ONE
-- signed-in user. This table is the only local answer to "may this user touch
-- this project?": the API key is account-wide, so upstream cannot tell one
-- Mavly user from another (TOTALUM_API_DEPENDENCY_AUDIT.md, F-2).
--
-- Additive and idempotent: safe to apply while the current single-tenant code
-- keeps running, and re-running it changes nothing. It changes NO behaviour by
-- itself — the guards that read it ship in a later phase; until then the table
-- simply exists, empty or backfilled.
--
-- Access rules:
--   * RLS is enabled.
--   * A signed-in user may SELECT, INSERT and DELETE only rows of their own
--     `user_id` — checked against `auth.uid()`, never trusted from the client.
--   * There is NO policy for `anon` and no policy that exposes other rows.
--   * There is no UPDATE policy on purpose: ownership is never transferred.
--
-- Backfill of pre-existing projects is a separate, operator-run template
-- (supabase/backfill-ownership.template.sql) — NOT part of this migration.

create table if not exists public.projects (
  project_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.projects is
  'One row per Totalum project owned by one Mavly user, keyed by the upstream project slug.';
comment on column public.projects.project_id is
  'The upstream VCaaS project slug — the only id used anywhere in this app.';
comment on column public.projects.user_id is
  'The auth.users.id that owns this project. Deleting the user deletes the row.';

-- ── Slug shape ──────────────────────────────────────────────────────────────
--
-- ⚠️ THIS IS NOT THE CREATE-TIME RULE. `validateProjectSlug` (src/lib/project-slug.ts)
-- enforces length 4–35 and the `-dev-` reservation when MINTING a project; real
-- upstream projects exist that violate both (e.g. a 38-character slug, per the
-- module's own docs) and must remain reachable. So the constraint here mirrors
-- only `isRoutableProjectSlug` — the structural path guard: lowercase letter
-- first, then [a-z0-9-], no `--`, no trailing `-`, at most 63 chars — which is
-- what keeps a slug safe to interpolate into an upstream URL.
--
-- ⚠️ Postgres POSIX regex has no lookaround, so the JS
--   /^[a-z]([a-z0-9]|-(?!-))*(?<!-)$/
-- is approximated by `^[a-z]([a-z0-9-]*[a-z0-9])?$` + the `not like '%--%'`.
-- They are equivalent on every input; `tests/ownership-migration.test.ts`
-- cross-checks them on a corpus so a future edit cannot silently diverge.

alter table public.projects drop constraint if exists projects_project_id_format;
alter table public.projects
  add constraint projects_project_id_format check (
    char_length(project_id) between 1 and 63
    and project_id ~ '^[a-z]([a-z0-9-]*[a-z0-9])?$'
    and project_id not like '%--%'
  );

-- ── Row level security ──────────────────────────────────────────────────────
-- Dropped first so the file can be applied twice without failing (same
-- pattern as 01_create_user_profiles.sql).

alter table public.projects enable row level security;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own"
  on public.projects
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own"
  on public.projects
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- No UPDATE policy: with none defined, UPDATE is refused for everyone.
-- No `anon` policy: with none defined, anon sees nothing.

-- ── The ownership check's hot path ──────────────────────────────────────────
-- `enforceProjectScope` will ask "does a row exist for (project_id, this user)?"
-- through the caller's own RLS-scoped client — an empty result means "not the
-- owner". The list filter asks "all project_ids for this user". Both want this
-- index.

create index if not exists projects_user_id_idx on public.projects (user_id);
