-- Mavly — idempotent project creation requests
--
-- A retry of an Android project creation request must return the original owned
-- project instead of allocating another slug. Null preserves existing callers.

alter table public.projects
  add column if not exists creation_request_id uuid;

create unique index if not exists projects_user_creation_request_id_idx
  on public.projects (user_id, creation_request_id)
  where creation_request_id is not null;

comment on column public.projects.creation_request_id is
  'Optional client-generated idempotency key for project creation, scoped to the owner.';
