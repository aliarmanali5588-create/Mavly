-- Vercel customer frontend hosting (Phase 16).
--
-- Apply after 62_domain_management.sql (and therefore after 07, 09, 13, 14,
-- 15, 51 and 56, which that file already requires).
--
-- This migration records the hosting-platform decision and the safety metadata
-- the application needs. It is additive and non-destructive:
--
--   · no deployment, published version, file, domain, billing or credit row is
--     rewritten or deleted;
--   · existing AWS rows are PRESERVED as historical records (`provider = 'aws'`,
--     `hosting_migration_state = 'aws_retained'`) and keep serving until the
--     owner explicitly migrates them;
--   · no customer site is switched between providers;
--   · no AWS object, DNS record or production mapping is touched.
--
-- Authority:
--   Vercel is the customer-generated frontend hosting platform. AWS customer
--   frontend hosting is retired for NEW publications. The AWS EC2 generation
--   worker is unrelated to this migration and is preserved.
--
-- Rollback:
--   drop the two indexes, the check constraint and the column added here, then
--   drop the marker function. No data was destroyed, so removing those objects
--   returns the schema to migration 62. Existing AWS rows are untouched either
--   way; the column only carries state, never a routing decision.

begin;

create or replace function public.vercel_customer_hosting_schema_version()
returns integer
language sql
immutable
as $$ select 63 $$;

comment on function public.vercel_customer_hosting_schema_version() is
  'Schema marker 63: Vercel customer frontend hosting. AWS frontend hosting is retired for new publications; existing AWS rows are preserved.';

-- ── Hosting migration state ────────────────────────────────────────────────
--
-- Describes how a row is hosted today, never what should be published
-- elsewhere. `aws_retained` is the explicit record that a site still runs on the
-- retired provider and has NOT been migrated. Shared-runtime rows stay NULL:
-- their hosting is described by `provider = 'shared'` and `active_version_id`.
alter table public.project_deployments
  add column if not exists hosting_migration_state text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.project_deployments'::regclass
       and conname = 'project_deployments_hosting_migration_state_check'
  ) then
    alter table public.project_deployments
      add constraint project_deployments_hosting_migration_state_check
      check (
        hosting_migration_state is null
        or hosting_migration_state in ('vercel', 'aws_retained', 'migrated')
      );
  end if;
end
$$;

comment on column public.project_deployments.hosting_migration_state is
  'vercel = published by Vercel; aws_retained = existing AWS publication kept until explicitly migrated; migrated = moved from AWS to Vercel and verified. NULL for shared rows and legacy mappings.';

-- Backfill is state only. It changes no guarded AWS column, so migration 51's
-- mutation guard continues to protect status, routing generation, hostname and
-- publication timestamps.
update public.project_deployments
   set hosting_migration_state = 'aws_retained'
 where provider = 'aws'
   and hosting_migration_state is null;

update public.project_deployments
   set hosting_migration_state = 'vercel'
 where provider = 'vercel'
   and hosting_migration_state is null;

-- ── Indexes ────────────────────────────────────────────────────────────────
--
-- A Vercel deployment id identifies exactly one deployment. Two rows pointing at
-- the same deployment would mean two Mavly projects claiming one public site, so
-- the duplicate check runs first with an actionable message instead of failing
-- halfway through index creation.
do $$
begin
  if exists (
    select 1
      from public.project_deployments
     where vercel_deployment_id is not null
     group by vercel_deployment_id
    having count(*) > 1
  ) then
    raise exception 'VERCEL_HOSTING_DUPLICATE_DEPLOYMENT_ID: two deployment rows share a vercel_deployment_id; resolve the duplicates before applying migration 63';
  end if;
end
$$;

create unique index if not exists project_deployments_vercel_deployment_uidx
  on public.project_deployments (vercel_deployment_id)
  where vercel_deployment_id is not null;

-- The publication/status paths filter on provider and status.
create index if not exists project_deployments_provider_status_idx
  on public.project_deployments (provider, status);

comment on column public.project_deployments.provider is
  'vercel = primary customer frontend hosting; shared = Mavly tenant runtime cohort; aws = retained historical AWS publication (no new rows).';

commit;
