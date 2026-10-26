-- Mavly — shared multi-tenant hosting: immutable published versions
--
-- ═══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
--
-- The per-project Vercel path uploads the CURRENT `project_files` on every
-- publish and keeps the released bytes at Vercel. A shared tenant runtime has no
-- such copy, so serving `project_files` directly would publish drafts and keep
-- serving content after an unpublish.
--
-- This migration adds the missing artifact:
--
--   project_published_versions — one immutable record per publish attempt;
--   project_published_files    — the exact static bytes of that version.
--
-- `project_deployments.active_version_id` links the authoritative active
-- version. Everything public is resolved from that link, never from
-- `project_files`.
--
-- ═══ STORAGE DECISION (DB-backed text, no new provider) ════════════════════
--
-- The existing pipeline is text-only (`project_files.content` is `text`; the
-- Vercel upload does `Buffer.from(content, "utf8")`) and a publish is capped at
-- 1,000 files / 8,000,000 bytes. A version is therefore at most a few MB of
-- text, which fits a table. Introducing object storage would add a provider, a
-- credential and a second consistency boundary for no measured benefit at this
-- size. If measured sizes ever justify it, the version id is already the natural
-- object prefix and the serving contract below does not change.
--
-- ═══ SECURITY MODEL ════════════════════════════════════════════════════════
--
--   · owners read/write their own versions through RLS, exactly like
--     `project_files`;
--   · `anon` has NO privilege on either table;
--   · the only public surface is two narrowly scoped RPCs:
--       resolve_published_tenant(hostname)  → project/version identity only;
--       read_published_file(hostname, version, path) → one published file.
--     Both are SECURITY DEFINER with a fixed `search_path`, both re-check that
--     the hostname currently resolves to that exact ACTIVE version through a
--     READY deployment row, and neither can return drafts, other tenants,
--     project metadata, secrets or unpublished files.
--
-- Additive and idempotent. No existing row is rewritten, and no existing
-- deployment/domain is touched.

begin;

-- ── 1. Immutable published versions ─────────────────────────────────────────

create table if not exists public.project_published_versions (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  /**
   * draft      — rows and files are being written; never publicly resolvable.
   * active     — the currently published version (at most one per project).
   * superseded — a previously published version, kept for retention/rollback.
   * failed     — the write did not complete; never publicly resolvable.
   */
  status text not null default 'draft'
    check (status in ('draft', 'active', 'superseded', 'failed')),
  /** Hash of the whole file set, in path order. Content-addressed identity. */
  content_hash text not null,
  /** The document served at `/`. */
  entry_path text not null default 'index.html',
  /** True when unknown extension-less paths may serve the entry document. */
  spa_fallback boolean not null default false,
  file_count integer not null default 0,
  byte_count bigint not null default 0,
  /** Set when this version first became publicly resolvable. */
  activated_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

-- At most ONE active version per project. A failed activation leaves the
-- previous active row untouched; a successful one supersedes it in the same
-- transaction (activate_published_version below).
create unique index if not exists project_published_versions_active_key
  on public.project_published_versions (project_id)
  where status = 'active';

create index if not exists project_published_versions_project_idx
  on public.project_published_versions (project_id, created_at desc);

comment on table public.project_published_versions is
  'Immutable published artifact metadata. The exact bytes live in project_published_files; project_files is never served publicly.';
comment on column public.project_published_versions.status is
  'draft = being written; active = publicly resolvable; superseded = retained history; failed = incomplete write.';
comment on column public.project_published_versions.content_hash is
  'SHA-256 over path + content hash for every file, in sorted path order. Used as the immutable cache/identity key.';
comment on column public.project_published_versions.spa_fallback is
  'When true an unknown extension-less path may serve entry_path. Set from the published site manifest, never guessed at request time.';

-- ── 2. The exact bytes of a version ─────────────────────────────────────────

create table if not exists public.project_published_files (
  version_id uuid not null
    references public.project_published_versions (id) on delete cascade,
  /** Version-relative path, always validated by the publishing code. */
  path text not null,
  content text not null,
  content_type text not null default 'application/octet-stream',
  sha256 text not null,
  size_bytes bigint not null default 0,
  primary key (version_id, path)
);

comment on table public.project_published_files is
  'Frozen static bytes for one published version. Text storage, matching project_files and the existing publish pipeline.';
comment on column public.project_published_files.path is
  'Version-relative path. index.html is the entry document; paths are validated before insert.';

-- ── 3. Link the active version from the deployment mapping ──────────────────

alter table public.project_deployments
  add column if not exists active_version_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_deployments_active_version_id_fkey'
  ) then
    alter table public.project_deployments
      add constraint project_deployments_active_version_id_fkey
      foreign key (active_version_id)
      references public.project_published_versions (id)
      on delete set null;
  end if;
end $$;

-- The mapping's provider now describes two real backends. `vercel` keeps the
-- existing per-project deployments; `shared` means the version above is served
-- by Mavly's tenant runtime and NO Vercel project is created for it.
alter table public.project_deployments
  drop constraint if exists project_deployments_provider_check;
alter table public.project_deployments
  add constraint project_deployments_provider_check
  check (provider in ('vercel', 'shared'));

comment on column public.project_deployments.provider is
  'vercel = per-project Vercel deployment; shared = immutable in-database version served by the tenant runtime.';
comment on column public.project_deployments.active_version_id is
  'The published version the shared runtime may serve. NULL for legacy Vercel rows and for an unpublished site.';

create index if not exists project_deployments_active_version_idx
  on public.project_deployments (active_version_id)
  where active_version_id is not null;

-- ── 4. Reserved hostname policy at the data layer ───────────────────────────
--
-- Mirrors src/lib/reserved-hostnames.ts. Applied to NEW/CHANGED rows only
-- (`NOT VALID`): an existing mapping is never rewritten or rejected, so a legacy
-- site cannot be broken by adding this constraint.

alter table public.project_deployments
  drop constraint if exists project_deployments_mavly_hostname_reserved_check;
alter table public.project_deployments
  add constraint project_deployments_mavly_hostname_reserved_check
  check (
    mavly_hostname is null
    or split_part(mavly_hostname, '.', 1) <> all (array[
      'adminsh', 'api', 'auth', 'careers', 'changelog', 'contact',
      'credit-topup', 'dashboard', 'docs', 'faq', 'features', 'home',
      'integrations', 'login', 'preview', 'privacy', 'project', 'projects',
      'signup', 'support', 'terms', 'tutorials', 'upgrade',
      'blog', 'help', 'status', 'www',
      'assets', 'cdn', 'files', 'mail', 'ns1', 'ns2', 'smtp', 'static',
      'storage', 'vercel',
      'admin', 'app', 'billing', 'internal', 'system'
    ]::text[])
  ) not valid;

-- ── 5. RLS for owners (no anon table privileges) ────────────────────────────

alter table public.project_published_versions enable row level security;
alter table public.project_published_files enable row level security;

drop policy if exists "project_published_versions_select_own"
  on public.project_published_versions;
create policy "project_published_versions_select_own"
  on public.project_published_versions
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_published_versions.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_versions_insert_own"
  on public.project_published_versions;
create policy "project_published_versions_insert_own"
  on public.project_published_versions
  for insert
  to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_published_versions.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_versions_update_own"
  on public.project_published_versions;
create policy "project_published_versions_update_own"
  on public.project_published_versions
  for update
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_published_versions.project_id
      and p.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.projects p
    where p.project_id = project_published_versions.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_versions_delete_own"
  on public.project_published_versions;
create policy "project_published_versions_delete_own"
  on public.project_published_versions
  for delete
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_published_versions.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_files_select_own"
  on public.project_published_files;
create policy "project_published_files_select_own"
  on public.project_published_files
  for select
  to authenticated
  using (exists (
    select 1
    from public.project_published_versions v
    join public.projects p on p.project_id = v.project_id
    where v.id = project_published_files.version_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_files_insert_own"
  on public.project_published_files;
create policy "project_published_files_insert_own"
  on public.project_published_files
  for insert
  to authenticated
  with check (exists (
    select 1
    from public.project_published_versions v
    join public.projects p on p.project_id = v.project_id
    where v.id = project_published_files.version_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_published_files_delete_own"
  on public.project_published_files;
create policy "project_published_files_delete_own"
  on public.project_published_files
  for delete
  to authenticated
  using (exists (
    select 1
    from public.project_published_versions v
    join public.projects p on p.project_id = v.project_id
    where v.id = project_published_files.version_id
      and p.user_id = (select auth.uid())
  ));

revoke all on public.project_published_versions from anon;
revoke all on public.project_published_files from anon;
grant select, insert, update, delete on public.project_published_versions to authenticated;
grant select, insert, delete on public.project_published_files to authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- 6. Hostname canonicalization (shared by the public functions)
-- ══════════════════════════════════════════════════════════════════════════════
--
-- ONE definition of "a tenant hostname". It lowercases, allows exactly one
-- trailing dot, refuses ports/paths/userinfo, requires exactly one label under
-- mavly.xyz, applies the same structural label rule as `isRoutableProjectSlug`,
-- refuses punycode and refuses Mavly's reserved labels.
--
-- ⚠️ KEEP THE RESERVED ARRAY IN STEP WITH src/lib/reserved-hostnames.ts.
-- `tests/shared-hosting-migration.test.ts` cross-checks every JS label here.

create or replace function public.mavly_tenant_hostname(p_hostname text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  with input as (
    select
      case
        when p_hostname is null then null
        when length(p_hostname) > 253 then null
        when p_hostname ~ '[\s/\\@*?#]' then null
        when strpos(p_hostname, ':') > 0 then null
        else regexp_replace(lower(trim(p_hostname)), '\.$', '')
      end as host
  ),
  parts as (
    select
      host,
      split_part(host, '.', 1) as label
    from input
    where host is not null
      -- Exactly one label plus the base domain. A deeper name
      -- ("a.b.mavly.xyz") can never equal this reconstruction.
      and host = split_part(host, '.', 1) || '.mavly.xyz'
  )
  select host
  from parts
  where label ~ '^[a-z]([a-z0-9-]*[a-z0-9])?$'
    and label not like '%--%'
    and length(label) <= 63
    and label not like 'xn--%'
    and label <> all (array[
      'adminsh', 'api', 'auth', 'careers', 'changelog', 'contact',
      'credit-topup', 'dashboard', 'docs', 'faq', 'features', 'home',
      'integrations', 'login', 'preview', 'privacy', 'project', 'projects',
      'signup', 'support', 'terms', 'tutorials', 'upgrade',
      'blog', 'help', 'status', 'www',
      'assets', 'cdn', 'files', 'mail', 'ns1', 'ns2', 'smtp', 'static',
      'storage', 'vercel',
      'admin', 'app', 'billing', 'internal', 'system'
    ]::text[])
  limit 1;
$$;

-- Internal helper: never callable from a public role.
revoke all on function public.mavly_tenant_hostname(text) from public;
revoke all on function public.mavly_tenant_hostname(text) from anon;
revoke all on function public.mavly_tenant_hostname(text) from authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- 7. Owner-only activation / deactivation (SECURITY INVOKER + RLS)
-- ══════════════════════════════════════════════════════════════════════════════

create or replace function public.activate_published_version(
  p_project_id text,
  p_version_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_project text := lower(trim(coalesce(p_project_id, '')));
begin
  if v_project = '' then
    raise exception 'INVALID_PROJECT' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = v_project
      and p.user_id = (select auth.uid())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.project_published_versions v
    where v.id = p_version_id
      and v.project_id = v_project
      and v.status in ('draft', 'active')
  ) then
    raise exception 'VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Supersede first: the partial unique index allows only one active row, and
  -- both statements run in this function's transaction.
  update public.project_published_versions
     set status = 'superseded',
         superseded_at = now()
   where project_id = v_project
     and status = 'active'
     and id <> p_version_id;

  update public.project_published_versions
     set status = 'active',
         activated_at = now()
   where id = p_version_id
     and project_id = v_project;

  update public.project_deployments
     set active_version_id = p_version_id,
         updated_at = now()
   where project_id = v_project;

  return p_version_id;
end;
$$;

create or replace function public.deactivate_published_version(p_project_id text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_project text := lower(trim(coalesce(p_project_id, '')));
begin
  if v_project = '' then
    raise exception 'INVALID_PROJECT' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.project_id = v_project
      and p.user_id = (select auth.uid())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- The version history is preserved; only the public mapping is removed. The
  -- resolver requires BOTH an active version and a ready deployment link, so
  -- clearing them makes the host stop serving immediately.
  update public.project_published_versions
     set status = 'superseded',
         superseded_at = now()
   where project_id = v_project
     and status = 'active';

  /**
   * ⚠️ DO NOT BUMP `updated_at` HERE. The unpublish flow holds that value as its
   * optimistic lease, and `finish_unpublish` matches on it. Touching it would
   * make a successful takedown unrecorable (the lease would look lost).
   */
  update public.project_deployments
     set active_version_id = null
   where project_id = v_project;

  return true;
end;
$$;

revoke all on function public.activate_published_version(text, uuid) from public;
revoke all on function public.activate_published_version(text, uuid) from anon;
grant execute on function public.activate_published_version(text, uuid) to authenticated;

revoke all on function public.deactivate_published_version(text) from public;
revoke all on function public.deactivate_published_version(text) from anon;
grant execute on function public.deactivate_published_version(text) to authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- 8. The public published-only contract (SECURITY DEFINER)
-- ══════════════════════════════════════════════════════════════════════════════
--
-- These two functions ARE the public hosting surface. They take a hostname (and
-- a path), never a project id, so an unauthenticated caller cannot ask for
-- somebody else's project by naming it.

create or replace function public.resolve_published_tenant(p_hostname text)
returns table (
  project_id text,
  version_id uuid,
  published_at timestamptz,
  content_hash text,
  entry_path text,
  spa_fallback boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    v.project_id,
    v.id,
    coalesce(v.activated_at, v.created_at),
    v.content_hash,
    v.entry_path,
    v.spa_fallback
  from public.project_published_versions v
  join public.project_deployments d on d.project_id = v.project_id
  where v.status = 'active'
    and d.status = 'ready'
    and d.active_version_id = v.id
    and d.mavly_hostname = public.mavly_tenant_hostname(p_hostname)
  limit 1;
$$;

revoke all on function public.resolve_published_tenant(text) from public;
grant execute on function public.resolve_published_tenant(text) to anon, authenticated;

create or replace function public.read_published_file(
  p_hostname text,
  p_version_id uuid,
  p_path text
)
returns table (
  path text,
  content text,
  content_type text,
  sha256 text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with tenant as (
    select t.version_id
    from public.resolve_published_tenant(p_hostname) t
  )
  select f.path, f.content, f.content_type, f.sha256
  from public.project_published_files f
  join tenant t on t.version_id = f.version_id
  where f.version_id = p_version_id
    and f.path = p_path
    and p_path is not null
    and length(p_path) between 1 and 1024
    and left(p_path, 1) <> '/'
    and strpos(p_path, '..') = 0
    and strpos(p_path, chr(92)) = 0
  limit 1;
$$;

revoke all on function public.read_published_file(text, uuid, text) from public;
grant execute on function public.read_published_file(text, uuid, text) to anon, authenticated;

commit;
