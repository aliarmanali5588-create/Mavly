-- Mavly — Supabase OAuth: restore `mavly_project_id` on `supabase_oauth_states` (migration 47).
--
-- ═══ WHY THIS MIGRATION EXISTS ══════════════════════════════════════════════
--
-- Production runtime log:
--
--   [supabase-oauth] state_create failed (42703)
--
-- SQLSTATE 42703 is `undefined_column`. The failing statement is inside
-- `public.create_supabase_oauth_state`, which migration 40 installs as:
--
--   insert into public.supabase_oauth_states (
--     state_hash, user_id, code_verifier_ciphertext, return_to, mavly_project_id, expires_at
--   )
--   values (...);
--
-- `mavly_project_id` does not exist on the production table.
--
-- ═══ THE MECHANISM (this is the whole bug) ══════════════════════════════════
--
-- Migration 04 created the table first, WITHOUT the column:
--
--   create table if not exists public.supabase_oauth_states (
--     state_hash text primary key,
--     user_id uuid not null references auth.users (id) on delete cascade,
--     code_verifier_ciphertext text not null,
--     return_to text not null default '/dashboard',
--     created_at timestamptz not null default now(),
--     expires_at timestamptz not null
--   );
--
-- Migration 40 then declared the SAME table name with the extra column, but
-- guarded by `create table if not exists` (40_supabase_oauth.sql line 42). On a
-- database that already had migration 04 applied, that statement is a NO-OP:
-- PostgreSQL emits a notice and does nothing. The new column was never added.
--
-- Migration 40 contains no `alter table ... add column` for this table, and
-- neither 42 nor 43 touches it, so nothing ever closed the gap.
--
-- The migration still "succeeded" because a plpgsql function body is not
-- resolved at CREATE time. `create or replace function` stored the body as text;
-- the missing column only surfaced on the first real invocation, which is why
-- this is a production runtime error and not a migration error.
--
-- ⚠️ `consume_supabase_oauth_state` IS BROKEN BY THE SAME COLUMN. It declares
-- `v_row public.supabase_oauth_states%rowtype` and returns
-- `v_row.mavly_project_id`, so the callback half of the flow fails with 42703
-- too. Fixing the table fixes both RPCs; neither function body needs to change.
--
-- ═══ WHAT THIS MIGRATION DOES ═══════════════════════════════════════════════
--
--   1. Adds `mavly_project_id text` if and only if it is absent. Additive,
--      nullable, no default, no rewrite of existing rows.
--   2. Adds a preflight report function so the state of this table can be
--      checked directly instead of inferred from a runtime log.
--   3. Bumps the OAuth schema marker to 47.
--
-- ═══ WHAT IT DELIBERATELY DOES NOT DO ═══════════════════════════════════════
--
-- No row is deleted, no column is dropped or retyped, no RPC is replaced, no
-- grant or RLS policy changes, and no existing state row is invalidated. The
-- single-use `delete ... returning` consumption guarantee in
-- `consume_supabase_oauth_state` is untouched.
--
-- ⚠️ THE CHECK CONSTRAINTS FROM MIGRATION 40 ARE NOT ADDED HERE. Adding
-- `supabase_oauth_states_hash_check` / `_return_to_check` to a table that may
-- already hold rows would fail the whole migration on one legacy row. They are
-- enforcement niceties, not part of this defect; add them separately after
-- confirming existing rows comply.
--
-- ⚠️ `mavly_project_id` IS INTENTIONALLY NOT BACKFILLED. Existing rows are
-- short-lived (10 minute) PKCE state. A row with a null project id is already
-- handled by the application: `store.ts` maps a non-string value to null, and
-- the owner check in `create_supabase_oauth_state` only runs when the caller
-- supplies a project id. Backfilling would be inventing an authorization
-- binding that was never established.
--
-- Additive and non-destructive. Apply after 46.

begin;

-- ── 1. The missing column ───────────────────────────────────────────────────

alter table public.supabase_oauth_states
  add column if not exists mavly_project_id text;

comment on column public.supabase_oauth_states.mavly_project_id is
  'The Mavly project this OAuth state was initiated for, re-validated on consumption. Nullable: a state row created without a project binding stays valid for a non-project-scoped flow.';

-- ── 2. Preflight: make this class of defect visible without a runtime log ───

create or replace function public.supabase_oauth_state_schema_report()
returns table (column_name text, present boolean, data_type text, is_nullable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    r.column_name,
    (a.attname is not null) as present,
    format_type(a.atttypid, a.atttypmod) as data_type,
    (not a.attnotnull) as is_nullable
  from (values
    ('state_hash'),
    ('user_id'),
    ('code_verifier_ciphertext'),
    ('return_to'),
    ('mavly_project_id'),
    ('created_at'),
    ('expires_at')
  ) as r(column_name)
  left join pg_catalog.pg_attribute a
    on a.attrelid = 'public.supabase_oauth_states'::regclass
   and a.attname = r.column_name
   and a.attnum > 0
   and not a.attisdropped
  order by r.column_name;
$$;

comment on function public.supabase_oauth_state_schema_report() is
  'Preflight: every column create_supabase_oauth_state and consume_supabase_oauth_state depend on. present = false is the precise answer to a 42703 in the OAuth state path.';

revoke all on function public.supabase_oauth_state_schema_report() from public, anon;
grant execute on function public.supabase_oauth_state_schema_report() to authenticated, service_role;

-- ── 3. Schema marker ────────────────────────────────────────────────────────

create or replace function public.supabase_oauth_schema_version()
returns integer
language sql
stable
as $$ select 47 $$;

comment on function public.supabase_oauth_schema_version() is
  'Schema marker 47: supabase_oauth_states carries mavly_project_id, so create_supabase_oauth_state and consume_supabase_oauth_state resolve every column they reference.';

revoke all on function public.supabase_oauth_schema_version() from public, anon;
grant execute on function public.supabase_oauth_schema_version()
  to authenticated, service_role;

commit;
