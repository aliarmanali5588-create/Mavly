-- ═══════════════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION — admin project directory (migration 46)
--
-- Run this against the deployed database to answer, with evidence:
--   * is the directory's schema actually complete?
--   * which exact relation is missing, if any?
--   * does the directory return real rows?
--
-- ⚠️ Every statement here is a SELECT. Nothing is created, altered or deleted.
-- Safe to run in production, including during an incident.
--
--   psql "$DATABASE_URL" -f supabase/diagnostics/admin-directory-46-verification.sql
-- ═══════════════════════════════════════════════════════════════════════════


select
  to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') is not null
    as directory_rpc_present,
  to_regprocedure('public.admin_directory_schema_report()') is not null
    as schema_report_present,
  to_regprocedure('public.admin_directory_schema_version()') is not null
    as version_marker_present;

select
  to_regprocedure('public.admin_directory_schema_version()') is not null as version_marker_present,
  to_regprocedure('public.admin_directory_schema_report()') is not null as schema_report_present;

-- If the markers above are true, run these manually:
--   select public.admin_directory_schema_version()::text as schema_version;
--   select public.admin_directory_schema_report() as schema_report;

select
  required.name,
  required.migration,
  required.required,
  to_regclass(required.name) is not null as present
from (values
  ('public.projects',                  '02', true),
  ('public.profiles',                  '01', true),
  ('public.project_runs',              '03', true),
  ('public.project_deployments',       '07', true),
  ('public.admin_allowlist',           '18', true),
  ('auth.users',                       'supabase', true),
  ('public.project_published_versions','14', false),
  ('public.credit_accounts',           '31', false)
) as required(name, migration, required)
order by required.required desc, required.migration;

select
  (select count(*) from public.projects)            as projects,
  (select count(*) from public.project_runs)        as runs,
  (select count(*) from public.project_deployments) as deployments;

select case
  when to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') is null
    then 'directory RPC absent — cannot evaluate'
  else 'see section 7'
end as note;

-- ⚠️ Non-fatal on purpose: a refusal here is the admin gate WORKING, and the
-- script must still finish so sections 8 and 9 can be read.
do $$
declare
  v_result jsonb;
begin
  v_result := public.admin_project_directory();
  raise notice 'publicationState = %', v_result -> 'publicationState';
  raise notice 'total            = %', v_result -> 'total';
  raise notice 'metrics          = %', v_result -> 'metrics';
  raise notice 'rows returned    = %', jsonb_array_length(v_result -> 'rows');
exception
  when insufficient_privilege then
    raise notice 'REFUSED (42501) — this session is not an admin. The gate is working; re-run as an admin to see the payload.';
  when undefined_table then
    raise notice 'FAILED (42P01) — a relation is missing. Section 3 names it.';
  when others then
    raise notice 'FAILED with SQLSTATE %: %', SQLSTATE, SQLERRM;
end $$;

select
  r.routine_name,
  coalesce(g.grantee, '(none)') as grantee,
  g.privilege_type
from information_schema.routines r
left join information_schema.role_routine_grants g
  on g.specific_name = r.specific_name
where r.routine_schema = 'public'
  and r.routine_name in (
    'admin_project_directory',
    'admin_user_directory',
    'admin_directory_schema_report'
  )
order by r.routine_name, g.grantee;

select
  p.proname,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '(none)') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_project_directory',
    'admin_user_directory',
    'admin_directory_schema_report'
  )
order by p.proname;
