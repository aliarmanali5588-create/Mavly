# Legacy Runbook — Cloudflare Cron Generation Worker

> **Do not use this as the current deployment guide.** The active production worker is the
> Render Background Worker documented in
> [`render-generation-worker.md`](./render-generation-worker.md). This file records the
> retained Cloudflare configuration for historical reference. Disable its Cron trigger
> before enabling the Render poller.

Status: **Legacy Cloudflare Cron implementation added; production deployment and invocation are
not verified.** Every production website and Android generation admission uses the durable
worker queue without a project allowlist or worker-specific enable/secret configuration.
Local development and Vercel previews retain the inline `after()` path.

The application remains on its existing Next.js/Vercel deployment; this repository has
no Cloudflare Workers application entrypoint or Pages deployment to attach a scheduled
handler to. The smallest compatible production design is a separate Cloudflare Worker
for Cron, with no public `fetch` endpoint and no application-runtime migration.

## Architecture

```text
authenticated production admission
  └─ create_generation_job(..., p_dispatch_mode = 'worker')
       └─ public.project_runs is the durable queue

Cloudflare Cron (* * * * *)
  └─ workers/generation-scheduler.ts
       └─ runGenerationWorkerOnce()
            ├─ schema preflight (worker schema >= 32)
            ├─ recover expired leases
            ├─ atomically claim one job (project_ids = NULL)
            ├─ re-read project and verify owner
            ├─ run the existing generation/checkpoint pipeline
            └─ renew the fenced lease while executing
```

The Cloudflare Worker invokes the existing worker directly. It exposes no HTTP endpoint
and creates no second queue. `wrangler.jsonc` disables `workers.dev` and registers the
one-minute Cron. The handler emits structured heartbeat, completion and failure events
through the existing generation observability logger.

- The queue row is the message; admission and queue insertion remain the existing atomic
  database operation.
- The database claim uses `FOR UPDATE SKIP LOCKED`; concurrent ticks cannot claim the
  same live job. The existing per-user/global run caps are unchanged.
- Lease tokens fence every worker-owned write. Expired claims recover to bounded retry or
  dead-letter states, and retries reuse only verified checkpoints.
- Provider calls are not exactly-once: a process interrupted after sending an upstream
  request may repeat that call on retry. Database leases prevent concurrent duplicate
  claims, not duplicate upstream side effects.
- Each tick claims at most one generation job. It also advances the existing verification
  and Android queues only when no generation job is ready.
- Credits, cancellation, resume, multi-agent cohorts, and feature-specific project
  allowlists retain their existing policies.

## Required platform setup

There is no project-level configuration. One-time production setup is required:

1. Use a Cloudflare Workers **Paid** account for this scheduled workload. Cron CPU is
   limited to 10 ms on Free and defaults to 30 seconds on Paid for schedules more frequent
   than hourly. No CPU limit increase is configured; measure before changing it.
2. Authenticate Wrangler for the target Cloudflare account using the operator's approved
   Cloudflare access method.
3. Configure the following values as secrets on the Cloudflare Worker. Do not commit them
   or place them in `wrangler.jsonc`:

   ```sh
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config wrangler.jsonc
   npx wrangler secret put NEXT_PUBLIC_SUPABASE_URL --config wrangler.jsonc
   npx wrangler secret put OPENROUTER_API_KEY --config wrangler.jsonc
   ```

   `NEXT_PUBLIC_SUPABASE_URL` is not a credential, but may be stored as a Worker secret
   for consistent deployment handling. The service-role key and OpenRouter key are
   server-only. Configure any additional existing server-side credentials required by
   worker-side features that operators have explicitly enabled; the feature flags/cohorts
   themselves remain unchanged.
4. Ensure the Next.js production application has its existing
   `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and `OPENROUTER_API_KEY`.
   The app needs them to admit production jobs; the scheduled Worker independently needs
   the corresponding values to claim and execute them.
5. Deploy the scheduler:

   ```sh
   npm run deploy:generation-worker
   ```

6. Confirm the Cron trigger appears in Cloudflare and observe
   `generation.scheduler.heartbeat` followed by
   `generation.scheduler.completed` or `generation.scheduler.failed` in Worker logs.
   Trigger changes may take up to 15 minutes to propagate.

The scheduler sets `MAVLY_CLOUDFLARE_WORKER=true` as a non-secret runtime marker so its
worker execution is considered production while local `next start` remains inline.
The configured compatibility date enables Node.js compatibility and the
`nodejs_compat_populate_process_env` flag, so the existing worker reads configured Worker
vars/secrets through `process.env`. The service-role key is never sent to a browser or
included in a public request.

## Database and migration requirements

No new migration is needed for Cloudflare scheduling. The existing database queue,
`claim_generation_job(..., p_project_ids => NULL)`, leases, retries, recovery, and owner
checks are reused. The worker preflight requires schema marker 32. Migration 36's
inline-to-worker handoff remains additive and unchanged.

Before deploying, confirm the normal migration history has already applied migrations 16,
32 and 36 and that:

```sql
select public.generation_worker_schema_version(); -- must return 32 or newer
```

Do not apply migrations from this runbook or delete/rewrite existing run rows.

## Local development

`npm run dev` remains inline and needs no Cloudflare worker secrets or scheduler. Vercel
preview deployments also remain inline. Production-mode local `next start` remains inline
unless the Cloudflare runtime marker or Vercel production environment is present.

## Monitoring

Cloudflare Worker logs contain the structured scheduler heartbeat and outcome events.
The admin queue overview reports backlog and lease health but cannot query Cloudflare's
last Cron invocation; when credentials are configured, it remains `unknown` until the
operator checks Worker logs. A healthy queue snapshot alone does not prove that Cron is
running.

Useful queue inspection queries (run only through an authorized operator SQL session):

```sql
-- Ready worker jobs, oldest first.
select id, project_id, stage, status, job_attempt, max_job_attempts,
       next_attempt_at, enqueued_at, trace_id
from public.project_runs
where finished_at is null
  and dispatch_mode = 'worker'
  and stage in ('queued', 'retry_wait')
order by coalesce(next_attempt_at, enqueued_at)
limit 100;

-- Active leases.
select id, project_id, stage, worker_id, trace_id,
       claimed_at, lease_expires_at, heartbeat_at, job_attempt
from public.project_runs
where finished_at is null
  and dispatch_mode = 'worker'
  and stage in ('validating', 'generating', 'retrying')
order by claimed_at
limit 100;

-- Dead letters.
select id, project_id, stage, error_code, last_error_class,
       job_attempt, max_job_attempts, dead_lettered_at
from public.project_runs
where dead_lettered_at is not null
order by dead_lettered_at desc
limit 50;
```

Recovery runs in each tick (bounded to five expired leases). Retry budgets, backoff,
lease duration and generation budgets are unchanged. Do not raise a timeout to mask
Cloudflare CPU termination; inspect CPU and execution logs first.

## Pause and rollback

- To pause processing, disable the Cron trigger in Cloudflare or remove the cron and
  redeploy the Worker. Accepted worker-dispatched jobs remain durable and queued; they
  are not deleted or silently moved to inline execution.
- To resume, restore the one-minute Cron configuration and redeploy. The next tick
  recovers expired leases and claims ready work.
- If rolling back application code, keep the scheduler running until worker-dispatched
  work is drained. If the scheduler must be paused, preserve all rows and restore the
  scheduled worker before expecting those jobs to continue.
- Never drop queue columns, delete runs, or manually mark jobs complete to hide backlog.
- No migration rollback is required or supported for this additive worker change.

## Acceptance checklist (human-run)

The repository's `AGENTS.md` prohibits automated verification by agents. These checks are
for the human operator before production enablement; no deployment or live generation has
been verified here.

- [ ] Run the repository's human-owned type, test, lint and build checks.
- [ ] Deploy the Cloudflare Worker with the required secrets and confirm the Cron trigger
      is `* * * * *`.
- [ ] Confirm heartbeats and completed outcomes appear in Cloudflare Worker logs.
- [ ] Create website and Android projects in production without project-specific worker
      settings; verify their new runs have `dispatch_mode = 'worker'`.
- [ ] Verify a non-empty queue is claimed, checkpoints persist, and a later tick resumes
      from verified checkpoints after an interrupted execution.
- [ ] Start multiple jobs and confirm concurrent ticks claim distinct jobs.
- [ ] Cause a retryable failure in a disposable project and verify bounded retry, then
      dead-letter at the configured attempt limit.
- [ ] Confirm cancellation and owner resume continue to use existing authorized APIs.
- [ ] Verify credit-enabled projects still use their database-owned policy and do not
      reserve or settle twice.
- [ ] Verify existing inline-dispatched runs remain compatible.
- [ ] Confirm that pausing Cron leaves accepted jobs intact and restoring it resumes them.
- [ ] Confirm no `MAVLY_GENERATION_WORKER_ENABLED`,
      `MAVLY_GENERATION_WORKER_SECRET` or
      `MAVLY_GENERATION_WORKER_PROJECTS` value is required at runtime.
