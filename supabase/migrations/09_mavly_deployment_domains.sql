-- Mavly — Mavly-owned domains for static deployments
--
-- Each deployment mapping can carry the project's Mavly-owned hostname,
-- `<project-id>.mavly.xyz`, and the result of assigning/verifying it at Vercel.
--
-- Existing rows keep NULL in every new column. That means "legacy mapping": the
-- old deployment URL remains the truthful address and is never rewritten.
-- Only a publish that explicitly assigned a Mavly hostname may report success at
-- that hostname, and only after Vercel reports the domain as verified.
--
-- No credential is stored here. Additive and idempotent.

alter table public.project_deployments
  add column if not exists mavly_hostname text,
  add column if not exists mavly_domain_status text,
  add column if not exists mavly_domain_error text,
  add column if not exists mavly_domain_checked_at timestamptz;

alter table public.project_deployments
  drop constraint if exists project_deployments_mavly_domain_status_check;

alter table public.project_deployments
  add constraint project_deployments_mavly_domain_status_check
  check (
    mavly_domain_status is null
    or mavly_domain_status in ('pending', 'verified', 'error')
  );

alter table public.project_deployments
  drop constraint if exists project_deployments_mavly_hostname_check;

alter table public.project_deployments
  add constraint project_deployments_mavly_hostname_check
  check (
    mavly_hostname is null
    or mavly_hostname = lower(project_id) || '.mavly.xyz'
  );

create unique index if not exists project_deployments_mavly_hostname_key
  on public.project_deployments (mavly_hostname)
  where mavly_hostname is not null;

comment on column public.project_deployments.mavly_hostname is
  'Mavly-owned public hostname derived from the project id, without a scheme. NULL means a legacy mapping that keeps its existing URL.';
comment on column public.project_deployments.mavly_domain_status is
  'Vercel domain state for mavly_hostname: pending, verified or error. NULL means no Mavly hostname was assigned.';
comment on column public.project_deployments.mavly_domain_error is
  'Last domain assignment/verification error. Never contains a credential.';
comment on column public.project_deployments.mavly_domain_checked_at is
  'When Mavly last checked the domain with Vercel.';
