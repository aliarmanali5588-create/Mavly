-- Domain management (Mavly-managed subdomains + customer-owned custom domains).
--
-- Apply after 57_platform_billing.sql (subscriptions), 56 (AWS fencing marker),
-- 50 (admin_audit_log) and 18 (admin allowlist). This migration is additive:
--   · it creates a domain registry, an append-only audit trail and a durable
--     provisioning queue processed by the EXISTING EC2 generation worker;
--   · it never rewrites an existing deployment, published version, file, credit,
--     billing or AWS row;
--   · it never changes DNS, CloudFront, certificates or production mappings.
--
-- Authority split:
--   authenticated owners  — read their own rows, request reservation/verification/
--                           provisioning; they CANNOT write authoritative
--                           verification, DNS, SSL, routing or publication state.
--   service_role worker   — claims one domain job, performs DNS/provider work and
--                           writes the terminal result through a fenced RPC.
--   admin                 — read-only overview plus an explicit routing approval
--                           for a custom hostname, written to admin_audit_log.
--
-- The canonical `<project-id>.mavly.xyz` hostname is NOT stored here: it remains
-- derived from the immutable project id by the existing publication path. Rows in
-- this table are additive aliases and customer-owned hostnames only.

begin;

do $$
declare
  v_aws integer;
begin
  if to_regclass('public.projects') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 02_create_projects.sql first';
  end if;
  if to_regclass('public.project_deployments') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 07_project_deployments.sql first';
  end if;
  if to_regclass('public.project_published_versions') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 14_shared_hosting.sql first';
  end if;
  -- `domain_entitlements_for_user` reads the canonical subscription row to pick a
  -- plan, so the table itself is the dependency. It deliberately does NOT call
  -- `billing_user_entitlements()`: that function answers a different question
  -- (project and published-site ceilings) and coupling the domain registry to it
  -- would refuse a valid install for a reason this migration never uses.
  if to_regclass('public.subscriptions') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 57_platform_billing.sql first';
  end if;
  -- Checked BEFORE it is called. The previous order executed the function first,
  -- so a deployment missing migration 56 got an undefined-function error instead
  -- of the sentence that names the file to apply.
  if to_regprocedure('public.aws_frontend_fencing_schema_version()') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 56_aws_frontend_fencing_and_status.sql first';
  end if;
  execute 'select public.aws_frontend_fencing_schema_version()' into v_aws;
  if v_aws < 56 then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: migration 56_aws_frontend_fencing_and_status.sql is outdated';
  end if;
  if to_regprocedure('public.current_user_is_admin()') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 18_admin_allowlist.sql first';
  end if;
  if to_regclass('public.admin_audit_log') is null then
    raise exception 'DOMAIN_PREREQUISITE_MISSING: apply 50_admin_console_backend.sql first';
  end if;
end
$$;

create or replace function public.domain_management_schema_version()
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$ select 62 $$;

revoke all on function public.domain_management_schema_version() from public, anon;
grant execute on function public.domain_management_schema_version() to authenticated, service_role;

-- ── Plan entitlements (database-driven, additive) ───────────────────────────
--
-- The canonical price catalog remains the plan source. This table only maps a
-- canonical plan id to domain allowances. Unknown plans and `free` are
-- restrictive by default; operators change these numbers through a reviewed
-- service-role write, never through a customer request.

create table if not exists public.domain_plan_limits (
  plan_id text primary key,
  max_custom_domains integer not null default 0,
  max_subdomain_aliases integer not null default 0,
  max_active_domains integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint domain_plan_limits_custom_check check (max_custom_domains between 0 and 100),
  constraint domain_plan_limits_alias_check check (max_subdomain_aliases between 0 and 100),
  constraint domain_plan_limits_active_check check (max_active_domains between 0 and 200)
);

insert into public.domain_plan_limits (plan_id, max_custom_domains, max_subdomain_aliases, max_active_domains)
values
  ('free', 0, 0, 0),
  ('starter', 1, 1, 2),
  ('creator', 3, 2, 5),
  ('pro', 10, 5, 15),
  ('agency', 25, 10, 35)
on conflict (plan_id) do nothing;

alter table public.domain_plan_limits enable row level security;
revoke all on public.domain_plan_limits from public, anon, authenticated;
grant select, insert, update, delete on public.domain_plan_limits to service_role;

-- ── Domain registry ─────────────────────────────────────────────────────────

create table if not exists public.project_domains (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  hostname text not null,
  domain_type text not null,
  status text not null default 'pending',
  dns_status text not null default 'unchecked',
  ssl_status text not null default 'not_started',
  publication_status text not null default 'pending',
  is_primary boolean not null default false,
  verification_token text,
  verification_token_hash text,
  verification_record_name text,
  certificate_reference text,
  routing_provider text not null default 'none',
  routing_generation bigint not null default 0,
  last_verified_at timestamptz,
  last_checked_at timestamptz,
  failure_code text,
  failure_message text,
  retry_count integer not null default 0,
  next_retry_at timestamptz,
  routing_approved_at timestamptz,
  routing_approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  constraint project_domains_type_check check (domain_type in ('mavly_subdomain', 'custom')),
  constraint project_domains_status_check check (status in (
    'pending', 'verification_required', 'verifying', 'verified', 'provisioning',
    'active', 'misconfigured', 'ssl_pending', 'ssl_failed', 'disabled',
    'removing', 'removed'
  )),
  constraint project_domains_dns_check check (dns_status in (
    'unchecked', 'pending', 'ready', 'misconfigured', 'error'
  )),
  constraint project_domains_ssl_check check (ssl_status in (
    'not_started', 'pending', 'provisioning', 'active', 'failed', 'expired'
  )),
  constraint project_domains_publication_check check (publication_status in (
    'pending', 'provisioning', 'active', 'failed', 'removed'
  )),
  constraint project_domains_routing_provider_check check (routing_provider in (
    'none', 'aws_cloudfront', 'shared', 'vercel', 'manual'
  )),
  constraint project_domains_hostname_lower_check check (hostname = lower(hostname)),
  constraint project_domains_hostname_length_check check (char_length(hostname) between 4 and 253),
  constraint project_domains_hostname_shape_check check (
    hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint project_domains_hostname_not_ip_check check (
    hostname !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
  ),
  constraint project_domains_mavly_shape_check check (
    domain_type <> 'mavly_subdomain'
    or (
      hostname ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?\.mavly\.xyz$'
      and hostname not like '%--%'
      and hostname not like 'xn--%'
    )
  ),
  constraint project_domains_custom_not_mavly_check check (
    domain_type <> 'custom' or hostname not like '%.mavly.xyz'
  ),
  constraint project_domains_custom_not_platform_check check (
    domain_type <> 'custom'
    or (
      hostname not like '%.vercel.app'
      and hostname not like '%.supabase.co'
      and hostname not like '%.local'
      and hostname not like '%.test'
      and hostname not like '%.invalid'
      and hostname not like '%.example'
    )
  ),
  constraint project_domains_failure_code_len check (
    failure_code is null or char_length(failure_code) between 1 and 80
  ),
  constraint project_domains_failure_message_len check (
    failure_message is null or char_length(failure_message) between 1 and 500
  ),
  constraint project_domains_token_hash_shape check (
    verification_token_hash is null or verification_token_hash ~ '^[a-f0-9]{64}$'
  )
);

comment on table public.project_domains is
  'Additive alias/custom-domain registry. The canonical <project-id>.mavly.xyz hostname stays derived from projects.project_id and is never a row here. Every authoritative state column is written only by a service-role worker RPC.';

create unique index if not exists project_domains_hostname_live_key
  on public.project_domains (hostname)
  where status <> 'removed';
create unique index if not exists project_domains_one_primary_idx
  on public.project_domains (project_id)
  where is_primary;
create index if not exists project_domains_project_idx
  on public.project_domains (project_id, created_at desc);
create index if not exists project_domains_owner_idx
  on public.project_domains (user_id, created_at desc);
create index if not exists project_domains_status_idx
  on public.project_domains (status, updated_at desc);
create index if not exists project_domains_hostname_idx
  on public.project_domains (hostname);

-- ── Append-only domain events (owner + admin audit) ─────────────────────────

create table if not exists public.project_domain_events (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid references public.project_domains (id) on delete set null,
  -- Nullable ON PURPOSE: events are an audit trail that survives project
  -- deletion. The append-only trigger below would otherwise abort the cascade.
  project_id text references public.projects (project_id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_kind text not null default 'owner',
  event text not null,
  outcome text not null default 'info',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint project_domain_events_actor_check check (actor_kind in ('owner', 'worker', 'admin', 'system')),
  constraint project_domain_events_outcome_check check (outcome in ('info', 'success', 'failure')),
  constraint project_domain_events_event_len check (char_length(btrim(event)) between 1 and 120),
  constraint project_domain_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists project_domain_events_project_idx
  on public.project_domain_events (project_id, created_at desc);
create index if not exists project_domain_events_domain_idx
  on public.project_domain_events (domain_id, created_at desc);

create or replace function public.project_domain_events_reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'DOMAIN_EVENTS_APPEND_ONLY' using errcode = 'P0001';
end;
$$;

drop trigger if exists project_domain_events_append_only on public.project_domain_events;
create trigger project_domain_events_append_only
  before update or delete on public.project_domain_events
  for each row execute function public.project_domain_events_reject_mutation();

-- ── Durable provisioning queue (claimed by the existing worker) ─────────────

create table if not exists public.project_domain_jobs (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references public.project_domains (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_domain_jobs_action_check check (action in ('verify', 'provision', 'remove')),
  constraint project_domain_jobs_status_check check (status in (
    'queued', 'processing', 'retry_wait', 'completed', 'failed'
  )),
  constraint project_domain_jobs_attempt_check check (attempt_count between 0 and 10)
);

create unique index if not exists project_domain_jobs_one_active_idx
  on public.project_domain_jobs (domain_id)
  where status in ('queued', 'processing', 'retry_wait');
create index if not exists project_domain_jobs_claim_idx
  on public.project_domain_jobs (status, next_attempt_at, created_at);

-- ── Durable verification/provisioning rate windows ─────────────────────────

create table if not exists public.domain_rate_windows (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, action, window_start),
  constraint domain_rate_windows_count_check check (count >= 0)
);

revoke all on public.domain_rate_windows from public, anon, authenticated;
grant select, insert, update, delete on public.domain_rate_windows to service_role;

create or replace function public.consume_domain_rate_limit(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer;
  v_window integer;
  v_start timestamptz;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  case p_action
    when 'availability' then v_limit := 60; v_window := 60;
    when 'reserve_subdomain' then v_limit := 10; v_window := 3600;
    when 'add_custom_domain' then v_limit := 10; v_window := 3600;
    when 'verify_domain' then v_limit := 6; v_window := 3600;
    when 'retry_provisioning' then v_limit := 6; v_window := 3600;
    when 'remove_domain' then v_limit := 10; v_window := 3600;
    else
      raise exception 'DOMAIN_RATE_ACTION_INVALID' using errcode = '22023';
  end case;

  -- Window start floored to the window length so concurrent attempts share a row.
  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / v_window) * v_window);

  insert into public.domain_rate_windows (user_id, action, window_start, count)
  values (v_uid, p_action, v_start, 1)
  on conflict (user_id, action, window_start)
  do update set count = public.domain_rate_windows.count + 1
  returning count into v_count;

  -- Bounded opportunistic cleanup; never on the request's critical path.
  delete from public.domain_rate_windows
   where window_start < now() - interval '1 day'
     and random() < 0.01;

  return jsonb_build_object(
    'allowed', v_count <= v_limit,
    'limit', v_limit,
    'windowSeconds', v_window,
    'retryAfterSeconds', case when v_count <= v_limit then 0
      else greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => v_window) - clock_timestamp())))::integer)
    end
  );
end;
$$;

revoke all on function public.consume_domain_rate_limit(text) from public, anon;
grant execute on function public.consume_domain_rate_limit(text) to authenticated;

-- ── Reserved labels (mirrors src/lib/reserved-hostnames.ts) ─────────────────

create or replace function public.domain_label_reserved(p_label text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(coalesce(p_label, '')) = any (array[
    'adminsh', 'api', 'auth', 'careers', 'changelog', 'contact',
    'credit-topup', 'dashboard', 'docs', 'faq', 'features', 'home',
    'integrations', 'login', 'preview', 'privacy', 'project', 'projects',
    'signup', 'support', 'terms', 'tutorials', 'upgrade',
    'blog', 'help', 'status', 'www',
    'assets', 'cdn', 'files', 'mail', 'ns1', 'ns2', 'smtp', 'static',
    'storage', 'vercel',
    'admin', 'app', 'billing', 'internal', 'system'
  ]::text[]);
$$;

revoke all on function public.domain_label_reserved(text) from public, anon;
grant execute on function public.domain_label_reserved(text) to authenticated, service_role;

-- ── View helper (owner-safe projection; token only when explicitly requested) ─

create or replace function public.domain_view_json(d public.project_domains, p_include_token boolean default false)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', d.id,
    'projectId', d.project_id,
    'hostname', d.hostname,
    'domainType', d.domain_type,
    'status', d.status,
    'dnsStatus', d.dns_status,
    'sslStatus', d.ssl_status,
    'publicationStatus', d.publication_status,
    'isPrimary', d.is_primary,
    'routingProvider', d.routing_provider,
    'verificationRecordName', d.verification_record_name,
    'verificationToken', case when p_include_token and d.status <> 'removed'
      then d.verification_token else null end,
    'certificateReference', d.certificate_reference,
    'lastVerifiedAt', d.last_verified_at,
    'lastCheckedAt', d.last_checked_at,
    'failureCode', d.failure_code,
    'failureMessage', d.failure_message,
    'retryCount', d.retry_count,
    'nextRetryAt', d.next_retry_at,
    'routingApprovedAt', d.routing_approved_at,
    'createdAt', d.created_at,
    'updatedAt', d.updated_at,
    'removedAt', d.removed_at
  );
$$;

revoke all on function public.domain_view_json(public.project_domains, boolean) from public, anon, authenticated;

-- ── Entitlements projection ─────────────────────────────────────────────────

create or replace function public.domain_entitlements_for_user(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan text := 'free';
  v_limits public.domain_plan_limits%rowtype;
  v_custom integer := 0;
  v_aliases integer := 0;
  v_active integer := 0;
begin
  if p_user_id is null then
    return jsonb_build_object('planId', 'free', 'maxCustomDomains', 0, 'maxSubdomainAliases', 0,
      'maxActiveDomains', 0, 'customDomainsUsed', 0, 'subdomainAliasesUsed', 0, 'activeDomainsUsed', 0);
  end if;

  select coalesce(s.plan_id, 'free') into v_plan
    from public.subscriptions s
   where s.user_id = p_user_id and s.status in ('active', 'past_due')
   order by s.current_period_end desc nulls last, s.created_at desc
   limit 1;

  select * into v_limits from public.domain_plan_limits where plan_id = v_plan;
  if not found then
    select * into v_limits from public.domain_plan_limits where plan_id = 'free';
  end if;
  if not found then
    v_limits.max_custom_domains := 0;
    v_limits.max_subdomain_aliases := 0;
    v_limits.max_active_domains := 0;
  end if;

  select
    count(*) filter (where domain_type = 'custom' and status <> 'removed'),
    count(*) filter (where domain_type = 'mavly_subdomain' and status <> 'removed'),
    count(*) filter (where status = 'active')
  into v_custom, v_aliases, v_active
  from public.project_domains
  where user_id = p_user_id;

  return jsonb_build_object(
    'planId', v_plan,
    'maxCustomDomains', v_limits.max_custom_domains,
    'maxSubdomainAliases', v_limits.max_subdomain_aliases,
    'maxActiveDomains', v_limits.max_active_domains,
    'customDomainsUsed', v_custom,
    'subdomainAliasesUsed', v_aliases,
    'activeDomainsUsed', v_active
  );
end;
$$;

revoke all on function public.domain_entitlements_for_user(uuid) from public, anon, authenticated, service_role;

create or replace function public.domain_entitlements()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.domain_entitlements_for_user(auth.uid());
$$;

revoke all on function public.domain_entitlements() from public, anon;
grant execute on function public.domain_entitlements() to authenticated;

-- ── Owner read model ────────────────────────────────────────────────────────

create or replace function public.list_project_domains(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_domains jsonb;
  v_deployment public.project_deployments%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_project from public.projects where project_id = p_project_id;
  if not found then
    raise exception 'DOMAIN_PROJECT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_project.user_id <> v_uid then
    raise exception 'DOMAIN_OWNERSHIP_MISMATCH' using errcode = '42501';
  end if;

  select * into v_deployment from public.project_deployments where project_id = p_project_id;

  select coalesce(jsonb_agg(public.domain_view_json(d, true) order by d.created_at), '[]'::jsonb)
    into v_domains
    from public.project_domains d
   where d.project_id = p_project_id
     and d.status <> 'removed';

  return jsonb_build_object(
    'projectId', p_project_id,
    'canonicalHostname', lower(p_project_id) || '.mavly.xyz',
    'canonicalStatus', case
      when v_deployment.project_id is null then 'not_published'
      when v_deployment.status = 'ready' then 'published'
      when v_deployment.status = 'unpublished' then 'not_published'
      when v_deployment.status in ('queued', 'building', 'deploying', 'unpublishing') then 'pending'
      when v_deployment.status = 'error' then 'failed'
      else v_deployment.status
    end,
    'canonicalProvider', case when v_deployment.project_id is null then null else v_deployment.provider end,
    'domains', v_domains,
    'entitlements', public.domain_entitlements_for_user(v_uid)
  );
end;
$$;

revoke all on function public.list_project_domains(text) from public, anon;
grant execute on function public.list_project_domains(text) to authenticated;

create or replace function public.get_project_domain(p_project_id text, p_domain_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.project_domains%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_row
    from public.project_domains
   where id = p_domain_id and project_id = p_project_id and user_id = v_uid;
  if not found then
    raise exception 'DOMAIN_NOT_FOUND' using errcode = 'P0001';
  end if;
  return public.domain_view_json(v_row, true);
end;
$$;

revoke all on function public.get_project_domain(text, uuid) from public, anon;
grant execute on function public.get_project_domain(text, uuid) to authenticated;

-- ── Mavly subdomain aliases ─────────────────────────────────────────────────

create or replace function public.check_subdomain_availability(p_label text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text := lower(btrim(coalesce(p_label, '')));
  v_hostname text;
  v_reason text := 'available';
  v_taken boolean := false;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if v_label = '' or char_length(v_label) > 63
     or v_label !~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or v_label like '%--%' then
    v_reason := 'invalid';
  elsif v_label like 'xn--%' then
    v_reason := 'invalid';
  elsif public.domain_label_reserved(v_label) then
    v_reason := 'reserved';
  else
    v_hostname := v_label || '.mavly.xyz';
    select exists(
      select 1 from public.project_domains d
       where d.hostname = v_hostname and d.status <> 'removed'
    ) or exists(
      select 1 from public.projects p where lower(p.project_id) = v_label
    ) into v_taken;
    if v_taken then v_reason := 'taken'; end if;
  end if;

  return jsonb_build_object(
    'label', v_label,
    'hostname', case when v_label = '' then null else v_label || '.mavly.xyz' end,
    'available', v_reason = 'available',
    'reason', v_reason
  );
end;
$$;

revoke all on function public.check_subdomain_availability(text) from public, anon;
grant execute on function public.check_subdomain_availability(text) to authenticated;

create or replace function public.reserve_mavly_subdomain(p_project_id text, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_label text := lower(btrim(coalesce(p_label, '')));
  v_hostname text;
  v_limits jsonb;
  v_row public.project_domains%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  select * into v_project from public.projects where project_id = p_project_id;
  if not found then raise exception 'DOMAIN_PROJECT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_project.user_id <> v_uid then raise exception 'DOMAIN_OWNERSHIP_MISMATCH' using errcode = '42501'; end if;

  if v_label = '' or char_length(v_label) > 63
     or v_label !~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     or v_label like '%--%'
     or v_label like 'xn--%' then
    raise exception 'DOMAIN_SUBDOMAIN_INVALID' using errcode = '22023';
  end if;
  if public.domain_label_reserved(v_label) then
    raise exception 'DOMAIN_SUBDOMAIN_RESERVED' using errcode = '22023';
  end if;
  if lower(p_project_id) = v_label then
    raise exception 'DOMAIN_SUBDOMAIN_IS_CANONICAL' using errcode = '22023';
  end if;

  v_hostname := v_label || '.mavly.xyz';

  -- Serialize reservations of the same name across instances.
  perform pg_advisory_xact_lock(hashtext('mavly:subdomain:' || v_hostname));

  if exists (select 1 from public.project_domains d where d.hostname = v_hostname and d.status <> 'removed') then
    raise exception 'DOMAIN_SUBDOMAIN_TAKEN' using errcode = '23505';
  end if;
  if exists (select 1 from public.projects p where lower(p.project_id) = v_label) then
    raise exception 'DOMAIN_SUBDOMAIN_TAKEN' using errcode = '23505';
  end if;

  v_limits := public.domain_entitlements_for_user(v_uid);
  if (v_limits->>'subdomainAliasesUsed')::integer >= (v_limits->>'maxSubdomainAliases')::integer then
    raise exception 'DOMAIN_ALIAS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into public.project_domains (
    project_id, user_id, hostname, domain_type, status, dns_status,
    ssl_status, publication_status, routing_provider, verification_record_name
  ) values (
    p_project_id, v_uid, v_hostname, 'mavly_subdomain', 'pending', 'ready',
    'pending', 'pending', 'none', null
  ) returning * into v_row;

  insert into public.project_domain_events (domain_id, project_id, actor_user_id, actor_kind, event, outcome, metadata)
  values (v_row.id, p_project_id, v_uid, 'owner', 'domain.subdomain_reserved', 'success',
    jsonb_build_object('hostname', v_hostname));

  insert into public.project_domain_jobs (domain_id, project_id, user_id, action, status)
  values (v_row.id, p_project_id, v_uid, 'provision', 'queued');

  return public.domain_view_json(v_row, false);
end;
$$;

revoke all on function public.reserve_mavly_subdomain(text, text) from public, anon;
grant execute on function public.reserve_mavly_subdomain(text, text) to authenticated;

-- ── Customer-owned custom domains ───────────────────────────────────────────

create or replace function public.add_custom_domain(
  p_project_id text,
  p_hostname text,
  p_token text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_project public.projects%rowtype;
  v_hostname text := lower(btrim(coalesce(p_hostname, '')));
  v_limits jsonb;
  v_row public.project_domains%rowtype;
  v_labels integer;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  select * into v_project from public.projects where project_id = p_project_id;
  if not found then raise exception 'DOMAIN_PROJECT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_project.user_id <> v_uid then raise exception 'DOMAIN_OWNERSHIP_MISMATCH' using errcode = '42501'; end if;

  if v_hostname = '' or char_length(v_hostname) > 253
     or v_hostname !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
     or v_hostname ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
     or v_hostname like '%.mavly.xyz'
     or v_hostname = 'mavly.xyz'
     or v_hostname like '%.vercel.app'
     or v_hostname like '%.supabase.co'
     or v_hostname like 'xn--%'
     or v_hostname like '%.xn--%' then
    raise exception 'DOMAIN_HOSTNAME_INVALID' using errcode = '22023';
  end if;
  v_labels := array_length(string_to_array(v_hostname, '.'), 1);
  if v_labels < 2 then
    raise exception 'DOMAIN_HOSTNAME_INVALID' using errcode = '22023';
  end if;
  if v_hostname ~ '\.(local|localhost|test|invalid|example|internal)$' then
    raise exception 'DOMAIN_HOSTNAME_RESERVED' using errcode = '22023';
  end if;
  if p_token is null or char_length(p_token) < 20 or p_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'DOMAIN_VERIFICATION_TOKEN_INVALID' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'DOMAIN_VERIFICATION_TOKEN_INVALID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('mavly:domain:' || v_hostname));

  if exists (select 1 from public.project_domains d where d.hostname = v_hostname and d.status <> 'removed') then
    raise exception 'DOMAIN_ALREADY_REGISTERED' using errcode = '23505';
  end if;

  v_limits := public.domain_entitlements_for_user(v_uid);
  if (v_limits->>'maxCustomDomains')::integer <= 0 then
    raise exception 'DOMAIN_PLAN_REQUIRED' using errcode = 'P0001';
  end if;
  if (v_limits->>'customDomainsUsed')::integer >= (v_limits->>'maxCustomDomains')::integer then
    raise exception 'DOMAIN_CUSTOM_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  insert into public.project_domains (
    project_id, user_id, hostname, domain_type, status, dns_status,
    ssl_status, publication_status, routing_provider, verification_token,
    verification_token_hash, verification_record_name
  ) values (
    p_project_id, v_uid, v_hostname, 'custom', 'verification_required', 'pending',
    'not_started', 'pending', 'none', p_token,
    p_token_hash, '_mavly-verification.' || v_hostname
  ) returning * into v_row;

  insert into public.project_domain_events (domain_id, project_id, actor_user_id, actor_kind, event, outcome, metadata)
  values (v_row.id, p_project_id, v_uid, 'owner', 'domain.custom_added', 'success',
    jsonb_build_object('hostname', v_hostname));

  return public.domain_view_json(v_row, true);
end;
$$;

revoke all on function public.add_custom_domain(text, text, text, text) from public, anon;
grant execute on function public.add_custom_domain(text, text, text, text) to authenticated;

-- ── Owner lifecycle actions ─────────────────────────────────────────────────

create or replace function public.enqueue_domain_action(p_domain_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.project_domains%rowtype;
  v_next_status text;
  v_job_id uuid;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  if p_action not in ('verify', 'provision', 'remove') then
    raise exception 'DOMAIN_ACTION_INVALID' using errcode = '22023';
  end if;
  select * into v_row from public.project_domains where id = p_domain_id for update;
  if not found then raise exception 'DOMAIN_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_row.user_id <> v_uid then raise exception 'DOMAIN_OWNERSHIP_MISMATCH' using errcode = '42501'; end if;
  if v_row.status = 'removed' then raise exception 'DOMAIN_REMOVED' using errcode = 'P0001'; end if;

  if p_action = 'verify' and v_row.domain_type <> 'custom' then
    raise exception 'DOMAIN_VERIFY_NOT_APPLICABLE' using errcode = '22023';
  end if;
  if p_action = 'verify' and v_row.status not in ('verification_required', 'verifying', 'misconfigured', 'ssl_pending', 'ssl_failed') then
    raise exception 'DOMAIN_VERIFY_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if p_action = 'provision' and v_row.domain_type = 'custom' and v_row.status not in ('verified', 'provisioning', 'ssl_pending', 'ssl_failed', 'misconfigured', 'pending') then
    raise exception 'DOMAIN_PROVISION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if p_action = 'provision' and v_row.domain_type = 'mavly_subdomain' and v_row.status not in ('pending', 'provisioning', 'active', 'misconfigured') then
    raise exception 'DOMAIN_PROVISION_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.project_domain_jobs j
     where j.domain_id = p_domain_id and j.status in ('queued', 'processing', 'retry_wait')
  ) then
    raise exception 'DOMAIN_JOB_IN_PROGRESS' using errcode = 'P0001';
  end if;

  v_next_status := case
    when p_action = 'verify' then 'verifying'
    when p_action = 'remove' then 'removing'
    when p_action = 'provision' then 'provisioning'
  end;

  update public.project_domains
     set status = v_next_status,
         failure_code = null,
         failure_message = null,
         updated_at = now()
   where id = p_domain_id;

  insert into public.project_domain_jobs (domain_id, project_id, user_id, action, status)
  values (v_row.id, v_row.project_id, v_row.user_id, p_action, 'queued')
  returning id into v_job_id;

  insert into public.project_domain_events (domain_id, project_id, actor_user_id, actor_kind, event, outcome, metadata)
  values (v_row.id, v_row.project_id, v_uid, 'owner', 'domain.' || p_action || '_requested', 'info',
    jsonb_build_object('jobId', v_job_id, 'hostname', v_row.hostname));

  return jsonb_build_object('jobId', v_job_id, 'action', p_action, 'status', v_next_status);
end;
$$;

revoke all on function public.enqueue_domain_action(uuid, text) from public, anon;
grant execute on function public.enqueue_domain_action(uuid, text) to authenticated;

create or replace function public.set_primary_domain(p_domain_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.project_domains%rowtype;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED' using errcode = '28000'; end if;
  select * into v_row from public.project_domains where id = p_domain_id for update;
  if not found then raise exception 'DOMAIN_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_row.user_id <> v_uid then raise exception 'DOMAIN_OWNERSHIP_MISMATCH' using errcode = '42501'; end if;
  if v_row.domain_type <> 'custom' then
    raise exception 'DOMAIN_PRIMARY_CUSTOM_ONLY' using errcode = '22023';
  end if;
  if v_row.status <> 'active' then
    raise exception 'DOMAIN_PRIMARY_REQUIRES_ACTIVE' using errcode = 'P0001';
  end if;

  update public.project_domains
     set is_primary = false, updated_at = now()
   where project_id = v_row.project_id and id <> v_row.id and is_primary;
  update public.project_domains
     set is_primary = true, updated_at = now()
   where id = v_row.id;

  insert into public.project_domain_events (domain_id, project_id, actor_user_id, actor_kind, event, outcome, metadata)
  values (v_row.id, v_row.project_id, v_uid, 'owner', 'domain.primary_selected', 'success',
    jsonb_build_object('hostname', v_row.hostname));

  select * into v_row from public.project_domains where id = p_domain_id;
  return public.domain_view_json(v_row, false);
end;
$$;

revoke all on function public.set_primary_domain(uuid) from public, anon;
grant execute on function public.set_primary_domain(uuid) to authenticated;

-- ── Worker claim / complete / fail (service role only) ──────────────────────

create or replace function public.claim_domain_job()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.project_domain_jobs%rowtype;
  v_domain public.project_domains%rowtype;
  v_deployment public.project_deployments%rowtype;
  v_version public.project_published_versions%rowtype;
  v_lease uuid := gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;

  -- Expired leases are retried or dead-lettered, never duplicated.
  update public.project_domain_jobs
     set status = case when attempt_count >= 10 then 'failed' else 'retry_wait' end,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = now() + make_interval(secs => least(300, 15 * power(2, greatest(attempt_count, 1)))::integer),
         failure_code = coalesce(failure_code, 'DOMAIN_LEASE_EXPIRED'),
         updated_at = now()
   where status = 'processing' and lease_expires_at <= now();

  select * into v_job
    from public.project_domain_jobs
   where status in ('queued', 'retry_wait')
     and next_attempt_at <= now()
   order by created_at
   for update skip locked
   limit 1;
  if not found then return null; end if;

  update public.project_domain_jobs
     set status = 'processing',
         lease_token = v_lease,
         lease_expires_at = now() + interval '5 minutes',
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_job.id;

  select * into v_domain from public.project_domains where id = v_job.domain_id;
  if not found then
    update public.project_domain_jobs set status = 'failed', failure_code = 'DOMAIN_MISSING', updated_at = now() where id = v_job.id;
    return jsonb_build_object('status', 'missing');
  end if;

  select * into v_deployment from public.project_deployments where project_id = v_job.project_id;
  if found and v_deployment.active_version_id is not null then
    select * into v_version
      from public.project_published_versions
     where id = v_deployment.active_version_id and project_id = v_job.project_id and status = 'active';
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'jobId', v_job.id,
    'action', v_job.action,
    'projectId', v_job.project_id,
    'userId', v_job.user_id,
    'leaseToken', v_lease,
    'attemptCount', v_job.attempt_count,
    'routingGeneration', coalesce(v_deployment.aws_route_generation, 0),
    'domain', jsonb_build_object(
      'id', v_domain.id,
      'hostname', v_domain.hostname,
      'domainType', v_domain.domain_type,
      'status', v_domain.status,
      'verificationToken', v_domain.verification_token,
      'routingProvider', v_domain.routing_provider,
      'routingGeneration', v_domain.routing_generation,
      'routingApproved', v_domain.routing_approved_at is not null
    ),
    'publication', case when v_version.id is null then null else jsonb_build_object(
      'versionId', v_version.id,
      'entryPath', v_version.entry_path,
      'spaFallback', v_version.spa_fallback,
      'provider', v_deployment.provider,
      'status', v_deployment.status,
      'mavlyHostname', v_deployment.mavly_hostname,
      'routingGeneration', v_deployment.aws_route_generation
    ) end
  );
end;
$$;

revoke all on function public.claim_domain_job() from public, anon, authenticated;
grant execute on function public.claim_domain_job() to service_role;

create or replace function public.complete_domain_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_dns_status text default null,
  p_ssl_status text default null,
  p_publication_status text default null,
  p_failure_code text default null,
  p_failure_message text default null,
  p_certificate_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.project_domain_jobs%rowtype;
  v_domain public.project_domains%rowtype;
  v_status text;
  v_next_action text;
  v_next_job uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;
  if p_outcome not in ('verified', 'active', 'removed') then
    raise exception 'DOMAIN_OUTCOME_INVALID' using errcode = '22023';
  end if;

  select * into v_job from public.project_domain_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'processing' or v_job.lease_token is distinct from p_lease_token then
    raise exception 'DOMAIN_LEASE_LOST' using errcode = 'P0001';
  end if;
  select * into v_domain from public.project_domains where id = v_job.domain_id for update;
  if not found then
    update public.project_domain_jobs set status = 'completed', lease_token = null, lease_expires_at = null, updated_at = now() where id = p_job_id;
    return jsonb_build_object('status', 'missing');
  end if;

  if p_outcome = 'removed' then
    v_status := 'removed';
  elsif p_outcome = 'verified' then
    v_status := 'verified';
  else
    v_status := 'active';
  end if;

  -- The plan's simultaneous-active ceiling is re-checked inside the terminal
  -- transaction. A worker cannot activate one domain too many, even if the
  -- owner raced several requests.
  if v_status = 'active' and v_domain.status <> 'active' then
    if (
      select count(*)
        from public.project_domains d
       where d.user_id = v_domain.user_id
         and d.status = 'active'
         and d.id <> v_domain.id
    ) >= (
      select coalesce((public.domain_entitlements_for_user(v_domain.user_id)->>'maxActiveDomains')::integer, 0)
    ) then
      raise exception 'DOMAIN_ACTIVE_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  update public.project_domains
     set status = v_status,
         dns_status = coalesce(p_dns_status, dns_status),
         ssl_status = coalesce(p_ssl_status, ssl_status),
         publication_status = coalesce(p_publication_status, publication_status),
         routing_provider = case
           when p_outcome = 'active' then 'aws_cloudfront'
           when p_outcome = 'removed' then 'none'
           else routing_provider
         end,
         routing_generation = case
           when p_outcome = 'active' then coalesce(
             (select d.aws_route_generation
                from public.project_deployments d
               where d.project_id = v_domain.project_id
                 and d.provider = 'aws'),
             routing_generation
           )
           when p_outcome = 'removed' then 0
           else routing_generation
         end,
         failure_code = p_failure_code,
         failure_message = p_failure_message,
         certificate_reference = coalesce(p_certificate_reference, certificate_reference),
         last_verified_at = case when p_outcome in ('verified', 'active') then now() else last_verified_at end,
         last_checked_at = now(),
         retry_count = 0,
         next_retry_at = null,
         removed_at = case when p_outcome = 'removed' then now() else removed_at end,
         is_primary = case when p_outcome = 'removed' then false else is_primary end,
         updated_at = now()
   where id = v_domain.id;

  update public.project_domain_jobs
     set status = 'completed', lease_token = null, lease_expires_at = null, failure_code = null, updated_at = now()
   where id = p_job_id;

  insert into public.project_domain_events (domain_id, project_id, actor_kind, event, outcome, metadata)
  values (v_domain.id, v_domain.project_id, 'worker',
    case p_outcome
      when 'verified' then 'domain.verified'
      when 'active' then 'domain.active'
      else 'domain.removed'
    end,
    case when p_outcome = 'removed' then 'info' else 'success' end,
    jsonb_build_object('hostname', v_domain.hostname, 'outcome', p_outcome, 'jobId', p_job_id));

  -- Verification alone does not serve traffic. Automatically enqueue the
  -- routing/SSL step so the owner does not have to press a second button.
  if p_outcome = 'verified' then
    v_next_action := 'provision';
    insert into public.project_domain_jobs (domain_id, project_id, user_id, action, status)
    values (v_domain.id, v_domain.project_id, v_domain.user_id, v_next_action, 'queued')
    on conflict do nothing
    returning id into v_next_job;
  end if;

  return jsonb_build_object('status', v_status, 'domainId', v_domain.id, 'nextJobId', v_next_job);
end;
$$;

revoke all on function public.complete_domain_job(uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_domain_job(uuid, uuid, text, text, text, text, text, text, text) to service_role;

drop function if exists public.fail_domain_job(uuid, uuid, text, text, text);

create or replace function public.fail_domain_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_domain_status text,
  p_failure_code text,
  p_failure_message text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.project_domain_jobs%rowtype;
  v_domain public.project_domains%rowtype;
  v_retry boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;
  if p_domain_status not in (
    'verification_required', 'verified', 'verifying', 'provisioning',
    'misconfigured', 'ssl_failed', 'ssl_pending', 'pending', 'active', 'removing'
  ) then
    raise exception 'DOMAIN_STATUS_INVALID' using errcode = '22023';
  end if;

  select * into v_job from public.project_domain_jobs where id = p_job_id for update;
  if not found or v_job.lease_token is distinct from p_lease_token then
    raise exception 'DOMAIN_LEASE_LOST' using errcode = 'P0001';
  end if;
  -- Only a failed REMOVAL may keep a row active: the route is still live, so
  -- claiming a different state would misreport serving.
  if p_domain_status = 'active' and v_job.action <> 'remove' then
    raise exception 'DOMAIN_STATUS_INVALID' using errcode = '22023';
  end if;

  select * into v_domain from public.project_domains where id = v_job.domain_id for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;

  v_retry := coalesce(p_retryable, true) and v_job.attempt_count < 10;
  update public.project_domain_jobs
     set status = case when v_retry then 'retry_wait' else 'failed' end,
         lease_token = null,
         lease_expires_at = null,
         next_attempt_at = now() + make_interval(secs => least(300, 15 * power(2, greatest(v_job.attempt_count, 1)))::integer),
         failure_code = left(coalesce(p_failure_code, 'DOMAIN_JOB_FAILED'), 80),
         updated_at = now()
   where id = p_job_id;

  update public.project_domains
     set status = p_domain_status,
         dns_status = case when p_domain_status = 'misconfigured' then 'misconfigured' else dns_status end,
         ssl_status = case when p_domain_status = 'ssl_failed' then 'failed' else ssl_status end,
         publication_status = case
           when v_retry then publication_status
           when v_job.action = 'provision' then 'failed'
           when v_job.action = 'remove' and p_domain_status = 'removed' then 'removed'
           else publication_status
         end,
         failure_code = left(coalesce(p_failure_code, 'DOMAIN_JOB_FAILED'), 80),
         failure_message = left(coalesce(p_failure_message, 'Domain provisioning did not complete.'), 500),
         retry_count = retry_count + case when v_retry then 1 else 0 end,
         next_retry_at = case when v_retry then now() + make_interval(secs => least(300, 15 * power(2, greatest(v_job.attempt_count, 1)))::integer) else null end,
         last_checked_at = now(),
         updated_at = now()
   where id = v_domain.id;

  insert into public.project_domain_events (domain_id, project_id, actor_kind, event, outcome, metadata)
  values (v_domain.id, v_domain.project_id, 'worker',
    case when v_retry then 'domain.retry_scheduled' else 'domain.failed' end,
    case when v_retry then 'info' else 'failure' end,
    jsonb_build_object('hostname', v_domain.hostname, 'failureCode', left(coalesce(p_failure_code, 'DOMAIN_JOB_FAILED'), 80), 'attempt', v_job.attempt_count));

  return jsonb_build_object('status', case when v_retry then 'retry_wait' else 'failed' end, 'domainId', v_domain.id);
end;
$$;

revoke all on function public.fail_domain_job(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.fail_domain_job(uuid, uuid, text, text, text, boolean) to service_role;

-- ── Public hostname resolution (active domains only) ───────────────────────

create or replace function public.resolve_public_domain(p_hostname text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host text := lower(btrim(coalesce(p_hostname, '')));
  v_row public.project_domains%rowtype;
  v_version public.project_published_versions%rowtype;
begin
  if v_host = '' or char_length(v_host) > 253 then return null; end if;

  select * into v_row
    from public.project_domains
   where hostname = v_host
     and status = 'active'
     and publication_status = 'active'
     and dns_status = 'ready'
     and ssl_status = 'active';
  if not found then return null; end if;

  select v.* into v_version
    from public.project_deployments d
    join public.project_published_versions v
      on v.id = d.active_version_id and v.project_id = d.project_id
   where d.project_id = v_row.project_id
     and v.status = 'active';
  if not found then return null; end if;

  return jsonb_build_object(
    'hostname', v_row.hostname,
    'projectId', v_row.project_id,
    'versionId', v_version.id,
    'entryPath', v_version.entry_path,
    'spaFallback', v_version.spa_fallback
  );
end;
$$;

revoke all on function public.resolve_public_domain(text) from public;
grant execute on function public.resolve_public_domain(text) to anon, authenticated, service_role;

-- ── Public file read for a domain hostname ─────────────────────────────────
--
-- `read_published_file` (migration 14) re-resolves the hostname through
-- `resolve_published_tenant`, which only knows the canonical
-- `<project-id>.mavly.xyz` shape. A Mavly alias or a customer-owned hostname
-- therefore resolves here but could not read a byte, so the Next tenant runtime
-- would answer 503 for every alias. This function is the read half of
-- `resolve_public_domain` and repeats the SAME active/ready gate, so a file is
-- only readable while the hostname is genuinely active for that exact version.
--
-- It cannot widen access: the version id must come from the caller's own
-- resolution of the same hostname, and the path rules match migration 14.

create or replace function public.read_public_domain_file(
  p_hostname text,
  p_version_id uuid,
  p_path text
)
returns table (
  path text,
  content text,
  content_type text,
  sha256 text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with resolved as (
    select (public.resolve_public_domain(p_hostname) ->> 'versionId')::uuid as version_id
  )
  select f.path, f.content, f.content_type, f.sha256
  from public.project_published_files f
  join resolved r on r.version_id = f.version_id
  where f.version_id = p_version_id
    and f.path = p_path
    and p_path is not null
    and length(p_path) between 1 and 1024
    and left(p_path, 1) <> '/'
    and strpos(p_path, '..') = 0
    and strpos(p_path, chr(92)) = 0
  limit 1;
$$;

revoke all on function public.read_public_domain_file(text, uuid, text) from public;
grant execute on function public.read_public_domain_file(text, uuid, text) to anon, authenticated, service_role;

-- ── Admin overview + routing approval ──────────────────────────────────────

create or replace function public.admin_domain_overview(
  p_limit integer default 50,
  p_offset integer default 0,
  p_search text default null,
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_summary jsonb;
  v_rows jsonb;
  v_events jsonb;
  v_total integer;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_domain_overview: not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'active', count(*) filter (where d.status = 'active'),
    'pendingVerification', count(*) filter (where d.status in ('pending', 'verification_required', 'verifying')),
    'provisioning', count(*) filter (where d.status in ('verified', 'provisioning', 'ssl_pending')),
    'dnsFailures', count(*) filter (where d.dns_status in ('misconfigured', 'error')),
    'sslFailures', count(*) filter (where d.ssl_status in ('failed', 'expired') or d.status = 'ssl_failed'),
    'disabled', count(*) filter (where d.status = 'disabled'),
    'removed', count(*) filter (where d.status = 'removed'),
    'custom', count(*) filter (where d.domain_type = 'custom' and d.status <> 'removed'),
    'aliases', count(*) filter (where d.domain_type = 'mavly_subdomain' and d.status <> 'removed')
  ) into v_summary
  from public.project_domains d;

  select count(*) into v_total
    from public.project_domains d
    join public.projects p on p.project_id = d.project_id
    join auth.users u on u.id = d.user_id
   where (p_status = 'all' or d.status = p_status)
     and (v_search is null
       or d.hostname ilike '%' || v_search || '%'
       or d.project_id ilike '%' || v_search || '%'
       or u.email ilike '%' || v_search || '%');

  select coalesce(jsonb_agg(row_to_json(page)), '[]'::jsonb) into v_rows from (
    select
      d.id, d.project_id as "projectId",
      coalesce(nullif(p.label, ''), p.project_id) as "projectName",
      d.user_id as "userId", u.email,
      d.hostname, d.domain_type as "domainType", d.status,
      d.dns_status as "dnsStatus", d.ssl_status as "sslStatus",
      d.publication_status as "publicationStatus", d.routing_provider as "routingProvider",
      d.is_primary as "isPrimary", d.failure_code as "failureCode",
      d.last_verified_at as "lastVerifiedAt", d.last_checked_at as "lastCheckedAt",
      d.routing_approved_at as "routingApprovedAt", d.created_at as "createdAt"
    from public.project_domains d
    join public.projects p on p.project_id = d.project_id
    join auth.users u on u.id = d.user_id
    where (p_status = 'all' or d.status = p_status)
      and (v_search is null
        or d.hostname ilike '%' || v_search || '%'
        or d.project_id ilike '%' || v_search || '%'
        or u.email ilike '%' || v_search || '%')
    order by d.created_at desc
    limit v_limit offset v_offset
  ) page;

  select coalesce(jsonb_agg(row_to_json(recent)), '[]'::jsonb) into v_events from (
    select e.id, e.project_id as "projectId", e.domain_id as "domainId",
           e.actor_kind as "actorKind", e.event, e.outcome, e.metadata, e.created_at as "createdAt"
      from public.project_domain_events e
     order by e.created_at desc
     limit 50
  ) recent;

  return jsonb_build_object('summary', v_summary, 'rows', v_rows, 'recentEvents', v_events);
end;
$$;

revoke all on function public.admin_domain_overview(integer, integer, text, text) from public, anon;
grant execute on function public.admin_domain_overview(integer, integer, text, text) to authenticated;

create or replace function public.admin_approve_domain_routing(p_domain_id uuid, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_row public.project_domains%rowtype;
  v_job_id uuid;
begin
  if not public.current_user_is_admin() then
    raise exception 'admin_approve_domain_routing: not authorized' using errcode = '42501';
  end if;
  select * into v_row from public.project_domains where id = p_domain_id for update;
  if not found then raise exception 'DOMAIN_NOT_FOUND' using errcode = 'P0001'; end if;

  update public.project_domains
     set routing_approved_at = case when coalesce(p_approved, false) then now() else null end,
         routing_approved_by = case when coalesce(p_approved, false) then v_uid else null end,
         updated_at = now()
   where id = p_domain_id;

  -- Approval is permission to route, not proof that routing happened. Enqueue
  -- the real provision step so the worker still performs and verifies it.
  if coalesce(p_approved, false)
     and v_row.domain_type = 'custom'
     and v_row.status in ('verified', 'misconfigured', 'ssl_failed', 'ssl_pending', 'pending')
     and not exists (
       select 1 from public.project_domain_jobs j
        where j.domain_id = p_domain_id
          and j.status in ('queued', 'processing', 'retry_wait')
     ) then
    update public.project_domains
       set status = 'provisioning',
           failure_code = null,
           failure_message = null,
           updated_at = now()
     where id = p_domain_id;
    insert into public.project_domain_jobs (domain_id, project_id, user_id, action, status)
    values (v_row.id, v_row.project_id, v_row.user_id, 'provision', 'queued')
    returning id into v_job_id;
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.project_domain_events (domain_id, project_id, actor_user_id, actor_kind, event, outcome, metadata)
  values (v_row.id, v_row.project_id, v_uid, 'admin', 'domain.routing_approval', 'success',
    jsonb_build_object('hostname', v_row.hostname, 'approved', coalesce(p_approved, false)));

  insert into public.admin_audit_log (actor_user_id, actor_email, action, target_type, target_id, outcome, metadata)
  values (v_uid, v_email, 'domain.routing_approval', 'domain', v_row.id::text, 'success',
    jsonb_build_object('hostname', v_row.hostname, 'approved', coalesce(p_approved, false)));

  return jsonb_build_object('domainId', v_row.id, 'approved', coalesce(p_approved, false));
end;
$$;

revoke all on function public.admin_approve_domain_routing(uuid, boolean) from public, anon;
grant execute on function public.admin_approve_domain_routing(uuid, boolean) to authenticated;

-- ── Publication lifecycle helpers (worker only) ────────────────────────────
--
-- These are the join between the EXISTING AWS publication worker and the domain
-- registry. They never publish anything themselves: the worker owns the S3,
-- CloudFront and KVS operations, and calls these to read the routes it must
-- keep in step or to reflect a real unpublish/re-publish in domain state.

create or replace function public.list_project_domain_routes(p_project_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id,
      'hostname', d.hostname,
      'domainType', d.domain_type,
      'status', d.status,
      'publicationStatus', d.publication_status,
      'routingProvider', d.routing_provider,
      'routingGeneration', d.routing_generation
    ) order by d.created_at)
      from public.project_domains d
     where d.project_id = p_project_id
       and d.status <> 'removed'
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_project_domain_routes(text) from public, anon, authenticated;
grant execute on function public.list_project_domain_routes(text) to service_role;

create or replace function public.enqueue_project_domain_routes(p_project_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domain public.project_domains%rowtype;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;

  for v_domain in
    select * from public.project_domains
     where project_id = p_project_id
       and status not in ('removed', 'verification_required', 'verifying')
       and (domain_type <> 'custom' or status in (
         'verified', 'provisioning', 'active', 'misconfigured', 'ssl_pending', 'ssl_failed'
       ))
  loop
    if not exists (
      select 1 from public.project_domain_jobs j
       where j.domain_id = v_domain.id
         and j.status in ('queued', 'processing', 'retry_wait')
    ) then
      insert into public.project_domain_jobs (domain_id, project_id, user_id, action, status)
      values (v_domain.id, v_domain.project_id, v_domain.user_id, 'provision', 'queued');
      v_count := v_count + 1;
    end if;
  end loop;

  update public.project_domains
     set status = case when status in ('active', 'misconfigured', 'ssl_pending', 'ssl_failed')
                       then 'provisioning' else status end,
         publication_status = case when publication_status = 'failed' then 'pending'
                                   else publication_status end,
         failure_code = null,
         failure_message = null,
         updated_at = now()
   where project_id = p_project_id
     and status not in ('removed', 'verification_required', 'verifying');

  return jsonb_build_object('enqueued', v_count);
end;
$$;

revoke all on function public.enqueue_project_domain_routes(text) from public, anon, authenticated;
grant execute on function public.enqueue_project_domain_routes(text) to service_role;

create or replace function public.suspend_project_domain_routes(p_project_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'DOMAIN_WORKER_ONLY' using errcode = '42501';
  end if;

  update public.project_domains
     set status = case
           when status in ('active', 'provisioning', 'ssl_pending') then 'pending'
           else status
         end,
         publication_status = 'pending',
         failure_code = case
           when status in ('active', 'provisioning', 'ssl_pending') then 'DOMAIN_PROJECT_UNPUBLISHED'
           else failure_code
         end,
         failure_message = case
           when status in ('active', 'provisioning', 'ssl_pending')
             then 'The project is not published, so this address does not serve yet.'
           else failure_message
         end,
         updated_at = now()
   where project_id = p_project_id
     and status <> 'removed';
  get diagnostics v_count = row_count;

  insert into public.project_domain_events (project_id, actor_kind, event, outcome, metadata)
  select p_project_id, 'worker', 'domain.project_unpublished', 'info',
         jsonb_build_object('affected', v_count)
   where v_count > 0;

  return jsonb_build_object('suspended', v_count);
end;
$$;

revoke all on function public.suspend_project_domain_routes(text) from public, anon, authenticated;
grant execute on function public.suspend_project_domain_routes(text) to service_role;

-- ── Row level security + column grants ─────────────────────────────────────

alter table public.project_domains enable row level security;
alter table public.project_domain_events enable row level security;

drop policy if exists project_domains_owner_read on public.project_domains;
create policy project_domains_owner_read on public.project_domains
  for select to authenticated
  using (exists (
    select 1 from public.projects p
     where p.project_id = project_domains.project_id and p.user_id = (select auth.uid())
  ));

drop policy if exists project_domain_events_owner_read on public.project_domain_events;
create policy project_domain_events_owner_read on public.project_domain_events
  for select to authenticated
  using (exists (
    select 1 from public.projects p
     where p.project_id = project_domain_events.project_id and p.user_id = (select auth.uid())
  ));

-- Metadata only. The raw verification token is never a table-select column;
-- the owner receives it through the owner-checked SECURITY DEFINER RPC above.
revoke all on public.project_domains, public.project_domain_events from public, anon, authenticated;
grant select (
  id, project_id, user_id, hostname, domain_type, status, dns_status, ssl_status,
  publication_status, is_primary, verification_record_name, certificate_reference,
  routing_provider, last_verified_at, last_checked_at, failure_code, failure_message,
  retry_count, next_retry_at, routing_approved_at, created_at, updated_at, removed_at
) on public.project_domains to authenticated;
grant select on public.project_domain_events to authenticated;
-- The worker's service role performs no direct domain write (every mutation is a
-- SECURITY DEFINER RPC), but it must be able to read rows it reconciles.
grant select on public.project_domains, public.project_domain_events to service_role;

revoke all on public.project_domain_jobs from public, anon, authenticated;
grant all on public.project_domain_jobs to service_role;

-- ── updated_at maintenance ──────────────────────────────────────────────────

create or replace function public.project_domains_touch()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists project_domains_updated_at on public.project_domains;
create trigger project_domains_updated_at
  before update on public.project_domains
  for each row execute function public.project_domains_touch();

revoke all on function public.project_domains_touch() from public, anon, authenticated;

commit;
