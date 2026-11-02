-- Mavly — Backend selection authority: managed Neon as a registered provider,
-- provider-specific readiness, stale-request fencing, and the server-only
-- backend context (migration 48).
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Migration 39 made "at most one active provider" a database fact, but only for
-- rows that exist. It had a hole with real consequences:
--
--   `mavly_managed_neon` was NEVER registered as a provider row. Only
--   `external_supabase` was. So a project could have a `ready` managed Neon
--   database in `project_managed_backends` AND an active `external_supabase`
--   provider row at the same time — two live backends, which is exactly the
--   state the product forbids. The UI hid this with a `legacyManagedBackend`
--   fallback that *reported* Neon as active without any row backing it, so the
--   one-active-provider index never saw Neon at all and could not constrain it.
--
--   The generated app's data gateway then resolved the managed backend directly
--   from `project_managed_backends`, ignoring provider selection entirely. A
--   project that had switched to Supabase still served from Neon.
--
-- ═══ WHAT IS ADDED ═══════════════════════════════════════════════════════════
--
--   1. `backend_selection_epoch` on `projects` — a monotonic counter bumped by
--      every activation. A generation run records the epoch it started under and
--      a stale run is refused, so one generation can never mix two providers.
--   2. `register_managed_backend_provider` — the managed Neon provider row is
--      created/refreshed from the trusted lifecycle, never from a client claim.
--   3. `activate_backend_provider` is REPLACED (same signature) to add
--      provider-specific readiness: managed Neon must have a genuinely `ready`
--      lifecycle row with a verified schema and configured gateway; Supabase must
--      have a verified connection. It also bumps the epoch atomically.
--   4. `read_backend_context` — the single server-only source of truth the agents
--      and the gateway both read. It resolves the ACTIVE provider and refuses to
--      guess when the registry and the lifecycle disagree.
--   5. A backfill that registers an existing ready managed backend as the active
--      provider row, so a pre-48 project is not left with an unconstrained Neon.
--
-- ═══ WHAT IT DOES NOT DO ═════════════════════════════════════════════════════
--
-- It deletes no database, drops no Neon project, revokes no Supabase OAuth
-- connection, and never moves customer data between providers. Switching only
-- moves the `active` flag, exactly as migration 39 established.
--
-- Additive and non-destructive. Apply after 47.

begin;

-- ── 1. The selection epoch ──────────────────────────────────────────────────
--
-- ⚠️ A TIMESTAMP WOULD BE WRONG HERE. Two activations inside the same
-- millisecond are possible, and a clock that moves backwards would make a stale
-- run look current. A monotonic integer bumped under the same per-project lock
-- that performs the swap is the only ordering that cannot lie.

alter table public.projects
  add column if not exists backend_selection_epoch bigint not null default 0;

comment on column public.projects.backend_selection_epoch is
  'Monotonic counter bumped by every backend activation. A generation run records the epoch it began under; a mismatch means the backend changed mid-run and the run must not continue against a different provider.';

-- ── 2. Managed Neon readiness, as one trusted predicate ─────────────────────
--
-- ⚠️ "READY" IS NOT ONE FACT. A managed backend is only genuinely ready when the
-- lifecycle row says `ready` AND the schema was verified AND the data gateway was
-- configured. `provisioned` means a Neon project exists and Mavly connected once;
-- it is never CRUD readiness. This predicate is the single definition so the
-- activation RPC, the context RPC and the backfill cannot drift apart.

create or replace function public.managed_backend_is_ready(p_project_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.project_managed_backends b
     where b.project_id = p_project_id
       and b.status = 'ready'
       and b.schema_verified_at is not null
       and b.gateway_configured_at is not null
       and b.connection_uri_ciphertext is not null
  );
$$;
revoke all on function public.managed_backend_is_ready(text) from public, anon, authenticated;
grant execute on function public.managed_backend_is_ready(text) to service_role;

comment on function public.managed_backend_is_ready(text) is
  'Trusted managed-backend readiness: lifecycle ready AND schema verified AND gateway configured AND a connection stored. Used by activation, the backend context and the gateway.';

-- ── 3. Register the managed Neon provider row ───────────────────────────────
--
-- ⚠️ SERVER-ONLY, AND IT DERIVES STATUS FROM THE LIFECYCLE. A caller cannot ask
-- for `ready`: the row's status is computed from `project_managed_backends` and
-- the readiness predicate above. This is what makes the one-active-provider
-- index able to constrain Neon at all.

create or replace function public.register_managed_backend_provider(
  p_project_id text,
  p_user_id uuid
)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lifecycle text;
  v_status text;
  v_owner uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select p.user_id into v_owner
    from public.projects p
   where p.project_id = p_project_id;
  if v_owner is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;
  -- The worker passes the run's owner; a mismatch is a bug or an attack.
  if v_owner <> p_user_id then
    raise exception using errcode = '42501', message = 'owner mismatch';
  end if;

  select b.status into v_lifecycle
    from public.project_managed_backends b
   where b.project_id = p_project_id
   order by b.created_at desc
   limit 1;

  v_status := case
    when v_lifecycle is null then 'not_connected'
    when public.managed_backend_is_ready(p_project_id) then 'ready'
    when v_lifecycle in ('provisioning', 'provisioned', 'configuring') then 'provisioning'
    when v_lifecycle = 'failed' then 'failed'
    when v_lifecycle = 'outcome_unknown' then 'reconnection_required'
    when v_lifecycle = 'cleanup_pending' then 'suspended'
    else 'not_connected'
  end;

  /**
   * ⚠️ AN ACTIVE ROW MAY NOT BE DEMOTED BELOW A SERVING STATE BY A REFRESH.
   * `project_backend_providers_active_status_check` permits active only when the
   * status is ready or provisioning. If a refresh would write `failed` onto the
   * active row, the constraint would abort the whole transaction and the run
   * would fail for a bookkeeping reason. Deactivating first keeps the write
   * legal and is the honest state: a failed backend is not the active one.
   */
  if v_status not in ('ready', 'provisioning') then
    update public.project_backend_providers r
       set active = false, updated_at = now()
     where r.project_id = p_project_id
       and r.provider = 'mavly_managed_neon'
       and r.active;
  end if;

  /**
   * ⚠️ `#variable_conflict use_column` IS REQUIRED HERE. This function's OUT
   * parameter is named `provider`, which shadows the table column inside the
   * INSERT below, and PL/pgSQL raises "column reference provider is ambiguous"
   * at runtime. The directive resolves the ambiguity in favor of the column.
   *
   * ⚠️ THE CONFLICT TARGET IS THE COLUMN LIST, NOT A CONSTRAINT NAME: migration
   * 39 creates a unique INDEX, and `on conflict on constraint` only accepts a
   * real constraint.
   */
  insert into public.project_backend_providers as r (
    project_id, user_id, provider, status, active, config, connected_at
  )
  values (
    p_project_id, p_user_id, 'mavly_managed_neon', v_status, false,
    jsonb_build_object('managed', true), now()
  )
  on conflict (project_id, provider) do update
    set status = v_status,
        connected_at = coalesce(r.connected_at, now()),
        disconnected_at = null,
        updated_at = now();

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = 'mavly_managed_neon';
end;
$$;
revoke all on function public.register_managed_backend_provider(text, uuid)
  from public, anon, authenticated;
grant execute on function public.register_managed_backend_provider(text, uuid)
  to service_role;

comment on function public.register_managed_backend_provider(text, uuid) is
  'Service-role only. Creates/refreshes the mavly_managed_neon provider row from the trusted lifecycle. Status is derived, never supplied by a caller.';

-- ── 4. Activation, with provider-specific readiness and the epoch bump ──────
--
-- Same signature as migration 39, so every existing caller keeps working. The
-- additions are: readiness is proven per provider, and the selection epoch is
-- bumped inside the same lock that performs the swap.

create or replace function public.activate_backend_provider(
  p_project_id text,
  p_provider text
)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.project_backend_providers%rowtype;
  v_current text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;
  if p_provider not in ('mavly_managed_neon', 'external_supabase') then
    raise exception using errcode = '22023', message = 'unsupported provider';
  end if;

  select * into v_row
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.provider = p_provider
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'provider not connected';
  end if;
  if v_row.status not in ('ready', 'provisioning') then
    raise exception using errcode = 'P0001', message = 'provider is not ready to activate';
  end if;

  /**
   * ⚠️ PROVIDER-SPECIFIC READINESS, NOT JUST THE ROW'S OWN STATUS.
   *
   * The row's `status` is Mavly's bookkeeping. The authoritative facts live in
   * the provider's own tables, and a row can claim `ready` after the underlying
   * resource stopped being usable. Activating on the row alone would make a
   * stale claim authoritative.
   */
  if p_provider = 'mavly_managed_neon' then
    if not public.managed_backend_is_ready(p_project_id) then
      raise exception using errcode = 'P0001',
        message = 'managed backend is not ready to activate';
    end if;
  else
    if v_row.verified_at is null then
      raise exception using errcode = 'P0001',
        message = 'supabase connection is not verified';
    end if;
    /**
     * The OAuth token row is what the broker actually acts through. A provider
     * row without a live connection would be a selection the runtime cannot
     * honour, so it is refused here rather than failing later at request time.
     */
    if not exists (
      select 1
        from public.supabase_oauth_connections c
       where c.mavly_project_id = p_project_id
         and c.supabase_project_ref = (v_row.config ->> 'projectRef')
         and c.status = 'connected'
    ) then
      raise exception using errcode = 'P0001',
        message = 'supabase connection is not active';
    end if;
  end if;

  -- Serialize the swap per project. Everything below is inside this lock.
  perform pg_advisory_xact_lock(hashtext('backend_provider:' || p_project_id));

  /**
   * ⚠️ RE-CHECK AFTER TAKING THE LOCK. The row was read before the lock, so a
   * concurrent activation could have changed it in between. Re-reading is what
   * makes "concurrent activation cannot activate both" true rather than likely.
   */
  select r.provider into v_current
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.active
   for update;

  update public.project_backend_providers r
     set active = false, updated_at = now()
   where r.project_id = p_project_id and r.active and r.provider <> p_provider;

  update public.project_backend_providers r
     set active = true, updated_at = now()
   where r.project_id = p_project_id and r.provider = p_provider;

  /**
   * ⚠️ THE EPOCH BUMPS ONLY ON A REAL CHANGE. Re-activating the already-active
   * provider is a no-op, and bumping there would invalidate in-flight runs for
   * nothing.
   */
  if v_current is distinct from p_provider then
    update public.projects p
       set backend_selection_epoch = p.backend_selection_epoch + 1
     where p.project_id = p_project_id;
  end if;

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = p_provider;
end;
$$;
revoke all on function public.activate_backend_provider(text, text)
  from public, anon;
grant execute on function public.activate_backend_provider(text, text)
  to authenticated;

-- ── 5. The authoritative backend context ────────────────────────────────────
--
-- ⚠️ THIS IS THE ONLY FUNCTION THE AGENTS AND THE GATEWAY MAY TRUST for "which
-- backend is selected". It reads the registry and the lifecycle together and
-- reports a conflict instead of picking one. A caller that resolves the provider
-- itself is how two agents end up disagreeing about the same project.

create or replace function public.read_backend_context(p_project_id text)
returns table (
  backend_provider text,
  backend_status text,
  backend_active boolean,
  selection_epoch bigint,
  managed_ready boolean,
  supabase_ready boolean,
  supabase_project_ref text,
  data_model jsonb,
  gateway_origin text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_active text;
  v_active_count integer;
  v_status text;
  v_epoch bigint;
  v_managed boolean;
  v_supabase boolean;
  v_ref text;
  v_model jsonb;
  v_origin text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select p.backend_selection_epoch into v_epoch
    from public.projects p
   where p.project_id = p_project_id;
  if v_epoch is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;

  select count(*)::integer into v_active_count
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.active;

  /**
   * ⚠️ TWO ACTIVE ROWS IS A BUG, NOT A TIE TO BREAK. The partial unique index
   * makes it impossible, so reaching here means the index is missing or was
   * dropped. Refusing is the only safe answer: guessing which backend to use is
   * how a project silently reads the wrong database.
   */
  if v_active_count > 1 then
    raise exception using errcode = 'P0001',
      message = 'multiple active backends for project';
  end if;

  select r.provider, r.status into v_active, v_status
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.active;

  v_managed := public.managed_backend_is_ready(p_project_id);

  select (r.status = 'ready' and r.verified_at is not null),
         r.config ->> 'projectRef'
    into v_supabase, v_ref
    from public.project_backend_providers r
   where r.project_id = p_project_id and r.provider = 'external_supabase';

  v_supabase := coalesce(v_supabase, false);

  /**
   * ⚠️ THE LEGACY CASE, RESOLVED HONESTLY. A project whose managed backend is
   * genuinely ready but which has no provider row predates migration 48. It is
   * reported as `mavly_managed_neon` — because that IS the backend serving it —
   * with `backend_active = true`. Reporting `none` would tell the agents no
   * backend exists while the app reads a real database.
   *
   * This is a read-only projection. Migration 48's backfill registers the row so
   * the state stops being legacy.
   */
  if v_active is null and v_managed then
    v_active := 'mavly_managed_neon';
    v_status := 'ready';
  end if;

  if v_active = 'mavly_managed_neon' then
    select b.data_model, b.gateway_origin
      into v_model, v_origin
      from public.project_managed_backends b
     where b.project_id = p_project_id
       and b.status = 'ready'
     order by b.created_at desc
     limit 1;
  end if;

  return query
    select
      coalesce(v_active, 'none'),
      coalesce(v_status, 'not_selected'),
      v_active is not null,
      v_epoch,
      v_managed,
      v_supabase,
      v_ref,
      v_model,
      v_origin;
end;
$$;
revoke all on function public.read_backend_context(text)
  from public, anon, authenticated;
grant execute on function public.read_backend_context(text) to service_role;

comment on function public.read_backend_context(text) is
  'Service-role only. The single authoritative answer to "which backend is selected". Reports a conflict rather than choosing when the registry is inconsistent. Read by the agents and the generated-app gateway.';

-- ── 6. Backfill: register an existing ready managed backend ─────────────────
--
-- ⚠️ WITHOUT THIS, A PRE-48 PROJECT IS STILL UNCONSTRAINED. Its Neon database is
-- live and serving, but no provider row exists, so the one-active-provider index
-- cannot see it and a Supabase activation could create two live backends.
--
-- The backfill registers the row as ACTIVE only when nothing else is active. If
-- a Supabase row is already active, the Neon row is registered as ready but NOT
-- active — that is a real double-backend state the operator must resolve, and
-- silently deactivating either one would be Mavly choosing a backend for the
-- customer.

insert into public.project_backend_providers as r (
  project_id, user_id, provider, status, active, config, connected_at
)
select
  b.project_id,
  p.user_id,
  'mavly_managed_neon',
  'ready',
  not exists (
    select 1 from public.project_backend_providers x
     where x.project_id = b.project_id and x.active
  ),
  jsonb_build_object('managed', true, 'backfilled', true),
  coalesce(b.created_at, now())
from public.project_managed_backends b
join public.projects p on p.project_id = b.project_id
where b.status = 'ready'
  and b.schema_verified_at is not null
  and b.gateway_configured_at is not null
  and b.connection_uri_ciphertext is not null
  and p.user_id is not null
on conflict (project_id, provider) do nothing;

-- ── 7. Repair: connect_external_supabase was unusable ───────────────────────
--
-- ⚠️ THIS FIXES A PRE-EXISTING DEFECT IN MIGRATION 39, NOT A DEFECT IN THIS WORK.
--
-- `connect_external_supabase` declares an OUT parameter named `provider` and then
-- writes `on conflict (project_id, provider)`. PL/pgSQL cannot tell whether
-- `provider` means the OUT variable or the column, so EVERY call raised
-- "column reference provider is ambiguous" at runtime. The customer Supabase
-- connection path has therefore never worked: the OAuth callback reaches this
-- function and fails, and the provider row is never written.
--
-- ⚠️ MIGRATION 39 IS NOT EDITED. It may already be applied in environments this
-- change cannot see, and rewriting an applied migration is how two databases end
-- up with different function bodies. The function is REPLACED here instead, with
-- the same signature, so this is additive and safe to apply over 39.
--
-- ⚠️ `#variable_conflict use_column` IS THE MINIMAL FIX. It resolves the
-- ambiguity in favor of the column without renaming the OUT parameter, so the
-- function's return shape and every existing caller stay identical.

create or replace function public.connect_external_supabase(
  p_project_id text,
  p_config jsonb,
  p_service_role_ciphertext text,
  p_anon_key_secret_name text,
  p_verified boolean
)
returns table (provider text, status text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_status text;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.backend_provider_owner_ok(p_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid provider config';
  end if;

  v_status := case when coalesce(p_verified, false) then 'ready' else 'reconnection_required' end;

  insert into public.project_backend_providers as r (
    project_id, user_id, provider, status, active, config,
    service_role_ciphertext, anon_key_secret_name, verified_at, connected_at
  )
  values (
    p_project_id, v_user, 'external_supabase', v_status, false, p_config,
    p_service_role_ciphertext, p_anon_key_secret_name,
    case when coalesce(p_verified, false) then now() end, now()
  )
  on conflict (project_id, provider) do update
    set status = v_status,
        config = excluded.config,
        service_role_ciphertext = excluded.service_role_ciphertext,
        anon_key_secret_name = excluded.anon_key_secret_name,
        verified_at = excluded.verified_at,
        connected_at = coalesce(r.connected_at, now()),
        disconnected_at = null,
        last_error = null,
        updated_at = now();

  return query
    select r.provider, r.status, r.active
      from public.project_backend_providers r
     where r.project_id = p_project_id and r.provider = 'external_supabase';
end;
$$;
revoke all on function public.connect_external_supabase(text, jsonb, text, text, boolean)
  from public, anon; grant execute on function public.connect_external_supabase(text, jsonb, text, text, boolean)
  to authenticated; -- ── 7. Schema marker ────────────────────────────────────────────────────────

create or replace function public.backend_selection_schema_version()
returns integer
language sql
stable
as $$ select 48 $$;

comment on function public.backend_selection_schema_version() is
  'Schema marker 48: managed Neon registered as a provider, provider-specific activation readiness, monotonic selection epoch, and the server-only authoritative backend context.';

revoke all on function public.backend_selection_schema_version() from public, anon;
grant execute on function public.backend_selection_schema_version()
  to authenticated, service_role;

commit;
