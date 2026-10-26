-- Mavly — unpublish state for static deployments
--
-- Publishing already records one mapping per project in
-- public.project_deployments (`queued`, `building`, `ready`, `error`, `canceled`).
-- Unpublishing needs two additional persistent states:
--
--   unpublishing — the request is in flight; the public address is not yet down.
--   unpublished  — the Vercel project domain (and the production deployment) was
--                  removed, so the project's public URL no longer serves a site.
--
-- `unpublished` is a real deployment state, not "no row": the mapping keeps the
-- Vercel project name/id and the derived Mavly hostname so a later publish can
-- reuse them. The project row, project_files, snapshots and workspace are never
-- touched by an unpublish.
--
-- Additive and idempotent. Existing rows keep their current status. The added
-- statuses are only written by server-side code through the caller's RLS client.

alter table public.project_deployments
  drop constraint if exists project_deployments_status_check;

alter table public.project_deployments
  add constraint project_deployments_status_check
  check (
    status in (
      'queued',
      'building',
      'ready',
      'error',
      'canceled',
      'unpublishing',
      'unpublished'
    )
  );

alter table public.project_deployments
  add column if not exists last_unpublished_at timestamptz;

comment on column public.project_deployments.last_unpublished_at is
  'When the latest successful unpublish detached this project from its public host. NULL means it has never been unpublished.';

comment on column public.project_deployments.status is
  'queued/building = publishing; ready = published; unpublishing = takedown in flight; unpublished = no public site; error/canceled = failed attempt.';
