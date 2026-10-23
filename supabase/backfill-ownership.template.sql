-- ═══════════════════════════════════════════════════════════════════════════
-- Mavly — ownership backfill TEMPLATE (operator-run, once)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS
--   A template, not a migration. Nothing in this file is ever applied
--   automatically. Copy it, fill the VALUES list with projects you can PROVE
--   are yours, run it once in the Supabase SQL editor, then delete your filled
--   copy. Do not commit a filled copy.
--
-- WHEN TO RUN IT
--   After `02_create_projects.sql` has been applied and BEFORE the route guards
--   (later phases) are deployed. Until the guards ship, this table is inert;
--   once they ship, any project missing from it becomes unreachable to
--   everybody — including you.
--
-- HOW TO RUN IT
--   Supabase Dashboard → SQL editor → new query → paste your filled copy → Run.
--   The editor runs as the project's service/postgres role, which is how a
--   backfill writes rows for an auth user other than the one a browser session
--   would carry. That is the ONLY privilege this file needs; do not disable
--   RLS, do not `row_security off`, do not run it from the app.
--
-- ⚠️⚠️ THE ONE RULE: NEVER INVENT AN ID.
--   `project_id` must be an upstream Totalum project slug you own (from your
--   Totalum console, or from the dashboard's project list while still on the
--   single-tenant build). `user_id` must be a real `auth.users.id` — your own
--   Supabase user id (Dashboard → Authentication → Users). The placeholders
--   below are DELIBERATELY INVALID so an unfilled template fails loudly
--   instead of inserting junk: the uppercase slug trips
--   `projects_project_id_format`, and the all-zero UUID trips the foreign key.
--   A failed statement inserts NOTHING (this file is one transaction).
--
-- IDEMPOTENT
--   `on conflict (project_id) do nothing`: re-running never duplicates and
--   never re-assigns an existing row. Ownership is not transferred here — if a
--   project already has an owner, this file leaves it alone. Correct that case
--   by hand, deliberately, after looking at both rows.
--
-- ORDER OF OPERATIONS (the full sequence, for the record)
--   1. Apply migration 02.
--   2. Run this backfill (filled in) as the operator.
--   3. Verify with the queries at the bottom.
--   4. Deploy the route-guard phases.
--   5. Delete your filled copy of this file.

begin;

with wanted (project_id, user_id) as (
  values
    -- ⬇⬇⬇ REPLACE BOTH PLACEHOLDERS ON EVERY LINE, THEN UNCOMMENT YOUR LINES ⬇⬇⬇
    ('REPLACE-WITH-PROJECT-ID', '00000000-0000-0000-0000-000000000000')
    -- ('my-real-project-slug', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    -- ('another-project',      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
)
insert into public.projects (project_id, user_id)
select w.project_id, w.user_id
from wanted w
-- The FK on user_id would refuse a non-existent user on its own; this EXISTS
-- check simply produces a clearer failure (zero rows inserted, no error) when
-- the VALUES list is still all placeholders, so a template run is a no-op
-- rather than an exception mid-editor-session.
where exists (
  select 1 from auth.users u where u.id = w.user_id
)
on conflict (project_id) do nothing;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY (run after the insert; these are read-only)
-- ═══════════════════════════════════════════════════════════════════════════

-- Everything the table now holds:
-- select project_id, user_id, created_at from public.projects order by project_id;

-- How many projects each user owns (should match what you backfilled):
-- select user_id, count(*) from public.projects group by user_id order by 2 desc;

-- Orphans to investigate (a row whose user was deleted cascades away, so this
-- should always be empty — it is a tripwire, not an expectation):
-- select p.project_id from public.projects p
--   left join auth.users u on u.id = p.user_id
--   where u.id is null;

-- Undo one mistaken row (the only "rollback" this file needs):
-- delete from public.projects where project_id = 'the-slug-you-meant';
