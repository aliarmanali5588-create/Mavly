-- Planning-driven image assets for generated websites (Phase 12).
--
-- Additive and forward-only. This migration adds:
--   · project_image_plans  — the backend's approval record for one run's plan
--                            (counts, model, ceilings, estimated provider spend);
--   · project_image_assets — one durable row per planned asset, carrying its
--                            provider cost, outcome, storage reference and the
--                            idempotency key that prevents duplicate generation;
--   · owner-checked SECURITY DEFINER RPCs for sync/claim/complete/fail/finish;
--   · a public-read Storage bucket for generated WEBSITE imagery.
--
-- ⚠️ WHAT IS PUBLIC AND WHAT IS NOT. Generated site images are public content:
-- the bucket is public-read with a server-derived, unguessable object path
-- (`<project_id>/<run_id>/<asset_key>.<ext>`), no listing is enabled, and the
-- table rows remain owner-only through `projects` RLS. Project source files,
-- secrets, keys and provider credentials are untouched by this migration.
--
-- ⚠️ NO CREDIT / BILLING CHANGE. Mavly's credit foundation prices generation
-- RUNS. There is no image price in this build, so this migration adds NO credit
-- reservation, settlement or refund for images, and it does not alter any
-- existing credit, payment or pricing table. Provider spend is recorded as
-- provider cost with an explicit `cost_known` flag; a timeout stays uncertain.
--
-- ⚠️ SELF-ATTESTATION LIMIT. The sync RPC is callable by the project owner, so
-- an owner can misrepresent their OWN plan counts within the SQL-enforced
-- ceiling (80 assets, $1.00 estimated). It cannot touch another project, and
-- the claim RPC is what actually gates provider spend. A service-role-only
-- variant is the follow-up if operator-cost resistance must be stronger.

begin;

-- ── Plans ───────────────────────────────────────────────────────────────────

create table if not exists public.project_image_plans (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  run_id uuid not null references public.project_runs (id) on delete cascade,
  user_id uuid,
  schema_version integer not null default 1
    check (schema_version between 1 and 16),
  model text not null,
  site_type text not null default 'other'
    check (site_type in ('landing','saas','content','local','ecommerce','catalog','other')),
  planned_count integer not null default 0 check (planned_count between 0 and 160),
  approved_count integer not null default 0 check (approved_count between 0 and 80),
  deferred_count integer not null default 0 check (deferred_count between 0 and 160),
  required_count integer not null default 0 check (required_count between 0 and 80),
  max_assets integer not null default 0 check (max_assets between 0 and 80),
  estimated_cost_usd numeric(12,6) not null default 0
    check (estimated_cost_usd between 0 and 1),
  max_cost_usd numeric(12,6) not null default 0
    check (max_cost_usd between 0 and 1),
  status text not null default 'planned'
    check (status in ('planned','executing','completed','partial','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_image_plans_run_key unique (project_id, run_id),
  constraint project_image_plans_approved_within_limit
    check (approved_count <= max_assets)
);

comment on table public.project_image_plans is
  'Backend approval record for one generation run''s image plan. Counts and ceilings are enforced here, never by model output.';
comment on column public.project_image_plans.estimated_cost_usd is
  'Provider spend estimate from the verified per-image price. It is NOT a user charge and never settles credits.';

create index if not exists project_image_plans_project_created_idx
  on public.project_image_plans (project_id, created_at desc);

-- ── Assets ──────────────────────────────────────────────────────────────────

create table if not exists public.project_image_assets (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.project_image_plans (id) on delete cascade,
  project_id text not null references public.projects (project_id) on delete cascade,
  run_id uuid not null references public.project_runs (id) on delete cascade,
  user_id uuid,
  asset_key text not null
    check (asset_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  reuse_key text
    check (reuse_key is null or reuse_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  purpose text not null default 'other'
    check (purpose in ('hero','product','category','editorial','feature','background','team','testimonial','logo','other')),
  page_path text not null default '/'
    check (page_path ~ '^/[A-Za-z0-9._~\-/]*$' and length(page_path) <= 200),
  section_id text check (section_id is null or length(section_id) <= 64),
  product_id text check (product_id is null or length(product_id) <= 64),
  product_image_index integer
    check (product_image_index is null or product_image_index between 0 and 20),
  alt_text text not null default '' check (length(alt_text) <= 200),
  prompt text not null check (length(prompt) between 1 and 1000),
  aspect_ratio text not null default '16:9'
    check (aspect_ratio in ('1:1','4:3','3:4','16:9','9:16','auto')),
  priority integer not null default 3 check (priority between 1 and 5),
  required boolean not null default false,
  status text not null default 'planned'
    check (status in ('planned','generating','ready','failed','deferred','skipped')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  max_attempts integer not null default 2 check (max_attempts between 1 and 3),
  model text not null,
  estimated_cost_usd numeric(12,6) not null default 0
    check (estimated_cost_usd between 0 and 1),
  actual_cost_usd numeric(12,6)
    check (actual_cost_usd is null or actual_cost_usd between 0 and 1),
  cost_known boolean not null default false,
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 200),
  media_type text check (media_type is null or media_type in ('image/png','image/jpeg')),
  bytes bigint check (bytes is null or bytes between 0 and 6000000),
  storage_path text check (storage_path is null or length(storage_path) <= 400),
  public_url text check (public_url is null or length(public_url) <= 800),
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z0-9_]{1,64}$'),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 300),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_image_assets_key_unique unique (project_id, run_id, asset_key),
  constraint project_image_assets_ready_complete check (
    status <> 'ready'
    or (storage_path is not null and public_url is not null and media_type is not null
        and bytes is not null)
  )
);

comment on table public.project_image_assets is
  'One durable row per planned image asset: idempotent claim/complete state, provider cost, storage reference and failure reason. Binary bytes live only in Storage.';
comment on column public.project_image_assets.cost_known is
  'True only when the provider reported a cost. A timeout leaves this false and actual_cost_usd null: unknown, never zero.';

create index if not exists project_image_assets_plan_status_idx
  on public.project_image_assets (plan_id, status);
create index if not exists project_image_assets_project_ready_idx
  on public.project_image_assets (project_id, status, created_at desc);
create index if not exists project_image_assets_reuse_idx
  on public.project_image_assets (project_id, reuse_key)
  where reuse_key is not null;

alter table public.project_image_plans enable row level security;
alter table public.project_image_assets enable row level security;

drop policy if exists "project_image_plans_select_own" on public.project_image_plans;
create policy "project_image_plans_select_own"
  on public.project_image_plans
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_image_plans.project_id
      and p.user_id = (select auth.uid())
  ));

drop policy if exists "project_image_assets_select_own" on public.project_image_assets;
create policy "project_image_assets_select_own"
  on public.project_image_assets
  for select
  to authenticated
  using (exists (
    select 1 from public.projects p
    where p.project_id = project_image_assets.project_id
      and p.user_id = (select auth.uid())
  ));

revoke all on table public.project_image_plans from anon;
revoke all on table public.project_image_assets from anon;
revoke insert, update, delete on table public.project_image_plans from authenticated;
revoke insert, update, delete on table public.project_image_assets from authenticated;
grant select on table public.project_image_plans to authenticated, service_role;
grant select on table public.project_image_assets to authenticated, service_role;

-- ── Ownership helper ────────────────────────────────────────────────────────

create or replace function public.image_plan_caller_owns_project(p_project_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return true;
  end if;
  if v_uid is null then
    return false;
  end if;
  return exists (
    select 1 from public.projects p
    where p.project_id = p_project_id
      and p.user_id = v_uid
  );
end;
$$;

comment on function public.image_plan_caller_owns_project(text) is
  'Owner check for the image-plan RPCs. service_role is trusted; every other caller must own the project row.';

-- ── Sync the approved plan (idempotent) ─────────────────────────────────────

create or replace function public.sync_image_plan(
  p_project_id text,
  p_run_id uuid,
  p_schema_version integer,
  p_model text,
  p_site_type text,
  p_planned_count integer,
  p_approved_count integer,
  p_deferred_count integer,
  p_required_count integer,
  p_max_assets integer,
  p_estimated_cost_usd numeric,
  p_max_cost_usd numeric,
  p_assets jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_plan public.project_image_plans;
  v_asset jsonb;
  v_inserted integer := 0;
begin
  if not public.image_plan_caller_owns_project(p_project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  if p_assets is null or jsonb_typeof(p_assets) <> 'array' then
    raise exception 'IMAGE_PLAN_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_assets) > 160 then
    raise exception 'IMAGE_PLAN_TOO_LARGE' using errcode = '22023';
  end if;
  if coalesce(p_approved_count, 0) < 0 or coalesce(p_approved_count, 0) > 80 then
    raise exception 'IMAGE_PLAN_TOO_LARGE' using errcode = '22023';
  end if;
  if coalesce(p_max_assets, 0) < 0 or coalesce(p_max_assets, 0) > 80 then
    raise exception 'IMAGE_PLAN_TOO_LARGE' using errcode = '22023';
  end if;
  if coalesce(p_approved_count, 0) > coalesce(p_max_assets, 0) then
    raise exception 'IMAGE_PLAN_TOO_LARGE' using errcode = '22023';
  end if;
  if coalesce(p_estimated_cost_usd, 0) > 1 or coalesce(p_max_cost_usd, 0) > 1 then
    raise exception 'IMAGE_PLAN_OVER_BUDGET' using errcode = '22023';
  end if;

  if not exists (select 1 from public.project_runs r
                 where r.id = p_run_id and r.project_id = p_project_id) then
    raise exception 'RUN_NOT_FOUND' using errcode = '42501';
  end if;

  insert into public.project_image_plans (
    project_id, run_id, user_id, schema_version, model, site_type,
    planned_count, approved_count, deferred_count, required_count,
    max_assets, estimated_cost_usd, max_cost_usd, status
  ) values (
    p_project_id, p_run_id, v_uid, coalesce(p_schema_version, 1), p_model,
    coalesce(nullif(lower(btrim(p_site_type)), ''), 'other'),
    least(160, greatest(coalesce(p_planned_count, 0), 0)),
    least(80, greatest(coalesce(p_approved_count, 0), 0)),
    least(160, greatest(coalesce(p_deferred_count, 0), 0)),
    least(80, greatest(coalesce(p_required_count, 0), 0)),
    greatest(coalesce(p_max_assets, 0), 0),
    greatest(coalesce(p_estimated_cost_usd, 0), 0),
    greatest(coalesce(p_max_cost_usd, 0), 0),
    'planned'
  )
  on conflict (project_id, run_id) do update set
    schema_version = excluded.schema_version,
    model = excluded.model,
    site_type = excluded.site_type,
    planned_count = excluded.planned_count,
    approved_count = excluded.approved_count,
    deferred_count = excluded.deferred_count,
    required_count = excluded.required_count,
    max_assets = excluded.max_assets,
    estimated_cost_usd = excluded.estimated_cost_usd,
    max_cost_usd = excluded.max_cost_usd,
    updated_at = now()
  returning * into v_plan;

  for v_asset in select * from jsonb_array_elements(p_assets)
  loop
    if jsonb_typeof(v_asset) <> 'object' then
      continue;
    end if;

    insert into public.project_image_assets (
      plan_id, project_id, run_id, user_id, asset_key, reuse_key, purpose,
      page_path, section_id, product_id, product_image_index, alt_text, prompt,
      aspect_ratio, priority, required, status, max_attempts, model, estimated_cost_usd
    ) values (
      v_plan.id,
      p_project_id,
      p_run_id,
      v_uid,
      v_asset ->> 'assetKey',
      nullif(v_asset ->> 'reuseKey', ''),
      coalesce(nullif(lower(v_asset ->> 'purpose'), ''), 'other'),
      coalesce(nullif(v_asset ->> 'pagePath', ''), '/'),
      nullif(v_asset ->> 'sectionId', ''),
      nullif(v_asset ->> 'productId', ''),
      case when v_asset ->> 'productImageIndex' ~ '^[0-9]{1,2}$'
           then (v_asset ->> 'productImageIndex')::integer else null end,
      left(coalesce(v_asset ->> 'alt', ''), 200),
      left(coalesce(nullif(v_asset ->> 'prompt', ''), 'Image'), 1000),
      coalesce(nullif(v_asset ->> 'aspectRatio', ''), '16:9'),
      least(5, greatest(1,
        case when v_asset ->> 'priority' ~ '^[0-9]{1,2}$'
             then (v_asset ->> 'priority')::integer else 3 end)),
      coalesce((v_asset ->> 'required') = 'true', false),
      case when (v_asset ->> 'deferred') = 'true' then 'deferred' else 'planned' end,
      least(3, greatest(1,
        case when v_asset ->> 'maxAttempts' ~ '^[0-9]{1,2}$'
             then (v_asset ->> 'maxAttempts')::integer else 2 end)),
      p_model,
      least(1, greatest(
        case when v_asset ->> 'estimatedCostUsd' ~ '^[0-9]+(\.[0-9]+)?$'
             then (v_asset ->> 'estimatedCostUsd')::numeric else 0 end, 0))
    )
    on conflict (project_id, run_id, asset_key) do update set
      reuse_key = excluded.reuse_key,
      purpose = excluded.purpose,
      page_path = excluded.page_path,
      section_id = excluded.section_id,
      product_id = excluded.product_id,
      product_image_index = excluded.product_image_index,
      alt_text = excluded.alt_text,
      prompt = excluded.prompt,
      aspect_ratio = excluded.aspect_ratio,
      priority = excluded.priority,
      required = excluded.required,
      model = excluded.model,
      estimated_cost_usd = excluded.estimated_cost_usd,
      -- Only an un-started row may be re-planned: a tighter or wider budget on a
      -- later attempt is reflected here, while ready/generating rows above are
      -- never touched and attempts already spent are never refunded.
      status = excluded.status,
      updated_at = now()
    where project_image_assets.status in ('planned','failed','deferred');

    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object(
    'planId', v_plan.id,
    'approvedCount', v_plan.approved_count,
    'assets', v_inserted
  );
end;
$$;

comment on function public.sync_image_plan(text, uuid, integer, text, text, integer, integer, integer, integer, integer, numeric, numeric, jsonb) is
  'Upserts the owner''s approved image plan and its assets. Ready/generating rows are never rewritten, so a resume cannot duplicate or reset completed work.';

-- ── Claim one asset before a paid provider call ─────────────────────────────

create or replace function public.claim_image_asset(
  p_project_id text,
  p_run_id uuid,
  p_asset_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.project_image_assets;
  v_approved integer;
begin
  if not public.image_plan_caller_owns_project(p_project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  -- The plan is the backend's approval record: no plan, no paid call. The
  -- per-plan ceiling itself is enforced when the plan is synced, and only
  -- approved (non-deferred) rows are ever claimable.
  select pl.approved_count into v_approved
  from public.project_image_plans pl
  where pl.project_id = p_project_id and pl.run_id = p_run_id;

  if coalesce(v_approved, 0) <= 0 then
    return null;
  end if;

  update public.project_image_assets a
  set status = 'generating',
      attempt_count = a.attempt_count + 1,
      claimed_at = now(),
      failure_code = null,
      failure_reason = null,
      updated_at = now()
  where a.project_id = p_project_id
    and a.run_id = p_run_id
    and a.asset_key = p_asset_key
    and a.status <> 'deferred'
    and a.status <> 'skipped'
    and a.attempt_count < a.max_attempts
    and (
      a.status = 'planned'
      or a.status = 'failed'
      or (a.status = 'generating' and a.claimed_at < now() - interval '5 minutes')
    )
  returning * into v_row;

  if v_row.id is null then
    return null;
  end if;

  update public.project_image_plans pl
  set status = 'executing', updated_at = now()
  where pl.id = v_row.plan_id and pl.status = 'planned';

  return jsonb_build_object(
    'id', v_row.id,
    'assetKey', v_row.asset_key,
    'prompt', v_row.prompt,
    'aspectRatio', v_row.aspect_ratio,
    'attempt', v_row.attempt_count,
    'maxAttempts', v_row.max_attempts,
    'pagePath', v_row.page_path,
    'purpose', v_row.purpose,
    'sectionId', v_row.section_id,
    'productId', v_row.product_id,
    'alt', v_row.alt_text
  );
end;
$$;

comment on function public.claim_image_asset(text, uuid, text) is
  'Atomically claims one asset (by run + asset key) for one provider attempt. A second worker gets null; a stale generating claim is reclaimable after five minutes.';

-- ── Complete / fail one asset ───────────────────────────────────────────────

create or replace function public.complete_image_asset(
  p_asset_id uuid,
  p_storage_path text,
  p_public_url text,
  p_media_type text,
  p_bytes bigint,
  p_actual_cost_usd numeric,
  p_cost_known boolean,
  p_provider_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project text;
begin
  select a.project_id into v_project
  from public.project_image_assets a where a.id = p_asset_id;

  if v_project is null then
    return false;
  end if;
  if not public.image_plan_caller_owns_project(v_project) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_image_assets a
  set status = 'ready',
      storage_path = left(p_storage_path, 400),
      public_url = left(p_public_url, 800),
      media_type = p_media_type,
      bytes = p_bytes,
      actual_cost_usd = p_actual_cost_usd,
      cost_known = coalesce(p_cost_known, false),
      provider_request_id = coalesce(left(p_provider_request_id, 200), a.provider_request_id),
      completed_at = now(),
      claimed_at = null,
      updated_at = now()
  where a.id = p_asset_id and a.status = 'generating';

  if found then
    return true;
  end if;

  -- Idempotent success: a retried completion for an already-ready asset is not
  -- an error and must not reset the row.
  return exists (
    select 1 from public.project_image_assets a
    where a.id = p_asset_id and a.status = 'ready'
  );
end;
$$;

create or replace function public.fail_image_asset(
  p_asset_id uuid,
  p_error_code text,
  p_error_reason text,
  p_uncertain boolean,
  p_actual_cost_usd numeric
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project text;
begin
  select a.project_id into v_project
  from public.project_image_assets a where a.id = p_asset_id;

  if v_project is null then
    return false;
  end if;
  if not public.image_plan_caller_owns_project(v_project) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  update public.project_image_assets a
  set status = 'failed',
      failure_code = nullif(left(btrim(coalesce(p_error_code, '')), 64), ''),
      failure_reason = nullif(left(btrim(coalesce(p_error_reason, '')), 300), ''),
      actual_cost_usd = p_actual_cost_usd,
      cost_known = (coalesce(p_uncertain, true) = false and p_actual_cost_usd is not null),
      claimed_at = null,
      updated_at = now()
  where a.id = p_asset_id and a.status = 'generating';

  if found then
    return true;
  end if;

  return exists (
    select 1 from public.project_image_assets a
    where a.id = p_asset_id and a.status = 'failed'
  );
end;
$$;

-- ── Settle the plan's truthful status ───────────────────────────────────────

create or replace function public.finish_image_plan(
  p_project_id text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.project_image_plans;
  v_ready integer := 0;
  v_failed integer := 0;
  v_deferred integer := 0;
  v_pending integer := 0;
  v_required_missing integer := 0;
  v_status text;
begin
  if not public.image_plan_caller_owns_project(p_project_id) then
    raise exception 'PROJECT_FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_plan from public.project_image_plans pl
  where pl.project_id = p_project_id and pl.run_id = p_run_id;

  if v_plan.id is null then
    return null;
  end if;

  select
    count(*) filter (where a.status = 'ready'),
    count(*) filter (where a.status = 'failed'),
    count(*) filter (where a.status in ('deferred','skipped')),
    count(*) filter (where a.status in ('planned','generating')),
    count(*) filter (where a.required and a.status <> 'ready')
  into v_ready, v_failed, v_deferred, v_pending, v_required_missing
  from public.project_image_assets a
  where a.plan_id = v_plan.id;

  v_status := case
    -- Nothing was approved: deferred-only is a partial outcome, not success.
    when v_plan.approved_count = 0 and v_deferred > 0 then 'partial'
    when v_plan.approved_count = 0 then 'completed'
    when v_pending = 0 and v_ready = 0 then 'failed'
    when v_pending = 0 and (v_failed > 0 or v_deferred > 0) then 'partial'
    when v_pending = 0 then 'completed'
    else 'executing'
  end;

  update public.project_image_plans pl
  set status = v_status, updated_at = now()
  where pl.id = v_plan.id;

  return jsonb_build_object(
    'planId', v_plan.id,
    'status', v_status,
    'ready', v_ready,
    'failed', v_failed,
    'deferred', v_deferred,
    'pending', v_pending,
    'requiredMissing', v_required_missing,
    'approved', v_plan.approved_count
  );
end;
$$;

comment on function public.finish_image_plan(text, uuid) is
  'Recomputes the plan''s status from its asset rows: completed, partial, failed or still executing. Never reports success it cannot see.';

-- ── Storage ─────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-images',
  'project-images',
  true,
  6000000,
  array['image/png','image/jpeg']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 6000000,
  allowed_mime_types = array['image/png','image/jpeg'];

drop policy if exists "project_images_owner_insert" on storage.objects;
create policy "project_images_owner_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-images'
    and exists (
      select 1 from public.projects p
      where p.project_id = (storage.foldername(name))[1]
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_images_owner_update" on storage.objects;
create policy "project_images_owner_update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-images'
    and exists (
      select 1 from public.projects p
      where p.project_id = (storage.foldername(name))[1]
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    bucket_id = 'project-images'
    and exists (
      select 1 from public.projects p
      where p.project_id = (storage.foldername(name))[1]
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_images_owner_delete" on storage.objects;
create policy "project_images_owner_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-images'
    and exists (
      select 1 from public.projects p
      where p.project_id = (storage.foldername(name))[1]
        and p.user_id = (select auth.uid())
    )
  );

-- ── Grants and schema marker ────────────────────────────────────────────────

revoke all on function public.image_plan_caller_owns_project(text) from anon;
revoke all on function public.sync_image_plan(text, uuid, integer, text, text, integer, integer, integer, integer, integer, numeric, numeric, jsonb) from anon;
revoke all on function public.claim_image_asset(text, uuid, text) from anon;
revoke all on function public.complete_image_asset(uuid, text, text, text, bigint, numeric, boolean, text) from anon;
revoke all on function public.fail_image_asset(uuid, text, text, boolean, numeric) from anon;
revoke all on function public.finish_image_plan(text, uuid) from anon;

grant execute on function public.sync_image_plan(text, uuid, integer, text, text, integer, integer, integer, integer, integer, numeric, numeric, jsonb) to authenticated, service_role;
grant execute on function public.claim_image_asset(text, uuid, text) to authenticated, service_role;
grant execute on function public.complete_image_asset(uuid, text, text, text, bigint, numeric, boolean, text) to authenticated, service_role;
grant execute on function public.fail_image_asset(uuid, text, text, boolean, numeric) to authenticated, service_role;
grant execute on function public.finish_image_plan(text, uuid) to authenticated, service_role;

create or replace function public.project_image_schema_version()
returns integer
language sql
stable
as $$ select 33 $$;

comment on function public.project_image_schema_version() is
  'Schema marker 33: planning-driven image assets (migration 33).';

grant execute on function public.project_image_schema_version() to authenticated, service_role;

commit;
