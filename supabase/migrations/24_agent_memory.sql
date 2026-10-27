-- Mavly — Phase 8: project memory
--
-- ═══ WHAT THIS IS ═══════════════════════════════════════════════════════════
--
-- A small, project-scoped, human-controlled memory store for the generation
-- agent. It holds only two categories:
--
--   decision — an EXPLICIT user-approved project decision. The authenticated
--              role may only insert/update/delete decisions it authored.
--   failure — an observed terminal task outcome written by the server after a
--              failed/dead-lettered run. Never a raw transcript, provider body
--              or secret; it expires.
--
-- Repository facts are NOT stored here. They are derived from the current files
-- at run start, so a stale summary can never outrank the source.
--
-- ═══ ACCESS ═════════════════════════════════════════════════════════════════
--
-- RLS is owner-through-projects, like every other child table. The authenticated
-- insert/update policy is narrower than the table: a client may only create or
-- mutate a `decision` with `authority='user'`; `failure` observations are made by
-- the server (the worker's service-role client bypasses RLS after it re-verifies
-- the project owner). There is no read/write path for anon.
--
-- The column grants exclude `user_id`, `category`, `authority`, `source_kind`
-- and `dedupe_key` from update, so a client cannot promote an observed outcome
-- into a user decision or move a row to another project.
--
-- ═══ ROLLOUT ═════════════════════════════════════════════════════════════════
--
-- Apply after 23. Additive and non-destructive. Nothing is read or written until
-- MAVLY_AGENT_MEMORY_ENABLED + an explicit MAVLY_AGENT_MEMORY_PROJECTS cohort is
-- configured. Generation without the flag behaves exactly as before.

begin;

-- ── 1. Project memory table ─────────────────────────────────────────────────

create table if not exists public.project_memories (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects (project_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null,
  content text not null,
  provenance text not null,
  source_kind text not null,
  authority text not null,
  approval_state text not null,
  confidence text not null,
  status text not null default 'active',
  dedupe_key text not null,
  supersedes_id uuid references public.project_memories (id) on delete set null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint project_memories_category_check
    check (category in ('decision', 'failure')),
  constraint project_memories_content_check
    check (char_length(content) between 1 and 2000),
  -- Defense in depth for direct PostgREST writers: the server validator rejects
  -- a wider set, but the table itself must not accept the obvious credential
  -- shapes. A decision never needs to contain one.
  constraint project_memories_content_secret_shape_check
    check (
      content !~* '(sk_live_|sk_test_|rk_live_|rk_test_|rzp_live_|rzp_test_|ghp_|gho_|ghu_|ghs_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})'
      and content !~* '(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^[:space:]]+:[^[:space:]@]+@'
      and content !~* '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
    ),
  constraint project_memories_provenance_check
    check (char_length(provenance) between 1 and 200),
  constraint project_memories_source_kind_check
    check (source_kind in ('user', 'run', 'system')),
  constraint project_memories_authority_check
    check (authority in ('user', 'observed', 'repository')),
  constraint project_memories_approval_check
    check (approval_state in ('approved', 'proposed', 'not_required')),
  constraint project_memories_confidence_check
    check (confidence in ('verified', 'unverified')),
  constraint project_memories_status_check
    check (status in ('active', 'archived', 'proposed', 'superseded')),
  constraint project_memories_dedupe_check
    check (dedupe_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  constraint project_memories_revision_check
    check (revision between 1 and 1000000),
  -- A decision is only ever a user decision; an observed failure is never
  -- promoted into one. This is the core "AI suggestion is not approval" rule.
  constraint project_memories_decision_authority_check
    check (category <> 'decision' or authority = 'user'),
  constraint project_memories_failure_authority_check
    check (category <> 'failure' or authority = 'observed'),
  constraint project_memories_decision_approval_check
    check (category <> 'decision' or approval_state in ('approved', 'proposed')),
  constraint project_memories_failure_approval_check
    check (category <> 'failure' or approval_state = 'not_required'),
  -- Observations expire; decisions are explicit until archived/deleted.
  constraint project_memories_decision_expiry_check
    check (category <> 'decision' or expires_at is null),
  constraint project_memories_failure_expiry_check
    check (category <> 'failure' or expires_at is not null)
);

comment on table public.project_memories is
  'Project-scoped agent memory: explicit user decisions and observed terminal task outcomes. No secrets, raw prompts, source files or provider payloads.';
comment on column public.project_memories.category is
  'decision (explicit user-approved) or failure (observed terminal task outcome).';
comment on column public.project_memories.provenance is
  'Short human-auditable source label, e.g. user or run:<uuid>. Never a secret or raw message.';
comment on column public.project_memories.dedupe_key is
  'Stable topic/run key. Unique per project and category; supports idempotent failure notes.';
comment on column public.project_memories.revision is
  'Optimistic concurrency token; a client update must present the revision it read.';
comment on column public.project_memories.expires_at is
  'Failure observations expire; decisions do not. Retrieval excludes expired rows.';

create unique index if not exists project_memories_project_category_key
  on public.project_memories (project_id, category, dedupe_key);

create index if not exists project_memories_project_status_idx
  on public.project_memories (project_id, status, category, updated_at desc);

create index if not exists project_memories_project_created_idx
  on public.project_memories (project_id, created_at desc);

-- ── 2. RLS ──────────────────────────────────────────────────────────────────

alter table public.project_memories enable row level security;

drop policy if exists "project_memories_select_own" on public.project_memories;
create policy "project_memories_select_own"
  on public.project_memories
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_memories.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- A client may create only a user decision. The server's failure observations
-- are written through the service-role worker client, which bypasses RLS after
-- run-agent re-verifies the owner.
drop policy if exists "project_memories_insert_own" on public.project_memories;
create policy "project_memories_insert_own"
  on public.project_memories
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and category = 'decision'
    and authority = 'user'
    and source_kind = 'user'
    and provenance = 'user'
    and approval_state in ('approved', 'proposed')
    and expires_at is null
    and exists (
      select 1 from public.projects p
      where p.project_id = project_memories.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_memories_update_own" on public.project_memories;
create policy "project_memories_update_own"
  on public.project_memories
  for update
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_memories.project_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and category = 'decision'
    and authority = 'user'
    and source_kind = 'user'
    and provenance = 'user'
    and expires_at is null
    and exists (
      select 1 from public.projects p
      where p.project_id = project_memories.project_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "project_memories_delete_own" on public.project_memories;
create policy "project_memories_delete_own"
  on public.project_memories
  for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.projects p
      where p.project_id = project_memories.project_id
        and p.user_id = (select auth.uid())
    )
  );

-- ── 3. Least privilege ──────────────────────────────────────────────────────

revoke all on public.project_memories from public;
revoke all on public.project_memories from anon;
revoke all on public.project_memories from authenticated;

grant select (
  id, project_id, user_id, category, content, provenance, source_kind,
  authority, approval_state, confidence, status, dedupe_key, supersedes_id,
  revision, created_at, updated_at, expires_at
) on public.project_memories to authenticated;

grant insert (
  id, project_id, user_id, category, content, provenance, source_kind,
  authority, approval_state, confidence, status, dedupe_key, supersedes_id,
  revision, created_at, updated_at, expires_at
) on public.project_memories to authenticated;

grant update (
  content, approval_state, confidence, status, supersedes_id,
  revision, updated_at
) on public.project_memories to authenticated;

grant delete on public.project_memories to authenticated;

-- The generation worker writes observed failure outcomes with the service-role
-- client after re-verifying the project owner in run-agent.
grant select, insert, update, delete on public.project_memories to service_role;

-- ── 4. Owner-observed terminal failure (inline generation path) ─────────────
--
-- The worker path writes a failure note with its service-role client. The
-- inline path has only the owner's session, and the table's authenticated insert
-- policy deliberately permits decisions only. This RPC derives the note from the
-- terminal run row after checking ownership, so a client can record its own
-- observed failure but cannot submit arbitrary content or a decision.

create or replace function public.record_run_failure_memory(
  p_project_id text,
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_run public.project_runs%rowtype;
  v_class text;
  v_terminal text;
  v_content text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.project_id = p_project_id and p.user_id = v_uid
  ) then
    raise exception 'project not found' using errcode = '42501';
  end if;

  select r.* into v_run
    from public.project_runs r
   where r.id = p_run_id
     and r.project_id = p_project_id;

  if v_run.id is null then
    raise exception 'run not found' using errcode = '42501';
  end if;
  if v_run.finished_at is null
     or v_run.status is distinct from 'error'
     or v_run.stage is distinct from 'failed' then
    raise exception 'run is not a terminal failure' using errcode = '22023';
  end if;

  v_class := coalesce(v_run.last_error_class, v_run.error_code, 'GENERATION_FAILED');
  if v_class !~ '^[A-Za-z0-9._:-]{1,80}$' then
    v_class := 'GENERATION_FAILED';
  end if;
  v_terminal := case
    when v_run.dead_lettered_at is not null then 'was dead-lettered'
    else 'did not complete'
  end;
  v_content := 'A generation attempt ' || v_terminal || ' (' || v_class ||
    '). Earlier batches may be checkpointed and resumable from the workspace. ' ||
    'This is an observed outcome, not a verified root cause or a project-code defect.';

  insert into public.project_memories (
    project_id, user_id, category, content, provenance, source_kind, authority,
    approval_state, confidence, status, dedupe_key, revision, created_at,
    updated_at, expires_at
  ) values (
    p_project_id, v_uid, 'failure', v_content, 'run:' || p_run_id::text,
    'run', 'observed', 'not_required', 'verified', 'active',
    'run:' || p_run_id::text, 1, now(), now(), now() + interval '30 days'
  )
  on conflict (project_id, category, dedupe_key) do update set
    content = excluded.content,
    provenance = excluded.provenance,
    source_kind = excluded.source_kind,
    authority = excluded.authority,
    approval_state = excluded.approval_state,
    confidence = excluded.confidence,
    status = 'active',
    updated_at = now(),
    expires_at = excluded.expires_at;
end;
$$;

comment on function public.record_run_failure_memory(text, uuid) is
  'Owner-only. Records one observed failure note derived from a terminal run row; accepts no content or decision fields.';

revoke all on function public.record_run_failure_memory(text, uuid) from public;
revoke all on function public.record_run_failure_memory(text, uuid) from anon;
grant execute on function public.record_run_failure_memory(text, uuid) to authenticated;

-- ── 5. Schema marker ────────────────────────────────────────────────────────

create or replace function public.agent_memory_schema_version()
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 24;
$$;

revoke all on function public.agent_memory_schema_version() from public;
revoke all on function public.agent_memory_schema_version() from anon;
grant execute on function public.agent_memory_schema_version() to authenticated, service_role;

comment on function public.agent_memory_schema_version() is
  'Agent memory schema marker. 24 means the project_memories table, RLS, grants and revision contract are installed.';

commit;
