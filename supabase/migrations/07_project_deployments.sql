-- Mavly — Mavly-managed Vercel deployments
--
-- One row per Mavly project. It maps the project to the Vercel project Mavly
-- created for it and records the latest deployment so the workspace can show a
-- truthful publish state after a reload.
--
-- The row stores identifiers and status only. It never stores a Vercel token:
-- the operator credential is server-only environment configuration. Generated
-- source remains in public.project_files; only the standalone preview is sent
-- to Vercel today.
--
-- Additive and idempotent. Deleting a Mavly project cascades this row; the
-- server also attempts a best-effort Vercel project deletion.

create table if not exists public.project_deployments (
  project_id text primary key references public.projects (project_id) on delete cascade,
  provider text not null default 'vercel' check (provider in ('vercel')),
  vercel_project_id text,
  vercel_project_name text not null,
  vercel_deployment_id text,
  status text not null default 'queued'
    check (status in ('queued', 'building', 'ready', 'error', 'canceled')),
  url text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_published_at timestamptz
);

comment on table public.project_deployments is
  'Latest Mavly-managed Vercel deployment for one Mavly project. No credentials are stored here.';
comment on column public.project_deployments.vercel_project_id is
  'Vercel project id created by Mavly. Not accepted from a browser request.';
comment on column public.project_deployments.vercel_project_name is
  'Deterministic Vercel project name derived server-side from the owner and Mavly project id.';
comment on column public.project_deployments.vercel_deployment_id is
  'Latest Vercel deployment id. Used only for server-side status reads.';
comment on column public.project_deployments.last_published_at is
  'When the latest publish was submitted; created_at is when this mapping row was first created.';

create index if not exists project_deployments_status_idx
  on public.project_deployments (status);

alter table public.project_deployments enable row level security;

drop policy if exists "project_deployments_select_own" on public.project_deployments;
create policy "project_deployments_select_own"
  on public.project_deployments
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_deployments.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_deployments_insert_own" on public.project_deployments;
create policy "project_deployments_insert_own"
  on public.project_deployments
  for insert
  to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_deployments.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_deployments_update_own" on public.project_deployments;
create policy "project_deployments_update_own"
  on public.project_deployments
  for update
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_deployments.project_id
      and p.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_deployments.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_deployments_delete_own" on public.project_deployments;
create policy "project_deployments_delete_own"
  on public.project_deployments
  for delete
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_deployments.project_id
      and p.user_id = (select auth.uid())
  ));

-- The browser reads deployment state through Mavly's API, never directly, and
-- anon has no reason to see a Vercel project name or id.
revoke all on public.project_deployments from anon;
grant select, insert, update, delete on public.project_deployments to authenticated;
