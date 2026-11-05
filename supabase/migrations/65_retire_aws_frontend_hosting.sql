-- ═══════════════════════════════════════════════════════════════════════════════
-- 65 — Retire AWS customer frontend hosting
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
--
-- Mavly removed the AWS customer frontend hosting implementation: the S3
-- publisher, the CloudFront KeyValueStore routing, the publication worker and
-- the eligibility/allowlist configuration. Vercel is the only customer frontend
-- hosting provider (Phase 16/17).
--
-- Migrations 51, 56 and 61 are ALREADY APPLIED and are not edited. Their
-- functions and triggers stay installed: they contain no customer data, and
-- dropping them while the previous application version may still be draining
-- would break that version's requests instead of retiring anything. No
-- application code calls them any more.
--
-- WHAT THIS MIGRATION DOES (and does not do)
--
--   · adds a schema marker recording that AWS frontend hosting is retired;
--   · settles AWS publication ATTEMPTS that can never finish, because their
--     worker no longer exists (queued / building / unpublishing), as an honest
--     `error` with code `aws_hosting_retired`. Without this they would display
--     as an in-flight publish for ever;
--   · relabels the `provider` column comment so the archived meaning is explicit.
--
-- It DOES NOT:
--   · delete or rewrite a deployment, published version, published file, domain,
--     project, snapshot or customer row;
--   · change any row's `provider` (no AWS row becomes a Vercel row);
--   · delete an S3 object, a CloudFront route, a DNS record or a certificate;
--   · touch credits, billing, auth, RLS policies, grants or indexes;
--   · touch `hosting_migration_state` (migration 63 already records
--     `aws_retained` for these rows).
--
-- The UPDATE is narrow: only rows whose `provider = 'aws'` AND whose attempt
-- status is still non-terminal. A previously `ready` AWS publication keeps its
-- recorded state, because this repository has no way to prove that site is down.
--
-- APPLY AFTER 64. Additive and safe to apply while the previous application
-- version is still deployed.
--
-- ROLLBACK: drop `aws_frontend_hosting_retirement_schema_version()`. The settled
-- attempts cannot be un-settled by this file; restore a status only from a
-- verified backup, never by guessing.

begin;

create or replace function public.aws_frontend_hosting_retirement_schema_version()
returns integer
language sql
immutable
as $$ select 65 $$;

comment on function public.aws_frontend_hosting_retirement_schema_version() is
  'Schema marker 65: AWS customer frontend hosting is retired. Vercel is the only customer frontend hosting provider; the AWS EC2 generation worker is unaffected.';

revoke all on function public.aws_frontend_hosting_retirement_schema_version() from public, anon;
grant execute on function public.aws_frontend_hosting_retirement_schema_version()
  to authenticated, service_role;

-- ── Settle attempts whose worker no longer exists ────────────────────────────
--
-- These rows described an operation the removed publication worker owned. They
-- are not deleted: the attempt, its version reference and its timestamps stay as
-- history. Setting them to `error` is the truthful terminal state and stops the
-- owner surface from showing a publish that can never progress.
--
-- `guard_aws_deployment_mutations` (migration 56) permits `status = 'error'` for
-- an AWS row from a non-service role; every other guarded column is untouched.

update public.project_deployments
   set status = 'error',
       error_code = 'aws_hosting_retired',
       error_message =
         'AWS customer frontend hosting was retired before this publication finished. The deployment history is kept; publish the project on Vercel to continue.',
       updated_at = now()
 where provider = 'aws'
   and status in ('queued', 'building', 'unpublishing');

comment on column public.project_deployments.provider is
  'vercel = the only customer frontend hosting provider; shared = Mavly tenant runtime cohort; aws = ARCHIVED historical AWS publication. The AWS implementation was removed, so no new row may use aws and this deployment never republishes or rewrites one.';

commit;
