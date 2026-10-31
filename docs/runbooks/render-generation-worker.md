# Runbook — Render Generation Worker

Status: **Render Background Worker adapter and Blueprint added; deployment and live
processing are not verified.** Vercel continues to host the website. Render only runs a
continuous Node.js process that polls the existing Supabase `project_runs` queue and calls
the existing `runGenerationWorkerOnce()` tick.

## Architecture

```text
Vercel app
  └─ create_generation_job(..., p_dispatch_mode = 'worker')
       └─ public.project_runs is the durable queue

Render Background Worker (one process, one serial loop)
  └─ workers/render-generation-worker.ts
       └─ runGenerationWorkerOnce()
            ├─ schema preflight (worker schema >= 32)
            ├─ recover expired leases
            ├─ atomically claim one job (FOR UPDATE SKIP LOCKED)
            ├─ re-read project and verify owner
            ├─ run the existing generation/checkpoint pipeline
            └─ renew the fenced lease while executing
```

The loop waits five seconds after an empty tick and retries worker errors after 15 seconds.
It never starts another tick while one is running. A completed tick immediately checks for
another ready job. The database row remains authoritative; no second queue or generation
implementation was added.

- Each Render instance runs one tick at a time, but multiple instances can process
  different jobs concurrently. The database `FOR UPDATE SKIP LOCKED` claim and fenced
  leases prevent two instances from owning the same live run; the database's existing
  admission limits remain the overall cap. Begin with one instance and do not scale out
  until staging confirms the required concurrency and resource behavior.
- A process termination can interrupt an upstream request, but cannot mark an unfinished
  run successful. The 420-second lease, renewal, bounded retry/recovery and verified
  checkpoints remain authoritative. A request already sent to OpenRouter may be repeated
  after a crash; provider calls are not exactly-once.
- SIGTERM/SIGINT stops the loop from starting another tick and lets the active tick finish
  during Render's configured 300-second shutdown grace. The normal generation allowance is
  at most about 220 seconds: the 300-second worker ceiling leaves 20 seconds for
  finalization, 10 seconds of margin and 50 seconds for post-coding reviews. Preflight and
  other tick overhead are additional, so this is not a hard end-to-end tick bound. Render
  sends SIGKILL after the grace if the process has not exited. The 420-second database
  lease and fencing then prevent a stale worker from committing; expired-lease recovery
  can retry the run on a later tick. The grace period does not guarantee completion.
- Cancellation, credits, verification, Android build processing, multi-agent orchestration,
  managed backend provisioning and migration 36's inline-to-worker handoff all remain in
  the existing tick and generation pipeline.
- The legacy `wrangler.jsonc` Cloudflare scheduler configuration is retained. Disable its
  Cron trigger before enabling this Render poller; running both is claim-safe but wastes
  worker ticks and database capacity.

## Blueprint and runtime

The root `render.yaml` defines only a Background Worker:

- Git branch: `main`; automatic deployment: every commit.
- Runtime: Node.js `24.22.1`. Current locked `@supabase/supabase-js` requires Node 22+,
  E2B requires Node 22.19+, and Next.js requires Node 20.9+.
- Region: Singapore.
- Initial compute: Render plan ID `0.5c-512mb` (`0.5 CPU`, `512 MB RAM`), preserving the
  intended 512 MB tier without silently upgrading to the next plan. This is **not a
  measured memory guarantee**. The worker does not build generated
  applications locally; Android builds and verification continue to use their configured
  isolated providers. Do not use this plan in production until the staging memory gate
  below passes.
- Build command: `npm ci --include=dev`, using the checked-in lockfile. Including dev
  dependencies is required because the existing worker import graph loads `next/headers`
  from the `next` package, which is currently a dev dependency. No Next.js website build
  is needed for the worker process.
- Importing `next/headers` alone does not require a request, but calling `cookies()` does.
  The worker persistence path is designed to pass its service-role client into store and
  snapshot operations instead of creating a request-scoped client. If a worker path falls
  back to `createSupabaseServerClient()`, there is no Next.js request context and that call
  may fail; the isolated startup/empty-tick check must cover this path.
- Start command: `node --import ./workers/register-node-ts-resolver.mjs
  ./workers/render-generation-worker.ts`. The preload registers the existing resolver
  before Node loads the entry point. The resolver preserves alias and extensionless
  imports, and marks only project-local `.ts` files as ESM; external packages and the
  Next.js app's module settings are unchanged. Node 24.22.1 strips erasable TypeScript
  syntax by default. Static inspection traced 121 local TypeScript modules and 321 local
  import edges; it found no unresolved local imports, `.tsx` modules, runtime enums,
  parameter properties, TypeScript import assignments or decorators. Two `namespace`
  search hits were ordinary text, not TypeScript namespace declarations.
  **The exact startup command remains unverified** until it runs successfully in an
  isolated staging service. The Render start command must keep the resolver preload.
- Shutdown grace: `maxShutdownDelaySeconds: 300`. Render's Blueprint specification allows
  an integer from 1 through 300 for background workers, so 300 is the supported maximum.

`workers/register-node-ts-resolver.mjs` and `workers/node-ts-resolver.mjs` are a Node
module resolver only; they do not alter generation behavior or accept external input.

## Required environment variables

Set these in the Render Dashboard when creating the Blueprint. The Blueprint uses
`sync: false`, so secret values are not stored in Git:

| Variable | Required for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Queue, claims, persistence and recovery | The variable's existing name is preserved; it is used server-side by this worker. |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker-only RPCs and queue writes | Secret. Never put this in Vercel's public environment or a `NEXT_PUBLIC_*` variable. |
| `OPENROUTER_API_KEY` | Website/Android generation | Secret; same existing OpenRouter provider boundary. |

`NODE_VERSION`, `NODE_ENV`, and `MAVLY_RENDER_WORKER` are non-secret Blueprint settings.
The marker selects production worker dispatch and the Render-specific log identity.

Optional features remain off unless explicitly configured. If enabled for the same
projects, their existing server-side credentials/configuration must also be copied to
Render: Vercel Sandbox verification/Android builds use the appropriate Vercel credentials;
runtime preview uses `E2B_API_KEY`; managed backends use their Neon/gateway settings; and
other feature flags/cohorts must match the app's configuration. Do not copy disabled or
unneeded secrets. Render cannot enable these features just by having the worker process.

## Cloudflare scheduler: inspect and disable manually

The retained production scheduler is configured by `wrangler.jsonc`: Worker name
`mavly-generation-worker`, entrypoint `workers/generation-scheduler.ts`, and Cron
`* * * * *` (every minute). `workers_dev: false`; `npm run deploy:generation-worker`
runs `wrangler deploy --config wrangler.jsonc`. Cloudflare documents Wrangler configuration
as the source of truth for a Wrangler-managed Cron Trigger. The repository does **not**
establish whether that Worker is currently deployed or whether its trigger is active.

Before enabling Render in production, an authorized operator should:

1. In Cloudflare, open **Workers & Pages → mavly-generation-worker → Settings → Triggers
   → Cron Triggers** and record whether the every-minute trigger is live. Check the
   correct account/environment; do not infer state from Git.
2. Coordinate a reviewed change that removes only the `triggers.crons` schedule from
   `wrangler.jsonc` (keep the Worker entrypoint, vars, name, and configuration). Deploy
   that change using the existing `npm run deploy:generation-worker` command.
3. Return to the Cloudflare dashboard and confirm the Cron Trigger list is empty. Wrangler
   deployments using the checked-in schedule could re-enable it, so do not restore that
   schedule in a later deploy while Render is the production scheduler.
4. Only after confirming the old trigger is gone, enable the Render production worker.
   Do not run both schedulers intentionally: claims prevent duplicate ownership of a run,
   but both can process separate jobs concurrently and increase provider/database load.

No Cloudflare configuration or live infrastructure was changed during this review.
Rollback is an operator action: pause Render first, restore the reviewed Cron schedule,
deploy it, verify the Cloudflare trigger is active, then resume one scheduler only.

## Staging gates before production

Do not point a staging worker at production Supabase. Use a disposable staging Supabase
project with the required schema already applied, staging-only credentials, and no queued
generation/build/verification work. Do not apply migrations from this runbook.

### 1. Check Node startup in isolation

Do not use the production Blueprint for this check: it pins the service branch to `main`.
Create a temporary standalone Render Background Worker from a review branch (or use an
authorized isolated Node 24.22.1 environment). Use the exact Blueprint build/start
commands and staging-only `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`OPENROUTER_API_KEY`. The startup command performs worker ticks, so keep the staging
queues empty and observe it only long enough to see startup plus an `empty` tick; then
send SIGTERM and confirm clean exit. Do not send a generation request.

If startup fails, capture the module-resolution/TypeScript error and resolve it in a
reviewed worker-only runtime change. Do not promote the current command based on static
inspection alone, and do not solve it by blindly changing the root `package.json` module
type.

### 2. Measure memory without assuming 512 MB is enough

Use the Render service **Metrics** view for the staging worker and record its memory
high-water mark, CPU, and restart/OOM events:

1. Record idle baseline after startup and allow at least 15 minutes of empty polling.
2. In staging only, exercise a representative small generation and the largest supported
   prompt/project shape, one job at a time. Repeat the largest case at least three times.
   Do not run these workloads against production.
3. If optional verification or Android build queues will be enabled on this same process,
   measure those separately; the tick can run them when generation is idle.
4. Record maximum memory per workload and any process restarts. Accept the 512 MB plan
   only if repeated peak memory stays below 384 MB (25% headroom) with no OOM/restart;
   otherwise choose the supported `1c-2g` plan (`1 CPU`, `2 GB`) and repeat the staging
   measurements. Do not claim a memory pass from idle-only measurements.

### 3. Production enablement

Only after the startup and memory gates pass:

1. Confirm production migrations/schema marker are already ready: marker at least 32;
   migrations 16 and 32 are required, and migration 36 is required for inline-to-worker
   handoff. Do not apply migrations as part of this deployment.
2. Ensure the Cloudflare trigger is confirmed disabled using the procedure above.
3. Open Render and create/sync the Blueprint from the reviewed `main` branch. Confirm it
   proposes a Background Worker named `mavly-generation-worker`, Singapore, plan
   `0.5c-512mb` (or the higher plan justified by staging data), and 300-second shutdown
   grace. Do not accept an unexplained plan change.
4. Enter the required secrets in Render's environment UI; never commit them.
5. Deploy only after the staging startup check succeeds. Confirm `[generation-worker]
   started` and repeated tick logs before allowing production worker-dispatched jobs.
6. Observe queue age, memory, restarts, lease recovery, and worker errors during a
   controlled rollout.

## Inspect queue health

Run these only through an authorized operator SQL session:

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

One tick handles one generation run, and recovery is bounded to five expired leases.
The worker idles between empty ticks. Retry backoff, lease duration, generation budgets,
the existing per-user/global admission limits, and database-owned credit settlement are
unchanged.

## Pause and rollback

- To pause processing, suspend/scale the Render Background Worker to zero or disable the
  service. Accepted `dispatch_mode = 'worker'` jobs remain in Supabase; do not delete or
  rewrite them. Disable any legacy Cloudflare Cron as well.
- To resume, start the Render worker again. It will poll, recover expired claims and
  process ready work.
- If rolling back the app deployment, keep a compatible worker running until queued work
  is drained. If the worker is paused, preserve all rows and restart a compatible worker
  before expecting queued work to progress.
- A Render deployment sends SIGTERM to the old process. The adapter starts no new tick
  after that signal and uses the configured grace period for the current tick. If it is
  killed, recovery is lease-based; never mark an interrupted run complete manually.
- Do not raise the generation budget to mask resource pressure. Inspect memory, runtime
  logs and provider errors first.

## Acceptance checklist (human-run)

No tests, lint, typecheck, build, deployment, provider call or live generation was run for
this change. The repository instructions reserve automated checks for the human developer.

- [ ] Render detects `render.yaml` on `main` and proposes a Background Worker only.
- [ ] The worker starts with the required environment variables and logs repeated ticks.
- [ ] An authorized Supabase schema preflight succeeds and an empty queue is reported.
- [ ] In staging, confirm worker-dispatched jobs progress and close the browser to verify
      processing is independent of the client session.
- [ ] Test two queued staging jobs; confirm claims/checkpoints complete without changing
      per-user/global admission limits. If multiple instances are enabled, confirm they
      may process separate jobs concurrently but never claim the same active run.
- [ ] In a disposable project, interrupt a worker tick and confirm lease expiry/recovery,
      checkpoint reuse and bounded retry; confirm no duplicate active claim.
- [ ] Verify owner cancellation and credit reservation/settlement still match the run.
- [ ] Send SIGTERM during idle and active work; confirm no new tick starts after the signal.
      If the active tick exceeds the shutdown grace, confirm lease recovery handles it.
- [ ] Complete the staging memory gate above; retain `0.5c-512mb` only with repeatable
      peak memory below 384 MB and no OOM/restart.
- [ ] Confirm Cloudflare Cron is disabled and Git pushes to `main` auto-deploy the Render
      worker.
