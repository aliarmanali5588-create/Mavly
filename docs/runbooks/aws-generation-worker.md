# Runbook — AWS EC2 Generation Worker (Code-Only)

Status: **This repository contains the AWS worker entry point and deployment scaffolding only. No AWS provisioning or worker start has been performed from this environment.**

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

Render remains preserved and disabled while AWS is the active host:

- `render.yaml` remains present and unchanged in substance
- `workers/render-generation-worker.ts` remains present
- `MAVLY_RENDER_WORKER_DISABLED=true` must remain set so Render does not claim jobs
- `workers/aws-generation-worker.ts` is the AWS entry point used when AWS is active

Render can be re-enabled later by removing the disable flag and redeploying the Render worker. The actual queue remains Supabase-owned and claim-safe.

## AWS worker entry point

The AWS-specific entry file is:

- `workers/aws-generation-worker.ts`

It does the following:

- initializes the worker loop
- reuses `runGenerationWorkerOnce()` from the existing generation engine
- leaves the durable queue and claim logic unchanged
- handles graceful shutdown and retry loops
- refuses to start unless `MAVLY_AWS_WORKER=true`
- exits cleanly if Render is disabled in the active host configuration

## Required environment variables

Set these on the EC2 host or systemd environment file:

- `MAVLY_AWS_WORKER=true`
- `MAVLY_RENDER_WORKER_DISABLED=true`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `NODE_ENV=production`

Do not expose these values to browser code or logs. Keep all secrets server-side only.

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

The active host decision is server-side and centralized in the worker config logic in:

- `src/lib/generation/worker-config.ts`

The implementation keeps the current queue semantics and prevents accidental simultaneous active workers by:

- requiring `MAVLY_RENDER_WORKER_DISABLED=true` when Render is intentionally off
- requiring `MAVLY_AWS_WORKER=true` for the AWS worker to start
- preserving the existing `project_runs` claim behavior and lease/fencing protections
- not creating a second queue, separate scheduler, or additional generation engine

## Deployment instructions (manual, not executed here)

1. Provision one EC2 instance with a minimal Ubuntu 24.04 LTS image.
2. Attach an IAM instance role with least-privilege access only to the AWS services the worker actually needs.
3. Configure the required environment variables in `/etc/environment`, a secure systemd environment file, or an AWS SSM parameter-backed bootstrap script.
4. Deploy the repository to the instance.
5. Install `npm ci --include=dev`.
6. Start the AWS worker service with systemd.
7. Confirm the service and logs, then monitor the queue claims in Supabase.
8. Keep Render disabled during the AWS-active phase.

## Rollback

To roll back to Render later:

1. Remove or clear `MAVLY_AWS_WORKER` on the AWS host.
2. Stop the AWS service.
3. Remove `MAVLY_RENDER_WORKER_DISABLED` from the Render deployment environment.
4. Redeploy the Render worker service.
5. Confirm the queue claims return to the Render worker and that no duplicate workers are active.

## Security requirements

- Use an IAM instance role instead of AWS access keys embedded in app code.
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
