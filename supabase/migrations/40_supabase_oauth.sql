-- Mavly — Customer-owned Supabase via Management API OAuth (migration 40).
--
-- ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
--
-- Migration 39 let an owner paste a Supabase service-role key. That is a
-- credential the user has to mint by hand, and it never expires on its own.
-- This migration replaces it with the Supabase Management API OAuth flow: the
-- user authorizes Mavly in Supabase's own consent screen, and Mavly holds a
-- revocable, expiring, refreshable token pair instead.
--
-- ═══ WHAT IS ADDED ═══════════════════════════════════════════════════════════
--
--   1. `supabase_oauth_states` — short-lived, single-use PKCE state rows.
--   2. `supabase_oauth_connections` — one row per (user, project): the encrypted
--      access/refresh token pair, the granted scopes, and the selected Supabase
--      project ref.
--   3. `supabase_oauth_audit` — append-only, secret-free record of every brokered
--      action (who, which action, which project, allowed or refused, why).
--   4. Owner-checked SECURITY DEFINER RPCs. The authenticated role gets no direct
--      write grant; every write is fenced.
--
-- ═══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════
--
-- No plaintext token, no service-role key, no SQL text, no query result. Tokens
-- are AES-256-GCM ciphertext produced by the existing project-secrets primitive,
-- AAD-bound to (user, project, purpose). Audit rows record the ACTION, never the
-- statement or its values.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Additive and non-destructive. Apply after 39. It does not alter
-- `project_backend_providers`, `project_secrets`, `projects` or any earlier
-- table, and it never deletes a customer database or data.
--
-- ⚠️ MIGRATION 39'S `service_role_ciphertext` IS LEFT IN PLACE. Existing rows
-- keep working; the OAuth flow supersedes them without a destructive backfill.

begin;

-- ── 1. Single-use PKCE state ────────────────────────────────────────────────

create table if not exists public.supabase_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The PKCE verifier, encrypted. It never leaves the server in plaintext.
  code_verifier_ciphertext text not null,
  -- Where the browser goes back to after the callback, and which Mavly project
  -- this connection is for. Both are re-validated on the way out.
  return_to text not null default '/dashboard',
  mavly_project_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint supabase_oauth_states_hash_check
    check (state_hash ~ '^[A-Za-z0-9_-]{43,64}$'),
  constraint supabase_oauth_states_return_to_check
    check (length(return_to) <= 2048 and return_to like '/%')
);

comment on table public.supabase_oauth_states is
  'Short-lived single-use PKCE state rows for the Supabase Management API OAuth flow. Consumed by a delete-returning RPC so a replayed callback finds nothing.';

create index if not exists supabase_oauth_states_expiry_idx
  on public.supabase_oauth_states (expires_at);

-- ── 2. The encrypted token pair ─────────────────────────────────────────────

create table if not exists public.supabase_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The Mavly project this Supabase project backs. One Supabase project may back
  -- several Mavly projects, so the pair is the identity, not the ref alone.
  mavly_project_id text not null references public.projects (project_id) on delete cascade,
  -- ⚠️ NULLABLE ON PURPOSE. The callback stores the token pair before the user has
  -- chosen a project, so the row exists in `pending_selection` with no ref yet.
  supabase_project_ref text,
  supabase_project_name text,
  organization_slug text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- The scopes Supabase actually granted. Never assumed from the request.
  granted_scopes text[] not null default '{}'::text[],
  status text not null default 'connected',
  last_error text,
  last_refreshed_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supabase_oauth_connections_status_check
    check (status in ('pending_selection', 'connected', 'expired', 'revoked', 'reconnection_required')),
  constraint supabase_oauth_connections_ref_check
    check (supabase_project_ref is null or supabase_project_ref ~ '^[a-z0-9]{6,40}$'),
  -- A row that is not pending selection must name a project.
  constraint supabase_oauth_connections_ref_required
    check (status = 'pending_selection' or supabase_project_ref is not null),
  constraint supabase_oauth_connections_last_error_length
    check (last_error is null or length(last_error) <= 300),
  constraint supabase_oauth_connections_unique
    unique (user_id, mavly_project_id)
);

comment on table public.supabase_oauth_connections is
  'Encrypted Supabase Management API OAuth tokens per (user, Mavly project). Tokens are AES-256-GCM, AAD-bound to (user, project, purpose). No plaintext credential is ever stored.';
comment on column public.supabase_oauth_connections.granted_scopes is
  'The scopes Supabase granted, read from the token response. Authorization decisions use this, never the requested scope list.';

create index if not exists supabase_oauth_connections_user_idx
  on public.supabase_oauth_connections (user_id);
create index if not exists supabase_oauth_connections_project_idx
  on public.supabase_oauth_connections (mavly_project_id);

-- ── 3. Secret-free audit trail ──────────────────────────────────────────────

create table if not exists public.supabase_oauth_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  mavly_project_id text not null,
  supabase_project_ref text,
  action text not null,
  outcome text not null,
  reason_code text,
  -- ⚠️ COUNTS AND IDENTIFIERS ONLY. Never SQL text, never a row value, never a
  -- token fragment. This table is readable by the owner, so it must be safe.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint supabase_oauth_audit_outcome_check
    check (outcome in ('allowed', 'refused', 'failed', 'pending_approval')),
  constraint supabase_oauth_audit_metadata_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint supabase_oauth_audit_action_length
    check (length(action) between 1 and 64)
);

comment on table public.supabase_oauth_audit is
  'Append-only, secret-free audit of brokered Supabase actions. Records the action and its outcome, never SQL text, row values or tokens.';

create index if not exists supabase_oauth_audit_project_idx
  on public.supabase_oauth_audit (mavly_project_id, created_at desc);

-- ── 4. Owner-checked RPCs ───────────────────────────────────────────────────

create or replace function public.supabase_oauth_owner_ok(
  p_project_id text,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
     where p.project_id = p_project_id and p.user_id = p_user_id
  );
$$;
revoke all on function public.supabase_oauth_owner_ok(text, uuid)
  from public, anon, authenticated;

/** Store a single-use PKCE state row. */
create or replace function public.create_supabase_oauth_state(
  p_state_hash text,
  p_code_verifier_ciphertext text,
  p_return_to text,
  p_mavly_project_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_mavly_project_id is not null
     and not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  insert into public.supabase_oauth_states (
    state_hash, user_id, code_verifier_ciphertext, return_to, mavly_project_id, expires_at
  )
  values (
    p_state_hash, v_user, p_code_verifier_ciphertext, p_return_to, p_mavly_project_id,
    now() + interval '10 minutes'
  );
  return true;
end;
$$;
revoke all on function public.create_supabase_oauth_state(text, text, text, text)
  from public, anon;
grant execute on function public.create_supabase_oauth_state(text, text, text, text)
  to authenticated;

/**
 * Consume a state row atomically.
 *
 * ⚠️ DELETE ... RETURNING IS THE SINGLE-USE GUARANTEE. Two callbacks arriving at
 * the same instant cannot both find the row, so a replayed authorization code
 * cannot be exchanged twice.
 */
create or replace function public.consume_supabase_oauth_state(p_state_hash text)
returns table (
  code_verifier_ciphertext text,
  return_to text,
  mavly_project_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.supabase_oauth_states%rowtype;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  delete from public.supabase_oauth_states s
   where s.state_hash = p_state_hash and s.user_id = v_user
  returning * into v_row;

  if v_row.state_hash is null then
    raise exception using errcode = 'P0002', message = 'state not found';
  end if;
  if v_row.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'state expired';
  end if;

  return query
    select v_row.code_verifier_ciphertext, v_row.return_to, v_row.mavly_project_id;
end;
$$;
revoke all on function public.consume_supabase_oauth_state(text)
  from public, anon;
grant execute on function public.consume_supabase_oauth_state(text)
  to authenticated;

/** Save (or replace) the encrypted token pair for a project. */
create or replace function public.save_supabase_oauth_connection(
  p_mavly_project_id text,
  p_supabase_project_ref text,
  p_supabase_project_name text,
  p_organization_slug text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_access_token_expires_at timestamptz,
  p_granted_scopes text[]
)
returns table (supabase_project_ref text, status text, granted_scopes text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  insert into public.supabase_oauth_connections as c (
    user_id, mavly_project_id, supabase_project_ref, supabase_project_name,
    organization_slug, access_token_ciphertext, refresh_token_ciphertext,
    access_token_expires_at, granted_scopes, status, connected_at
  )
  values (
    v_user, p_mavly_project_id, p_supabase_project_ref, p_supabase_project_name,
    p_organization_slug, p_access_token_ciphertext, p_refresh_token_ciphertext,
    p_access_token_expires_at, coalesce(p_granted_scopes, '{}'::text[]),
    -- ⚠️ STATUS IS DERIVED FROM THE REF, NOT PASSED IN. A row with no project is
    -- awaiting selection; a row with one is connected. The caller cannot claim
    -- `connected` for a row that names no project.
    case when p_supabase_project_ref is null then 'pending_selection' else 'connected' end,
    now()
  )
  on conflict (user_id, mavly_project_id) do update
    set supabase_project_ref = excluded.supabase_project_ref,
        supabase_project_name = coalesce(excluded.supabase_project_name, c.supabase_project_name),
        organization_slug = coalesce(excluded.organization_slug, c.organization_slug),
        access_token_ciphertext = excluded.access_token_ciphertext,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        access_token_expires_at = excluded.access_token_expires_at,
        granted_scopes = excluded.granted_scopes,
        status = case
          when excluded.supabase_project_ref is null then 'pending_selection'
          else 'connected'
        end,
        last_error = null,
        updated_at = now();

  return query
    select c.supabase_project_ref, c.status, c.granted_scopes
      from public.supabase_oauth_connections c
     where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id;
end;
$$;
revoke all on function public.save_supabase_oauth_connection(text, text, text, text, text, text, timestamptz, text[])
  from public, anon;
grant execute on function public.save_supabase_oauth_connection(text, text, text, text, text, text, timestamptz, text[])
  to authenticated;

/**
 * The owner's connection METADATA. Never a ciphertext, never a token.
 */
create or replace function public.read_supabase_oauth_connection(p_mavly_project_id text)
returns table (
  supabase_project_ref text,
  supabase_project_name text,
  organization_slug text,
  status text,
  granted_scopes text[],
  access_token_expires_at timestamptz,
  last_error text,
  connected_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  return query
    select c.supabase_project_ref, c.supabase_project_name, c.organization_slug,
           c.status, c.granted_scopes, c.access_token_expires_at, c.last_error,
           c.connected_at, c.updated_at
      from public.supabase_oauth_connections c
     where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id;
end;
$$;
revoke all on function public.read_supabase_oauth_connection(text)
  from public, anon;
grant execute on function public.read_supabase_oauth_connection(text)
  to authenticated;

/**
 * The token ciphertexts, for the OWNER of the project.
 *
 * ═══ WHY THIS IS OWNER-CHECKED AND NOT SERVICE-ROLE-ONLY ═════════════════════
 *
 * The first draft of this function required `auth.role() = 'service_role'`. That
 * was a design contradiction: every caller (the broker, the selection step, the
 * refresh path) runs inside a route handler holding the CALLER'S session client,
 * and `AGENTS.md` confines the service-role client to the generation worker and
 * its trusted entrypoints. So the function could never be called by anything that
 * needed it, and the whole integration was dead on arrival.
 *
 * ⚠️ WHAT MAKES THIS SAFE IS THE ENCRYPTION KEY, NOT THE GRANT. These columns are
 * AES-256-GCM ciphertext whose associated data binds each value to
 * `(user, project, purpose)`, and the key lives only in the server process
 * (`MAVLY_INTEGRATION_ENCRYPTION_KEY`). A browser session that calls this RPC
 * directly receives ciphertext it cannot decrypt, cannot replay into another row,
 * and cannot turn into a token. The real boundary is the key, and the key never
 * leaves the server.
 *
 * ⚠️ THE OWNER FILTER IS EXPLICIT. This is SECURITY DEFINER, so it bypasses RLS;
 * `c.user_id = auth.uid()` is what stops one account reading another's rows.
 */
create or replace function public.read_supabase_oauth_tokens(p_mavly_project_id text)
returns table (
  supabase_project_ref text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  granted_scopes text[],
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  return query
    select c.supabase_project_ref, c.access_token_ciphertext, c.refresh_token_ciphertext,
           c.access_token_expires_at, c.granted_scopes, c.status
      from public.supabase_oauth_connections c
     where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id;
end;
$$;
revoke all on function public.read_supabase_oauth_tokens(text)
  from public, anon;
grant execute on function public.read_supabase_oauth_tokens(text)
  to authenticated;

/** Record a status transition (expired / revoked / reconnection_required). */
create or replace function public.mark_supabase_oauth_status(
  p_mavly_project_id text,
  p_status text,
  p_last_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_status not in ('pending_selection', 'connected', 'expired', 'revoked', 'reconnection_required') then
    raise exception using errcode = '22023', message = 'invalid status';
  end if;

  update public.supabase_oauth_connections c
     set status = p_status,
         last_error = left(coalesce(p_last_error, ''), 300),
         updated_at = now()
   where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id;
  return found;
end;
$$;
revoke all on function public.mark_supabase_oauth_status(text, text, text)
  from public, anon;
grant execute on function public.mark_supabase_oauth_status(text, text, text)
  to authenticated;

/** Disconnect: delete the token row. The customer's Supabase project is untouched. */
create or replace function public.delete_supabase_oauth_connection(p_mavly_project_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  delete from public.supabase_oauth_connections c
   where c.user_id = v_user and c.mavly_project_id = p_mavly_project_id;
  return found;
end;
$$;
revoke all on function public.delete_supabase_oauth_connection(text)
  from public, anon;
grant execute on function public.delete_supabase_oauth_connection(text)
  to authenticated;

/** Append an audit row. Owner-scoped; the metadata is caller-supplied and secret-free. */
create or replace function public.record_supabase_oauth_audit(
  p_mavly_project_id text,
  p_supabase_project_ref text,
  p_action text,
  p_outcome text,
  p_reason_code text,
  p_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if not public.supabase_oauth_owner_ok(p_mavly_project_id, v_user) then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  insert into public.supabase_oauth_audit (
    user_id, mavly_project_id, supabase_project_ref, action, outcome, reason_code, metadata
  )
  values (
    v_user, p_mavly_project_id, p_supabase_project_ref, p_action, p_outcome,
    p_reason_code, coalesce(p_metadata, '{}'::jsonb)
  );
  return true;
end;
$$;
revoke all on function public.record_supabase_oauth_audit(text, text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.record_supabase_oauth_audit(text, text, text, text, text, jsonb)
  to authenticated;

-- ── 5. RLS: owner reads, nobody writes directly ─────────────────────────────

alter table public.supabase_oauth_states enable row level security;
alter table public.supabase_oauth_connections enable row level security;
alter table public.supabase_oauth_audit enable row level security;

drop policy if exists supabase_oauth_states_owner on public.supabase_oauth_states;
create policy supabase_oauth_states_owner
  on public.supabase_oauth_states for select to authenticated
  using (user_id = auth.uid());

drop policy if exists supabase_oauth_connections_owner on public.supabase_oauth_connections;
create policy supabase_oauth_connections_owner
  on public.supabase_oauth_connections for select to authenticated
  using (user_id = auth.uid());

drop policy if exists supabase_oauth_audit_owner on public.supabase_oauth_audit;
create policy supabase_oauth_audit_owner
  on public.supabase_oauth_audit for select to authenticated
  using (user_id = auth.uid());

/**
 * ⚠️ NO INSERT/UPDATE/DELETE POLICY AND NO WRITE GRANT. Every mutation goes
 * through a fenced RPC, so the authenticated role cannot write a token row
 * directly or forge an audit entry.
 */
revoke insert, update, delete on public.supabase_oauth_states
  from authenticated, anon;
revoke insert, update, delete on public.supabase_oauth_connections
  from authenticated, anon;
revoke insert, update, delete on public.supabase_oauth_audit
  from authenticated, anon;
grant select on public.supabase_oauth_states to authenticated;
grant select on public.supabase_oauth_connections to authenticated;
grant select on public.supabase_oauth_audit to authenticated;

-- ── 6. Schema marker ────────────────────────────────────────────────────────

create or replace function public.supabase_oauth_schema_version()
returns integer
language sql
stable
as $$ select 40 $$;

comment on function public.supabase_oauth_schema_version() is
  'Schema marker 40: Supabase Management API OAuth state, encrypted token pair, secret-free audit and owner-checked RPCs.';

revoke all on function public.supabase_oauth_schema_version() from public;
revoke all on function public.supabase_oauth_schema_version() from anon;
grant execute on function public.supabase_oauth_schema_version()
  to authenticated, service_role;

commit;
