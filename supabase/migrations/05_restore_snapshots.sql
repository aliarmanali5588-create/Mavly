-- Mavly — restore points (execution snapshots)
--
-- Every AI execution that changes the project's source leaves a durable,
-- restorable copy of the source state behind. This is Mavly's OWN recovery
-- mechanism: it does not depend on GitHub, on a deployment, or on the removed
-- Totalum backend.
--
-- ⚠️ WHAT A SNAPSHOT IS. A snapshot stores the COMPLETE recoverable file state
-- of a project (path + content per file), not a summary or a diff. A diff cannot
-- be replayed onto a state that has since diverged; a full file set can.
--
-- ⚠️ THE FILE ROWS ARE THE POINT. `project_snapshot_files` holds the content.
-- `project_snapshots` holds only metadata (who, when, which run, what changed).
--
-- ⚠️ OWNERSHIP IS INHERITED, NOT RESTATED. Like every other child table in this
-- schema, access is decided by the ownership row in `public.projects`: a
-- snapshot is readable exactly when its project is. There is no service-role
-- path and no privileged client.
--
-- Additive and idempotent. It changes nothing about `public.projects`, the
-- authentication flow, or the existing project id shape.

-- ── Snapshot metadata ───────────────────────────────────────────────────────

create table if not exists public.project_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  /** The agent run this snapshot belongs to, when it has one. */
  run_id uuid references public.project_runs (id) on delete set null,
  /**
   * What the snapshot holds:
   *   'baseline'    — the source state BEFORE a run (the restore target of that
   *                   run's "Restore Code" action);
   *   'result'      — the source state AFTER a run;
   *   'pre_restore' — the source state captured just before a restore, so the
   *                   restore itself is recoverable;
   *   'import'      — the source state captured before GitHub source was
   *                   imported over the project;
   *   'manual'      — any other recovery point.
   */
  kind text not null default 'manual'
    check (kind in ('baseline', 'result', 'pre_restore', 'import', 'manual')),
  /** A short, human-readable summary of what this point captures. */
  description text not null default '',
  /** A content hash of the whole snapshot, used to detect stale restores. */
  source_hash text not null default '',
  file_count integer not null default 0,
  /** The paths this snapshot changed relative to its predecessor, when known. */
  changed_paths jsonb not null default '[]'::jsonb,
  /** 'ready' — the content is stored and restorable; 'failed' — it is not. */
  status text not null default 'ready' check (status in ('ready', 'failed')),
  /** Set when this snapshot has been restored at least once. */
  restored_at timestamptz,
  /** For a 'pre_restore' snapshot: the snapshot it was taken for. */
  restore_of_snapshot_id uuid references public.project_snapshots (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.project_snapshots is
  'Recoverable source states of a project. The content lives in project_snapshot_files.';
comment on column public.project_snapshots.source_hash is
  'SHA-256 over the sorted path/content pairs. Used to detect a stale restore.';
comment on column public.project_snapshots.changed_paths is
  'JSON array of the paths this snapshot changed, when the producer knew them.';

create index if not exists project_snapshots_project_created_idx
  on public.project_snapshots (project_id, created_at desc);
create index if not exists project_snapshots_run_idx
  on public.project_snapshots (run_id);

alter table public.project_snapshots enable row level security;

drop policy if exists "project_snapshots_select_own" on public.project_snapshots;
create policy "project_snapshots_select_own"
  on public.project_snapshots
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_snapshots.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_snapshots_insert_own" on public.project_snapshots;
create policy "project_snapshots_insert_own"
  on public.project_snapshots
  for insert
  to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_snapshots.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_snapshots_update_own" on public.project_snapshots;
create policy "project_snapshots_update_own"
  on public.project_snapshots
  for update
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_snapshots.project_id
      and p.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_snapshots.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_snapshots_delete_own" on public.project_snapshots;
create policy "project_snapshots_delete_own"
  on public.project_snapshots
  for delete
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_snapshots.project_id
      and p.user_id = (select auth.uid())
  ));

-- The browser never needs to write these rows directly: snapshots are created
-- by the server's own RLS-scoped session client.
revoke all on public.project_snapshots from anon;
grant select, insert, update, delete on public.project_snapshots to authenticated;

-- ── Snapshot content ────────────────────────────────────────────────────────

create table if not exists public.project_snapshot_files (
  snapshot_id uuid not null references public.project_snapshots (id) on delete cascade,
  path text not null,
  content text not null,
  bytes integer not null default 0,
  primary key (snapshot_id, path)
);

comment on table public.project_snapshot_files is
  'The complete file content of one snapshot. One row per file path.';

create index if not exists project_snapshot_files_snapshot_idx
  on public.project_snapshot_files (snapshot_id);

alter table public.project_snapshot_files enable row level security;

drop policy if exists "project_snapshot_files_select_own" on public.project_snapshot_files;
create policy "project_snapshot_files_select_own"
  on public.project_snapshot_files
  for select
  to authenticated
  using (exists (
    select 1
    from public.project_snapshots s
    join public.projects p on p.project_id = s.project_id
    where s.id = project_snapshot_files.snapshot_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_snapshot_files_insert_own" on public.project_snapshot_files;
create policy "project_snapshot_files_insert_own"
  on public.project_snapshot_files
  for insert
  to authenticated
  with check (exists (
    select 1
    from public.project_snapshots s
    join public.projects p on p.project_id = s.project_id
    where s.id = project_snapshot_files.snapshot_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_snapshot_files_delete_own" on public.project_snapshot_files;
create policy "project_snapshot_files_delete_own"
  on public.project_snapshot_files
  for delete
  to authenticated
  using (exists (
    select 1
    from public.project_snapshots s
    join public.projects p on p.project_id = s.project_id
    where s.id = project_snapshot_files.snapshot_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_snapshot_files from anon;
grant select, insert, delete on public.project_snapshot_files to authenticated;

-- ── The chat link ───────────────────────────────────────────────────────────
--
-- The "Restore Code" action in the chat belongs to ONE message and ONE
-- snapshot. The link lives on the message so the button is bound to persisted
-- execution state, not to transient client state: a reload shows the same
-- button for the same run.

alter table public.project_messages
  add column if not exists restore_snapshot_id uuid
  references public.project_snapshots (id) on delete set null;

comment on column public.project_messages.restore_snapshot_id is
  'The snapshot the chat Restore Code action restores. Null when the run changed nothing.';
