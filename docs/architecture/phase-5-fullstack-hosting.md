# Phase 5 — full-stack production hosting

## Purpose

Phases 1–4 publish static bytes and verify a generated Next.js project by
building and briefly running it in an isolated microVM. Phase 5 adds a separate,
opt-in path that deploys a **verified snapshot** to **Vercel's native Next.js
runtime**, so route handlers, server actions and middleware execute inside the
user's deployment — never on a Mavly host.

This is not a general "run any backend" platform. The supported scope is
deliberately narrow:

| Capability | Status |
|---|---|
| Next.js App Router production runtime | Supported, via Vercel |
| Route handlers / server actions / middleware | Supported by the provider runtime |
| Static export (`output: "export"`) | Refused: it would silently drop every server route |
| Other frameworks, containers, long-running servers | Not implemented |
| Database provisioning or migrations | Not implemented (user supplies a connection URL) |
| Application database engines | PostgreSQL / Supabase connection URLs only |
| Permanent preview URLs | Not implemented (Phase 3/4 preview stays `unavailable`) |

## Flow

```
verified snapshot (Phase 3/4, exact hash)
        │
        ▼
resolveVerifiedSource  ── snapshot ownership + status=ready + hash equality
        │
planFullstackDeployment ── paths, sizes, App Router profile, static-export refusal
        │
claim_fullstack_attempt ── one active attempt, fenced, ownership + verification
        │
resolve/create Vercel project by owner-bound deterministic NAME
        │
env + database readiness  ── production secrets and DATABASE_URL synced
        │
attach <project-id>.mavly.xyz (pending until Vercel verifies)
        │
upload files → create Next.js production deployment
        │
settle(building)          ── fenced provider deployment id
        │
status poll → provider READY + domain verified → settle(ready)
```

A row never becomes `ready` from a build request alone. `ready` requires:

1. the exact snapshot hash that passed Phase 3/4 verification;
2. Vercel reporting the deployment `READY`;
3. the Mavly hostname verified by Vercel (when one is attached);
4. every production project secret in `synced` state;
5. a configured application database, if the source references `DATABASE_URL`,
   whose provider env fingerprint matches the stored metadata and whose
   save-time connectivity check succeeded.

## Durable deployment lifecycle

`project_deployments.lifecycle` is `queued → building → ready`, or
`failed/cancelled/disabled`. `project_deployment_attempts` records every
attempt, its immutable snapshot binding, the provider deployment id and the
rollback target. The mapping carries a monotonic `deployment_attempt` fence, so
a delayed provider response can only settle the attempt it belongs to.

A failed attempt restores `vercel_deployment_id` from `previous_deployment_id`;
the previous production deployment keeps serving. A successful rollback creates
a **new** attempt (`kind = rollback`) that records `rolling_back` and then
`ready` against a previously ready attempt's provider deployment. Rollback and
takedown do **not** depend on the current feature flag or cohort: an operator
turning the rollout off must still be able to recover or remove a live site.

## Secrets

Project secrets remain write-only encrypted rows in `project_secrets`.
`secret-sync.ts` pushes a secret to the provider **only in the request that
saved its plaintext**, using the provider's encrypted env API. It never reads a
value back, never stores a value in deployment metadata, and never logs one.

- `NEXT_PUBLIC_*`, `MAVLY_*`, `VERCEL_*` and Mavly credential names are refused
  as application env keys.
- `development` secrets are recorded but never pushed to production.
- `awaiting_project` means the value was saved before a Vercel project existed.
  The first deploy creates the project, then refuses with a "re-save" message;
  the next attempt can sync the value. This avoids a permanent deadlock.
- `project_deployment_env` stores only key names, a SHA-256 fingerprint and
  sync state (never a value or ciphertext).

## Application database

`project_database_configs` stores non-secret metadata only. The URL is an
encrypted `DATABASE_URL` project secret. Saving a connection performs one
bounded, DNS-pinned `select 1` using the supplied least-privilege credentials
(no DDL, no migrations). Private/loopback/link-local/metadata addresses are
refused after DNS resolution, and the TCP target is pinned to the validated
address while TLS identity is verified against the original hostname. Mavly
never creates a database and never uses its own control-plane database as a
user's application database.

## Security boundaries

- Generated code runs only inside the provider's build/runtime, never on Mavly
  hosts. Phase 3/4 verification remains a separate, temporary microVM.
- The service-role Supabase client is not used by Phase 5. Deployment RPCs are
  `SECURITY DEFINER` functions that verify `auth.uid()` ownership, snapshot
  ownership, hash equality and a passed verification themselves; authenticated
  clients have no direct INSERT/UPDATE on attempts or env-sync rows.
- **Provider targeting is server-derived.** Vercel project names include a hash
  of the owner's user id (`vercelProjectName`). Deploy, status, rollback, takedown
  and secret sync resolve that name; they never use a project id/name stored on
  a deployment row. Takedown deletes only deployments the provider lists for the
  project.
- **Residual trust model:** a project owner can call the deployment RPCs
  directly with their own session. The database re-checks ownership and the
  attempt fence, and `ready` now requires an in-flight attempt carrying the same
  provider deployment id. A determined owner can still misrepresent *their own*
  deployment state (for example by marking env metadata synced). This cannot
  grant access to another tenant's data or project. Moving these mutations to a
  service-role-only path is the follow-up hardening decision if stronger
  self-attestation resistance is required.

## Configuration

Server-only:

```bash
MAVLY_FULLSTACK_HOSTING_ENABLED=on
MAVLY_FULLSTACK_HOSTING_PROJECTS=project-a,project-b   # explicit; '*' refused
MAVLY_VERCEL_DEPLOYMENTS_ENABLED=on
VERCEL_API_TOKEN=...
MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY=...               # 32 bytes, base64
```

A project in the cohort is routed to full-stack hosting **before** static
resolution. A missing prerequisite is a refusal, never a silent static publish.
An existing full-stack row keeps the full-stack status/takedown path even if the
project is later removed from the cohort; new deploys are then refused, and
`disable`/`rollback` remain available.

## Migration

`supabase/migrations/20_fullstack_hosting.sql` is additive and applies after
migration `19` (verification runtime/health) and `11` (project secrets). It adds
deployment lifecycle columns, the attempt/env/database tables, fenced RPCs and
schema marker `20`. It does not modify `project_files`, snapshots, verification
rows, RLS on `projects`, or existing static deployment rows.

## Known limitations (not production-verified by this repository)

- **No live post-deploy HTTP health probe.** Readiness is the Phase 3/4
  verified snapshot hash + provider `READY` + verified Mavly domain. Mavly does
  not fetch the deployed app, so runtime behavior after the build remains the
  user's responsibility.
- **Database verification is at save time.** The plaintext URL is write-only, so
  a later database outage is not re-probed during deploy; the user re-saves to
  verify again.
- **Crash window after provider submit.** If the process dies after Vercel
  accepts a deployment but before `building` is recorded, the attempt is marked
  stalled and the user redeploys. The provider's newest deployment is not
  adopted automatically.
- **Renamed/orphaned provider projects** are not adopted. Takedown refuses to
  claim success when the deterministic project cannot be found but the row could
  describe a live site; an operator must intervene. Vercel project names are
  stay stable for a project that already has a full-stack deployment.
- **No UI for rollback, attempt history or database configuration.** They are
  authenticated project endpoints; the existing Deploy control drives deploy,
  status and unpublish. `POST …/deployments/rollback`,
  `GET …/deployments/history`, `GET …/deployments/snapshots` and
  `GET|PUT|DELETE …/database/config` are wired server-side.
- No real Vercel build, secret push or application database connection has been
  exercised by this repository's static tests.
