# Runbook — AWS EC2 Generation Worker

Status: **AWS is the designated production worker host in this repository. This runbook is implementation guidance only; no AWS provisioning, deployment, or worker operation has been performed from this environment.**

## Scope

This runbook documents how to deploy Mavly's existing generation worker onto AWS EC2 while keeping the existing Supabase queue, claim logic, retries, leases, checkpoints, recovery and owner verification intact.

The worker remains a thin adapter over the existing durable generation engine in:

- `src/lib/generation/worker.ts`
- `src/lib/mavly/run-agent.ts`
- `src/lib/supabase/worker.ts`
- `src/lib/generation/verification.ts`
- `src/lib/generation/leases.ts`

No new queue or database was introduced.

## Preserved Render fallback

Render remains preserved and disabled while AWS is the designated host:

- `render.yaml` remains present, with `MAVLY_RENDER_WORKER_DISABLED=true`
- `workers/render-generation-worker.ts` remains present
- the Render entry point returns before `runGenerationWorkerOnce()` when that flag is true
- `workers/aws-generation-worker.ts` is the AWS entry point used when AWS is active

To reactivate Render later, first stop and verify the AWS service, then set
`MAVLY_RENDER_WORKER_DISABLED=false` (or remove it) in the Render environment and deploy the
preserved `render.yaml` worker. Never enable Render while AWS is processing production
jobs. The Supabase queue remains claim-safe, but multiple hosts can process different runs
at the same time and increase provider/database load.

## AWS worker entry point

The AWS-specific entry file is:

- `workers/aws-generation-worker.ts`

It does the following:

- initializes the worker loop
- reuses `runGenerationWorkerOnce()` from the existing generation engine
- leaves the durable queue and claim logic unchanged
- handles graceful shutdown and retry loops
- refuses to start unless `MAVLY_AWS_WORKER=true`
- logs that Render remains disabled when `MAVLY_RENDER_WORKER_DISABLED=true`

## Required environment variables

The systemd unit sets `NODE_ENV=production`, `MAVLY_AWS_WORKER=true`, and
`MAVLY_RENDER_WORKER_DISABLED=true`. Put these three required values in
`/etc/mavly/worker.env`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`

The Cloudflare Worker has a separate `MAVLY_CLOUDFLARE_WORKER_DISABLED=true` setting; it
does not belong in the EC2 env file. All secrets stay server-side and must not be logged.

Optional worker-owned features need their own existing configuration only when enabled.
Examples include `MAVLY_CREDITS_ENABLED` and its project/cost policy, the
`MAVLY_MULTI_AGENT_*` settings, `MAVLY_VERIFICATION_SANDBOX_*`, Android build settings,
managed-backend settings, and image-planning settings. Do not copy optional Vercel/E2B/Neon
credentials to EC2 unless the corresponding worker feature is intentionally enabled and its
existing runbook requires them.

## AWS runtime recommendations

- OS: Ubuntu 24.04 LTS
- Node.js: use Node.js 24.22.2 or newer Node 24.x. The worker's custom resolver returns
  `module-typescript` for project `.ts` files, allowing Node's native TypeScript type
  stripping to run while retaining ESM imports without a package-level `"type": "module"`.
- User: dedicated non-root service account, for example `mavly-worker`
- Process manager: `systemd`
- Systemd unit: use a service file that runs `node --import ./workers/register-node-ts-resolver.mjs ./workers/aws-generation-worker.ts`
- Start behavior: `After=network-online.target`, `Wants=network-online.target`
- Restart policy: `Restart=on-failure`, `RestartSec=5`
- Graceful shutdown: handle `SIGTERM` and `SIGINT` and stop starting new ticks while allowing the active one to drain
- Logs: direct stdout/stderr to journald, or to a dedicated log file with size rotation

## Host selection and duplicate-worker prevention

AWS and Render activation are server-side guarded by their entrypoints and environment
flags. The legacy Cloudflare scheduler also has an explicit no-op guard:

- `src/lib/generation/worker-config.ts`
- `workers/aws-generation-worker.ts`
- `workers/render-generation-worker.ts`
- `workers/generation-scheduler.ts`

The AWS deployment must have `MAVLY_AWS_WORKER=true`, while Render must retain
`MAVLY_RENDER_WORKER_DISABLED=true` and Cloudflare must have
`MAVLY_CLOUDFLARE_WORKER_DISABLED=true`. The checked-in `wrangler.jsonc` retains its Cron
trigger for rollback, but the scheduler returns before calling the worker engine while
disabled. Removing the Cron trigger in the Cloudflare dashboard prevents even those
no-op invocations.

The database remains the final same-job concurrency safeguard: the existing atomic
`claim_generation_job` uses `FOR UPDATE SKIP LOCKED`, assigns a unique random lease token,
and later writes are fenced by that token. Concurrent AWS instances can safely claim
different runs; a stale worker cannot complete a run owned by a newer lease. This is not a
global single-host lock: host flags and operational configuration are still required to
ensure AWS alone is active.

### Legacy Cloudflare Cron shutdown before AWS-only operation

1. In the correct Cloudflare account/environment, inspect the deployed
   `mavly-generation-worker` Worker, its active version, Cron Triggers, and variables.
   Do not assume the checked-in config matches the deployed Worker.
2. Set `MAVLY_CLOUDFLARE_WORKER_DISABLED=true` on that Worker and deploy the reviewed
   version (`npm run deploy:generation-worker`). The checked-in `wrangler.jsonc` now
   includes this guard. This causes any still-configured scheduled invocation to log a
   `disabled` scheduler result and return before `runGenerationWorkerOnce()`.
3. For no scheduled invocations, remove the `* * * * *` Cron Trigger in Cloudflare's
   Worker **Triggers → Cron Triggers** settings. The trigger remains in source for a
   deliberate future rollback, so a later Wrangler deployment can restore it.
4. Confirm the Cloudflare trigger list is empty. If a scheduled trigger is temporarily
   retained, confirm the deployed logs show `status=disabled` and no
   `cloudflare-generation-worker` claim events for at least two schedule intervals.
5. Confirm the Render deployment still has
   `MAVLY_RENDER_WORKER_DISABLED=true`; verify the AWS service is the only worker host
   reporting claim events. Do not use the fact that atomic claims prevent same-run
   duplication as evidence that another host is disabled.

To deliberately reactivate the legacy Cloudflare scheduler in the future, first stop the
AWS service and establish the replacement host plan; then remove
`MAVLY_CLOUDFLARE_WORKER_DISABLED` from the Cloudflare environment, deploy the reviewed
config, and add/verify its Cron Trigger. Do not operate it simultaneously with AWS or
Render.

## Queue concurrency and admission ceiling

Each `runGenerationWorkerOnce()` invocation claims at most one generation run. A
continuously polling AWS process starts another tick after each result; multiple EC2
instances/processes can safely claim distinct rows using the same Supabase RPC and fencing
tokens. The database prevents two claims from owning the same active lease.

Admission remains capped by migrations 10/16 at **2 unfinished runs per user and 8
unfinished runs globally**. These caps include queued/retrying work, not just currently
executing provider calls. They are compatible with a small, bounded worker fleet but will
throttle admissions once 8 global slots are occupied, regardless of EC2 count. Do not raise
them or claim 1,000-user readiness without measured provider, database and worker capacity
and a separately reviewed migration. This work does not change those limits.

## EC2 deployment instructions (manual, not executed here)

1. Provision Ubuntu 24.04 LTS and attach an IAM instance role; do not put AWS access keys
   in the repository or environment file.
2. Install a supported Node 24 runtime (the resolver was prepared for Node 24.22.2) and
   deploy the reviewed repository to `/srv/mavly`.
3. From the repository directory install the lockfile dependencies:
   `npm ci --include=dev`.
4. Create the dedicated account and environment-file directory, then install the unit:
   ```sh
   sudo useradd --system --home /srv/mavly --shell /usr/sbin/nologin mavly-worker
   sudo install -d -o root -g mavly-worker -m 0750 /etc/mavly
   sudo install -o root -g mavly-worker -m 0640 /dev/null /etc/mavly/worker.env
   sudoedit /etc/mavly/worker.env
   sudo install -o root -g root -m 0644 \
     infra/aws-generation-worker/mavly-aws-worker.service \
     /etc/systemd/system/mavly-aws-worker.service
   ```
5. Add only the required secret values to `/etc/mavly/worker.env`:
   ```ini
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<retrieve-from-approved-secret-store>
   OPENROUTER_API_KEY=<retrieve-from-approved-secret-store>
   ```
   Do not paste real values into shell history or the repository. Keep the file owned by
   `root:mavly-worker`, mode `0640`; the service unit itself sets the host-selection flags.
6. Confirm the Cloudflare Cron shutdown steps above and confirm Render is disabled before
   starting AWS.
7. Enable the service:
   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now mavly-aws-worker.service
   sudo systemctl status mavly-aws-worker.service --no-pager
   sudo journalctl -u mavly-aws-worker.service -f
   ```
8. Verify logs and run/lease activity through the approved operator views. Do not manually
   alter `project_runs` or bypass the existing claim RPC.

## Rollback

To roll back to the preserved Render worker later:

1. Stop and disable AWS first:
   `sudo systemctl disable --now mavly-aws-worker.service`.
2. Confirm AWS claim events have stopped and the AWS process is not running.
3. Keep Cloudflare disabled unless Cloudflare, rather than Render, is the deliberately
   selected replacement.
4. Set `MAVLY_RENDER_WORKER_DISABLED=false` (or remove it) in Render and redeploy the
   preserved Render worker.
5. Confirm Render claims resume and AWS/Cloudflare remain inactive. Do not rely on queue
   fencing as a substitute for stopping the old host.

## Security requirements

- Use an IAM instance role instead of AWS access keys embedded in app code.
- The worker code itself makes no AWS API calls and requires no AWS permissions. If using
  SSM Parameter Store or Secrets Manager for bootstrap, scope read/decrypt permissions to
  only the exact parameter/secret ARNs and KMS key required. Session Manager access is an
  operator access requirement, not a generation-worker permission.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY` and other secrets out of Git and logs.
- Use SSM Parameter Store or Secrets Manager for secret delivery if the deployment environment requires it.
- Avoid SSH exposure when possible; prefer Session Manager or tightly scoped access controls.
- Keep the workload limited to background worker execution; do not move frontend, auth, app database or billing into EC2.

## Compatibility concerns

`workers/register-node-ts-resolver.mjs` registers the resolver before importing the
TypeScript worker. The resolver preserves the existing `@/` alias, extensionless local
imports, and `next/server` / `next/headers` `.js` fallback. It assigns
`module-typescript` only to project-owned `.ts` files; TypeScript packages in
`node_modules` retain Node's package resolution. Node 24.22.2 is the target runtime for
this format. A Node 24.22.2 runtime execution has not been performed in this repository.

The worker reuses the repository's existing generation engine, so the main compatibility risk is process/runtime environment rather than application logic. Confirm:

- Node and package compatibility on the EC2 image
- any required native modules or SDKs are installed
- network egress to Supabase and OpenRouter is permitted
- the same service-role and provider credentials are present on the AWS host

## Known limitations

- This repository does not provision AWS infrastructure.
- No AWS host, IAM role, EC2 instance, or service was created here.
- Live queue processing and production verification remain pending manual operator work.
- The worker is code-only and unverified in a live environment.
- AWS has no database-enforced exclusive-host setting. The Supabase claim RPC prevents
  duplicate ownership of a given run; the operator must still disable Cloudflare and Render
  to make AWS the sole production host.
