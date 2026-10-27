# Mavly

Mavly is an AI app-builder built with Next.js 16, React 19, TypeScript and Tailwind 4. It
includes the dashboard, project workspace, prompt composer, preview frame, code/visual
editor surfaces and settings dialogs of an AI app builder.

> **Current status: local AI builder.** Supabase authentication and project ownership are
> real. OpenRouter, called only from the server, generates a complete frontend and backend
> project through its OpenAI-compatible chat-completions API; the same server-only key
> serves the separate OpenRouter image API. Token Harbor is an optional additional text
> provider, off unless an operator explicitly selects it. Supabase
> stores the generated source, conversation and run state; the workspace
> previews the generated static `preview.html`, or an imported static site with an
> `index.html` / `public/index.html` and local assets. A user-owned Supabase account can
> also be connected through OAuth to list and select one of its projects. An **opt-in,
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
| Agent generation | OpenRouter (`deepseek/deepseek-v4.1-flash`) by default, or Token Harbor (`deepseek-v4.1-flash:free`) when explicitly selected, server-side; durable run rows, bounded batches, per-batch checkpoints, resume and cooperative cancel |
| Conversations and run status | Persisted in Supabase and polled by the workspace |
| Project settings | Owner-editable project name and description; the derived Mavly address is read-only |
| Project secrets | Write-only AES-256-GCM encrypted values per project/environment; list returns metadata only and update replaces without retrieval; **not injected into previews or published static sites** |
| Project activity | Real generation-run history from `project_runs` (runs, outcomes, files, tokens). Visitor analytics are not collected |
| Project files | Generated source tree, file reads and file saves |
| Source download | ZIP built from stored project files |
| Preview | Sandboxed static `preview.html`, or an imported static `index.html` / `public/index.html` with local assets |
| Supabase account connection | OAuth with PKCE, encrypted server-side tokens, organization/project discovery and one selected project |
| Figma design reference | Personal access token validated with Figma, encrypted per project, and a bounded design summary injected into generation |
| Publishing (opt-in, disabled by default) | Static files → deterministic Vercel project, published at `<project-id>.mavly.xyz`; framework builds are not run. Deployment and domain state persisted and polled. **Unpublish** removes the Mavly project domain and production deployments, preserving the project/files for republishing. Requires `MAVLY_VERCEL_DEPLOYMENTS_ENABLED=1`, `VERCEL_API_TOKEN` and operator-configured `mavly.xyz` DNS/SSL. See [`MAVLY_VERCEL_DEPLOYMENTS.md`](MAVLY_VERCEL_DEPLOYMENTS.md). |
| Shared tenant hosting (opt-in, off by default) | Immutable published versions stored in Supabase and served at `<project-id>.mavly.xyz` by Mavly's own tenant runtime. Enabled per project cohort with `MAVLY_HOSTING_MODE=shared` + `MAVLY_SHARED_HOSTING_PROJECTS`; the legacy Vercel path remains the default. See [`MAVLY_SHARED_HOSTING.md`](MAVLY_SHARED_HOSTING.md). |
| Durable generation worker (opt-in, off by default) | A project-cohort worker claims durable runs with `FOR UPDATE SKIP LOCKED`, executes them under a fenced lease, renews the lease, recovers crashed/expired jobs into bounded retries or dead letters, and never deletes accepted work. Requires `MAVLY_GENERATION_WORKER_ENABLED`, a ≥32-char secret, an explicit cohort, `SUPABASE_SERVICE_ROLE_KEY` and an operator-supplied scheduler. Uncohort projects keep the inline `after()` path. See [`docs/runbooks/generation-worker.md`](docs/runbooks/generation-worker.md). |
| Verification sandbox (opt-in, off by default) | Worker-dispatched runs enqueue one durable verification for their completed run and immutable snapshot. A later worker tick installs and builds the project's source in a Vercel Sandbox microVM, starts the validated `next start` on `127.0.0.1`, and requests `/` from inside the sandbox. `passed` requires the build to exit `0`, the runtime to start and the local health response to be `2xx`/`3xx`; a build-only success is never `passed`. Unsupported formats return `unsupported_runtime`. Detached stages span ticks, every terminal path destroys the sandbox, and cleanup failure never overwrites the outcome. An optional bounded AI repair (default 1, hard cap 2) may create one new immutable snapshot after a source-level `build_failed`/`runtime_start_failed`/`health_check_failed`, then rebuild and recheck. Preview remains unavailable: no public provider URL is stored or returned. Requires `MAVLY_VERIFICATION_SANDBOX_ENABLED`, `MAVLY_VERIFICATION_SANDBOX_PROJECTS`, Vercel provider credentials, migrations `17` then `19`, and a human-run `npm install` for `@vercel/sandbox`. No generated code runs on a Mavly host. See [`docs/architecture/phase-4-runtime-verification.md`](docs/architecture/phase-4-runtime-verification.md). |
| `/api/config` | `200 { "ok": true, "data": { "configured": false } }` |
| Visual shell | Dashboard, workspace, chat, composer, dialogs and preview frame render |

Generated code is **never executed** on this server. The only execution anywhere is the
opt-in verification build and loopback runtime check inside an isolated provider microVM,
which never runs on a Mavly host and exposes no public port. A generated backend exists as
source files, not as a running service.

## What does not work yet

Uploads/attachments, rebuilds, database browsing, schema changes, SQL execution,
customer-owned custom domains, runtime logs, visitor analytics, mobile builds, payments,
an included scheduler, usage, credits, versions and visual edits do not have a local
implementation. The durable generation worker is implemented but needs an operator-provided
scheduler; without one, worker-dispatched runs stay queued. The verification sandbox is
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
   ├── /api/generation/worker      Bearer secret → service-role worker tick
   │      ├── src/lib/generation/worker.ts → run-agent (worker mode)
   │      └── src/lib/sandbox/verification.ts → provider microVM (build + loopback runtime)
   ├── /api/vcaas/source-code/{id} auth + ownership → generated ZIP
   ├── /api/preview/{id}/…         auth + ownership → sandboxed static site
   ├── /api/vcaas/upload|env|git-diff
   │                               auth + ownership → 503
   ├── /api/visual-edit/.../apply  auth + ownership → 503
   ├── /api/vcaas/backup-download  auth + ownership → 503
   ├── /api/integrations/supabase/* auth → encrypted OAuth connection
   │      └── src/lib/integrations/supabase/* → api.supabase.com
   ├── /auth/supabase/callback      auth → state/CSRF/PKCE → encrypted token save
   └── /api/config                 200 { configured: false }
```

- **Auth:** `@supabase/ssr`, OAuth callback at `/auth/callback`, sessions refreshed in
  `src/proxy.ts`. The separate `/auth/supabase/callback` belongs to the user-owned
  Supabase connection, not Mavly sign-in.
- **Authorization:** a row in `public.projects` for `(project_id, user_id)`, read through
  the caller's RLS-scoped Supabase client. Missing and foreign rows return the same
  non-enumerating 403; lookup failures fail closed. Child tables inherit that ownership
  through RLS.
- **Generation:** `POST …/agent/start` atomically admits one run per project (and bounded
  per-user/global concurrency) through `create_generation_job`. By default `after()` then
  runs the agent: plan a manifest, request small file batches, validate every path and size,
  and checkpoint each batch before starting the next. A truncated response is never written; a
  failed/interrupted run can be resumed from its verified checkpoints with
  `POST …/agent/resume`, and `POST …/agent/stop` cooperatively cancels it. When the durable
  worker is enabled for a project cohort, admission records `dispatch_mode = 'worker'`
  instead and an external scheduler invokes `/api/generation/worker`; that path adds a
  fenced lease, heartbeat renewal, expired-lease recovery, bounded retries and dead letters
  while reusing the same generator and checkpoints. See
  [Generation reliability](#generation-reliability) and the
  [worker runbook](docs/runbooks/generation-worker.md).
- **Publishing:** disabled unless `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` is one of
  `1`/`true`/`yes`/`on` and `VERCEL_API_TOKEN` is set. The server uploads the static
  entry point (`preview.html`, `index.html`, or `public/index.html`) and its local assets
  as a static site, creates one deterministic Vercel project per
  Mavly project, attaches the derived `<project-id>.mavly.xyz` domain, and records
  deployment plus domain status in `project_deployments`. Success requires both the
  deployment and the verified domain. The browser never calls Vercel and never supplies a
  Vercel id, URL or hostname.
- **Unpublishing:** a separate authenticated operation. It claims the mapping, detaches the
  Mavly project domain, removes the project's production deployments, and records
  `unpublished` only after Vercel confirms. The Vercel project, Mavly hostname, project row
  and files are preserved, so republishing reuses the same address. Shared DNS and the
  wildcard are never touched.
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
instance can be terminated after the response. The durable row, checkpoints and
user-authenticated resume endpoint make recovery possible, but they do not by themselves
restart an inline run. The opt-in durable worker (`docs/runbooks/generation-worker.md`)
executes worker-dispatched runs under a lease and recovers crashed jobs, but it requires an
operator-provided scheduler; no scheduler is included. The service-role key it needs is
server-only and confined to the worker code path.

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
24,000-token project cap; `MAVLY_DEFAULT_MODEL` may only name a model in the selected
provider's catalog in `src/lib/ai/models.ts`.

### Text-generation providers

OpenRouter is the default provider for website and native Android source generation.
Token Harbor is an additional, OpenAI-compatible provider that an operator can select for
controlled testing:

- leave `MAVLY_AI_PROVIDER` unset (or set it to `openrouter`) for the default behaviour;
- set `MAVLY_AI_PROVIDER=tokenharbor` **and** `TOKEN_HARBOR_API_KEY` to use Token Harbor;
  the model is `deepseek-v4.1-flash:free`, and `TOKEN_HARBOR_BASE_URL` defaults to
  `https://tokenharbor.ai/v1`.

An unrecognized provider value keeps the default. There is no automatic fallback between
providers: a failure is reported as the selected provider's failure. Deleting
`MAVLY_AI_PROVIDER` and redeploying restores the previous behaviour — no data migration is
needed. Token Harbor serves **text/code generation only**; image generation stays on the
OpenRouter image API, and the free route is rate-limited by the provider. See
[`docs/architecture/phase-10-token-harbor-provider.md`](docs/architecture/phase-10-token-harbor-provider.md).

```bash
npm install
cp .env.example .env.local
```

Set these in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-key
NEXT_PUBLIC_APP_URL=http://localhost:3000
MAVLY_AI_PROVIDER=            # optional: openrouter (default) | tokenharbor
MAVLY_DEFAULT_MODEL=          # optional; must be a catalog entry of the selected provider
OPENROUTER_API_KEY=your-openrouter-api-key  # default generation provider + image generation
# Optional, only when MAVLY_AI_PROVIDER=tokenharbor. Server-only, never public.
TOKEN_HARBOR_API_KEY=
TOKEN_HARBOR_BASE_URL=        # optional; defaults to https://tokenharbor.ai/v1

SUPABASE_OAUTH_CLIENT_ID=your-oauth-app-client-id
SUPABASE_OAUTH_CLIENT_SECRET=your-oauth-app-client-secret
SUPABASE_OAUTH_REDIRECT_URI=http://localhost:3000/auth/supabase/callback
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
`OPENROUTER_API_KEY` (default generation provider and images), `TOKEN_HARBOR_API_KEY`
(optional generation provider), the OAuth client secrets,
`MAVLY_INTEGRATION_ENCRYPTION_KEY`, `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`,
`VERCEL_API_TOKEN`, `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`,
`MAVLY_GENERATION_WORKER_SECRET` and
`SUPABASE_SERVICE_ROLE_KEY` are server-only: never prefix them with `NEXT_PUBLIC_`, never
commit them, and configure usage/spend limits in your OpenRouter account as
appropriate. The service-role key is required only when the opt-in durable worker is
enabled, and is confined to `src/lib/supabase/worker.ts`, the worker orchestrator,
`/api/generation/worker` and the verification tick it invokes. Sandbox provider credentials
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

### User-owned Supabase connection

Create an OAuth app in the Supabase dashboard, set its redirect URL to the exact
`SUPABASE_OAUTH_REDIRECT_URI` above (or the deployed equivalent), and request only
`organizations:read` and `projects:read`. Generate the encryption key with:

```bash
openssl rand -base64 32
```

Keep that key stable and server-only. Changing it, the OAuth client ID, or the OAuth app
makes existing stored connections undecryptable; affected users must reconnect. The
integration stores ciphertext only and never sends tokens to the browser.

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
OpenRouter and Token Harbor request/response classification and the provider-selection
policy, generation validator/batching/truncation rules,
provider retry classification, checkpoint verification, deployment host/state rules, the
verification runtime/health/preview/config/state/result modules, the bounded repair policy
and parsers, and static invariants of migration `19` (including the build+runtime+health
`passed` rule). They do not exercise a real
Supabase session, a live OpenRouter generation or image call, the Supabase OAuth connection, a
real Vercel Sandbox or any other verification provider, a generated app, a repair model
call, or the migrations against a database. A manual OAuth check needs a real Supabase
OAuth app: connect, verify organization/project discovery, save a selection, refresh the
page, disconnect, and confirm the grant is revoked. A manual publish check requires a real
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
