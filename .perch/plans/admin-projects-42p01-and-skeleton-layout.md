# Admin Projects 42P01 + Skeleton Layout Mismatch

## Root cause A — Projects 42P01

`admin_project_directory` (migration 41, wrapped by 44) reads six relations:
`public.projects`, `auth.users`, `public.profiles`, `public.project_runs`,
`public.project_deployments`, `public.project_published_versions`.

The Users directory reads four of those and works. So the missing relation is
one of: `project_runs` (03), `project_deployments` (07),
`project_published_versions` (14).

`project_published_versions` is the only one whose feature is opt-in
(`MAVLY_HOSTING_MODE=shared`), so it is the one a production database is most
likely to lack. Migration 41 creates the function body without validating table
existence (plpgsql resolves at run time), so 41 can apply cleanly on a database
missing 14 — which is exactly how this surfaces as 42P01 at request time.

Fix: treat the publication dependency as optional-but-declared, the same way
migration 41 already treats `credit_accounts`. Publication state becomes
`available` or `schema_missing` in the response; the page reports it truthfully
instead of rendering "Draft" for every project.

## Root cause B — skeleton layout

`src/app/adminsh/loading.tsx` is the only loading boundary. It renders a bare
KPI row + table card, with:
- no `AdminShell`, so the sidebar and header vanish during navigation;
- no `max-w-7xl mx-auto` container, so it spans the full viewport;
- geometry matching no actual page (Projects uses `gap-3.5`/`p-4 rounded-xl`,
  Users/Billing use `gap-4`/`p-5 rounded-2xl`, Overview has six sections).

Fix: shell-preserving skeletons per route, each mirroring its real page.

## Steps
1. Migration 46: optional-publication directory implementation + diagnostic RPC + marker.
2. `directory.ts`: `publicationState`, nullable publication metrics.
3. Projects page: truthful unavailable publication state.
4. `AdminShell`/`useAdminUserCount`: opt-out of the count fetch for skeletons.
5. Per-route `loading.tsx` skeletons matching real geometry.
6. Runbook update.

---

## Verification (executed, not assumed)

A throwaway PostgreSQL 16 instance was built locally and the migration was run
against reconstructed schemas, because this workspace has no deployed-DB
credentials.

**Bug reproduced.** With `project_published_versions` absent, migration 41's
body fails exactly as production reports:

    ERROR: relation "public.project_published_versions" does not exist
    SQLSTATE 42P01

**Fix confirmed, both directions.**

| Database state | `publicationState` | `total` | `published` | row `visibility` |
|---|---|---|---|---|
| no migration 14 | `schema_missing` | 2 | `null` | `unknown` |
| migration 14 present | `available` | 2 | 1 | `custom_domain` / `draft` |

Real rows, real owners, real generation state in both cases. Publication
degrades to `null`, never to a confident `0`.

**Also verified:** search (name and owner email), status filter, visibility
filter, pagination (`pageSize` clamped to 50), invalid-status rejection
(`22023`), non-admin refusal (`42501`), anonymous refusal (`42501`), schema
marker `46`, grants limited to `authenticated`, `SECURITY DEFINER` with
`search_path=""`, idempotent re-apply, and zero customer rows created, altered
or deleted.

**Rollback tested:** refuses cleanly when migration 44's prior body is absent
(nothing changed), and restores the prior wrapper when it is present.

## Not done, and why

Migration 46 is **not applied to any database**. This workspace has no deployed
credentials: no `.env.local`, the project is not linked, and the Management API
path is gated. Applying it is a deliberate operator step:

    supabase db push          # or apply 46 by hand
    psql "$DATABASE_URL" -f supabase/diagnostics/admin-directory-46-verification.sql

Until it is applied, production keeps returning `DIRECTORY_TABLE_MISSING`. The
new `GET /api/adminsh/diagnostics` route reports `SCHEMA_REPORT_NOT_INSTALLED`
in that state, which is the honest answer rather than a second guess.
