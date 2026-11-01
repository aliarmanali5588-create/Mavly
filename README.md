# Mavly

Mavly is an AI app-builder built with Next.js 16, React 19, TypeScript and Tailwind 4. It
includes the dashboard, project workspace, prompt composer, preview frame, code/visual
editor surfaces and settings dialogs of an AI app builder.

> **Current status: local AI builder.** Supabase authentication and project ownership are
> real. OpenRouter, called only from the server, generates a complete frontend and backend
> project through its OpenAI-compatible chat-completions API; the same server-only key
> serves the separate OpenRouter image API. OpenRouter is the only text-generation
> provider. Supabase
> stores the generated source, conversation and run state; the workspace
> previews the generated static `preview.html`, or an imported static site with an
> `index.html` / `public/index.html` and local assets. An **opt-in,
> off-by-default** publishing path can upload those static files to a Mavly-managed Vercel
> account as a static site; it is not a dynamic backend host. A separate **opt-in,
> off-by-default** verification sandbox builds a generated App Router project inside an
> isolated Vercel microVM, starts its validated production server on loopback and runs a
> sandbox-local health check; `passed` requires all three to succeed. A separately opt-in,
> bounded AI repair may try one corrected immutable snapshot after a source-level build or
> runtime failure. No preview URL is exposed. Other platform features still return an
> explicit `503 BACKEND_NOT_CONFIGURED`.

Read [`MAVLY_CLEAN_BASELINE.md`](MAVLY_CLEAN_BASELINE.md) for the authoritative record of
what remains unavailable. The old Totalum integration is documented only in the historical
audits listed at the end of this file; it is not a runtime dependency.

## What works

| Area | State |
|---|---|
| Marketing homepage (`/`) | Loads |
| Sign-in page and Google/GitHub OAuth start | Implemented with Supabase Auth |
| Session refresh and redirects | `src/proxy.ts` gates `/dashboard` and `/project/*` |
| API session gate | `/api/*` returns JSON `401 UNAUTHENTICATED` without a verified session |
| Project ownership checks | `public.projects` plus RLS, checked by every project-scoped route |
| Project create/launch/list/get/update/delete | Stored in Supabase |
| Agent generation | OpenRouter (`deepseek/deepseek-v4.1-flash`), server-side; durable run rows, bounded batches, per-batch checkpoints, resume and cooperative cancel |
| Managed Neon databases (opt-in foundation) | A worker-only, explicit-cohort Neon provisioning foundation can create one quota-bounded Neon project per Mavly project and encrypt its connection URI in the internal Supabase registry. It does not expose credentials, apply app schema migrations, bind generated code to the database, or make CRUD/auth live. Requires Neon Agent Plan approval; remains off by default. |
| Credits (opt-in foundation, off by default) | Whole-credit accounts, an append-only ledger, atomic reservation with the generation job, settle-on-completion, release-on-terminal-failure, audited service-role refunds, and per-attempt AI usage/cost reconciliation. Enabled per project cohort with `MAVLY_CREDITS_ENABLED`, `MAVLY_CREDITS_PROJECTS` and `MAVLY_CREDITS_GENERATION_COST`; requires migration 31. There is no Mavly credit-funding flow yet, so credits are granted only through the service-role `grant_credits` RPC. See [`docs/architecture/phase-11-credit-foundation.md`](docs/architecture/phase-11-credit-foundation.md). |
| Conversations and run status | Persisted in Supabase and polled by the workspace |
| Project settings | Owner-editable project name and description; the derived Mavly address is read-only |
| Project secrets | Write-only AES-256-GCM encrypted values per project/environment; list returns metadata only and update replaces without retrieval; **not injected into previews or published static sites** |
| Project activity | Real generation-run history from `project_runs` (runs, outcomes, files, tokens). Visitor analytics are not collected |
| Project files | Generated source tree, file reads and file saves |
| Source download | ZIP built from stored project files |
| Preview | Sandboxed static `preview.html`, or an imported static `index.html` / `public/index.html` with local assets |
| Supabase account connection | OAuth with PKCE, encrypted server-side tokens, organization/project discovery and one selected project |
| Figma design reference | Personal access token validated with Figma, encrypted per project, and a bounded design summary injected into generation |
| Customer publishing | Retired; no deployment provider is configured. Publish, unpublish, and deployment-status actions fail closed with `BACKEND_NOT_CONFIGURED` and do not claim a live deployment or success. Source editing, static preview, source export, generation, and restore points remain available. Historical deployment rows and migrations are preserved rather than destructively rewritten. |
| Shared tenant hosting (opt-in, off by default) | Immutable published versions stored in Supabase and served at `<project-id>.mavly.xyz` by Mavly's own tenant runtime. Enabled per project cohort with `MAVLY_HOSTING_MODE=shared` + `MAVLY_SHARED_HOSTING_PROJECTS`; the legacy Vercel path remains the default. See [`MAVLY_SHARED_HOSTING.md`](MAVLY_SHARED_HOSTING.md). |
| Durable generation worker (Render preserved, current fallback; AWS worker adapter added) | The Render Background Worker implementation remains in place as a preserved fallback and future reactivation target, but it is intentionally disabled while AWS hosts Mavly's active background workers. The existing `project_runs` queue, claims, leases, retries, recovery and safeguards remain unchanged. A minimal AWS worker adapter is provided at [`workers/aws-generation-worker.ts`](workers/aws-generation-worker.ts), and the AWS deployment runbook is at [`docs/runbooks/aws-generation-worker.md`](docs/runbooks/aws-generation-worker.md). Local development and Vercel previews keep the inline `after()` path. The root `render.yaml` and render worker files remain available for future reactivation without deletion. See [`docs/runbooks/render-generation-worker.md`](docs/runbooks/render-generation-worker.md). |
| Verification sandbox (opt-in, off by default) | Worker-dispatched runs enqueue one durable verification for their completed run and immutable snapshot. A later worker tick installs and builds the project's source in a Vercel Sandbox microVM, starts the validated `next start` on `127.0.0.1`, and requests `/` from inside the sandbox. `passed` requires the build to exit `0`, the runtime to start and the local health response to be `2xx`/`3xx`; a build-only success is never `passed`. Unsupported formats return `unsupported_runtime`. Detached stages span ticks, every terminal path destroys the sandbox, and cleanup failure never overwrites the outcome. An optional bounded AI repair (default 1, hard cap 2) may create one new immutable snapshot after a source-level `build_failed`/`runtime_start_failed`/`health_check_failed`, then rebuild and recheck. Preview remains unavailable: no public provider URL is stored or returned. Requires `MAVLY_VERIFICATION_SANDBOX_ENABLED`, `MAVLY_VERIFICATION_SANDBOX_PROJECTS`, Vercel provider credentials, migrations `17` then `19`, and a human-run `npm install` for `@vercel/sandbox`. No generated code runs on a Mavly host. See [`docs/architecture/phase-4-runtime-verification.md`](docs/architecture/phase-4-runtime-verification.md). |
| `/api/config` | `200 { "ok": true, "data": { "configured": false } }` |
| Visual shell | Dashboard, workspace, chat, composer, dialogs and preview frame render |

Generated code is **never executed** on this server. The only execution anywhere is the
opt-in verification build and loopback runtime check inside an isolated provider microVM,
which never runs on a Mavly host and exposes no public port. A generated backend exists as
source files, not as a running service.

The optional Neon foundation provisions infrastructure only. `provisioned` means Neon
created a project and Mavly verified a server-side connection; it does not mean the
generated app can connect, has schema applied, has authentication, or is hosted. The
connection URI remains encrypted and server-only. The Neon Agent Plan requires an active
Scale plan and explicit Neon team approval; ordinary Neon account access is not treated as
platform enrollment. Deleted Mavly projects do not automatically delete their Neon
resources, and Mavly usage or billing attribution is not wired. No live provisioning or
Neon account acceptance has been verified.

## What does not work yet

Uploads/attachments, rebuilds, database browsing, schema changes, SQL execution,
customer-owned custom domains, visitor analytics, payments, usage, versions and visual
edits do not have a local implementation. Credit accounting exists only as the opt-in,
off-by-default generation foundation above; it has no funding flow, pricing engine or
billing integration. The workspace has no mobile-app management or runtime-log viewer;
Android source generation and its isolated debug builds remain, but generated apps are
never run on a Mavly host. The durable generation worker has a Render Background Worker
Blueprint; until it is deployed and observed, worker-dispatched runs stay queued. Disable
the retained Cloudflare Cron trigger before enabling the Render poller. The
verification sandbox is
implemented but off by default, applies only to worker-dispatched runs, and its `passed`
status means the production build exited `0`, the validated runtime started, and a
sandbox-local health request returned `2xx`/`3xx` — not that the site is correct, that it
was rendered in a browser, that a backend is reachable, or that a preview is hosted. An
authenticated preview proxy does not exist, so `agent/status` reports `preview.status =
"unavailable"` and never returns a provider URL. Secrets are stored and managed, but are not injected into generated
sites (the preview and published output are static). The workspace still offers real
project metadata editing and generation
activity; unsupported settings sections state that they are unavailable instead of
calling fabricated endpoints. Publishing is limited to static sites: generated or imported source that needs a framework build is
not built, and generated API routes are not deployed. Dynamic hosting and customer custom
domains remain unavailable. Each new publish does get a Mavly-owned
`<project-id>.mavly.xyz` address once its Vercel deployment and domain are verified.
Connecting a Supabase account and selecting a project is implemented;
using that selection to inspect or change the project is not. Unimplemented routes answer:

```json
{
  "ok": false,
  "error": "The Mavly backend is not implemented yet.",
  "code": "BACKEND_NOT_CONFIGURED",
  "data": null
}
```

with HTTP **503**. There is no mock backend, no fabricated project id and no outbound
request to a former provider.

## Architecture

```
browser ── src/lib/vcaas.ts (client catalog, same-origin only)
   │
   ▼
/api/* ── src/proxy.ts (Supabase session refresh + page/API gate)
   │
   ├── /api/vcaas/[...path]        auth → scope → ownership → handler or 503
   │      ├── src/lib/mavly/api.ts       project/agent/file handlers
   │      ├── src/lib/mavly/store.ts     Supabase RLS-scoped persistence
   │      ├── src/lib/mavly/run-agent.ts background generation
   │      │      ├── src/lib/integrations/figma/* → api.figma.com
   │      │      └── src/lib/ai/agent.ts → src/lib/ai/provider.ts → src/lib/ai/openrouter.ts
   │      └── src/lib/deployments/*      opt-in publish/unpublish orchestration
   │             ├── store.ts            project_deployments (RLS)
   │             └── service.ts → src/lib/vercel/provider.ts → api.vercel.com
   ├── Render Background Worker    continuous Node process → service-role worker tick
   │      ├── workers/render-generation-worker.ts → src/lib/generation/worker.ts
   │      └── run-agent → OpenRouter + durable checkpoints
   ├── /api/vcaas/source-code/{id} auth + ownership → generated ZIP
   ├── /api/preview/{id}/…         auth + ownership → sandboxed static site
   ├── /api/vcaas/upload|env|git-diff
   │                               auth + ownership → 503
   ├── /api/visual-edit/.../apply  auth + ownership → 503
   ├── /api/vcaas/backup-download  auth + ownership → 503
   └── /api/config                 200 { configured: false }
```

- **Auth:** `@supabase/ssr`, OAuth callback at `/auth/callback`, sessions refreshed in
  `src/proxy.ts`.
- **Authorization:** a row in `public.projects` for `(project_id, user_id)`, read through
  the caller's RLS-scoped Supabase client. Missing and foreign rows return the same
  non-enumerating 403; lookup failures fail closed. Child tables inherit that ownership
  through RLS.
- **Generation:** `POST …/agent/start` atomically admits one run per project (and bounded
  per-user/global concurrency) through `create_generation_job`. Production admissions use
  `dispatch_mode = 'worker'`; the Render Background Worker repeatedly invokes the existing
  worker tick, adding a fenced lease, heartbeat renewal, expired-lease recovery, bounded
  retries and dead letters while reusing the same generator and checkpoints. Local
  development and Vercel previews retain the inline `after()` path. A truncated response is
  never written; a failed/interrupted run can be resumed from its verified checkpoints
  with `POST …/agent/resume`, and `POST …/agent/stop` cooperatively cancels it. See
  [Generation reliability](#generation-reliability) and the
  [worker runbook](docs/runbooks/render-generation-worker.md).
- **Publishing:** retired. The workspace does not expose a customer publish action, and
  the deployment API returns `503 BACKEND_NOT_CONFIGURED` without creating a provider
  deployment, changing a live URL, or reporting success. Source editing, static preview,
  source export, generation, and restore points remain unchanged.
- **Unpublishing:** unavailable until a replacement deployment provider is implemented.
  The retired path does not call Vercel or claim that an external deployment was removed;
  historical deployment rows and migrations are preserved.
- **Verification (opt-in):** after a worker-dispatched run completes, one verification row
  is enqueued for its immutable snapshot. A later worker tick re-validates the snapshot,
  uploads a manifest-validated copy into a Vercel Sandbox microVM with restricted egress,
  runs install and `next build` as detached commands, then starts the validated
  `next start` on `127.0.0.1` and requests the fixed path `/` from inside the sandbox.
  Later ticks reconnect to the same sandbox by name. The provider type, build/runtime/health
  results and bounded diagnostics are stored; `passed` requires all three checks, and a
  build-only success is never `passed`. If repair is separately enabled, at most one
  (hard cap two) bounded AI attempt may produce a new immutable `repair` snapshot for a
  source-level failure, after which the build, runtime and health checks rerun. Unsupported
  or ambiguous projects return `unsupported_runtime` rather than a guessed command. Preview
  is not exposed: there is no authenticated proxy, so only a status contract is returned.
  See the [phase 4 architecture](docs/architecture/phase-4-runtime-verification.md) and the
  [verification runbook](docs/runbooks/verification-sandbox.md).
- **Supabase connection:** authorization-code flow with PKCE, a single-use state row and
  AES-256-GCM encrypted access/refresh tokens. The selected external project is stored per
  Mavly account, separately from `public.projects.project_id`.
- **Client API surface:** components call the catalog in `src/lib/vcaas.ts`, never the
  route paths directly.

## Generation reliability

One `project_runs` row is one durable job. The lifecycle is recorded in `stage`
(`queued` → `validating` → `generating`/`retrying` → `completed`/`failed`/`cancelled`/
`interrupted`) while the legacy `status` column stays `init`/`done`/`error` for the
workspace. Every provider call records a safe attempt: status, requested/actual model,
`finish_reason`, token usage, provider request id and a bounded error code. No prompt,
provider payload, API key or token is stored in that metadata.

The invariants are:

- `finish_reason: "length"` is a failure. The response is discarded, never written.
- A validated batch is checkpointed in `project_run_batches` with a SHA-256 hash per path.
- A resume reuses the manifest and skips only paths whose current content still matches
  their checkpoint. Edited/missing files are regenerated. It takes a fresh claim; run,
  manifest and heartbeat writes are guarded by `claimed_at`, and a checkpoint is written
  between two lease checks, so a stale worker cannot finalize the new attempt.
- Retries are bounded by attempts, exponential backoff + jitter, the provider's
  `Retry-After` and the run's wall-clock budget. Output-limit failures are not retried:
  the batch is split instead.
- One project has at most one unfinished run. Admission is serialized with a Postgres
  advisory lock, so the per-user (2) and global (8) limits are enforced across instances.
  Those limits are server constants in migration `10`; change them only after measuring
  provider quotas.

### Deployment order

1. Preflight: `select project_id, count(*) from public.project_runs where finished_at is
   null group by 1 having count(*) > 1;` The migration closes all but the newest active run
   per project before creating the unique index, but review the result.
2. Apply `supabase/migrations/10_generation_jobs.sql`.
3. Deploy the application code. Without migration `10`, start/resume answers
   `503 MIGRATION_REQUIRED` instead of silently bypassing admission.
4. Smoke-test: start a run, verify `agent/status.stage` advances and batches appear; stop
   one and verify `cancelled`; interrupt one and verify `interrupted` then `agent/resume`.

**The inline path has no autonomous worker.** `after()` is opportunistic and a serverless
instance can be terminated after the response. Production admissions use the durable queue
and Render Background Worker (`docs/runbooks/render-generation-worker.md`), which executes
under a lease and recovers crashed jobs. Do not claim automatic processing is operational
until the Render runtime has passed an isolated startup check and repeated worker ticks
have been observed. The service-role key remains server-only in both the app and worker.

### Metric definitions

| Metric | Definition |
|---|---|
| Active runs | `finished_at is null` and heartbeat newer than 10 minutes |
| Stale/interrupted rate | runs reaching `interrupted` ÷ terminal runs |
| Success rate | runs reaching `completed` ÷ terminal runs |
| Truncation rate | terminal runs with `error_code = 'GENERATION_TRUNCATED'` ÷ terminal runs |
| Provider attempt count | `attempt_count` (manifest + batches + repairs + retries) |
| Queue wait | `claimed_at − started_at` |
| Time to first checkpoint | first `project_run_batches.completed_at − started_at` |
| Time to complete | `finished_at − started_at` on `completed` runs |
| Batch progress | `checkpoint_count ÷ the manifest file count` |
| Retry pressure | `jsonb_array_length(provider_attempts)` and any non-null `retry_after_seconds` |

**Load test status:** not run. This repository has no staging project, provider quota or
authorization to generate at 1,000-user scale, and agents are forbidden from running test,
build or load commands. The admission limits are conservative defaults, not measured
capacity. Do not describe Mavly as validated for 1,000 concurrent users until a human has
run the staged load test.

## Local setup

Requirements: Node.js 20+ and npm. Supabase is needed for sign-in, project access and
Storage. An OpenRouter API key is needed for website/code generation, and the same key
serves the image-generation path.
The default model is the verified OpenRouter ID `deepseek/deepseek-v4.1-flash`, requested
from `https://openrouter.ai/api/v1/chat/completions`. Mavly preserves its existing
24,000-token project cap; `MAVLY_DEFAULT_MODEL` may only name a model in the OpenRouter
catalog in `src/lib/ai/models.ts`.

### Text generation

Website and native Android source generation use OpenRouter only. Set the server-only
`OPENROUTER_API_KEY`; `MAVLY_DEFAULT_MODEL` is accepted only when it matches the verified
OpenRouter model catalog. There is no provider-selection setting or automatic fallback.
Image generation continues to use OpenRouter's separate image API.

For controlled evaluation, `cohere/north-mini-code:free` is available only when the
server environment sets `MAVLY_NORTH_MINI_CODE_PROJECTS` to an explicit comma- or
semicolon-separated list of project IDs (never `*`). An eligible authenticated
generation request must explicitly set its existing `model` field to that exact ID.
Requests outside the cohort are refused; the Cohere model is not a default and is not
exposed through a new public selector. The existing `OPENROUTER_API_KEY` is reused.

If an older deployment still has `MAVLY_AI_PROVIDER`, `TOKEN_HARBOR_API_KEY`, or
`TOKEN_HARBOR_BASE_URL` configured, remove those variables manually from its environment.
The application no longer reads or uses them.

```bash
npm install
cp .env.example .env.local
```

Set these in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-key
NEXT_PUBLIC_APP_URL=http://localhost:3000
MAVLY_DEFAULT_MODEL=          # optional; must be in the OpenRouter model catalog
MAVLY_NORTH_MINI_CODE_PROJECTS=  # optional test cohort; explicit project ids only
OPENROUTER_API_KEY=your-openrouter-api-key  # text generation + image generation

MAVLY_INTEGRATION_ENCRYPTION_KEY=your-32-byte-base64-key
MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY=your-32-byte-base64-key

# Optional, off by default. Read the eligibility warning first.
MAVLY_VERCEL_DEPLOYMENTS_ENABLED=
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_PREFIX=mavly

# Optional, off by default. Requires the durable worker and migrations 17 then 19.
MAVLY_VERIFICATION_SANDBOX_ENABLED=
MAVLY_VERIFICATION_SANDBOX_PROVIDER=vercel
MAVLY_VERIFICATION_SANDBOX_PROJECTS=
# Separately opt-in. Defaults to 1; 0 disables, values above 2 are clamped.
MAVLY_VERIFICATION_REPAIR_ENABLED=
MAVLY_VERIFICATION_MAX_REPAIRS=
VERCEL_OIDC_TOKEN=
# Or the access-token triple: VERCEL_TOKEN below, VERCEL_TEAM_ID above,
# VERCEL_PROJECT_ID below.
VERCEL_TOKEN=
VERCEL_PROJECT_ID=

# Optional, off by default. Full-stack hosting deploys a VERIFIED Next.js
# snapshot to the Vercel runtime (server routes run there, never on Mavly).
# Requires the Vercel publishing config above, an explicit project cohort and
# MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY. A wildcard cohort is refused.
MAVLY_FULLSTACK_HOSTING_ENABLED=
MAVLY_FULLSTACK_HOSTING_PROJECTS=
```

Only the two `NEXT_PUBLIC_SUPABASE_*` values and `NEXT_PUBLIC_APP_URL` are public.
`OPENROUTER_API_KEY` (text generation and images), server OAuth secrets such as GitHub/Figma when enabled,
`MAVLY_INTEGRATION_ENCRYPTION_KEY`, `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`,
`VERCEL_API_TOKEN`, `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`,
`SUPABASE_SERVICE_ROLE_KEY` is server-only: never prefix it with `NEXT_PUBLIC_`, never
commit them, and configure usage/spend limits in your OpenRouter account as
appropriate. The service-role key is used by the durable worker and is confined to
`src/lib/supabase/worker.ts`, the worker orchestrator, the Render worker entrypoint
and the verification tick it invokes. Sandbox provider credentials
are used only by the server-side adapter and are never uploaded into a sandbox. OpenRouter
generation is billed to your OpenRouter account; confirm the current price for
`deepseek/deepseek-v4.1-flash` and your account's credit and rate limits. The project-secrets key must not be stored in the database:
losing it makes existing saved values unrecoverable.

Generation runs in the Next.js `nodejs` runtime (including its `after()` run scheduling),
not in Supabase Edge Functions. Add `OPENROUTER_API_KEY` to Vercel Project → Settings →
Environment Variables for each required Vercel environment, then redeploy so the runtime
receives it. Do not add this key to Supabase secrets for the current implementation.

Apply the schema in `supabase/migrations/` with the Supabase CLI (`supabase db push`) or by
pasting the migrations into the Supabase SQL editor. `03_ai_builder.sql` creates the file,
message and run tables. `04_supabase_integration.sql` creates the encrypted connection and
OAuth state tables. `07_project_deployments.sql` creates the deployment mapping used only
when publishing is enabled, `09_mavly_deployment_domains.sql` adds the Mavly-owned
domain state, and `13_deployment_unpublish.sql` adds the `unpublishing`/`unpublished` states
and `last_unpublished_at`. `08_figma_integration.sql` creates the encrypted per-project Figma
connection. `10_generation_jobs.sql` adds the durable run lifecycle, per-batch checkpoints
and the atomic admission function; **apply it before deploying code that reads those
columns.** `11_project_secrets.sql` creates encrypted project-secret storage with RLS and
metadata-only column grants; apply it before using the Secrets section.
`14_shared_hosting.sql` and `15_shared_hosting_attempt_state.sql` are required before
enabling shared tenant hosting, `16_durable_generation_worker.sql` before enabling the
durable worker, and `17_verification_sandbox.sql` followed by
`19_runtime_verification.sql` before enabling the verification sandbox. These are additive
and non-destructive. The worker refuses verification work unless
`verification_schema_version()` returns `19`. Configure the Mavly sign-in redirect as a bare `/auth/callback` URL
with no query string, and keep Supabase's redirect allow-list tight.

### GitHub App connection

Create a GitHub App with a callback URL of `/auth/github/callback` and these repository
permissions:

- **Contents: Read and write** for push and import.
- **Repository creation: Read and write** (or the broader **Administration: Read and
  write**) for repository creation.
- **Metadata: Read-only**, which GitHub includes automatically.

Each user must install the App on their personal account, not only authorize it, or grant
the updated permissions if the App is already installed. Make the App public if accounts
other than its owner will use it. After changing App permissions, approve the update on
GitHub and reconnect GitHub in Mavly so a fresh user access token is issued. Keep "Request
user authorization (OAuth) during installation" disabled; Mavly uses the normal
authorization callback.

Mavly lists repositories through the App installation
(`GET /user/installations/{installation_id}/repositories`), not `/user/repos`, because a
user access token can only reach the intersection of the user's repositories and the
installation's selection. If the list is empty, check the installation's repository
selection. Repository-creation failures include the runtime App ID/slug, installation URL,
and the permissions GitHub reports for that installation; they never include a token.

### Figma connection

Figma is connected with a user-owned personal access token, not Mavly's own credential.
Generate a token in Figma with `current_user:read` and `file_content:read`; Mavly validates
it against `GET /v1/me` before storing it, encrypts it with
`MAVLY_INTEGRATION_ENCRYPTION_KEY`, and keeps one connection per project. Applying
`08_figma_integration.sql` is required. The agent reads the Figma frames referenced in
the prompt, injects a bounded text summary of their layout, typography, colours and copy,
and never sends the token to the model. A link that selects a whole file is resolved only
when that file has one top-level design; otherwise the run asks for a frame link.


The Database tab connects the Mavly account and stores one selected external project. This
is an account-level selection in Phase 1, not a mapping from each Mavly project to a
Supabase project, and it grants no SQL, schema or data access.

Start the app:

```bash
npm run dev     # http://localhost:3000
```

Without Supabase configuration, the marketing page still loads and the builder explains
that authentication is not configured. Without `OPENROUTER_API_KEY`, the workspace refuses
to start a website-generation run instead of pretending it did, and image generation is
disabled.

## Verification

The repository owner runs checks manually before merge:

```bash
npx tsc --noEmit
npm test          # Node 22.6+
npm run lint
npm run build && npm start
```

Unit tests cover the pure auth/redirect/ownership/scope modules, static route invariants,
OpenRouter request/response classification and model-catalog policy, generation
validator/batching/truncation rules,
provider retry classification, checkpoint verification, deployment host/state rules, the
verification runtime/health/preview/config/state/result modules, the bounded repair policy
and parsers, and static invariants of migration `19` (including the build+runtime+health
`passed` rule). They do not exercise a real
Supabase session, a live OpenRouter generation or image call, a live customer OAuth integration, a
real Vercel Sandbox or any other verification provider, a generated app, a repair model
call, or the migrations against a database. A manual publish check requires a real
Vercel token and explicit eligibility approval; see
[`MAVLY_VERCEL_DEPLOYMENTS.md`](MAVLY_VERCEL_DEPLOYMENTS.md). A manual verification check
needs a disposable Vercel team/project and an explicit cohort, plus a human-run
`npm install` so `@vercel/sandbox` is present; see
[`docs/runbooks/verification-sandbox.md`](docs/runbooks/verification-sandbox.md). See [`AGENTS.md`](AGENTS.md) for the rules
that apply to automated agents working in this repository.

## Historical documents

These describe earlier architectures, before authentication and ownership were added and
before the backend was disconnected. They are **not current instructions**:

- [`AUDIT.md`](AUDIT.md)
- [`ROUTE_AUDIT.md`](ROUTE_AUDIT.md)
- [`TOTALUM_API_DEPENDENCY_AUDIT.md`](TOTALUM_API_DEPENDENCY_AUDIT.md)
- [`MAVLY_PRODUCT_ARCHITECTURE_REALITY_AUDIT.md`](MAVLY_PRODUCT_ARCHITECTURE_REALITY_AUDIT.md)

## License

MIT. See [`LICENSE`](LICENSE).
