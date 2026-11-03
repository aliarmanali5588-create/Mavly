-- AWS frontend hosting corrective fencing and worker-verified status.
--
-- Apply after migrations 14, 15, 32, 49, 51 and 55. This is additive and must be
-- applied as a new migration; it does not rewrite migration 51 in an existing
-- database. It adds no AWS resources and does not change Vercel/shared rows.

begin;

do $$
declare
  v_shared integer;
  v_worker integer;
  v_restriction integer;
  v_aws integer;
begin
  if to_regprocedure('public.shared_hosting_schema_version()') is null then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 15_shared_hosting_attempt_state.sql is required';
  end if;
  execute 'select public.shared_hosting_schema_version()' into v_shared;
  if v_shared < 15 then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 15_shared_hosting_attempt_state.sql is outdated';
  end if;
  if to_regprocedure('public.generation_worker_schema_version()') is null then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 32_credit_reliability_hardening.sql is required';
  end if;
  execute 'select public.generation_worker_schema_version()' into v_worker;
  if v_worker < 32 then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 32_credit_reliability_hardening.sql is required';
  end if;
  if to_regprocedure('public.account_restriction_schema_version()') is null then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 49_account_restriction_reason.sql is required';
  end if;
  execute 'select public.account_restriction_schema_version()' into v_restriction;
  if v_restriction < 49 then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 49_account_restriction_reason.sql is required';
  end if;
  if to_regprocedure('public.aws_frontend_hosting_schema_version()') is null then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 51_aws_frontend_deployment.sql is required';
  end if;
  execute 'select public.aws_frontend_hosting_schema_version()' into v_aws;
  if v_aws < 51 then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: migration 51_aws_frontend_deployment.sql is outdated';
  end if;
  if to_regclass('public.project_deployments') is null then
    raise exception 'AWS_FRONTEND_FENCING_PREREQUISITE_MISSING: project_deployments is required';
  end if;
end
$$;

-- Migration 20 is not a prerequisite. Protect the same sensitive columns here,
-- while retaining the legacy Vercel/shared columns that the caller-scoped
-- deployment service legitimately updates.
revoke update on public.project_deployments from authenticated;
grant update (
  provider,
  vercel_project_id,
  vercel_project_name,
  vercel_deployment_id,
  status,
  url,
  error_code,
  error_message,
  mavly_hostname,
  mavly_domain_status,
  mavly_domain_error,
  mavly_domain_checked_at,
  active_version_id,
  last_published_at,
  last_unpublished_at,
  updated_at
) on public.project_deployments to authenticated;

-- A private, transaction-local nonce lets the owner-scoped verification RPC
-- cross the authenticated mutation trigger without giving callers a reusable
-- bypass setting. No application role can read or write this table.
create table if not exists public.aws_frontend_mutation_nonces (
  nonce uuid primary key,
  purpose text not null check (purpose = 'publication_enqueue'),
  created_at timestamptz not null default now()
);
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.aws_frontend_mutation_nonces'::regclass
       and conname = 'aws_frontend_mutation_nonces_purpose_check'
  ) then
    alter table public.aws_frontend_mutation_nonces
      add constraint aws_frontend_mutation_nonces_purpose_check
      check (purpose = 'publication_enqueue');
  end if;
end
$$;
revoke all on public.aws_frontend_mutation_nonces from public, anon, authenticated, service_role;

create or replace function public.guard_aws_deployment_mutations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if auth.role() = 'authenticated'
     and exists (
       select 1
         from public.aws_frontend_mutation_nonces n
        where n.nonce::text = current_setting('mavly.aws_mutation_nonce', true)
          and n.purpose = 'publication_enqueue'
     ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.provider = 'aws' and (
      new.status <> 'queued'
      or new.active_version_id is not null
      or new.aws_route_generation <> 0
    ) then
      raise exception 'AWS_DEPLOYMENT_MUTATION_FORBIDDEN' using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.provider = 'aws' and old.status <> 'unpublished' then
      raise exception 'AWS_PUBLICATION_MUST_BE_UNPUBLISHED' using errcode = '42501';
    end if;
    return old;
  end if;

  if old.project_id is distinct from new.project_id
     and (old.provider = 'aws' or new.provider = 'aws') then
    raise exception 'AWS_PROJECT_ID_IMMUTABLE' using errcode = '42501';
  end if;

  if old.provider = 'aws' or new.provider = 'aws' then
    if old.provider = 'aws' and new.provider <> 'aws' then
      raise exception 'AWS_DEPLOYMENT_PROVIDER_IMMUTABLE' using errcode = '42501';
    end if;
    if old.provider <> 'aws' and new.provider = 'aws' then
      raise exception 'AWS_DEPLOYMENT_MIGRATION_REQUIRED' using errcode = '42501';
    end if;
    if new.provider = 'aws'
       and old.status is distinct from new.status
       and new.status not in ('queued', 'error', 'canceled', 'unpublishing') then
      raise exception 'AWS_DEPLOYMENT_STATE_WORKER_ONLY' using errcode = '42501';
    end if;
    if new.provider = 'aws'
       and old.status is distinct from new.status
       and new.status = 'ready'
       and old.status <> 'unpublishing' then
      raise exception 'AWS_DEPLOYMENT_STATE_WORKER_ONLY' using errcode = '42501';
    end if;
    if old.provider = 'aws' and new.active_version_id is distinct from old.active_version_id then
      raise exception 'AWS_ACTIVE_VERSION_WORKER_ONLY' using errcode = '42501';
    end if;
    if old.provider = 'aws' and new.aws_route_generation is distinct from old.aws_route_generation then
      raise exception 'AWS_ROUTE_GENERATION_WORKER_ONLY' using errcode = '42501';
    end if;
    if new.provider = 'aws'
       and new.mavly_hostname is distinct from old.mavly_hostname
       and not (
         new.status = 'queued'
         and new.active_version_id is null
         and new.mavly_hostname = lower(new.project_id) || '.mavly.xyz'
       ) then
      raise exception 'AWS_HOSTNAME_WORKER_ONLY' using errcode = '42501';
    end if;
    if new.provider = 'aws'
       and (
         new.mavly_domain_status is distinct from old.mavly_domain_status
         or new.mavly_domain_error is distinct from old.mavly_domain_error
         or new.mavly_domain_checked_at is distinct from old.mavly_domain_checked_at
       )
       and not (
         new.status = 'queued'
         and new.mavly_domain_status = 'pending'
         and new.mavly_domain_error is null
         and new.mavly_domain_checked_at is null
       ) then
      raise exception 'AWS_DOMAIN_STATE_WORKER_ONLY' using errcode = '42501';
    end if;
    if new.provider = 'aws'
       and (
         new.last_published_at is distinct from old.last_published_at
         or new.last_unpublished_at is distinct from old.last_unpublished_at
       ) then
      raise exception 'AWS_PUBLICATION_TIMESTAMP_WORKER_ONLY' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_aws_deployment_mutations on public.project_deployments;
create trigger guard_aws_deployment_mutations
  before insert or update or delete on public.project_deployments
  for each row execute function public.guard_aws_deployment_mutations();

-- Queueing also records the server-derived hostname and pending domain state.
-- The caller cannot patch those AWS metadata fields directly.
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
  v_hostname text;
  v_nonce uuid := gen_random_uuid();
begin
  if auth.role() <> 'authenticated' or auth.uid() is null or not exists (
    select 1
      from public.projects p
     where p.project_id = p_project_id
       and p.user_id = auth.uid()
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  v_hostname := public.mavly_tenant_hostname(p_project_id || '.mavly.xyz');
  if v_hostname is null then
    raise exception 'INVALID_HOSTNAME' using errcode = '22023';
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

  insert into public.aws_frontend_mutation_nonces (nonce, purpose)
  values (v_nonce, 'publication_enqueue');
  perform set_config('mavly.aws_mutation_nonce', v_nonce::text, true);
  update public.project_deployments
     set mavly_hostname = v_hostname,
         mavly_domain_status = 'pending',
         mavly_domain_error = null,
         mavly_domain_checked_at = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where project_id = p_project_id
     and provider = 'aws'
     and status = 'queued';
  if not found then
    delete from public.aws_frontend_mutation_nonces where nonce = v_nonce;
    raise exception 'DEPLOYMENT_STATE_CHANGED' using errcode = '40001';
  end if;
  delete from public.aws_frontend_mutation_nonces where nonce = v_nonce;

  return p_version_id;
end;
$$;

revoke all on function public.enqueue_aws_frontend_publication(text, uuid) from public, anon;
grant execute on function public.enqueue_aws_frontend_publication(text, uuid) to authenticated;

create or replace function public.authorize_aws_frontend_route_restore(
  p_project_id text,
  p_version_id uuid,
  p_lease_token uuid,
  p_routing_generation bigint,
  p_expected_active_version_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_version_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform 1
    from public.aws_frontend_publications j
   where j.project_id = p_project_id
     and j.version_id = p_version_id
     and j.status = 'processing'
     and j.lease_token = p_lease_token
     and j.lease_expires_at > now()
     and j.routing_generation = p_routing_generation
   for update;
  if not found then
    return false;
  end if;

  select d.active_version_id
    into v_active_version_id
    from public.project_deployments d
   where d.project_id = p_project_id
     and d.provider = 'aws'
     and d.status = 'building'
     and d.aws_route_generation = p_routing_generation
   for update;
  if not found or v_active_version_id is distinct from p_expected_active_version_id then
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.authorize_aws_frontend_route_restore(text, uuid, uuid, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_aws_frontend_route_restore(text, uuid, uuid, bigint, uuid)
  to service_role;

create or replace function public.authorize_aws_frontend_route_activation(
  p_project_id text,
  p_version_id uuid,
  p_lease_token uuid,
  p_routing_generation bigint
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

  perform 1
    from public.aws_frontend_publications j
   where j.project_id = p_project_id
     and j.version_id = p_version_id
     and j.status = 'processing'
     and j.lease_token = p_lease_token
     and j.lease_expires_at > now()
     and j.routing_generation = p_routing_generation
   for update;
  if not found then
    return false;
  end if;

  return exists (
    select 1
      from public.project_deployments d
     where d.project_id = p_project_id
       and d.provider = 'aws'
       and d.status = 'building'
       and d.aws_route_generation = p_routing_generation
  );
end;
$$;

revoke all on function public.authorize_aws_frontend_route_activation(text, uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.authorize_aws_frontend_route_activation(text, uuid, uuid, bigint)
  to service_role;

-- Migration 51 intentionally left the domain pending until a later read. The
-- worker has already performed the exact-host, exact-version public probe before
-- calling this fenced completion RPC, so migration 56 records that proof atomically
-- with activation. This replaces the 51 definition for databases that already ran it.
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
         mavly_domain_status = 'verified',
         mavly_domain_error = null,
         mavly_domain_checked_at = now(),
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

create or replace function public.aws_frontend_fencing_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 56;
$$;

revoke all on function public.aws_frontend_fencing_schema_version() from public, anon;
grant execute on function public.aws_frontend_fencing_schema_version()
  to authenticated, service_role;

commit;
