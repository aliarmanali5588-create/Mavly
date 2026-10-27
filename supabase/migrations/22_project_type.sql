-- Mavly — project type metadata
--
-- The project model is website-first, but Android is also an explicit project type.
-- Keep the default entirely backward compatible: existing rows remain "website"
-- unless the application or operator explicitly creates an Android project.

alter table public.projects
  add column if not exists project_type text not null default 'website';

update public.projects
set project_type = 'website'
where project_type is null;

alter table public.projects
  drop constraint if exists projects_project_type_check;

alter table public.projects
  add constraint projects_project_type_check
  check (project_type in ('website', 'android'));

comment on column public.projects.project_type is
  'Project type for the current workspace: ''website'' (default) or ''android''.';
