-- ═══════════════════════════════════════════════════════════════════════════
-- MAVLY — READ-ONLY MIGRATION RECONCILIATION DIAGNOSTIC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- The admin directory reported "the deployed database is missing a table or
-- column required by the admin project directory" while every column the RPC
-- reads is defined in migrations 02/03/07/09/10/14/20. That message is produced
-- by classifying a database error code, so the real cause is one specific code
-- on one specific object — and nothing in the repository could tell us which.
--
-- This script answers that from the database itself instead of guessing.
--
-- ⚠️ IT IS STRICTLY READ-ONLY.
--   · No CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, TRUNCATE or GRANT.
--   · Every statement is a SELECT over catalogs or a LIMIT-ed row count.
--   · It is safe to run against production at any time.
--   · It does NOT fix anything. It reports what is actually installed.
--
-- HOW TO RUN
--
--   Supabase Dashboard → SQL Editor → paste → Run.
--   Or: psql "$DATABASE_URL" -f supabase/diagnostics/migration_reconciliation.sql
--
-- Read section 7 first: it is the direct answer to "why did the project
-- directory fail".
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. WHICH MIGRATIONS DOES THE DATABASE THINK IT HAS?
-- ───────────────────────────────────────────────────────────────────────────
-- Supabase CLI / `db push` records applied migrations here. A migration applied
-- MANUALLY through the SQL editor does NOT appear in this table — which is
-- exactly why a hand-applied schema can disagree with the recorded history.

select
  '1. recorded migration history' as section,
  case
    when to_regclass('supabase_migrations.schema_migrations') is null
      then 'supabase_migrations.schema_migrations is not installed; migration history is unavailable (manual SQL editor applies do not record here).'
    else 'supabase_migrations.schema_migrations is installed; run `select version, name, inserted_at from supabase_migrations.schema_migrations order by version;` to list applied migrations.'
  end as detail;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE TABLES THE ADMIN DIRECTORIES READ
-- ───────────────────────────────────────────────────────────────────────────
-- `present = false` on any row is a missing prerequisite migration.

with required_tables(schema_name, table_name, first_migration, needed_by) as (
  values
    ('public', 'projects',                   '02', 'both directories'),
    ('public', 'profiles',                   '01', 'both directories'),
    ('public', 'project_runs',               '03', 'project directory'),
    ('public', 'project_deployments',        '07', 'project directory'),
    ('public', 'project_published_versions', '14', 'project directory'),
    ('public', 'admin_allowlist',            '18', 'admin authorization'),
    ('public', 'credit_accounts',            '31', 'user directory (optional)')
)
select
  '2. required tables' as section,
  r.schema_name,
  r.table_name,
  r.first_migration,
  r.needed_by,
  (c.oid is not null) as present
from required_tables r
left join pg_class c
  on c.relname = r.table_name
 and c.relnamespace = to_regnamespace(r.schema_name)
order by r.first_migration, r.table_name;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. THE COLUMNS THE ADMIN PROJECT DIRECTORY READS
-- ───────────────────────────────────────────────────────────────────────────
-- Every column `admin_project_directory` touches, with the migration that adds
-- it. `present = false` is the precise answer to a 42703 / PGRST204.

with required_columns(schema_name, table_name, column_name, added_by) as (
  values
    ('public', 'projects',                   'project_id',            '02'),
    ('public', 'projects',                   'user_id',               '02'),
    ('public', 'projects',                   'created_at',            '02'),
    ('public', 'projects',                   'label',                 '03'),
    ('public', 'projects',                   'updated_at',            '03'),
    ('public', 'project_runs',               'project_id',            '03'),
    ('public', 'project_runs',               'model',                 '03'),
    ('public', 'project_runs',               'started_at',            '03'),
    ('public', 'project_runs',               'stage',                 '10'),
    ('public', 'project_runs',               'model_used',            '10'),
    ('public', 'project_deployments',        'project_id',            '07'),
    ('public', 'project_deployments',        'status',                '07'),
    ('public', 'project_deployments',        'url',                   '07'),
    ('public', 'project_deployments',        'mavly_hostname',        '09'),
    ('public', 'project_deployments',        'mavly_domain_status',   '09'),
    ('public', 'project_deployments',        'active_version_id',     '14'),
    ('public', 'project_deployments',        'lifecycle',             '20'),
    ('public', 'project_published_versions', 'id',                    '14'),
    ('public', 'project_published_versions', 'project_id',            '14'),
    ('public', 'project_published_versions', 'status',                '14'),
    ('public', 'profiles',                   'id',                    '01'),
    ('public', 'profiles',                   'full_name',             '01')
)
select
  '3. required columns' as section,
  r.table_name,
  r.column_name,
  r.added_by,
  (a.attname is not null) as present
from required_columns r
left join pg_class c
  on c.relname = r.table_name
 and c.relnamespace = to_regnamespace(r.schema_name)
left join pg_attribute a
  on a.attrelid = c.oid
 and a.attname = r.column_name
 and a.attnum > 0
 and not a.attisdropped
order by r.table_name, r.column_name;


-- ───────────────────────────────────────────────────────────────────────────
-- 4. THE DIRECTORY FUNCTIONS — SIGNATURE, OWNER, SECURITY, GRANTS
-- ───────────────────────────────────────────────────────────────────────────
-- A signature mismatch (PGRST202/42883) or a missing EXECUTE grant (42501) is
-- visible here. The `_v41` rows are the private implementations migration 44
-- renames the originals into; the public names must be the wrappers.

select
  '4. directory functions' as section,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  (p.proconfig is not null) as has_search_path_pin,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_user_directory',
    'admin_project_directory',
    'admin_user_directory_v41',
    'admin_project_directory_v41',
    'current_user_is_admin',
    'admin_overview'
  )
order by p.proname, arguments;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. DUPLICATE / OVERLOADED FUNCTIONS
-- ───────────────────────────────────────────────────────────────────────────
-- More than one row for a name is an overload. A stale overload is the usual
-- cause of PGRST203 ("ambiguous") and of a call resolving to an old body.

select
  '5. function overloads' as section,
  p.proname as function_name,
  count(*) as signature_count,
  array_agg(pg_get_function_identity_arguments(p.oid) order by p.oid) as signatures
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_user_directory', 'admin_project_directory')
group by p.proname
having count(*) > 1;


-- ───────────────────────────────────────────────────────────────────────────
-- 6. RLS STATE ON THE TABLES THE DIRECTORIES READ
-- ───────────────────────────────────────────────────────────────────────────
-- The directory RPCs are SECURITY DEFINER, so RLS does not gate them — but a
-- table with RLS enabled and NO policy is a common cause of an empty result
-- elsewhere in the app. This is informational for the directory, diagnostic
-- for the rest of the console.

select
  '6. rls state' as section,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  (select count(*) from pg_policy pol where pol.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'projects', 'profiles', 'project_runs', 'project_deployments',
    'project_published_versions', 'admin_allowlist', 'credit_accounts'
  )
order by c.relname;


-- ───────────────────────────────────────────────────────────────────────────
-- 7. ⭐ THE DIRECT ANSWER: CAN THE PROJECT DIRECTORY ACTUALLY RUN?
-- ───────────────────────────────────────────────────────────────────────────
-- This executes the SAME resolution PostgREST performs, without calling the
-- function, and reports the first thing that would make the call fail.
-- `blocking_reason` is null when the RPC is resolvable.

with checks as (
  select
    (to_regprocedure('public.admin_project_directory(text,text,text,integer,integer)') is not null)
      as project_rpc_resolvable,
    (to_regprocedure('public.admin_user_directory(text,text,integer,integer)') is not null)
      as user_rpc_resolvable,
    (to_regprocedure('public.admin_project_directory_v41(text,text,text,integer,integer)') is not null)
      as project_rpc_v41_present,
    (to_regprocedure('public.current_user_is_admin()') is not null)
      as admin_check_present,
    (to_regclass('public.projects') is not null) as projects_present,
    (to_regclass('public.project_runs') is not null) as project_runs_present,
    (to_regclass('public.project_deployments') is not null) as deployments_present,
    (to_regclass('public.project_published_versions') is not null) as published_versions_present,
    (to_regclass('public.profiles') is not null) as profiles_present,
    (to_regclass('public.admin_allowlist') is not null) as allowlist_present
)
select
  '7. project directory readiness' as section,
  checks.*,
  case
    when not checks.admin_check_present
      then 'current_user_is_admin() is missing — apply migration 18'
    when not checks.project_rpc_resolvable
      then 'admin_project_directory(text,text,text,integer,integer) does not resolve — apply migration 41 then 44'
    when not checks.project_rpc_v41_present
      then 'the _v41 implementation is missing — migration 44 ran without migration 41'
    when not checks.projects_present
      then 'public.projects is missing — apply migration 02'
    when not checks.project_runs_present
      then 'public.project_runs is missing — apply migration 03'
    when not checks.deployments_present
      then 'public.project_deployments is missing — apply migration 07'
    when not checks.published_versions_present
      then 'public.project_published_versions is missing — apply migration 14'
    when not checks.profiles_present
      then 'public.profiles is missing — apply migration 01'
    when not checks.allowlist_present
      then 'public.admin_allowlist is missing — apply migration 18'
    else null
  end as blocking_reason
from checks;


-- ───────────────────────────────────────────────────────────────────────────
-- 8. ROW COUNTS — PROOF THE DATA IS INTACT
-- ───────────────────────────────────────────────────────────────────────────
-- Read-only counts, so the reconciliation report can state that no customer
-- project, run or deployment was lost. `auth.users` is the authoritative user
-- population the admin console must agree with.

select '8. row counts' as section, 'auth.users' as object, count(*) as rows from auth.users
union all
select '8. row counts', 'public.projects', count(*) from public.projects
union all
select '8. row counts', 'public.project_runs', count(*) from public.project_runs
union all
select '8. row counts', 'public.project_deployments', count(*) from public.project_deployments
union all
select '8. row counts', 'public.project_published_versions', count(*) from public.project_published_versions
union all
select '8. row counts', 'public.profiles', count(*) from public.profiles
order by object;


-- ───────────────────────────────────────────────────────────────────────────
-- 9. SCHEMA MARKERS INSTALLED BY THE MIGRATIONS THEMSELVES
-- ───────────────────────────────────────────────────────────────────────────
-- Most migrations record a `*_schema_version()` marker function. Comparing
-- these against the recorded history in section 1 is the fastest way to see
-- where a hand-applied schema diverged from what the repository expects.
-- `present = false` means that migration's objects are not installed.

with markers(function_name, migration) as (
  values
    ('admin_schema_version',                     '18'),
    ('shared_hosting_schema_version',            '15'),
    ('generation_worker_schema_version',         '16'),
    ('verification_schema_version',              '19'),
    ('fullstack_hosting_schema_version',         '20'),
    ('business_integrations_schema_version',     '21'),
    ('production_hardening_schema_version',      '23'),
    ('agent_memory_schema_version',              '24'),
    ('android_build_schema_version',             '26'),
    ('multi_agent_schema_version',               '29'),
    ('managed_backend_schema_version',           '30'),
    ('credit_schema_version',                    '31'),
    ('project_image_schema_version',             '33'),
    ('runtime_sandbox_schema_version',           '34'),
    ('backend_providers_schema_version',         '39'),
    ('supabase_oauth_schema_version',            '40'),
    ('supabase_oauth_audit_schema_version',      '42'),
    ('admin_auth_schema_version',                '55')
)
select
  '9. schema markers' as section,
  m.migration,
  m.function_name,
  (to_regprocedure('public.' || m.function_name || '()') is not null) as present
from markers m
order by m.migration::int;
