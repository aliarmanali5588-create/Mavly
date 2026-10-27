# Runbook — Durable Generation Worker

Status: **implemented, opt-in, disabled by default.** The inline `after()` path remains the
default for every project. This runbook describes the durable path, its prerequisites,
and the operator procedures for running, pausing, recovering and rolling it back.

The worker does **not** execute generated code. It runs the existing generation pipeline
(`src/lib/mavly/run-agent.ts` → `src/lib/ai/agent.ts` → `src/lib/ai/provider.ts` →
`src/lib/ai/openrouter.ts`) outside the request that admitted the job. Prompt, output, checkpoint
and file semantics are unchanged.

---

## 1. Architecture

```
admission (authenticated request)
  └─ create_generation_job(..., p_dispatch_mode)
        dispatch_mode = 'worker'   only when the worker is ready AND the project is in the cohort
        dispatch_mode = 'inline'   every other case (unchanged after() path)

durable queue = public.project_runs rows
  stage: queued | retry_wait   → ready
  stage: validating | generating | retrying → executing
  stage: completed | failed | cancelled | interrupted → terminal

scheduler ──POST/GET /api/generation/worker (Bearer secret)──▶ one tick:
  1. preflight   generation_worker_schema_version() >= 16
  2. recover     recover_expired_generation_leases(5)
  3. claim       claim_generation_job(worker_id, lease, cohort)  FOR UPDATE SKIP LOCKED
  4. verify      re-read public.projects, re-check owner + cohort
  5. execute     runAgent({ worker: { client, leaseToken, … } })
  6. renew       renew_generation_lease every 120 s while executing
```

Key properties:

- **The job row is the message.** Admission inserts the run through the existing atomic
  `create_generation_job` RPC; that insert *is* the enqueue. There is no second write that
  can be lost, and no outbox to drain.
- **One claim per tick.** Each invocation claims at most one job. The scheduler's
  parallelism is the throughput knob; the existing admission cap (2 per user, 8 global
  unfinished runs) remains the concurrency bound.
- **Leases are fencing tokens.** The database stores a random `lease_token`; every worker
  write presents it. A worker whose lease expired cannot persist files, complete a run or
  schedule a retry.
- **Retries are new job attempts, not exactly-once AI calls.** A provider request already
  submitted cannot be cancelled or un-billed. A retried run reuses only checkpoints whose
  content still matches.
- **Worker-only columns are not writable by users.** Migration 16 revokes the table-wide
  UPDATE grant and re-grants only the columns the pre-existing path used. RLS itself is
  unchanged.
- **The service-role client is confined to the worker route/orchestrator** and re-verifies
  ownership from `public.projects`; a claim answer is never treated as proof.

Files:

| File | Responsibility |
|---|---|
| `supabase/migrations/16_durable_generation_worker.sql` | Queue columns, constraints, indexes, claim/lease/retry/recovery/resume RPCs, least-privilege grants, schema marker. |
| `src/lib/generation/state-machine.ts` | Pure stage set, transitions, failure classification and redaction. |
| `src/lib/generation/leases.ts` | Lease bounds, retry backoff, timing-safe secret comparison, worker-id sanitation. |
| `src/lib/generation/worker-config.ts` | Opt-in flag, secret, cohort and prerequisite validation; admission dispatch mode. |
| `src/lib/generation/verification.ts` | Claim parsing and owner/cohort re-verification. |
| `src/lib/generation/worker.ts` | One bounded tick: recover → claim → verify → execute → renew. |
| `src/app/api/generation/worker/route.ts` | Internal invocation endpoint (bearer secret). |
| `src/lib/supabase/worker.ts` | The only service-role client factory. |
| `src/lib/observability/*` | Correlation ids, structured events, reported-cost policy. |

---

## 2. Environment variables

All are **server-only**. Never add a `NEXT_PUBLIC_` prefix to the secret, the service-role
key or any worker value.

| Variable | Required | Meaning |
|---|---|---|
| `MAVLY_GENERATION_WORKER_ENABLED` | yes | `1`, `true`, `yes` or `on`. Any other value (or unset) keeps the worker off. |
| `MAVLY_GENERATION_WORKER_SECRET` | yes | At least 32 characters, no whitespace. Shared with the scheduler. High entropy; rotate like any credential. |
| `MAVLY_GENERATION_WORKER_PROJECTS` | yes | Comma/space/semicolon separated project ids. Exact match. Empty is **not** "all projects"; `*` is not accepted. Max 500 entries. |
| `MAVLY_GENERATION_WORKER_ID` | no | Log-safe worker identity (default `generation-worker`). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Used only by the worker. Bypasses RLS, so it must never reach a browser or a generated site. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | The Supabase project URL (already required by the app). |

Readiness is all-or-nothing: if any prerequisite is missing or invalid, new runs are
admitted **inline** and `/api/generation/worker` answers `503 BACKEND_NOT_CONFIGURED`.
A malformed cohort entry makes the worker not ready rather than silently widening the set.

---

## 3. Local setup

1. Apply migrations in order (see §4).
2. Add the variables above to `.env.local`. Use the local Supabase service-role key, not a
   production key.
3. Start the app with `npm run dev`.
4. Enqueue a run for a project in the cohort (launch it from the workspace, or call the
   normal agent start endpoint).
5. Invoke one tick:

   ```bash
   curl -sS -X POST http://localhost:3000/api/generation/worker \
     -H "Authorization: Bearer $MAVLY_GENERATION_WORKER_SECRET" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   `200 {"ok":true,"status":"empty"}` means the worker is healthy and the queue is empty.
   A claimed run returns `status: completed | failed | retry | dead_letter | cancelled |
   skipped` (plus `runId`). `404` means the flag is off; `503` means a prerequisite is
   missing or migration 16 is not installed; `401` means the bearer secret is wrong.

Do not call this endpoint from a browser. It is exempt from the proxy's session gate by
exact path and authenticates itself.

---

## 4. Migration order

Apply **only** as part of the normal reviewed migration process; this runbook does not
authorize production DDL.

1. `03_ai_builder.sql` — base builder tables and RLS.
2. `10_generation_jobs.sql` — durable run lifecycle, batches and admission RPC.
3. `14_shared_hosting.sql`, then `15_shared_hosting_attempt_state.sql` — only if shared
   tenant hosting is enabled.
4. `16_durable_generation_worker.sql` — after 10 (and after 14/15 when those are used).

Migration 16 is additive and idempotent: columns are added with `if not exists`, indexes
with `if not exists`, constraints are dropped/re-added by name, and RPCs use
`create or replace`. The old four-argument `create_generation_job` is dropped and replaced
by the five-argument function whose `p_dispatch_mode` defaults to `inline`, so a
mixed-version caller that sends four named arguments still resolves once PostgREST
reloads its schema cache. After applying the migration, run
`notify pgrst, 'reload schema';` (or wait for the automatic reload) before serving traffic.
It does not delete rows or tables.

Verify:

```sql
select public.generation_worker_schema_version();  -- must return 16
```

If the marker is missing or lower, the worker refuses to claim (`503`, reason
`schema_outdated`). Admission against a database without 16 fails closed with
`503 MIGRATION_REQUIRED` **before** writing an attempt row, because the five-argument
admission RPC does not exist.

---

## 5. Invocation and scheduling

- **Endpoint:** `POST` or `GET https://<canonical-app-origin>/api/generation/worker`.
- **Auth:** `Authorization: Bearer <MAVLY_GENERATION_WORKER_SECRET>`. Comparison is
  constant-time.
- **Origin:** always the canonical app origin (`NEXT_PUBLIC_APP_URL`), never a tenant host.
  A tenant host is rewritten to the tenant runtime before routing.
- **No `Origin` header.** The endpoint is server-to-server. A non-browser client with no
  `Origin` passes the cross-origin mutation policy; an unexpected `Origin` may be rejected.
- **Duration:** the route allows 300 s; the generation budget is 240 s and the lease 420 s,
  so a healthy tick is never recovered out from under itself.
- **Response:** 200 with a non-sensitive outcome; 404 disabled; 401 unauthorized; 503
  misconfigured/outdated; 500 worker error. The body never contains a prompt, file content
  or provider body.

Recommended starting schedule: **one invocation per minute**, overlapping is safe. To drain
faster, run several invocations concurrently (for example four per minute); the database
`SKIP LOCKED` claim and the admission cap prevent double execution. There is no built-in
scheduler in this repository — the operator supplies one:

- any cron runner that can send an authenticated HTTPS request;
- GitHub Actions schedule (minimum interval is platform-limited);
- a systemd timer or container CronJob;
- a platform scheduler that supports a custom `Authorization` header.

> **Vercel Cron note.** Vercel Cron can send `Authorization: Bearer $CRON_SECRET` when
> `CRON_SECRET` is configured. Setting `CRON_SECRET` to the same value as
> `MAVLY_GENERATION_WORKER_SECRET` is one option, but verify the current platform behavior
> before relying on it; an external scheduler that sets the header explicitly is the most
> predictable choice. Hobby plans restrict cron frequency.

Treat a `404` from the endpoint as "worker disabled" and pause or ignore the schedule; it is
expected during rollback.

---

## 6. Queue inspection

Run these as an operator with SQL access (for example the Supabase SQL editor or a
service-role REST call). The authenticated app role has RLS and cannot see other users'
runs.

Ready jobs, oldest first:

```sql
select id, project_id, stage, status, job_attempt, max_job_attempts,
       next_attempt_at, enqueued_at, trace_id
from public.project_runs
where finished_at is null
  and dispatch_mode = 'worker'
  and stage in ('queued', 'retry_wait')
order by coalesce(next_attempt_at, enqueued_at);
```

Executing jobs and their leases:

```sql
select id, project_id, stage, worker_id, trace_id,
       claimed_at, lease_expires_at, heartbeat_at, job_attempt
from public.project_runs
where finished_at is null
  and dispatch_mode = 'worker'
  and stage in ('validating', 'generating', 'retrying')
order by claimed_at;
```

Expired leases (recovered by the next tick):

```sql
select id, project_id, stage, worker_id, trace_id,
       lease_expires_at, now() - lease_expires_at as overdue,
       job_attempt, max_job_attempts
from public.project_runs
where finished_at is null
  and dispatch_mode = 'worker'
  and lease_token is not null
  and lease_expires_at < now();
```

Dead letters:

```sql
select id, project_id, stage, error_code, last_error_class,
       job_attempt, max_job_attempts, dead_lettered_at
from public.project_runs
where dead_lettered_at is not null
order by dead_lettered_at desc
limit 50;
```

Per-run timing:

```sql
select id, trace_id, stage, enqueued_at, claimed_at, dispatched_at,
       finished_at, finished_at - enqueued_at as total,
       claimed_at - enqueued_at as queue_lag,
       reported_cost_usd, cost_known
from public.project_runs
where id = '<run-uuid>';
```

The status API also exposes `traceId`, `jobAttempt`, `maxJobAttempts`, `nextAttemptAt`,
`lastErrorClass`, `stage` and `dispatchMode` to the owning user.

---

## 7. Stuck jobs and manual recovery

An expired lease is recovered automatically by the next worker tick (up to five per tick):

- below the attempt limit → `retry_wait` with exponential backoff;
- at the attempt limit → terminal `failed` plus a dead-letter timestamp and one
  user-visible message.

If the scheduler itself is stopped, leases expire but nothing recovers them until it
resumes. To recover immediately without waiting for a tick, invoke the RPC as the
service role through PostgREST (never from a browser):

```bash
curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/recover_expired_generation_leases" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_limit": 50}'
```

The RPC is executable only by `service_role`; calling it as `authenticated` or `anon`
raises `FORBIDDEN`.

**Do not delete a stuck run to make it disappear.** Rows are the queue and the audit trail.
A `failed` or `interrupted` run can be resumed by its owner from the workspace, which resets
the attempt budget and preserves checkpoints. A `queued`/`retry_wait` worker run cannot be
resumed until it fails or is completed — see rollback below for the honest options.

---

## 8. Retries, backoff and dead letters

- `job_attempt` counts job attempts; it is incremented when a worker claims the job.
  (The existing `attempt_count` still counts provider calls and is not reused.)
- Default budget: `max_job_attempts = 3` (constrained to 1–10).
- Backoff: 15 s, 30 s, 60 s, 120 s, 240 s, capped at 300 s, plus up to 25 % jitter. The SQL
  and `src/lib/generation/leases.ts` implement the same schedule.
- Only conservative classes retry: timeout, rate limit, transient/network provider errors
  and persistence failures. Authentication, content policy, truncation, malformed output,
  unsafe paths, size limits and unknown failures are terminal.
- At the limit the run is dead-lettered: terminal `failed`, `dead_lettered_at` set, one
  actionable message inserted. The user can resume it from the workspace.
- A manual resume clears `job_attempt` and the worker fields but keeps file/checkpoint and
  token-usage history.

There is no dead-letter admin UI. Use the SQL above and the workspace resume action.

---

## 9. Pause, drain and resume

**Pause new worker admissions** (the queue is preserved):

1. Disable the schedule, or set `MAVLY_GENERATION_WORKER_ENABLED` off and redeploy.
2. With the flag off, `/api/generation/worker` returns `404`, and new admissions for every
   project use the inline `after()` path.
3. Already queued worker jobs stay durable in `queued`/`retry_wait`. They are **not**
   interrupted by queue age or by the UI's stale-run check; they wait for a worker.

**Resume:**

1. Restore the same flag, secret, cohort and service-role key.
2. Redeploy, then re-enable the schedule.
3. The first tick recovers any expired leases and claims ready work.

**Drain before disabling permanently:** keep the worker enabled and the schedule running
until the ready/executing queries above return no rows, then turn the flag off. Turning the
flag off immediately is safe for state but parks queued worker jobs until the worker is
re-enabled.

---

## 10. Safe rollback

1. Stop or disable the scheduler.
2. Set `MAVLY_GENERATION_WORKER_ENABLED` off (or remove the secret/cohort) and redeploy.
   New runs go inline; the endpoint returns 404 or 503.
3. **Do not drop migration 16 columns, delete rows or truncate the queue.** The migration is
   additive and the inline path ignores the new columns.
4. Keep the scheduler disabled while the worker is off. Re-enable it only to drain.
5. If the worker is being abandoned permanently, worker-dispatched unfinished jobs are
   visible with `dispatch_mode = 'worker'`. There is **no built-in conversion** of a queued
   worker job to the inline path. The safe options are to re-enable the worker until the
   queue is empty, or to have an operator explicitly fail those runs (with a user-visible
   message) after a reviewed decision. Never silently flip `dispatch_mode` and assume
   `after()` will pick the run up — it will not.
6. Rolling back the code without the migration is not supported: remove the scheduler and
   disable the flag first, then deploy the previous build. The extra columns are harmless.

---

## 11. Observability

One JSON object per line is written to stdout with the prefix `[generation] `. There is no
metrics vendor and no event table; the log pipeline is the source of truth. Every string is
allowlisted/redacted, and prompt, generated code, credentials, emails and provider bodies
are never emitted.

Events: `accepted`, `rejected`, `claimed`, `claim_failed`, `heartbeat_failed`, `checkpoint`,
`retry_scheduled`, `lease_recovered`, `lease_lost`, `completed`, `failed`, `cancelled`,
`dead_letter`, `worker_empty`, `worker_unavailable`, `worker_error`.

Useful fields: `traceId`, `runId`, `projectId`, `workerId`, `stage`, `status`,
`dispatchMode`, `attempt`, `maxAttempts`, `errorClass`, `reason`, `durationMs`,
`queueLagMs`, `retryAfterSeconds`, `filesWritten`, `checkpoints`, `recovered`, `model`,
`promptTokens`, `completionTokens`, `costUsd`, `costKnown`.

Suggested alerts and thresholds (tune to observed traffic):

| Signal | Suggested alert |
|---|---|
| `generation.worker_unavailable` | any occurrence for 5 minutes, or `reason=schema_outdated` at deploy time |
| Queue lag (`queueLagMs`) | p95 > 120 s for 10 minutes |
| `generation.lease_recovered` | more than 3 in 15 minutes |
| `generation.heartbeat_failed` / `lease_lost` | any occurrence |
| `generation.dead_letter` | any occurrence (page the owner) |
| `generation.failed` rate | > 5 % of completed runs over 30 minutes |
| `generation.worker_error` | any occurrence for 5 minutes |
| `worker_empty` | normal; use as a liveness signal |

Cost is honest but partial: `costUsd` and `costKnown` are written only when **every**
provider attempt reported a finite, non-negative cost. A missing cost never fails a run and
is never estimated.

---

## 12. Capacity and limitations

- **One job per invocation.** The route's 300 s budget, the 240 s generation budget and the
  420 s lease bound a tick. Scale with scheduler parallelism, not by raising the admission
  cap inside one request.
- **Admission limits are unchanged:** 2 unfinished runs per user, 8 globally. They are
  durable because unfinished retries remain rows. **Do not raise them to support 1,000
  concurrent users.** That requires a separate capacity design, a worker fleet and a
  reviewed concurrency model; the current system deliberately does not claim to support it.
- **Provider calls are not exactly-once.** A crash after a provider call but before a
  checkpoint repeats that call on retry. Only verified checkpoints are reused.
- **Cancellation is cooperative.** A queued job is prevented from starting. A running job
  is checked between provider attempts/batches; an HTTP request already sent cannot be
  aborted or refunded.
- **No scheduler is included.** Without one, enabled jobs stay queued and leases are not
  recovered.
- **No admin UI.** Queue inspection, dead letters and manual recovery are SQL/REST operator
  tasks.
- **Serverless constraints.** A 300 s route is the ceiling on Vercel/Next.js, and the
  deployed plan may cap it lower. If the platform kills an invocation, the lease expires
  and the next tick recovers the job into a bounded retry; never raise the generation
  budget past the lease, and do not assume the invocation lives to its nominal limit.
- **Service-role key.** Required and powerful. It belongs only in the server environment
  and must never reach the browser, generated code or logs.
- **Verification status.** The unit/static tests in `tests/generation-*.test.ts` prove the
  pure policy and SQL text; they do not prove database transactions, a live scheduler, or
  provider behavior. Those require a disposable Supabase project and an operator-driven
  end-to-end check.

---

## 13. Acceptance checklist (human-run)

Nothing below was executed by the implementing agent. Run it on a disposable Supabase
project before enabling the worker for real users.

**Code checks (repository root):**

- [ ] `npx tsc --noEmit`
- [ ] `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`

**Database and configuration:**

- [ ] Migrations `03`, `10` and `16` are applied in order, then
      `notify pgrst, 'reload schema';`.
- [ ] `select public.generation_worker_schema_version();` returns `16`.
- [ ] `select proname from pg_proc where proname in
      ('claim_generation_job','renew_generation_lease','schedule_generation_retry',
      'recover_expired_generation_leases');` returns all four.
- [ ] The worker role is service-role only: `has_function_privilege('authenticated',
      'public.claim_generation_job(text,int,text[])', 'execute')` is false, and the
      same check for `service_role` is true.
- [ ] `MAVLY_GENERATION_WORKER_ENABLED`, `MAVLY_GENERATION_WORKER_SECRET` (≥ 32 chars),
      `MAVLY_GENERATION_WORKER_PROJECTS` and `SUPABASE_SERVICE_ROLE_KEY` are set in the
      server environment only; none has a `NEXT_PUBLIC_` prefix.

**Endpoint boundaries:**

- [ ] With the flag absent, `POST /api/generation/worker` returns 404.
- [ ] With the flag on but no secret, it returns 503 `BACKEND_NOT_CONFIGURED`.
- [ ] With a missing or wrong bearer token, it returns 401 and no job is claimed.
- [ ] A signed-out browser `fetch()` to any other `/api/*` path still returns 401.

**One end-to-end run:**

- [ ] A non-cohort project runs inline: its row has `dispatch_mode = 'inline'` and the
      worker never claims it.
- [ ] A cohort project's run has `dispatch_mode = 'worker'`, `enqueued_at` set, and is
      claimed exactly once (`job_attempt` increments once, one `claimed` event).
- [ ] `GET …/agent/status` shows queued → running → done; `retry_wait` is reported as
      `retrying` with `nextAttemptAt`.
- [ ] Files and checkpoints are written, and the completion message appears once.
- [ ] The worker response contains only `status`, `runId` and (where relevant)
      `errorClass` / `retryAfterSeconds` — no prompt, code, token or provider body.
- [ ] Logs contain exactly one structured `[generation]` line per event and no prompt,
      generated code, secret, email or provider payload.

**Failure and recovery:**

- [ ] Killing the worker mid-run (or letting the invocation time out) leaves a live lease
      that expires; the next tick records `lease_recovered` and the job returns to
      `retry_wait`, then `retrying`.
- [ ] A resumed attempt does not rewrite paths whose checkpoint hash still matches.
- [ ] Repeatedly forcing a retryable failure ends at `dead_lettered_at` with a
      `generation.dead_letter` event — never an unbounded retry loop.
- [ ] A second worker invocation while the first holds a valid lease claims a different
      job (or none), never the same one.
- [ ] Cancelling a queued job prevents it from starting; cancelling a running job stops it
      at the next safe checkpoint; repeating cancel is idempotent.
- [ ] A user cannot read or cancel another user's run (`403`, non-enumerating).

**Rollback:**

- [ ] Follow section 10, then confirm a new non-cohort project still runs inline with
      migration 16 applied.
- [ ] No accepted job was deleted, truncated or silently completed during rollback.
