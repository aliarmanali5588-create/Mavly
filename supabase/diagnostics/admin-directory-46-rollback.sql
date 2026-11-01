-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — migration 46
--
-- ⚠️ YOU PROBABLY DO NOT NEED THIS.
--
-- Migration 46 creates no table, alters no table, and touches no customer row.
-- It replaces two function bodies and adds one read-only report function. The
-- only reason to roll back is a defect in the new function, and even then the
-- correct move is usually to fix forward.
--
-- ⚠️ ROLLING BACK RE-INTRODUCES THE 42P01 DEFECT on any database without
-- migration 14's `project_published_versions` table. That is the exact bug this
-- migration fixes. Only run this if the new function is worse than the old one.
--
-- ⚠️ THIS IS NOT A MIGRATION FILE. It is an operator script. It is not numbered,
-- it is not applied automatically, and it must be run deliberately:
--
--   psql "$DATABASE_URL" -f supabase/diagnostics/admin-directory-46-rollback.sql
--
-- What it does:
--   1. Drops the two functions migration 46 added (report + version marker).
--   2. Restores `admin_project_directory` to the migration 44 wrapper, which
--      delegates to the migration 41 body.
--
-- What it does NOT do:
--   * It does not drop or restore any table.
--   * It does not delete or modify a single customer row.
--   * It does not touch `admin_user_directory`.
-- ═══════════════════════════════════════════════════════════════════════════


begin;

-- ── 0. Refuse to run half-way ──────────────────────────────────────────────
-- The wrapper below delegates to the migration 41 body that migration 44
-- renamed. If that body is absent, restoring the wrapper would leave the
-- directory pointing at a function that does not exist — worse than the bug we
-- are rolling back. Fail loudly and change nothing.
do $$
begin
  if to_regprocedure(
       'public.admin_project_directory_v41(text,text,text,integer,integer)'
     ) is null then
    raise exception
      'Cannot roll back: public.admin_project_directory_v41(...) is absent. Migration 44 has not been applied, so there is no prior body to restore. Nothing was changed.';
  end if;
end $$;

-- ── 1. Remove what migration 46 added ──────────────────────────────────────
drop function if exists public.admin_directory_schema_report();
drop function if exists public.admin_directory_schema_version();

-- ── 2. Restore the migration 44 wrapper over the migration 41 body ─────────
create or replace function public.admin_project_directory(
  p_search text default null,
  p_status text default 'all',
  p_visibility text default 'all',
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.admin_project_directory_v41(
    p_search, p_status, p_visibility, p_page, p_page_size
  );
$$;

revoke all on function public.admin_project_directory(text, text, text, integer, integer)
  from public, anon;
grant execute on function public.admin_project_directory(text, text, text, integer, integer)
  to authenticated;

commit;

select
  to_regprocedure('public.admin_directory_schema_report()') is null
    as report_removed,
  to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') is not null
    as wrapper_restored;
