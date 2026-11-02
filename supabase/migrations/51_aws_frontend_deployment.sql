-- Durable, worker-owned AWS static publication queue.
--
-- Apply after migrations 15 and 16. This migration does not create deployment
-- rows, alter existing deployment state, delete S3 objects, or depend on the
-- admin-console migration.

begin;

do $$
begin
  if not exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.project_deployments'::regclass
       and c.conname = 'project_deployments_provider_check'
       and position('aws' in pg_get_constraintdef(c.oid)) > 0
  ) then
    alter table public.project_deployments
      drop constraint if exists project_deployments_provider_check;
    alter table public.project_deployments
      add constraint project_deployments_provider_check
      check (provider in ('vercel', 'shared', 'aws'));
  end if;
end
$$;

comment on column public.project_deployments.provider is
  'vercel = legacy per-project Vercel; shared = Mavly tenant runtime; aws = immutable S3/CloudFront publication.';

alter table public.project_deployments
  add column if not exists aws_route_generation bigint not null default 0;

do $$
begin
  if not exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.project_deployments'::regclass
       and c.conname = 'project_deployments_aws_route_generation_check'
  ) then
    alter table public.project_deployments
      add constraint project_deployments_aws_route_generation_check
      check (aws_route_generation >= 0);
  end if;
end
$$;

create table if not exists public.aws_frontend_publications (
  version_id uuid primary key
    references public.project_published_versions (id) on delete cascade,
  project_id text not null
    references public.projects (project_id) on delete cascade,
  owner_id uuid not null
    references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_wait', 'complete', 'failed')),
  routing_generation bigint not null default 0 check (routing_generation >= 0),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null)
  )
);

create table if not exists public.aws_frontend_unpublish_jobs (
  project_id text primary key
    references public.projects (project_id) on delete cascade,
  owner_id uuid not null
    references auth.users (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_wait', 'complete', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  routing_generation bigint not null default 0 check (routing_generation >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null)
  )
);

create index if not exists aws_frontend_publications_ready_idx
  on public.aws_frontend_publications (next_attempt_at, created_at)
  where status in ('queued', 'retry_wait');

create index if not exists aws_frontend_publications_expired_lease_idx
  on public.aws_frontend_publications (lease_expires_at)
  where status = 'processing';

create unique index if not exists aws_frontend_publications_active_project_idx
  on public.aws_frontend_publications (project_id)
  where status in ('queued', 'processing', 'retry_wait');

create index if not exists aws_frontend_unpublish_jobs_ready_idx
  on public.aws_frontend_unpublish_jobs (next_attempt_at, created_at)
  where status in ('queued', 'retry_wait');

create index if not exists aws_frontend_unpublish_jobs_expired_lease_idx
  on public.aws_frontend_unpublish_jobs (lease_expires_at)
  where status = 'processing';

alter table public.aws_frontend_publications enable row level security;
alter table public.aws_frontend_unpublish_jobs enable row level security;
revoke all on public.aws_frontend_publications from anon, authenticated;
revoke all on public.aws_frontend_unpublish_jobs from anon, authenticated;
grant select, insert, update, delete on public.aws_frontend_publications to service_role;
grant select, insert, update, delete on public.aws_frontend_unpublish_jobs to service_role;

create or replace function public.guard_aws_published_version_mutations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version_id uuid;
begin
  if auth.role() <> 'authenticated' or pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_version_id := case when tg_op = 'DELETE' then old.id else new.id end;
  if exists (
    select 1
      from public.aws_frontend_publications j
     where j.version_id = v_version_id
       and j.status <> 'failed'
  ) or exists (
    select 1
      from public.project_deployments d
     where d.provider = 'aws'
       and d.active_version_id = v_version_id
  ) then
    raise exception 'AWS_PUBLICATION_IMMUTABLE' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_aws_published_version_mutations
  on public.project_published_versions;
create trigger guard_aws_published_version_mutations
  before update or delete on public.project_published_versions
  for each row execute function public.guard_aws_published_version_mutations();

create or replace function public.guard_aws_published_file_mutations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version_id uuid := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  v_status text;
begin
  if auth.role() <> 'authenticated' or pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select v.status into v_status
    from public.project_published_versions v
   where v.id = v_version_id
   for update;
  if v_status is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if v_status <> 'draft' or exists (
    select 1
      from public.aws_frontend_publications j
     where j.version_id = v_version_id
       and j.status <> 'failed'
  ) then
    raise exception 'AWS_PUBLICATION_IMMUTABLE' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_aws_published_file_mutations
  on public.project_published_files;
create trigger guard_aws_published_file_mutations
  before insert or delete on public.project_published_files
  for each row execute function public.guard_aws_published_file_mutations();

revoke all on function public.guard_aws_published_version_mutations() from public, anon, authenticated;
revoke all on function public.guard_aws_published_file_mutations() from public, anon, authenticated;

create or replace function public.aws_frontend_hosting_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 51;
$$;

revoke all on function public.aws_frontend_hosting_schema_version() from public, anon;
grant execute on function public.aws_frontend_hosting_schema_version()
  to authenticated, service_role;

create or replace function public.enqueue_aws_frontend_publication(
  p_project_id text,
  p_version_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_bytes bigint;
  v_expected_count integer;
  v_expected_bytes bigint;
begin
  if auth.uid() is null or not exists (
    select 1
      from public.projects p
     where p.project_id = p_project_id
       and p.user_id = auth.uid()
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.project_deployments d
     where d.project_id = p_project_id
       and d.provider = 'aws'
       and d.status = 'queued'
  ) then
    raise exception 'DEPLOYMENT_NOT_QUEUED' using errcode = '22023';
  end if;

  select v.file_count, v.byte_count
    into v_expected_count, v_expected_bytes
    from public.project_published_versions v
   where v.id = p_version_id
     and v.project_id = p_project_id
     and v.status = 'draft'
   for update;
  if not found then
    raise exception 'INVALID_PUBLICATION' using errcode = '22023';
  end if;

  select count(*)::integer, coalesce(sum(f.size_bytes), 0)
    into v_count, v_bytes
    from public.project_published_files f
   where f.version_id = p_version_id;

  if v_expected_count <> v_count
     or v_expected_bytes <> v_bytes
     or v_count not between 1 and 1000
     or v_bytes not between 1 and 8000000 then
    raise exception 'INVALID_PUBLICATION' using errcode = '22023';
  end if;

  insert into public.aws_frontend_publications (version_id, project_id, owner_id)
  values (p_version_id, p_project_id, auth.uid())
  on conflict (version_id) do nothing;

  return p_version_id;
end;
$$;

revoke all on function public.enqueue_aws_frontend_publication(text, uuid) from public, anon;
grant execute on function public.enqueue_aws_frontend_publication(text, uuid) to authenticated;

create or replace function public.claim_aws_frontend_publication()
returns table (
  project_id text,
  version_id uuid,
  owner_id uuid,
  lease_token uuid,
  attempt_count integer,
  routing_generation bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_id text;
  v_version_id uuid;
  v_generation bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.aws_frontend_publications
     set status = 'failed',
         lease_token = null,
         lease_expires_at = null,
         error_code = 'PUBLICATION_FAILED',
         updated_at = now()
   where status = 'processing'
     and lease_expires_at <= now()
     and attempt_count >= 8;

  update public.project_deployments d
     set status = 'error',
         error_code = 'PUBLICATION_FAILED',
         error_message = 'The AWS publication could not be completed.',
         updated_at = now()
    from public.aws_frontend_publications j
   where j.project_id = d.project_id
     and j.status = 'failed'
     and j.error_code = 'PUBLICATION_FAILED'
     and d.provider = 'aws'
     and d.status = 'building'
     and d.aws_route_generation = j.routing_generation
     and not exists (
       select 1
         from public.aws_frontend_publications active
        where active.project_id = d.project_id
          and active.status in ('queued', 'processing', 'retry_wait')
     );

  select j.project_id, j.version_id
    into v_project_id, v_version_id
    from public.aws_frontend_publications j
    join public.project_deployments d
      on d.project_id = j.project_id
     and d.provider = 'aws'
     and d.status in ('queued', 'building')
   where (
     j.status in ('queued', 'retry_wait')
     and j.next_attempt_at <= now()
   ) or (
     j.status = 'processing'
     and j.lease_expires_at <= now()
     and j.attempt_count < 8
   )
   order by j.next_attempt_at, j.created_at
   for update of j, d skip locked
   limit 1;
  if not found then return; end if;

  update public.project_deployments
     set status = 'building',
         aws_route_generation = aws_route_generation + 1,
         updated_at = now()
   where project_id = v_project_id
     and provider = 'aws'
     and status in ('queued', 'building')
  returning aws_route_generation into v_generation;
  if not found then return; end if;

  return query
  update public.aws_frontend_publications j
     set status = 'processing',
         attempt_count = least(j.attempt_count + 1, 8),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + interval '7 minutes',
         routing_generation = v_generation,
         updated_at = now()
   where j.version_id = v_version_id
  returning
    j.project_id,
    j.version_id,
    j.owner_id,
    j.lease_token,
    j.attempt_count,
    j.routing_generation;
end;
$$;

revoke all on function public.claim_aws_frontend_publication() from public, anon, authenticated;
grant execute on function public.claim_aws_frontend_publication() to service_role;

create or replace function public.renew_aws_frontend_publication(
  p_version_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.aws_frontend_publications
     set lease_expires_at = now() + interval '7 minutes',
         updated_at = now()
   where version_id = p_version_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now();

  return found;
end;
$$;

revoke all on function public.renew_aws_frontend_publication(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.renew_aws_frontend_publication(uuid, uuid)
  to service_role;

create or replace function public.fail_aws_frontend_publication(
  p_version_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.aws_frontend_publications%rowtype;
  v_retry boolean;
  v_delay_seconds integer;
  v_safe_code text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_safe_code := case
    when p_error_code in (
      'INVALID_MANIFEST',
      'S3_OBJECT_CONFLICT',
      'S3_UPLOAD_FAILED',
      'KEY_VALUE_STORE_FAILED',
      'PUBLICATION_ACTIVATION_FAILED'
    ) then p_error_code
    else 'PUBLICATION_FAILED'
  end;

  select * into v_job
    from public.aws_frontend_publications
   where version_id = p_version_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now()
   for update;
  if not found then
    raise exception 'LEASE_LOST' using errcode = '40001';
  end if;

  v_retry := p_retryable and v_job.attempt_count < 8;
  v_delay_seconds := least(
    300,
    15 * (2 ^ greatest(v_job.attempt_count - 1, 0))::integer
  );

  update public.aws_frontend_publications
     set status = case when v_retry then 'retry_wait' else 'failed' end,
         next_attempt_at = case
           when v_retry then now() + make_interval(secs => v_delay_seconds)
           else next_attempt_at
         end,
         lease_token = null,
         lease_expires_at = null,
         error_code = v_safe_code,
         updated_at = now()
   where version_id = p_version_id;

  if not v_retry then
    update public.project_deployments
       set status = 'error',
           error_code = v_safe_code,
           error_message = 'The AWS publication could not be completed.',
           updated_at = now()
     where project_id = v_job.project_id
       and provider = 'aws'
       and status in ('queued', 'building')
       and aws_route_generation = v_job.routing_generation;
  end if;

  return case when v_retry then 'retry_wait' else 'failed' end;
end;
$$;

revoke all on function public.fail_aws_frontend_publication(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_aws_frontend_publication(uuid, uuid, text, boolean)
  to service_role;

create or replace function public.complete_aws_frontend_publication(
  p_version_id uuid,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.aws_frontend_publications%rowtype;
  v_version public.project_published_versions%rowtype;
  v_hostname text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_job
    from public.aws_frontend_publications
   where version_id = p_version_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now()
   for update;
  if not found then
    raise exception 'LEASE_LOST' using errcode = '40001';
  end if;

  select * into v_version
    from public.project_published_versions
   where id = p_version_id
     and project_id = v_job.project_id
     and status in ('draft', 'active');
  if not found then
    raise exception 'VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_hostname := lower(v_job.project_id) || '.mavly.xyz';

  update public.project_published_versions
     set status = 'superseded', superseded_at = now()
   where project_id = v_job.project_id
     and status = 'active'
     and id <> p_version_id;

  update public.project_published_versions
     set status = 'active',
         activated_at = coalesce(activated_at, now()),
         superseded_at = null
   where id = p_version_id;

  update public.project_deployments
     set provider = 'aws',
         status = 'ready',
         active_version_id = p_version_id,
         mavly_hostname = v_hostname,
         mavly_domain_status = 'pending',
         mavly_domain_error = null,
         mavly_domain_checked_at = null,
         vercel_deployment_id = null,
         url = null,
         error_code = null,
         error_message = null,
         last_published_at = now(),
         updated_at = now()
   where project_id = v_job.project_id
     and provider = 'aws'
     and status = 'building'
     and aws_route_generation = v_job.routing_generation;

  if not found then
    raise exception 'DEPLOYMENT_STATE_CHANGED' using errcode = '40001';
  end if;

  update public.aws_frontend_publications
     set status = 'complete',
         lease_token = null,
         lease_expires_at = null,
         error_code = null,
         updated_at = now(),
         completed_at = now()
   where version_id = p_version_id;
end;
$$;

revoke all on function public.complete_aws_frontend_publication(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_aws_frontend_publication(uuid, uuid)
  to service_role;

create or replace function public.enqueue_aws_frontend_unpublish(
  p_project_id text,
  p_lease_updated_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1
      from public.projects p
     where p.project_id = p_project_id
       and p.user_id = auth.uid()
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.project_deployments d
     where d.project_id = p_project_id
       and d.provider = 'aws'
       and d.status = 'unpublishing'
       and d.updated_at = p_lease_updated_at
  ) then
    raise exception 'DEPLOYMENT_NOT_UNPUBLISHING' using errcode = '22023';
  end if;

  insert into public.aws_frontend_unpublish_jobs (project_id, owner_id)
  values (p_project_id, auth.uid())
  on conflict (project_id) do update
     set owner_id = excluded.owner_id,
         status = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then 'queued'
           else public.aws_frontend_unpublish_jobs.status
         end,
         attempt_count = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then 0
           else public.aws_frontend_unpublish_jobs.attempt_count
         end,
         next_attempt_at = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then now()
           else public.aws_frontend_unpublish_jobs.next_attempt_at
         end,
         lease_token = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then null
           else public.aws_frontend_unpublish_jobs.lease_token
         end,
         lease_expires_at = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then null
           else public.aws_frontend_unpublish_jobs.lease_expires_at
         end,
         error_code = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then null
           else public.aws_frontend_unpublish_jobs.error_code
         end,
         completed_at = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then null
           else public.aws_frontend_unpublish_jobs.completed_at
         end,
         updated_at = case
           when public.aws_frontend_unpublish_jobs.status in ('complete', 'failed')
             then now()
           else public.aws_frontend_unpublish_jobs.updated_at
         end;

  return true;
end;
$$;

revoke all on function public.enqueue_aws_frontend_unpublish(text, timestamptz)
  from public, anon;
grant execute on function public.enqueue_aws_frontend_unpublish(text, timestamptz)
  to authenticated;

create or replace function public.claim_aws_frontend_unpublish()
returns table (
  project_id text,
  owner_id uuid,
  lease_token uuid,
  attempt_count integer,
  routing_generation bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_id text;
  v_generation bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.aws_frontend_unpublish_jobs
     set status = 'failed',
         lease_token = null,
         lease_expires_at = null,
         error_code = 'ROUTE_REMOVAL_FAILED',
         updated_at = now()
   where status = 'processing'
     and lease_expires_at <= now()
     and attempt_count >= 8;

  select j.project_id
    into v_project_id
    from public.aws_frontend_unpublish_jobs j
    join public.project_deployments d
      on d.project_id = j.project_id
     and d.provider = 'aws'
     and d.status = 'unpublishing'
   where (
     j.status in ('queued', 'retry_wait')
     and j.next_attempt_at <= now()
   ) or (
     j.status = 'processing'
     and j.lease_expires_at <= now()
     and j.attempt_count < 8
   )
   order by j.next_attempt_at, j.created_at
   for update of j, d skip locked
   limit 1;
  if not found then return; end if;

  update public.project_deployments
     set aws_route_generation = aws_route_generation + 1,
         updated_at = now()
   where project_id = v_project_id
     and provider = 'aws'
     and status = 'unpublishing'
  returning aws_route_generation into v_generation;
  if not found then return; end if;

  return query
  update public.aws_frontend_unpublish_jobs j
     set status = 'processing',
         attempt_count = least(j.attempt_count + 1, 8),
         lease_token = gen_random_uuid(),
         lease_expires_at = now() + interval '7 minutes',
         routing_generation = v_generation,
         updated_at = now()
   where j.project_id = v_project_id
  returning j.project_id, j.owner_id, j.lease_token, j.attempt_count, j.routing_generation;
end;
$$;

revoke all on function public.claim_aws_frontend_unpublish() from public, anon, authenticated;
grant execute on function public.claim_aws_frontend_unpublish() to service_role;

create or replace function public.fail_aws_frontend_unpublish(
  p_project_id text,
  p_lease_token uuid,
  p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.aws_frontend_unpublish_jobs%rowtype;
  v_retry boolean;
  v_delay_seconds integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_job
    from public.aws_frontend_unpublish_jobs
   where project_id = p_project_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now()
   for update;
  if not found then
    raise exception 'LEASE_LOST' using errcode = '40001';
  end if;

  v_retry := p_retryable and v_job.attempt_count < 8;
  v_delay_seconds := least(
    300,
    15 * (2 ^ greatest(v_job.attempt_count - 1, 0))::integer
  );
  update public.aws_frontend_unpublish_jobs
     set status = case when v_retry then 'retry_wait' else 'failed' end,
         next_attempt_at = case
           when v_retry then now() + make_interval(secs => v_delay_seconds)
           else next_attempt_at
         end,
         lease_token = null,
         lease_expires_at = null,
         error_code = 'ROUTE_REMOVAL_FAILED',
         updated_at = now()
   where project_id = p_project_id;
  return case when v_retry then 'retry_wait' else 'failed' end;
end;
$$;

revoke all on function public.fail_aws_frontend_unpublish(text, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_aws_frontend_unpublish(text, uuid, boolean)
  to service_role;

create or replace function public.complete_aws_frontend_unpublish(
  p_project_id text,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.aws_frontend_unpublish_jobs%rowtype;
  v_version_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_job
    from public.aws_frontend_unpublish_jobs
   where project_id = p_project_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now()
   for update;
  if not found then
    raise exception 'LEASE_LOST' using errcode = '40001';
  end if;

  select d.active_version_id
    into v_version_id
    from public.project_deployments d
   where d.project_id = p_project_id
     and d.provider = 'aws'
     and d.status = 'unpublishing'
     and d.aws_route_generation = v_job.routing_generation
   for update;
  if not found then
    raise exception 'DEPLOYMENT_STATE_CHANGED' using errcode = '40001';
  end if;

  if v_version_id is not null then
    update public.project_published_versions
       set status = 'superseded',
           superseded_at = coalesce(superseded_at, now())
     where id = v_version_id
       and project_id = p_project_id
       and status = 'active';
  end if;

  update public.project_deployments
     set status = 'unpublished',
         active_version_id = null,
         vercel_deployment_id = null,
         url = null,
         error_code = null,
         error_message = null,
         mavly_domain_status = null,
         mavly_domain_error = null,
         mavly_domain_checked_at = null,
         last_unpublished_at = now(),
         updated_at = now()
   where project_id = p_project_id
     and provider = 'aws'
     and status = 'unpublishing'
     and aws_route_generation = v_job.routing_generation;
  if not found then
    raise exception 'DEPLOYMENT_STATE_CHANGED' using errcode = '40001';
  end if;

  update public.aws_frontend_unpublish_jobs
     set status = 'complete',
         lease_token = null,
         lease_expires_at = null,
         error_code = null,
         updated_at = now(),
         completed_at = now()
   where project_id = p_project_id;
end;
$$;

revoke all on function public.complete_aws_frontend_unpublish(text, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_aws_frontend_unpublish(text, uuid)
  to service_role;

commit;
