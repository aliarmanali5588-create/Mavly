# AGENTS.md — Mavly

Mavly is an AI app-builder built with Next.js 16, React 19, TypeScript and Tailwind 4.
Supabase Auth (Google + GitHub OAuth) is real and gates the builder pages. The builder has
a local, server-side AI implementation: OpenRouter generates frontend and backend source
files through its OpenAI-compatible chat-completions API, and the same server-only key
serves the separate OpenRouter image-generation API. OpenRouter is the only supported
text-generation provider. Supabase stores projects/files/messages/runs, and the workspace
previews a generated static `preview.html`. An opt-in Phase 13 runtime can instead run a
supported React + Vite project's real Vite dev server inside an isolated E2B sandbox;
that preview is off by default, uses a disposable copy of the persisted files, and never
writes back to them. Customer-owned Supabase account/project OAuth connections are not
supported.

Read `MAVLY_CLEAN_BASELINE.md` before changing anything under `src/app/api/`,
`src/lib/ai/`, `src/lib/mavly/` or `src/lib/vcaas*`. It records what was removed and what
the current implementation does.

> **Do not reconnect Totalum or add another hosted builder backend implicitly.** The old
> Totalum integration stays removed and is documented only for historical context below.
> OpenRouter is the only website/code-generation provider: `src/lib/ai/provider.ts`
> dispatches to `src/lib/ai/openrouter.ts`, and its server-only key also serves the image
> path. Do not add a provider or backend without explicit product approval and a security
> review.

---

## Non-negotiable verification policy

**Agents must not run automated verification of any kind.** This includes, without
limitation:

- `npm test` or any other test runner / test file
- `npm run lint`, ESLint, Prettier checks, or import-hygiene checks
- `npx tsc --noEmit` or any TypeScript check
- `npm run build`, `next build`, or any bundler/build command
- `npm run dev`, `npm start`, `next dev`, `next start`, or any smoke-test server
- browser automation, Playwright, Cypress, screenshot tools, or manual HTTP probes
- adding a test framework, CI workflow, or smoke-check script solely to satisfy a task

Static inspection is allowed and expected: reading files, searching, and `git diff`.
Implementation work is still required — the policy removes automated checks, not the
obligation to write correct code.

Report honestly. Never say a test, lint, typecheck, build, or smoke check passed unless it
was actually run, and under this policy it normally was not. If a task appears to require
running one of the commands above, stop and ask the human developer.

**The human developer runs the checks before merge.** The commands are documented below
for that person, not for agents.

## Commands (human-run)

```bash
npm install                      # Node 20+
cp .env.example .env.local       # Supabase + AI provider (OpenRouter default) + OAuth + publishing
npm run dev                      # http://localhost:3000
npx tsc --noEmit                 # typecheck
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test                         # unit tests (node:test); needs Node 22.6+
npm run lint
npm run build && npm start
```

Apply `supabase/migrations/10_generation_jobs.sql` before deploying the durable generation
jobs, `03_ai_builder.sql` before using the builder,
`04_supabase_integration.sql` before using the Supabase connection,
`07_project_deployments.sql`, `09_mavly_deployment_domains.sql` and
`13_deployment_unpublish.sql` before enabling publishing/unpublishing,
`14_shared_hosting.sql` before deploying this build (it is additive, but the deployment
mapping now reads `active_version_id`), then `15_shared_hosting_attempt_state.sql` before
enabling shared tenant hosting (it separates the live active version from the latest publish
attempt and adds the publish preflight), then `16_durable_generation_worker.sql` before
enabling the durable generation worker (it adds queue leases, retries, recovery and the
schema preflight; additive and non-destructive), then `17_verification_sandbox.sql` before
enabling the isolated verification sandbox (it adds the verification table, its fenced
RPCs and schema marker 17; additive and non-destructive), then
`19_runtime_verification.sql` before enabling runtime/health verification and bounded AI
repair (it adds build/runtime/health/preview/repair state, the 7-argument enqueue, the
build+runtime+health `passed` rule and schema marker 19; additive, applied after 17),
then `20_fullstack_hosting.sql` before enabling full-stack production hosting (it adds the
deployment lifecycle/attempt/env/database tables, the fenced deployment RPCs and schema
marker 20; additive, applied after 19 and 11), then `21_business_integrations.sql` before
enabling business integrations (it adds the per-project provider metadata, payment and
webhook-event tables, the owner/gateway/webhook SECURITY DEFINER RPCs and schema marker
21; additive, applied after 11 and 12),
`08_figma_integration.sql`
before using Figma, `11_project_secrets.sql` before using project secrets, and
`18_admin_allowlist.sql` before opening `/adminsh` (the server layout fails closed
without `current_user_is_admin()`). Apply `23_production_hardening.sql` after 21 and 22
and before deploying this build to an environment that serves payment orders: the gateway
fails closed without its durable rate-limit RPC. Apply `24_agent_memory.sql` after 23
before enabling `MAVLY_AGENT_MEMORY_ENABLED`; the memory API fails closed without it and
generation keeps its prior context behavior. Both migrations are additive and safe to
apply while the previous application version is still deployed. Apply
`25_project_creation_idempotency.sql` after 24 before enabling Android project creation;
it adds an owner-scoped creation request key so retries return the same project. Apply
`26_android_builds.sql` after 25 (and after 20) before enabling isolated Android debug
builds: it adds the durable build table, fenced claim/lease/complete/recovery RPCs,
artifact-retention state, owner-safe column grants, schema marker 26 and a private
`android-artifacts` Storage bucket. It never stores an APK/AAB in Postgres. Apply
`29_multi_agent_orchestration.sql` after 28 (and after 16) before enabling multi-agent
orchestration or the deployment approval gate: it adds the durable workflow/task/event
tables, the owner-scoped deployment-proposal table and atomic consume RPC, and schema
marker 29. It is additive and non-destructive and can be applied while the previous
application version is live. Apply `30_managed_backends.sql` after 29 and before
enabling managed Neon provisioning; it adds an owner-readable-metadata-only registry
and service-role-only fenced provisioning RPCs. It is additive and non-destructive.
Apply `31_credit_foundation.sql` after 30 before enabling ANY credit enforcement or
role-level AI usage metering: it adds the credit accounts, append-only ledger,
reservations, per-attempt usage tables, the database-owned `credit_project_policies`
cohort/cost mirror, service-role-only credit admission/resume/release/terminal RPCs and
the service-role metering RPC. It is additive and does not alter migration 16's
queue/fencing RPCs. Credit-enforced production projects use the platform-wide durable
worker dispatch; local and preview paths remain inline and do not bypass the database guard.
the database run-state guard blocks authenticated legacy create/resume paths and permits
service-role insert/resume only through the credit-aware transaction-local markers.
Synchronize enabled policy rows with `MAVLY_CREDITS_PROJECTS` and
`MAVLY_CREDITS_GENERATION_COST`. Without migration 31, `MAVLY_CREDITS_ENABLED` fails
closed with `MIGRATION_REQUIRED`. Apply
`32_credit_reliability_hardening.sql` after 31 and before enabling the credit cohort: it
sets the required worker/credit marker to 32, serializes policy activation and
credit-aware admission in a consistent lock order, settles or releases reservations in
the terminal `project_runs` transaction, and records worker provider attempts before
dispatch with service-role-only RPCs. With the flag off, new app admissions and
owner-facing credit calls are disabled, but an enabled database policy continues to block
unreserved legacy run writes until drained and explicitly disabled; existing reservations
and usage remain recoverable through worker/database paths. See `docs/runbooks/credits.md`.
Generation-level and per-role usage-metering failures are logged without changing the
terminal generation outcome and without discarding an already-produced advisory role
result; the missing usage row stays missing and no cost is claimed for it. Neither path
changes credit settlement. Apply `33_project_image_assets.sql` after 32 and after 03
(and after any migration that recreated `project_runs`) before setting
`MAVLY_IMAGE_PLANNING_ENABLED`: it adds `project_image_plans`/`project_image_assets`,
owner-checked SECURITY DEFINER sync/claim/complete/fail/finish RPCs, schema marker 33 and
the public-read `project-images` Storage bucket. It is additive and non-destructive, does
not alter any credit, payment or pricing table, and stores no image bytes in Postgres.
With the flag off the planner is never asked for an image plan and the stage never runs.
Apply `34_runtime_sandboxes.sql` after 33 before setting
`MAVLY_RUNTIME_SANDBOX_ENABLED`: it adds the `project_runtime_sandboxes` lifecycle
table, owner-checked SECURITY DEFINER begin/update/stop RPCs, a service-role-only expiry
sweep, the database transition table, SELECT-only owner RLS, schema marker 34 and the
`E2B_API_KEY`-gated live preview runtime. It is additive and non-destructive, does not
alter generation runs, credits, images, verification, payments or deployment, and stores
no generated source or artifact. With the flag off no sandbox is created and the static
preview is unchanged. It requires a separately managed E2B template with Node + npm.
Apply `37_managed_backend_enrollment.sql` after 35 before enabling automatic managed-backend
enrollment: it adds `project_managed_backend_enrollments` (one row per project incarnation,
unique on `(project_id, project_created_at)`), the append-only
`project_managed_backend_enrollment_events` audit table, the service-role-only enrollment and
execution-time authorization RPCs, the admin-gated `set_managed_backend_enrollment`, and an
enrollment guard inside `mark_managed_backend_create_started` and
`begin_managed_backend_configuration` (signatures unchanged; the guard applies only when a
registry row exists, so a legacy deployment is unaffected). It is additive and non-destructive
and never deletes a Neon project or customer row. Enrollment is a SEPARATE state machine from
the backend lifecycle — do not merge them. With
`MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE` unset the legacy
`MAVLY_MANAGED_BACKENDS_PROJECTS` allowlist still authorizes; setting it to any value makes the
registry authoritative and the static list stops authorizing. Apply
`35_managed_backend_runtime.sql` after 34 and after 30 before enabling the managed
backend runtime: it extends the managed-backend lifecycle to
`configuring`/`ready`/`cleanup_pending`, adds the verified-schema and gateway columns, a
sanitized migration mirror, the service-role configuration RPCs, the public
`data_gateway_context`/`consume_app_gateway_rate` functions and schema marker 35. It is
additive: `claim_managed_backend` keeps its signature, and no customer data is touched.
Apply `36_generation_worker_handoff.sql` after 16 before relying on the
inline→worker hand-off: it adds `handoff_generation_job(project_id, run_id, claimed_at)`, an
owner-checked, claim-fenced SECURITY DEFINER function that moves a LIVE inline run to
`retry_wait`/`dispatch_mode = 'worker'` only when it has a persisted manifest and at least
one verified checkpoint, and cannot be repeated. It is additive: no column, table, policy,
grant or existing RPC changes. Without it the hand-off is refused and the run fails exactly
as before.
Apply `52_admin_notifications_and_reporting.sql` after 51 before enabling the
production admin notification store: it adds admin-only persistent notifications,
the trusted signup notification trigger, read/unread RPCs, optional Realtime
publication, retention cleanup, and the Asia/Kolkata reporting-window authority
used by the admin Overview and AI-usage aggregates. It does not add Mavly billing
or treat customer-app Razorpay payments as platform revenue.
Apply `53_live_announcement_banner.sql` after 52 before enabling the public
announcement banner: it extends the existing `admin_settings` registry with the
plain-text `announcements.message`, adds an atomic admin-only enabled/message write
RPC with audit logging, and adds the anonymous read-only banner RPC. It creates no
new announcement table and fails closed on invalid or empty enabled messages.
Project-secret encryption also
requires the server-only `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` (32 random bytes,
base64-encoded); without it create/update fail closed. `npm test` covers the pure
auth/redirect/ownership/scope modules, the generation state/lease/claim/observability
modules, the generation timeout-budget and preview-document/preview-state modules, the
verification runtime/health/preview/policy/config/state/result modules, the
bounded repair policy and parsers, the full-stack runtime/config/database/env/address
rules, the business-integration registry/config/validation, Razorpay signature and
provider-error mapping, the payment state machine, the gateway session exemptions, the
Phase 7 durable rate-limit migration contracts, payment-event metadata/redaction, the
admin surface gate, Phase 8 memory validation/retrieval/prompt framing/migration
contracts, the planning-driven image plan validator/approval/budget/prompt/stage rules,
the Phase 13 live-runtime config/path/command/preview-host/log-redaction/lifecycle/
evidence rules against a mocked provider and an in-memory store,
the Phase 9 Android source contract/profile/capability rules, the Android build
config/policy/archive/artifact/migration contracts, the Phase 10 workflow transition/
dependency/budget/output/config/approval/security/tool/parser rules and its static
migration/catalog/deploy-gate invariants, the build-image reference/registry and
offline-verification static contracts in `infra/android-build/`, the operator-doc coverage
checks, the OpenRouter adapter contract, the model-catalog policy, the managed-backend
requirement/model/compiler/lifecycle contracts, the data-gateway auth/query/origin rules,
the inline→worker hand-off decision and the capped pending-work reserve, the static
file/structure verification stage,
the Phase 11
credit configuration/lifecycle/RPC-error/migration contracts (pure and static),
per-role model resolution, and static route/migration invariants.
It does not
exercise a
real Supabase session, OpenRouter, a live worker/queue, the Supabase OAuth connection, Vercel
publishing, a real Vercel Sandbox, a generated Android or website app, a real Gradle build,
an APK/AAB artifact, a signed download, a repair model call, a real Vercel
full-stack deployment, a real application database connection, a live Razorpay account,
a delivered webhook, a container image build/publish, a real E2B sandbox, a real npm
install/Vite dev server/readiness probe/QA build, or the migrations against a database.

---

## Current backend status

- Website and native Android code generation use OpenRouter server-side through
  `src/lib/ai/provider.ts` and `src/lib/ai/openrouter.ts`, with the verified catalog entry
  `deepseek/deepseek-v4.1-flash` as the default and server-only `OPENROUTER_API_KEY`. The
  optional `cohere/north-mini-code:free` model is restricted to the explicit
  `MAVLY_NORTH_MINI_CODE_PROJECTS` cohort. The same key serves the image API; the shared
  chat contract is `src/lib/ai/chat-contract.ts`. **Requests are streamed and
  progress-bounded:** each call class has one absolute cap plus a shorter idle-progress
  window (`src/lib/ai/budget.ts`), and the streamed-accumulation/completion rules live in
  `src/lib/ai/stream-contract.ts`. A cancelled, unknown-reason or prematurely closed
  stream is a failure even when text arrived. A timeout is answered by reducing batch
  scope, never by repeating the same request, and each run has a provider-attempt ceiling
  (`MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN`, 4–40, default 12). Do not add another model provider or
  hosted builder backend without approval.
- **Managed Neon backends are implemented end-to-end server-side but OFF BY DEFAULT
  (Phase 14).** A website planner proposes a bounded `dataModel`; the trusted server
  validates it (`src/lib/managed-backend/model.ts`), and a deterministic compiler turns it
  into additive, idempotent steps (`migrations.ts`) applied by a ledgered, advisory-locked
  runner (`runner.ts`) that reads the resulting schema back from `information_schema`. Only
  then can the run reach `ready`, which also requires the data gateway's origin and
  server-only RPC proof. `provisioned` still means only "a Neon project exists and Mavly
  connected once"; it is never CRUD readiness. It requires
  `MAVLY_MANAGED_BACKENDS_ENABLED`, `MAVLY_NEON_AGENT_PLAN_APPROVED`, `NEON_API_KEY`,
  `NEON_ORG_ID`, `NEON_REGION_ID`, `MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY`,
  `MAVLY_APP_GATEWAY_ORIGIN`, `MAVLY_MANAGED_BACKENDS_RPC_SECRET`, migrations 30 and 35,
  the durable worker, and a Neon Agent Plan enrollment approved by Neon (active Scale plan +
  team approval). A static product never provisions; a prompt that needs persistence but
  has no valid data model gets no database and an explicit message, never an empty database
  or in-memory storage presented as persistence. The compiler contains no destructive
  statement: it never drops, truncates, retypes or deletes customer data, and a column added
  to a populated table is nullable so an additive step can never fail on existing rows
  (`required` stays a gateway input rule; verification checks presence and type everywhere
  and exact nullability only for tables the run created). A backend failure never discards
  the user's generation: the stage reports a sanitized `blocked` reason, forces a labelled
  prototype, keeps any existing database/schema/rows, and lets the code batches finish, so a
  later run can retry without starting over. Generated apps
  use Mavly's data API (`/api/app/v1/apps/{projectId}/data|auth/...`), which executes only
  Mavly-authored parameterized SQL against the customer database, scopes every user-owned
  row by the session user, and never returns a connection credential. End-user accounts
  live in the customer database (scrypt passwords, hashed opaque sessions on
  `_mavly_auth_users`/`_mavly_auth_sessions`) and are unrelated to Mavly auth. The Neon
  connection URI stays AES-256-GCM ciphertext bound to `(user, project, registry)`.
  Project deletion and `cleanup_pending` do not delete the Neon resource; there is no
  automatic backup/restore and no credit pricing for managed databases. **A hosting runtime
  for generated Next.js server code is still absent** (customer Vercel publishing is
  retired, Phase 5 is off by default, Phase 13 is a React + Vite dev preview), so the data
  API is real but cannot be exercised from a published generated app in this repository.
  Password reset is not implemented (no email transport). No live Neon provisioning, schema
  run, gateway request or end-to-end generated app has been verified.
- **Native Android source generation is implemented (Phase 9).** Project types persist in
  `public.projects.project_type` (migration 22) and Android creation is idempotent through
  migration 25. An Android prompt flows through the same durable run, OpenRouter provider, batch
  checkpoints, snapshots and memory as a website prompt, but selects a Kotlin 2.0 / Jetpack
  Compose / Gradle Kotlin DSL profile instead of Next.js. The planner is given a
  deterministic `com.mavly.<project>` application id; the complete resulting source is
  re-validated by `src/lib/android/contract.ts` before completion (required
  settings/root/app Gradle files, manifest, README, matching
  package/namespace/applicationId, Compose entry point, launcher activity, pinned
  dependency versions, allowlisted Maven repositories, no cleartext, dangerous permissions,
  binary/keystore/signing files or build-script process execution). Invalid source fails
  the run; completed batches remain recoverable from the baseline snapshot.
  **Isolated Android DEBUG builds are implemented but OFF BY DEFAULT.** They require
  `MAVLY_ANDROID_BUILD_ENABLED`, an explicit `MAVLY_ANDROID_BUILD_PROJECTS` cohort,
  `MAVLY_ANDROID_BUILD_IMAGE` (a Vercel Container Registry image) pinned by `@sha256:`
  digest, a private artifact bucket,
  Vercel Sandbox credentials, migration 26, the service-role key and the Supabase URL.
  A tag, an external registry host (Docker Hub/GHCR/ECR) and a non-numeric vCPU value are
  rejected. The reproducible image definition lives in `infra/android-build/` (base and
  every download digest/checksum pinned, seed-warmed Gradle cache, offline verification);
  the repository does not build or publish it. The pinned image must contain JDK 17,
  Gradle 8.9 on `PATH`, Android SDK/build-tools 35 and `aapt`, with a pre-populated
  Gradle cache; builds run `:app:assembleDebug --no-daemon --offline`
  inside a Vercel microVM with **deny-all network**, never on a Mavly host. Each build is
  bound to an immutable source snapshot and re-verifies the snapshot hash, contract,
  artifact ZIP, package id, size and SHA-256 before a fenced `succeeded` write. APKs live
  in private Storage; download requires an owner check and returns a 5-minute signed URL.
  Debug only: no release signing, AAB, store publishing, emulator/device test or public
  artifact URL. If any prerequisite is missing the API fails closed with
  `ANDROID_BUILD_NOT_CONFIGURED`; before migration 26 is applied,
  `GET …/mobile/builds` returns `503 MIGRATION_REQUIRED`, and afterwards the same
  request reports the exact capability. No build row, log or artifact is fabricated. See
  `docs/architecture/phase-9-android.md`, `docs/runbooks/android.md` and
  `infra/android-build/README.md`.
- **Customer Vercel publishing is retired** and is not a builder backend. The workspace
  does not expose a publish action, and deployment routes fail closed instead of calling
  Vercel or reporting success. Historical deployment rows and migrations are preserved;
  no production database mutation or external takedown is performed by this removal.
- **Shared tenant hosting is implemented but off by default** (`MAVLY_HOSTING_MODE=shared`
  plus an explicit `MAVLY_SHARED_HOSTING_PROJECTS` cohort). A shared publish stores an
  immutable version in `project_published_versions` / `project_published_files`, then
  `activate_shared_publication` (migration 15) atomically supersedes the previous version,
  sets `project_deployments.active_version_id`, and marks the attempt `ready`. The public
  resolver serves from `active_version_id` + the active version, **not** from the attempt
  `status`, so a republish (`queued`) or a failed attempt (`error`) leaves the previous
  version live. It serves at `<project-id>.mavly.xyz` through the tenant runtime
  (`src/app/api/tenant/…` reached by a validated-host rewrite in `src/proxy.ts`), and the
  runtime re-checks the configured cohort after resolution. Public access is limited to two
  `SECURITY DEFINER` RPCs; `project_files` is never served publicly, drafts never leak, and
  unpublish deactivates the mapping without deleting history. A publish on a database
  missing migration 14/15 fails closed with `503 BACKEND_NOT_CONFIGURED` **before writing
  any attempt state**. The legacy per-project Vercel path remains the default and its rows
  keep their Vercel takedown behaviour. Wildcard DNS/TLS and Vercel plan eligibility are
  still unverified operator prerequisites; see `MAVLY_SHARED_HOSTING.md`.
- `src/lib/vcaas-server.ts` was deleted and must not be recreated. No Totalum host, key or
  forwarding remains.
- Implemented paths authenticate, check `/api/vcaas` scope and project ownership, then use
  Supabase through the caller's RLS-scoped client:
  - project list/create/launch/get/update/delete;
  - `agent/start`, `agent/status`, `agent/full-conversation`, `agent/workflow` (GET) and
    `agent/workflow/cancel` (POST, owner-only orchestration record cancellation);
  - `files/tree`, `files/content` (GET/PUT);
  - `deployments/deploy` (POST), `deployments/unpublish` (POST) and
    `deployments/status` (GET), which fail closed with
    `BACKEND_NOT_CONFIGURED` unless publishing is explicitly enabled and configured;
  - `deployments/proposals` (GET/POST), `deployments/proposals/{id}` (GET),
    `…/approve` (POST) and `…/revoke` (POST), the Phase 10 owner approval chain. A
    proposal is not a deployment; `deployments/deploy` consumes an approved proposal
    atomically when the gate is enabled.
- Dedicated routes serve the generated source ZIP (`/api/vcaas/source-code/{id}`) and the
  sandboxed static preview (`/api/preview/{id}/`).
- Customer-owned Supabase account/project OAuth connections are retired. Migration `04` is
  historical and retained; its tables are not served by runtime code. Mavly's own Supabase
  authentication, projects, RLS, generation, publishing, and worker infrastructure remain.
- **Generation jobs are durable per run.** `project_runs.stage` records
  `queued/validating/generating/retrying/retry_wait/completed/failed/cancelled/interrupted`;
  `project_run_batches` stores a validated batch and per-path SHA-256 hashes. A run plans a
  manifest, generates bounded batches and checkpoints each one; `finish_reason: "length"`
  is never success, and a resume skips only paths whose current content still matches.
  `create_generation_job` is the atomic admission gate (one active run per project, 2 per
  user, 8 global, serialized with a Postgres advisory lock; a trigger re-checks the
  limits on resume). `agent/resume` and `agent/stop` are user-authenticated. Run,
  manifest and heartbeat writes carry the run's `claimed_at` lease (checkpoints are
  written between lease checks), so a resumed run cannot be finalized by a stale worker.
- **The durable generation worker is platform-wide in production.** Production website
  and Android generation admissions use `dispatch_mode = 'worker'`; there is no worker
  enable flag, shared worker secret, project allowlist or public invocation route. Local
  development and Vercel previews retain the inline `after()` path. The app admission path
  and Render Background Worker require only the existing server-side
  `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and `OPENROUTER_API_KEY`. AWS
  EC2 is the designated production worker host through
  `workers/aws-generation-worker.ts`; it polls the existing worker engine. The preserved
  Render entry point and `render.yaml` are disabled with
  `MAVLY_RENDER_WORKER_DISABLED=true` and remain a future fallback. The worker recovers
  expired leases, claims one ready job with `FOR UPDATE SKIP LOCKED`, re-verifies the owner
  with a service-role client, executes the unchanged generation pipeline under a 420 s
  fenced `lease_token`, and renews it every 120 s. Retries reuse only verified checkpoints
  and back off 15 s→300 s with jitter; exhaustion dead-letters the run without deleting it.
  Expired leases become retries or dead letters, never duplicates. Cancellation is persisted
  and fences the worker at safe checkpoints; a provider request already sent cannot be
  undone. **The service-role client is confined to `src/lib/supabase/worker.ts`, the worker
  orchestrator and trusted worker entrypoints; the managed-backend provisioning service
  only receives that client from the worker. RLS is unchanged, and the authenticated role's
  UPDATE grant explicitly excludes all worker-owned columns.** The previous Cloudflare Cron
  configuration is retained in `wrangler.jsonc` but its scheduler is disabled by
  `MAVLY_CLOUDFLARE_WORKER_DISABLED=true`; remove its deployed trigger before AWS-only
  production operation. Render is preserved but inactive; its reactivation instructions
  are in `docs/runbooks/aws-generation-worker.md`. AWS deployment, runtime compatibility
  and production behavior remain unverified. Do not raise the 2/user or 8/global admission caps to claim
  support for 1,000 concurrent users.
  **An inline run that cannot finish can be handed to the worker (migration 36).** When an
  inline attempt reaches its terminal decision with a retryable failure and this deployment
  dispatches the run to the worker, `fail()` persists its provider usage, then calls
  `handoff_generation_job` and returns without a terminal write. The RPC re-verifies
  ownership, the exact `claimed_at` fence, the persisted manifest and at least one verified
  checkpoint; it refuses a run another attempt owns and a non-retryable failure (a rejected
  or unsafe generation is not a scheduling problem). Production dispatch is platform-wide,
  so there is no project cohort to drift from the queue claim. The transition is once-only
  because it sets `dispatch_mode = 'worker'`, so a resume of that run also stays on the
  worker. Every
  refusal falls through to the existing terminal failure, never to a claim of success.
  Budget constants are not inflated to fake a longer inline window.
- **The isolated verification sandbox is implemented but off by default.** It builds a
  generated project's source in a Vercel Sandbox microVM, starts the validated production
  server on loopback and runs a sandbox-local health request. It is enabled only when
  `MAVLY_VERIFICATION_SANDBOX_ENABLED` is truthy,
  `MAVLY_VERIFICATION_SANDBOX_PROVIDER=vercel`, an explicit
  `MAVLY_VERIFICATION_SANDBOX_PROJECTS` cohort is set, and the provider authenticates
  through `VERCEL_OIDC_TOKEN` + `VERCEL_PROJECT_ID` or the
  `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`/`VERCEL_TOKEN` triple. Only **worker-dispatched**
  runs enqueue verification, one row per completed run (uniquely keyed by `run_id`) tied
  to that run's ready snapshot whose `source_hash` still matches; inline runs never do. The
  generation worker advances at most one verification stage per tick, so it never competes
  with a queued generation job. Install, build and the runtime run as detached provider
  commands that write on-disk marker/log files; the worker's per-stage deadline (plus a
  grace period) and the sandbox's own lifetime bound them, because the provider exposes no
  per-command timeout. Later ticks reconnect to the same sandbox by its persisted name and
  poll. **`passed` means three separate things succeeded:** `next build` exited `0`, the
  fixed `next start` was launched on `127.0.0.1:3000`, and a sandbox-local request to `/`
  returned `2xx`/`3xx`. Both the tick and migration 19's `complete_verification` reject a
  `passed` write without all three (`PASSED_REQUIRES_RUNTIME`); a build-only success is
  never `passed`, and a passing health check is not a deployed app, a browser render or a
  correctness proof. Unsupported/ambiguous formats return `unsupported_runtime` instead of
  a guessed command; the generated `start` script is validated but never executed.
  Runtime failures are distinguished (`runtime_start_failed`, `runtime_port_unavailable`,
  `runtime_exited`, `health_check_failed`, `timed_out`). A **separately opt-in** bounded AI
  repair (`MAVLY_VERIFICATION_REPAIR_ENABLED`, `MAVLY_VERIFICATION_MAX_REPAIRS` 0–2,
  default 1) may create one new immutable `repair` snapshot after a source-level
  `build_failed`/`runtime_start_failed`/`health_check_failed`, then rebuild, restart and
  recheck; it never edits `project_files`, never touches manifests/lockfiles/secrets, and
  cannot make the verification pass by itself. **Preview is unavailable on purpose:** the
  provider can mint a public unauthenticated URL and Mavly has no authenticated proxy, so
  `agent/status` returns only `preview.status = "unavailable"` and never a provider URL.
  Sandboxes are destroyed on every terminal path, with bounded orphan reconciliation;
  cleanup failure never overwrites the outcome. No generated code runs on Mavly
  hosts and there is no local execution fallback. Verification status is exposed only
  through the existing authorized `agent/status` and `agent/stop` responses for the
  caller's own project. See `docs/architecture/phase-4-runtime-verification.md`,
  `docs/architecture/phase-3-verification-sandbox.md` and
  `docs/runbooks/verification-sandbox.md`.
- **Full-stack production hosting is implemented but off by default (Phase 5).**
  A project explicitly listed in `MAVLY_FULLSTACK_HOSTING_PROJECTS` (never `*`) is
  routed to `src/lib/deployments/fullstack.ts` before static resolution, and only a
  PASSED Phase 3/4 verification for the exact snapshot hash can be deployed. Vercel
  builds and runs the Next.js App Router app (route handlers, server actions,
  middleware) in its own runtime; no generated code runs on Mavly hosts, and the
  Phase 3/4 microVM is not used as hosting. The attempt table and monotonic
  `deployment_attempt` fence keep one active attempt, settle only the attempt they
  belong to, and preserve `previous_deployment_id` on failure; rollback uses Vercel
  Instant Rollback to a previously ready attempt. `ready` requires provider READY, a
  verified Mavly domain, every production secret synced and any configured
  `DATABASE_URL` synced with the same fingerprint. Existing full-stack rows keep
  status/takedown/rollback even when the flag or cohort is turned off; takedown
  requires only the Vercel token. Provider project targeting is derived from the
  owner-bound `vercelProjectName` (never a row-supplied id/name), and takedown deletes
  only deployments the provider lists for the project. Project secrets are pushed to
  the provider's encrypted env in the save request (write-only; no read-back); a
  value saved before the provider project existed is `awaiting_project` and must be
  re-saved after the first deploy creates the project. The application database
  contract stores non-secret metadata and one encrypted `DATABASE_URL`; saving it runs
  one bounded, DNS-pinned `select 1` (private addresses refused) and never provisions,
  migrates or reads application data. The deployment RPCs are SECURITY DEFINER and
  ownership-checked and use the caller's RLS client (no service role); a project owner
  can still misrepresent their own deployment/env metadata, which needs a
  service-role-only follow-up if stronger self-attestation resistance is required.
  No live post-deploy HTTP probe is performed (readiness is the verified snapshot +
  provider READY + domain). See `docs/architecture/phase-5-fullstack-hosting.md` and
  `docs/runbooks/fullstack-hosting.md`. Static tests do not exercise a real Vercel
  build, secret push or database connection.
- **Business integrations are implemented but off by default (Phase 6).** The first
  provider is **Razorpay payments for generated applications**, separate from Mavly's
  own Razorpay-only billing: Mavly plan prices, credit packs and billing rules are
  untouched. Enabled only when `MAVLY_BUSINESS_INTEGRATIONS_ENABLED` is truthy, an
  explicit `MAVLY_BUSINESS_INTEGRATIONS_PROJECTS` cohort exists, and
  `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`, `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET`
  (a server-only ≥32-character proof) + Supabase are configured. The three provider
  values (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) are saved
  per project as encrypted `project_secrets`; the owner UI never receives them back, and
  a save tests the key pair with a side-effect-free `GET /v1/orders?count=1` before
  writing. Saving is not enabling: the API defaults `enabled` to false, and the workspace
  requires a separate confirmation before enabling live (`rzp_live_`) keys. A published app's **server code** calls
  `POST /api/app/v1/payments/orders`, `POST /api/app/v1/payments/verify` and
  `GET /api/app/v1/payments/{orderId}` with a project API key carrying `integrations:*`;
  those two path prefixes are the only new public API exemptions, and each route
  authenticates itself. The app calls the HTTP gateway, never PostgREST directly:
  every gateway DB RPC also requires the server-only RPC hash, so an API key alone
  cannot create, fail or mark an order paid. Order creation is idempotent per `(integration, idempotencyKey)`
  and is never blindly retried; the provider order is read back when a recorded order
  already exists. `paid` is reachable only after the Checkout signature over
  `order_id|payment_id` AND an authoritative `GET /v1/payments/{id}` (amount/currency must
  match), or after a webhook whose HMAC-SHA256 matches the **exact raw body**. Webhooks
  resolve an unguessable per-integration token, require the SHA-256 of the server-only
  `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET` on every write RPC (so the public anon key
  alone cannot record or apply an event), are idempotent on the SHA-256 of the signed
  body (not the unsigned event-id header), and never store the raw body. `paid` never regresses; a late
  verified capture is accepted from any state. Disable refuses new orders but **does not
  rotate the webhook token or delete the user's secrets**; signed webhooks for orders
  already created are still recorded. Refunds, subscriptions,
  payouts, email and WhatsApp are **not implemented and not listed in the catalog**.
  The workspace gains a real **Business payments** section; the older copied Stripe
  Connect "Payments" panel remains pre-existing, unimplemented copy and is not wired to
  Phase 6. A Mavly-hosted generated app needs Phase 5 full-stack hosting (or another
  server runtime) to keep the project API key server-side. Static apps must not call the
  gateway from the browser. No live Razorpay account, webhook delivery or real payment
  has been verified. See `docs/architecture/phase-6-business-integrations.md` and
  `docs/runbooks/business-integrations.md`.
- **Production hardening is implemented, with live acceptance still pending (Phase 7).**
  `/adminsh/*` is no longer a public mock console: the proxy requires a session and
  `app/adminsh/layout.tsx` calls `public.current_user_is_admin()` from migration 18,
  returning 404 to a signed-in non-admin and failing closed if the allowlist migration is
  missing. Payment order/verification attempts now use the durable
  `consume_integration_rate_limit()` RPC (migration 23): **30 order attempts and 60
  verification attempts per 60 seconds per integration**, fixed in SQL and shared across
  instances. The gateway fails closed if that RPC is missing, and the owner status shows
  a migration warning instead of silently degrading. Webhook audit metadata (event type,
  status, error code, timestamps — never the raw body/digest/secret) is exposed to the
  owner for reconciliation; unmatched/mismatched events remain `failed` and never guess a
  payment state. A signed retry can reclaim a `received` webhook row older than two
  minutes (migration 23), so a crash/finish failure cannot strand the audit row; processed
  and ignored events are never re-applied. Structured `[payments]` events carry only
  allowlisted identifiers and classifications. **Unresolved, documented risks:** a database read compromise exposes
  the API-key hash and RPC-secret hash that the anon RPCs accept as bearer values (a
  service-role/asymmetric-proof redesign is required; re-hashing with a pepper would not
  close it); the authenticated Phase 5 `claim`/`settle` RPCs still allow an owner to
  misrepresent their own deployment readiness (self-only; documented in Phase 5); webhook
  writes have no shared rate limit on purpose so provider retries are not dropped; there
  is no platform-wide database backup/restore implementation in this repository (source
  snapshots/restores are implemented; Supabase/provider backups are external). See
  `docs/architecture/phase-7-production-hardening.md` and
  `docs/runbooks/production-hardening.md`.
- **Agent memory is implemented but off by default (Phase 8).** It is enabled only by
  `MAVLY_AGENT_MEMORY_ENABLED` plus an explicit `MAVLY_AGENT_MEMORY_PROJECTS` cohort and
  migration 24. There is **no vector database and no extra model call**: retrieval is
  deterministic over a small relational table. **Repository facts are derived from the
  current files on every run**, never stored, so they cannot go stale. **Persistent memory
  has two categories only:** an explicit user-approved `decision` (created through the
  authenticated workspace API/panel; the authenticated role may not create/update a
  failure) and an observed terminal `failure` note written by the server after a
  failed/dead-lettered run, expiring after 30 days. AI inferences are never promoted to
  decisions automatically. At generation start Mavly selects a bounded relevant-file set
  (40 files; manifests/entries/API routes/prompt matches/one-hop imports), derives compact
  facts, ranks active approved memory (12 items / 8,000 chars) and places it in a block
  explicitly marked as **context, not instructions**; current files, repository rules and
  the current user request outrank it. The planner also records an optional 2,000-character
  implementation plan (persisted with the manifest, no second model call). Failure notes
  are deduplicated per run, contain only a bounded error class, and explicitly do not claim
  a root cause. Memory is project-scoped through `projects` RLS; secrets, credentials,
  connection strings and contact data are rejected before storage. Failure notes are
  written only after a terminal run: the worker writes with its confined service client
  after re-verifying the owner, and an inline run uses an owner-checked RPC that derives
  the note from the run row and accepts no content. With the flag off, persistent
  memory, retrieval selection and plan requests are disabled and generation uses the
  existing full-file context/provider pipeline; the fixed system prompt still marks
  repository content as untrusted data. The memory panel provides real list/add/edit/approve/reject/
  archive/delete/clear controls. **Unverified:** migration 24, RLS, real retrieval and the
  UI have not been exercised live; no benchmark claims are made. See
  `docs/architecture/phase-8-agent-memory.md` and `docs/runbooks/agent-memory.md`.
- **Multi-agent orchestration is implemented but off by default (Phase 10).** It is
  enabled only by `MAVLY_MULTI_AGENT_ENABLED` plus an explicit
  `MAVLY_MULTI_AGENT_PROJECTS` cohort, a fully configured durable generation worker
  (migration 16), `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `OPENROUTER_API_KEY`, migrations 29 and 31. It runs **only for worker-dispatched runs**;
  inline `after()` runs and projects outside the cohort keep the existing pipeline and
  record no workflow. The durable `project_runs` row remains the only job/lease and
  `generateApp` remains the only writer of `project_files`: the orchestrator adds a
  1:1 `agent_workflows` record, dependency-aware `agent_tasks` and a bounded
  `agent_workflow_events` audit trail. Role IDs are pinned in
  `src/lib/ai/model-roles.ts` to the finalized product mapping: Planner and Repair
  `deepseek/deepseek-v4-pro`, UI/UX, Coding and Security `anthropic/claude-sonnet-5`,
  QA `openai/gpt-5.6-sol`, Deployment deterministic. All of them are catalog entries
  with no environment override and no implicit fallback: a role whose pinned id is
  rejected fails with its exact id instead of being substituted. **Configured is not
  verified.** Only DeepSeek V4.1 Flash and the cohort-gated Cohere North Mini Code are
  `verified: true`; the three specialist ids are `verified: false` until an operator
  confirms them against the deployment's OpenRouter account, and `roleModelStatus`
  reports the two facts separately. Coding still delegates to the
  existing generation engine; QA adds a bounded advisory source
  review while the existing verification sandbox alone can report build/runtime
  checks; Security combines a bounded advisory review with the deterministic static
  scan. Repair suggestions are passed only as subordinate context to the existing
  coding engine on a durable retry and never write source directly. Deployment
  remains deterministic and can only record a proposal. Specialist attempts record
  provider tokens, request ids and reported cost through migrations 31/32; unknown cost
  stays unknown and no credit-price or settlement rules change. Role failures are
  reflected in workflow/task state and never turn into fabricated passes. The workflow
  projection is owner-readable through the existing authorized `agent/workflow`
  routes and the workspace's **Agents & approvals** panel. QA and Security reviews run
  after the `project_runs` row is marked done: their failure
  can fail the workflow record but cannot change that run's terminal state or trigger a
  retry. Only a separate eligible generation retry may receive the Repair role's
  subordinate suggestions. **The deployment approval
  gate is separate and server-enforced** (`MAVLY_DEPLOYMENT_APPROVAL_REQUIRED`, or
  automatically for a multi-agent cohort project): a publish without an owner-approved,
  unexpired, single-use proposal bound to the exact server-derived snapshot/target/
  source hash is refused with `428 DEPLOYMENT_APPROVAL_REQUIRED`; the consume RPC is
  atomic and burns the approval before any provider mutation. No model, QA result or
  security scan approves anything, and nothing auto-deploys or auto-merges. With the
  flag off, generation, publishing and verification are unchanged; the gate is also a
  no-op unless explicitly enabled. **Unverified:** migration 29, its RLS/RPCs, a live
  workflow, real OpenRouter planning calls, the panel and the approval gate have not
  been exercised live. See `docs/architecture/phase-10-multi-agent-orchestration.md`
  and `docs/runbooks/multi-agent-orchestration.md`.
- **The credit foundation is implemented but OFF BY DEFAULT (Phase 11).** It is
  enabled only when `MAVLY_CREDITS_ENABLED` is truthy, an explicit
  `MAVLY_CREDITS_PROJECTS` cohort exists and `MAVLY_CREDITS_GENERATION_COST` is a whole
  number between 1 and 100000, the project is in the credit cohort, and a service-managed
  `credit_project_policies` row matches the project and fixed cost. Credits are whole
  `bigint` units; USD uses `numeric(20,9)`. The service-role-only
  `create_generation_job_with_credits` RPC calls the existing `create_generation_job`
  and takes the hold in the SAME transaction, so an insufficient balance raises and rolls
  the job back. An enabled database policy blocks authenticated legacy create/resume calls
  and permits service-role insert/resume only through the transaction-local markers set
  by the credit-aware RPCs. Migration 32's trigger settles completed runs and releases
  terminal failed/cancelled runs atomically with the terminal run update; owner
  reconciliation settles successes only. A resume re-holds only after a release, and a duplicate resume of an
  active run is refused instead of starting or charging a second execution. A hold whose
  run row was deleted (a deleted project cascades its runs) is released by the worker
  sweep's bounded orphan pass, and the launch path releases the hold before deleting a
  project it just created. The workspace sends a stable `clientRequestId` per launch, and
  the wrapper rejects a reused key with a different prompt/model as a conflict. The
  `credit_ledger` is append-only (a trigger rejects UPDATE/DELETE) and reconciles to the
  cached account (`sum(amount) = balance`, `sum(reserved_delta) = reserved`).
  Authenticated users have SELECT only; admission/resume/release/failure-cancellation,
  grants/refunds, role usage writes and worker sweep are service-role only. **There is no
  Mavly credit-funding flow** — credits exist only
  through the service-role `grant_credits` RPC, so enabling enforcement before funding
  refuses generation with `402 INSUFFICIENT_CREDITS`. Per-attempt usage is derived from
  the   server-written run row or durable provider-attempt RPC; actual cost is provider-reported only, and estimated cost
  is NULL unless an operator installs a row in `ai_cost_rates`. A timeout/network
  failure stays `uncertain`, never zero. **Unverified:** migrations 31/32, their RLS/RPCs,
  live settlement and the workspace balance indicator. See
  `docs/architecture/phase-11-credit-foundation.md` and `docs/runbooks/credits.md`.
- **Restore points are implemented.** Every completed AI execution that changes the
  project's source leaves a durable snapshot (`project_snapshots` +
  `project_snapshot_files`). The chat renders a **Restore Code** action on that execution,
  and `POST /api/vcaas/projects/{id}/snapshots/{snapshotId}/restore` puts the project back
  to the state from BEFORE the run. The restore captures the pre-restore state first, so a
  restore is itself recoverable. It needs no GitHub connection.
- **Planning-driven website imagery is implemented but OFF BY DEFAULT (migration 33).**
  The planner returns a structured `images` plan inside its existing plan JSON
  (`siteType` + a bounded array); `src/lib/images/manifest.ts` validates every field and
  `approveImagePlan` decides — deterministically, from backend policy only — how many
  assets are paid for. The planner can never raise the ceiling: `MAVLY_IMAGE_MAX_ASSETS`
  (default 40, clamped 1..40), `MAVLY_IMAGE_MAX_RUN_COST_USD` (default 0.30, clamped
  0..1) and an explicit `MAVLY_IMAGE_LARGE_CATALOG_PROJECTS` cohort (80 assets, catalog
  site type required) are the only sources of authority. Assets past the ceiling are
  DEFERRED and named, never silently dropped and never reported ready. The stage runs
  inside the existing durable run (`runImageStage` in `src/lib/images/service.ts`) between
  the persisted plan and the first code batch, is bounded by its own slice of the run
  deadline, and marks an asset `ready` only after the provider bytes were validated
  (PNG/JPEG signature, size), uploaded to the `project-images` Storage bucket and written
  through `complete_image_asset`. Each asset is CLAIMED in the database before the paid
  call, so a retried run, a second worker or a concurrent resume cannot generate it twice;
  a resumed run reuses finished rows and the coding prompt lists ONLY persisted URLs.
  Every attempt records provider cost with `cost_known`; a timeout stays `uncertain` with
  a NULL cost, never zero. **There is no image credit price and no credit reservation,
  charge, refund or settlement for images** — provider spend is provider spend, and the
  Phase 11 credit foundation still prices generation runs only. The model is locked to
  `recraft/recraft-v4.1-flash` through OpenRouter's dedicated image API with no fallback;
  `MAVLY_IMAGE_MODEL` is a selector over the one-entry catalog, and an unregistered value
  resolves to that model rather than being forwarded. No UI surface calls the image stage:
  it is a generation-path feature, and the standalone unbilled
  `POST /api/vcaas/projects/{id}/images/generate` route remains (it returns bytes to the
  caller, persists nothing, and has no UI caller). Reference images are not supported and
  a URL-only provider response is refused rather than fetched. The standalone route keeps
  its best-effort per-instance admission window (5 per user / 40 per instance per 10
  minutes) and its 3 MB response cap; the plan-driven stage is bounded by its own count,
  spend, concurrency, attempt and deadline limits instead.
- **Live runtime previews are implemented but OFF BY DEFAULT (Phase 13).** For an
  existing **React + Vite** website project, Mavly can materialize the authoritative
  `project_files` into an isolated **E2B** sandbox, run `npm ci|install --ignore-scripts`,
  start the installed Vite binary with fixed arguments and a validated port, and mark the
  session `ready` only after a server-side request to the provider's preview host returns
  2xx/3xx. Enabled by `MAVLY_RUNTIME_SANDBOX_ENABLED` plus server-only
  `E2B_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL` and migration 34. It is global: there
  is no per-project allowlist, and `MAVLY_RUNTIME_SANDBOX_PROJECTS` is only an
  optional temporary restriction (empty or `*` means every eligible project). The
  framework detector, project ownership/RLS and the resource limits are the actual
  gates. The pinned SDK is `e2b@2.62.0`, loaded
  lazily behind the typed adapter in `src/lib/runtime-sandbox/`. One durable
  `project_runtime_sandboxes` row per project (partial unique index + advisory lock) makes
  concurrent starts reuse one sandbox; a ready row with the same source hash is reused, an
  explicit Restart stops and rebuilds, Stop is idempotent, and provider/lifetime expiry is
  reconciled on read and by the worker's bounded sweep. The sandbox never writes back to
  `project_files`; only `generateApp` does. Generated lifecycle scripts never run, package
  scripts are never executed, browser input cannot supply a command/path/port/env, log
  output is bounded and redacted, and egress is denied after install. The preview URL is
  validated on write **and on every read** against `https://<label>.e2b.app`; the iframe
  has no top navigation, downloads or Mavly origin. **The preview host is public by URL
  unless the provider project is configured otherwise — Mavly does not proxy it, so a
  private preview is not claimed.** QA and Security read the durable row only when
  `MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE` is on, and a running dev server is never a build,
  a QA pass or a deployment authorization; the separate owner-triggered
  `vite build` requires `MAVLY_RUNTIME_SANDBOX_QA_BUILD`. Repair receives the recorded
  failure as subordinate coding context; source changes still flow through
  `generateApp`. Unsupported frameworks (Next.js/Android/anything else) keep the static
  preview and fail closed with the exact reason; Mavly's own generated websites are
  Next.js App Router, so they are not eligible for this React + Vite runtime.
  **Unverified:** no real E2B sandbox,
  npm install, Vite server, readiness probe, build, migration 34 or workspace render has
  been exercised. See `docs/architecture/phase-13-live-runtime-preview.md` and
  `docs/runbooks/runtime-sandbox.md`.
- **The GitHub integration is implemented** as a GitHub App used with user-to-server
  tokens: OAuth start, callback, status, repository/branch discovery, connect, disconnect,
  push and import under `/api/integrations/github/`; callback at `/auth/github/callback`.
  Tokens are AES-256-GCM ciphertext in `github_connections`; the project↔repository link
  lives in `github_repository_connections`. An existing repository connects only to a
  branch GitHub reports. An empty repository (no commits) connects to an intended branch
  name, marked `first_push_pending`; the first successful push creates that branch and
  first commit through the Git Data API, and import stays disabled until it exists. Mavly
  never creates an empty placeholder commit. The integration is opt-in: without
  `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_OAUTH_REDIRECT_URI` the
  routes answer a truthful `503` and the rest of Mavly is unaffected.
- **The Figma integration is implemented** with a user-owned personal access token
  (`current_user:read`, `file_content:read`). The token is checked against `GET /v1/me`,
  encrypted with `MAVLY_INTEGRATION_ENCRYPTION_KEY`, and stored per project in
  `figma_connections` (migration `08`). Status/connect/disconnect are under
  `…/projects/{id}/figma/*`; validate is account-level at `/api/vcaas/figma/validate`.
  When a prompt contains a Figma link, `run-agent.ts` reads the selected frame through
  `src/lib/integrations/figma/*` and injects a bounded text summary into generation. A
  file-level link is accepted only when the file has exactly one top-level design; otherwise
  the run fails with an actionable request for a “Copy link to selection” frame link. The
  stored token is never returned to the browser, never reaches the model, and is never
  logged.
- **Project secrets are implemented as write-only encrypted storage.** Create, list
  (metadata only), update/replace and delete live under
  `…/projects/{id}/secrets[/{secretId}]`. Values are AES-256-GCM ciphertext in
  `project_secrets` (migration `11`), encrypted with the server-only
  `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY`; the authenticated role has no SELECT grant on
  `value_ciphertext`. Listing never returns a value or ciphertext, and no reveal endpoint
  exists. **Secrets are not injected into generated sites**: the preview and published
  output are static, generated server code is not executed, and the UI says so. Do not
  claim generated apps can read saved secrets until a real server-side injection path and
  tests exist.
- Anything not implemented (uploads, rebuild, production dynamic hosting beyond the
  opt-in React + Vite live preview, domains, versions, usage, visual-edit apply, Android
  release signing/AAB/store publishing, …)
  still authenticates and authorizes, then returns:

  ```json
  {
    "ok": false,
    "error": "The Mavly backend is not implemented yet.",
    "code": "BACKEND_NOT_CONFIGURED",
    "data": null
  }
  ```

  with HTTP **503** and `cache-control: private, no-store, max-age=0`.
- `/api/config` keeps returning `{ "ok": true, "data": { "configured": false } }`.
- No route may fabricate success, mint a fake project id, return mock data, or report an
  operation as complete when no backend performed it.
- Generated code is **never executed** on the Mavly server. The only execution anywhere is
  the opt-in verification sandbox's build inside an isolated Vercel microVM, which is off
  by default and never runs on a Mavly host. Otherwise the preview is a static entry point:
  the generated `preview.html`, or an imported
  `index.html` / `public/index.html` with its local assets. Backend endpoints exist only as
  source in the project files. Publishing uploads those static bytes; it does not build
  generated or imported source. A framework entry point that needs a build is reported as
  unsupported, not shown as a blank success.
- `OPENROUTER_API_KEY` is server-only and is required by the Vercel/Next.js generation
  runtime for website and Android source generation; it also serves image generation. No
  Supabase Edge Function or worker reads it. `MAVLY_DEFAULT_MODEL` may select only a model
  in the OpenRouter catalog; an unsupported override is ignored rather than forwarded.
  `MAVLY_IMAGE_MODEL` is a selector over the separate image catalog, whose single entry
  is `recraft/recraft-v4.1-flash`; any value that is not a catalog entry resolves to that
  model and is never forwarded. There is no second image model and no fallback.
  `VERCEL_API_TOKEN` is also server-only and is never stored in the database or returned
  to a browser.
- Obsolete operator secrets (`TOTALUM_VCAAS_API_KEY`, `VCAAS_API_KEY`, `TOTALUM_API_URL`)
  are not read. Their revocation/removal is a manual operator task; do not print, copy,
  commit, or request their values.

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
   │      ├── src/lib/mavly/run-agent.ts inline run after the response, or worker run
   │      │      └── src/lib/ai/agent.ts → src/lib/ai/provider.ts → src/lib/ai/openrouter.ts
   │      └── src/lib/deployments/*      opt-in static publish/unpublish
   │             ├── store.ts            project_deployments (RLS)
   │             └── service.ts → src/lib/vercel/provider.ts → api.vercel.com
   ├── AWS EC2 Background Worker    systemd Node process → service-role worker tick
   │      ├── workers/aws-generation-worker.ts → src/lib/generation/worker.ts
   │      └── run-agent → OpenRouter + durable checkpoints
   ├── Render Background Worker    preserved, disabled future fallback
   │      └── workers/render-generation-worker.ts → src/lib/generation/worker.ts
   ├── /api/app/v1/apps/{id}/data|auth/*  public, project id + end-user session
   │      └── src/lib/app-data/gateway.ts → parameterized SQL → customer Neon database
   ├── /api/app/v1/payments/*      public, project API key (integrations:*) → Razorpay
   ├── /api/integrations/webhooks/razorpay/{token}
   │                               public, token + signed raw body → payment state
   ├── /api/vcaas/source-code/{id} auth + ownership → ZIP from project_files
   ├── /api/preview/{id}/…         auth + ownership → sandboxed static site
   ├── /api/runtime/{id}           auth + ownership → opt-in E2B live Vite preview
   ├── /api/vcaas/upload|env|git-diff
   │                               auth + ownership → 503
   ├── /api/visual-edit/.../apply  auth + ownership → 503
   ├── /api/vcaas/backup-download  auth + ownership → 503
   └── /api/config                 200 { configured: false }
```

The client catalog in `src/lib/vcaas.ts` may keep its endpoint-shaped functions; components
must call through it rather than hardcoding `/api/...` paths. The catch-all classifies
paths with `src/lib/vcaas-scope.ts`, so unknown shapes are refused before any work.

### Key files

| File | Responsibility |
|---|---|
| `src/proxy.ts` | Supabase session refresh; redirects signed-out visitors away from `/dashboard` and `/project/*`; JSON 401 for unauthenticated `/api/*`. Also the CORS/CSP boundary. |
| `src/lib/supabase/` | Browser, server and proxy Supabase clients. `getCurrentUser()` is the authoritative session check. |
| `src/lib/auth/` | Destination validation, OAuth start, callback decision, error copy. |
| `src/app/auth/callback/route.ts` | OAuth code → session exchange. |
| `src/app/api/vcaas/_shared.ts` | `resolveVcaasContext`, `checkProjectAccess`, `authorizeProjectRequest`, `enforceProjectScope`, `backendNotConfigured`. |
| `src/lib/vcaas-scope.ts` | Path allowlist, body/query identity conflicts, path classification. |
| `src/app/api/vcaas/[...path]/route.ts` | Auth → scope → ownership → `handleMavlyVcaasRequest` or 503. |
| `src/lib/mavly/api.ts` | Implemented project/agent/file handlers and response mapping. |
| `src/lib/mavly/store.ts` | Project, file, message and run persistence through the caller's client. |
| `src/lib/mavly/run-agent.ts` | Generation execution in both modes: inline claim, or worker execution under a fenced lease; baseline → checkpointed atomic batches → complete/fail/retry; cooperative cancellation. |
| `src/lib/generation/state-machine.ts` | Pure stage set/transitions and conservative failure classification with redaction. |
| `src/lib/generation/leases.ts` | Lease bounds, retry backoff and worker-id sanitation. |
| `src/lib/generation/worker-config.ts` | Platform credential readiness and production/local admission dispatch mode. |
| `src/lib/generation/verification.ts` | Claim parsing plus owner re-verification for the service-role worker. |
| `src/lib/generation/worker.ts` | One bounded worker tick: preflight → recover → claim → verify → execute → renew. |
| `workers/aws-generation-worker.ts`, `infra/aws-generation-worker/mavly-aws-worker.service` | AWS EC2 process entrypoint and systemd unit; reuses the existing queue worker. |
| `workers/render-generation-worker.ts`, `render.yaml` | Preserved Render fallback; `MAVLY_RENDER_WORKER_DISABLED=true` prevents it from polling. |
| `workers/generation-scheduler.ts`, `wrangler.jsonc` | Retained legacy Cloudflare Cron with `MAVLY_CLOUDFLARE_WORKER_DISABLED=true`; scheduler no-ops before a worker tick. |
| `workers/register-node-ts-resolver.mjs`, `workers/node-ts-resolver.mjs` | Node resolver hook for native TypeScript execution and source `@/` aliases in the standalone worker process. |
| `src/lib/supabase/worker.ts` | The confined service-role client factory (scheduled worker, credit accounting, and owner-checked Android artifact download only). |
| `src/lib/observability/` | Correlation ids, structured generation events, redaction and reported-cost accounting. |
| `src/lib/runtime/` | Generated-project runtime detection (App Router only), package-manifest validation, the bounded `next build` plan and the fixed loopback runtime start. |
| `src/lib/sandbox/adapter.ts` | Provider-neutral verification adapter contract: create, upload, execute, poll, destroy, reconnect, with typed failures. |
| `src/lib/sandbox/vercel-sandbox.ts` | The only real provider: Vercel Sandbox microVM, file upload, detached commands, bounded logs and destruction. |
| `src/lib/sandbox/policy.ts` | Pure verification policy: snapshot manifest, path/secret/hash validation, script safety, fixed runtime/health commands, egress and diagnostics redaction. |
| `src/lib/sandbox/state.ts` | Public verification result model, stage/status transitions, build/runtime/health/preview/repair fields, budgets and timeout/error helpers. |
| `src/lib/sandbox/config.ts` | Opt-in verification and repair prerequisites, provider selection, cohort parsing and the database preflight. |
| `src/lib/sandbox/store.ts` | Fenced verification persistence through the worker's service-role client. |
| `src/lib/sandbox/enqueue.ts` | Idempotent enqueue after a worker run completes with a ready, hash-matching snapshot. |
| `src/lib/sandbox/repair.ts` | Bounded repair policy: eligible failures, context selection, protected-path refusal, response parsing, merge bounds and one provider call. |
| `src/lib/sandbox/verification.ts` | One bounded verification tick: recover → clean up → claim → install/build/runtime/health or repair → finalize → destroy. |
| `supabase/migrations/17_verification_sandbox.sql` | Verification table, leases, fenced completion, recovery, orphan cleanup, owner cancellation and schema marker 17. |
| `supabase/migrations/19_runtime_verification.sql` | Build/runtime/health/preview/repair state, the runtime-enforced `passed` rule, repair attempts, repairable supersession and schema marker 19. Additive; apply after 17. |
| `docs/architecture/phase-3-verification-sandbox.md` | Phase 3 build-only baseline, provider decision and rollout. |
| `docs/architecture/phase-4-runtime-verification.md` | Phase 4 runtime/health verification, preview security contract, bounded repair, budgets and rollout. |
| `docs/runbooks/verification-sandbox.md` | Operator validation, alerting, pause/drain, rollback and capacity runbook. |
| `src/lib/runtime-sandbox/types.ts` | Phase 13 shared, client-safe lifecycle vocabulary, the only legal transition table, the typed provider contract and the owner-visible session/status/evidence views. |
| `src/lib/runtime-sandbox/config.ts` | Off-by-default live-runtime prerequisites, bounded limits, global-by-default project eligibility (optional restriction list) and the exact capability problem. Pure parse. |
| `src/lib/runtime-sandbox/policy.ts` | React + Vite detection from persisted files, the fixed install/dev/build commands, provider-preview-host validation and bounded/redacted terminal output. Pure. |
| `src/lib/runtime-sandbox/paths.ts` | Materialization policy: relative-path safety, secret/runtime exclusions, file/byte limits, stale-path removal and required-file checks. Pure. |
| `src/lib/runtime-sandbox/e2b-provider.ts`, `provider.ts` | The only E2B SDK adapter (`e2b@2.62.0`) behind the typed surface, and the lazy factory that returns `null` unless configured. |
| `src/lib/runtime-sandbox/store.ts` | Migration-34 RPC wrappers, row normalization and read-time preview-URL re-validation; caller-scoped client only. |
| `src/lib/runtime-sandbox/service.ts` | One bounded lifecycle: status/reconcile → begin/reuse → sync → install → deny egress → start → readiness → ready; idempotent stop, owner log refresh, approved build and service-role expiry sweep. |
| `src/lib/runtime-sandbox/evidence.ts` | Pure mapping from a durable runtime row to explicit install/dev-server/readiness/build checks and the subordinate QA/Security/Repair blocks. |
| `src/app/api/runtime/[projectId]/route.ts` | Authenticated live-preview route: ownership check, status-only GET, and the fixed `start`/`restart`/`stop`/`build` actions. |
| `src/components/workspace/LiveRuntimePreview.tsx` | Workspace live-preview surface with truthful states, start/restart/stop, logs and the opt-in build; the static preview stays mounted as fallback. |
| `src/lib/generation/dispatch.ts` | Pure inline→worker hand-off decision: which runs may leave the inline path, and the exact reason every other one may not. |
| `supabase/migrations/36_generation_worker_handoff.sql` | `handoff_generation_job` — owner-checked, claim-fenced, once-only move of a LIVE inline run to `retry_wait`/worker, refused without a persisted manifest and a verified checkpoint. Additive; apply after 16. |
| `src/lib/verification/static.ts` | Stages A/B of verification: required files, non-empty contents, package manifest, balanced source delimiters, local import resolution and the preview document. Pure; `compiled`/`rendered`/`verified` are always false. |
| `supabase/migrations/34_runtime_sandboxes.sql` | Runtime sandbox lifecycle table, active-session uniqueness, database transition table, owner-checked begin/update/stop RPCs, service-role expiry sweep, SELECT-only RLS and schema marker 34. Additive; apply after 33. |
| `docs/architecture/phase-13-live-runtime-preview.md`, `docs/runbooks/runtime-sandbox.md` | Phase 13 design, authority, security model, residuals and the operator enable/smoke/rollback runbook. |
| `supabase/migrations/16_durable_generation_worker.sql` | Queue columns/constraints/indexes, claim/lease/retry/recovery/resume RPCs, least-privilege grants and the worker schema marker. |
| `docs/runbooks/aws-generation-worker.md` | AWS worker deployment, shutdown/rollback, Cloudflare deactivation and preserved Render fallback runbook. |
| `docs/runbooks/render-generation-worker.md` | Historical Render worker operations; use only when deliberately reactivating the fallback. |
| `docs/runbooks/generation-worker.md` | Historical Cloudflare Cron runbook; do not use for current deployment. |
| `src/lib/ai/retry.ts` | Bounded exponential retry, jitter and `Retry-After` parsing. |
| `src/lib/ai/budget.ts` | Pure run-deadline policy: finalization reserve, per-attempt planning from the time actually left, the minimum useful attempt, the capped reserve for work still queued (`reserveForPendingWork`) and the reserve that keeps every queued group's own minimum (`reserveForPendingFloors`). A batch group's minimum scales with its own estimated bytes (`batchAttemptFloorMs` / `batchGroupFloorFor` in `src/lib/ai/agent.ts`), so a single small file gets a usable window instead of the full-batch 60 s floor, and the one deadline is reserved for the groups that still need it rather than letting the first consume it. |
| `docs/architecture/generation-reliability.md` | Static audit of the generation pipeline: which of the seven roles really execute, the budget/timeout and parse-recovery defects that were found and fixed, and what remains unverified (nothing was executed to produce it). |
| `src/lib/preview-document.ts` | Pure structural check that a generated `preview.html` is a complete document before it can be persisted. |
| `src/lib/preview-status.ts` | Pure `ready`/`stale`/`incomplete`/`unavailable`/`none` preview state and generation state derived from saved files plus the durable run. |
| `src/lib/mavly/checkpoints.ts` | Pure verification of resumed batch hashes. |
| `supabase/migrations/10_generation_jobs.sql` | Run lifecycle columns, batch checkpoints, admission RPC and RLS. |
| `src/lib/mavly/snapshots.ts` | Restore points: create, list, read, and the content hash of a source state. |
| `src/lib/mavly/restore.ts` | Restoring a source state, with the pre-restore recovery point and the stale-restore check. |
| `src/lib/integrations/github/` | The GitHub App client: config, encryption, OAuth, the Git database API, the file policy, the store, the service. |
| `src/lib/integrations/figma/` | The Figma PAT client: config, encryption, token store, `/v1/me` validation, frame reading, file-link resolution and the agent's bounded design context. |
| `src/lib/project-secrets/` | Server-only write-only secret storage: validation, AES-256-GCM with owner/project/row AAD, RLS-scoped CRUD and metadata-only mapping. No value is returned to a route. |
| `supabase/migrations/11_project_secrets.sql` | Encrypted project-secret table, ownership RLS and metadata-only column grants. |
| `src/lib/figma-url.ts` | Pure, host-anchored Figma link parsing shared by the composer and the server. |
| `src/lib/github-client.ts` | The browser's GitHub catalog. It never carries a credential. |
| `src/lib/ai/agent.ts` | Profile-aware prompt, JSON parsing/repair, path and size validation, and final Android contract validation. |
| `src/lib/android/contract.ts` | Pure Kotlin/Compose project contract: required files, package/applicationId consistency, manifest/Gradle policy, forbidden binary/signing/secret paths, Compose entry point and size bounds. |
| `src/lib/android/capability.ts` | Dynamic Android capability: source generation plus cohort/config-gated debug build and artifact availability with the exact blocker. |
| `src/lib/android/build-config.ts` | Off-by-default build prerequisites: cohort, digest-pinned Vercel Container Registry image (external registries refused), bucket, strict vCPUs, provider credentials, service role and Supabase URL, plus the non-fatal `non_default_bucket` warning. |
| `src/lib/android/build-policy.ts` | Pure build policy: snapshot re-validation, fixed offline Gradle command, bounded/redacted logs, APK ZIP/zip-bomb validation and checksum. |
| `src/lib/android/build-worker.ts` | One bounded build tick: recover → clean → claim → create/upload/build → validate APK → private upload → fenced completion; never runs on a Mavly host. |
| `src/lib/android/build-store.ts`, `build-state.ts` | Typed migration-26 RPC wrappers and the shared status/artifact view model. |
| `src/lib/android/artifact-store.ts` | Private Supabase Storage upload, delete and short-lived signed URL; object keys are server-derived. |
| `src/lib/sandbox/vercel-sandbox.ts` | Adds custom image/vCPU purpose tags and bounded sandbox file reads for the Android artifact path. |
| `supabase/migrations/26_android_builds.sql` | Durable Android build table, fenced lifecycle/recovery/cleanup RPCs, retention state, owner column grants, schema marker 26 and the private artifact bucket. |
| `infra/android-build/` | Reproducible `android-debug-v1` image definition (digest-pinned base, checksum-verified JDK 17/Gradle 8.9/command-line tools, SDK 35 + `aapt`, seed-warmed offline Gradle cache), the seed project, pin templates, and `build.sh`/`verify.sh`/`publish.sh`. The repository never builds or publishes the image. |
| `docs/architecture/phase-9-android.md`, `docs/runbooks/android.md` | Phase 9 Android profile, validation, isolation, artifact lifecycle, capability matrix, security boundaries and rollout. |
| `src/lib/ai/image-models.ts` | The one-entry image-model catalog (locked `recraft/recraft-v4.1-flash`, its verified aspect-ratio enum and $0.007/image price) and image-request validation, kept apart from the text catalog. |
| `src/lib/ai/openrouter-images.ts` | The separate OpenRouter image API client: response validation, size cap, bounded retry, server-only key. |
| `src/lib/images/policy.ts` | Backend-owned image plan policy: site-type guidance, the effective asset ceiling, the large-catalog cohort, spend ceiling, concurrency/timeout/attempt bounds and the stage's deadline slice. Pure. |
| `src/lib/images/manifest.ts` | The typed image plan: validation of the planner's `images` array (ids, paths, ratios, placements, bounds) and deterministic approval of required-first assets within the count and spend ceilings. Pure. |
| `src/lib/images/prompt.ts` | Server-authored planner addendum and the coding block that lists only persisted asset URLs, names unavailable placements, and keeps `preview.html` self-contained. Pure. |
| `src/lib/images/service.ts` | One bounded image stage per run: approve → persist → claim → generate → validate → upload → complete, with truthful partial/uncertain outcomes and cancellation. |
| `src/lib/images/store.ts` | Typed wrappers for migration 33's owner-checked RPCs and the run's asset rows; no service-role client is created here. |
| `src/lib/images/asset-store.ts` | Server-derived Storage path, public URL and bounded upload for generated imagery. |
| `supabase/migrations/33_project_image_assets.sql` | Image plan/asset tables, owner-checked sync/claim/complete/fail/finish RPCs, column grants, schema marker 33 and the `project-images` bucket. Additive; apply after 32 and 03. |
| `docs/architecture/phase-12-image-planning.md` | Phase 12 design: authority model, plan schema, budgets, execution/idempotency, storage, rollout and what is (not) verified. |
| `src/lib/ai/chat-contract.ts` | Provider-neutral chat-completions contract used by OpenRouter: result types, response parsing and failure classification. Pure. |
| `src/lib/ai/openrouter.ts` | The OpenRouter chat-completions call for website/Android generation and its catalog gate; server-only key, redacted failures. |
| `src/lib/mavly/image-limits.ts` | Best-effort per-user/per-instance image-generation admission windows. |
| `src/lib/ai/provider.ts` | The fixed OpenRouter boundary for completion calls and configuration errors. |
| `src/lib/ai/models.ts` | OpenRouter model catalog and default-model resolution. |
| `src/lib/managed-backend/config.ts`, `neon.ts`, `crypto.ts` | Off-by-default Neon configuration (including the gateway origin and server-only RPC proof hash), fixed-origin API client, encrypted connection-URI storage. |
| `src/lib/managed-backend/requirement.ts` | Pure backend-requirement policy: static products never provision; a missing data model blocks provisioning truthfully. |
| `src/lib/managed-backend/lifecycle.ts`, `status.ts`, `prompt.ts` | The only lifecycle/transition vocabulary, the capability projection used by `agent/status`, and the server-authored data API contract placed in the coding prompt. |
| `src/lib/managed-backend/model.ts` | Validation of the planner's `dataModel`: bounded tables/columns, closed type allowlist, reserved names, declarative resources and ownership. |
| `src/lib/managed-backend/migrations.ts`, `runner.ts` | Deterministic additive SQL compiler, plus the bounded ledgered runner that applies steps under an advisory lock and verifies the schema read-back. |
| `src/lib/managed-backend/service.ts`, `store.ts` | Provision/reconcile → configure → verify orchestration, fenced migration-35 RPC wrappers and the owner status read. |
| `src/lib/app-data/` | Generated-app data gateway: scrypt/hashed-session auth primitives, parameterized CRUD query builder, app resolution, durable rate admission, CORS policy and the auth/CRUD handlers. |
| `src/app/api/app/v1/apps/[projectId]/` | The public, self-authenticating data and end-user auth routes for a generated app. |
| `supabase/migrations/35_managed_backend_runtime.sql` | Configuration lifecycle, verified-schema/gateway columns, sanitized migration mirror, fenced configuration RPCs, data-gateway context, durable rate windows and schema marker 35. Additive; apply after 34 and 30. |
| `docs/architecture/phase-14-managed-backend-runtime.md`, `docs/runbooks/managed-backends.md` | Phase 14 design, authority, security residuals, blocked runtime dependency and the operator enable/smoke/rollback runbook. |
| `supabase/migrations/30_managed_backends.sql` | Owner-readable Neon lifecycle metadata, service-role-only provisioning RPCs, encrypted-URI column grants and a fenced per-project provisioning claim. It does not apply generated application SQL. |
| `src/lib/credits/config.ts` | Opt-in flag/cohort/fixed whole-credit cost; a half-configured deployment charges nothing and reports the exact problem. |
| `src/lib/credits/state.ts` | Pure balance, settle/release eligibility, resume and insufficient-credits rules. |
| `src/lib/credits/store.ts` | Typed wrappers for the credit RPCs; fail-closed error mapping; no fabricated balance. |
| `src/lib/credits/service.ts` | Credit snapshot, owner reconciliation and worker recovery sweep; terminal accounting is database-atomic. |
| `supabase/migrations/31_credit_foundation.sql` | Accounts, append-only ledger, reservations, service-managed cohort/cost policies, per-attempt usage, service-role credit admission/resume/release/terminal RPCs, successful owner reconciliation and worker sweep. Additive; apply after 30. |
| `supabase/migrations/32_credit_reliability_hardening.sql` | Consistent admission/policy lock order, atomic terminal reservation settlement/release, service-only durable provider-attempt tracking, tightened usage RPC grants and schema marker 32. Additive; apply after 31. |
| `src/lib/ai/model-roles.ts` | Per-role model resolution over the verified catalog; deployment is deterministic; unverified overrides are ignored. |
| `docs/architecture/phase-11-credit-foundation.md`, `docs/runbooks/credits.md` | Phase 11 design, invariants, rollout, funding gap and acceptance checklist. |
| `src/lib/mavly-hostname.ts` | Pure derivation of `<project-id>.mavly.xyz` from the immutable, owned project id; refuses reserved labels. |
| `src/lib/tenant-host.ts` | Pure request-host parser and the only way to identify a public tenant. |
| `src/lib/reserved-hostnames.ts` | Mavly-owned host labels, shared by slug creation, publishing, routing and migration 14. |
| `src/lib/hosting/` | Shared hosting: mode/cohort config, immutable version persistence, atomic activation, missing-migration detection, public resolution/serving, publish admission limits, hosting events. |
| `src/lib/deployments/fullstack.ts` | Phase 5 orchestration: verified-snapshot deploy, owner-bound provider targeting, fenced attempt lifecycle, readiness finalization, rollback, takedown and history. |
| `src/lib/hosting/fullstack-config.ts` | Opt-in Phase 5 prerequisites (flag, explicit cohort, Vercel config, secrets key) and the no-silent-downgrade refusal. |
| `src/lib/hosting/fullstack-source.ts` | The join between a PASSED Phase 3/4 verification and the exact deployable snapshot/hash. |
| `src/lib/runtime/deployment-plan.ts` | Pure deployment profile: App Router only, path/size limits, static-export refusal and the deployable hash. |
| `src/lib/hosting/fullstack-store.ts` | Caller-scoped attempts/env/database persistence; the fenced deployment RPCs are the only writers of deployment state. |
| `src/lib/hosting/secret-sync.ts` | Write-only secret write-through to the provider's encrypted env; no value is ever read back, logged or stored in metadata. |
| `src/lib/hosting/database-config.ts`, `database-connectivity.ts`, `fullstack-database.ts` | Application database contract: URL validation, non-secret metadata, and one bounded, DNS-pinned live `select 1` before anything is stored. |
| `src/lib/hosting/deployment-env.ts` | Public/server env classification, reserved names, and the production-secret readiness gate. |
| `supabase/migrations/20_fullstack_hosting.sql` | Deployment lifecycle/attempt/env/database tables, ownership-checked fenced RPCs, column-level grants and schema marker 20. Additive; apply after 19 and 11. |
| `docs/architecture/phase-5-fullstack-hosting.md`, `docs/runbooks/fullstack-hosting.md` | Phase 5 design, readiness contract, security boundaries, rollout, failure handling and live verification checklist. |
| `src/lib/integrations/contracts.ts` | Pure Phase 6 provider catalog: only implemented providers, credential schema, capabilities and webhook events. |
| `src/lib/integrations/config.ts` | Opt-in flag/cohort, the server-only webhook-write RPC hash, and the canonical-origin webhook URL derivation (never from the request Host). |
| `src/lib/integrations/payments/razorpay.ts` | Server-only Razorpay Order/Payment client: fixed origin, timeout, no blind order retry, HMAC checkout/webhook verification and redacted failures. |
| `src/lib/integrations/payments/state.ts` | Pure payment state machine (`paid` never regresses; only `paid` may fulfil) and provider-status mapping. |
| `src/lib/integrations/payments/validation.ts` | Pure order/verify/credential validation; secrets never echoed. |
| `src/lib/integrations/payments/store.ts` | Owner RLS reads and the public anon-client calls to the fenced gateway/webhook RPCs. |
| `src/lib/integrations/payments/service.ts` | Owner save/test/disable/status; encrypted credential upsert and provider test-before-save. |
| `src/lib/integrations/payments/gateway.ts` | Generated-app order/verify/status path: project API key auth, local idempotency, authoritative capture check. |
| `src/lib/integrations/payments/webhooks.ts` | Raw-body webhook verification, event idempotency and the audit-only event record. |
| `src/lib/integrations/rate-limit.ts` | Phase 6's pure per-instance window utility and the documented gateway limit constants; production limits are enforced by migration 23's shared RPC. |
| `src/app/api/app/v1/payments/` | Public generated-app payments API (self-authenticating; the only `/api/app/v1/` exemption). |
| `src/app/api/integrations/webhooks/razorpay/[token]/route.ts` | Public Razorpay webhook receiver (signed raw body; token resolves one integration). |
| `src/components/workspace/v2/ProjectPaymentsIntegration.tsx` | Real Business payments panel: truthful status, test, disable, webhook address and recent orders. |
| `supabase/migrations/21_business_integrations.sql` | Integration metadata, payment and webhook-event tables, owner/gateway/webhook SECURITY DEFINER RPCs, column grants and schema marker 21. Additive; apply after 11 and 12. |
| `supabase/migrations/23_production_hardening.sql` | Durable per-integration payment attempt windows, fixed-limit consume RPC, bounded cleanup, stale-`received` webhook recovery and schema marker 23. Additive; apply after 21 and 22. |
| `src/lib/integrations/payments/event-view.ts` | Pure owner-visible webhook-event metadata projection; never includes the raw body, digest or secret. |
| `src/lib/observability/payments.ts` | Allowlisted, secret-free structured payment diagnostic events. |
| `src/app/adminsh/layout.tsx` | Server-side session + `current_user_is_admin()` gate for every admin page; 404 for non-admins, fail closed on a missing migration. |
| `docs/architecture/phase-6-business-integrations.md`, `docs/runbooks/business-integrations.md` | Phase 6 design, provider setup, security boundaries, rollout and manual acceptance. |
| `docs/architecture/phase-7-production-hardening.md`, `docs/runbooks/production-hardening.md` | Phase 7 threat model, limits, recovery, observability, backup/DR limitations and acceptance. |
| `src/lib/memory/` | Phase 8 memory: types/limits, secret-shape validation, deterministic fact/file/memory retrieval and prompt framing, RLS-scoped store, owner service, terminal outcome summaries, projections and content-free events. |
| `supabase/migrations/24_agent_memory.sql` | Project memory table, decision/failure constraints, owner RLS, revision-based updates, column grants, service-role failure writes and schema marker 24. Additive; apply after 23. |
| `src/components/workspace/v2/ProjectMemoryPanel.tsx` | Real memory controls: derived facts, list, add/edit/approve/reject/archive/delete/clear; disabled and error states are truthful. |
| `docs/architecture/phase-8-agent-memory.md`, `docs/runbooks/agent-memory.md` | Phase 8 memory authority, storage/retrieval, freshness, security, rollout and acceptance. |
| `src/lib/orchestration/contracts.ts`, `workflow.ts` | Phase 10 pure role/task/workflow contracts, explicit transitions, dependency graph, bounded scheduling, complexity classification, budgets, retries and normalized output projection. |
| `src/lib/ai/model-roles.ts` | Fixed role-to-OpenRouter model mapping with no fallback for missing or disabled model entries. |
| `src/lib/orchestration/config.ts`, `roles.ts`, `tools.ts`, `security.ts` | Opt-in cohort/approval configuration, specialist prompts and source-line-validated parsers, the scoped tool registry, and the deterministic static security scan. |
| `src/lib/orchestration/engine.ts` | Worker-only workflow start, pinned specialist calls, per-attempt usage recording, bounded QA/security review, coding markers, repair diagnosis and the truthful workflow projection. |
| `src/lib/credits/store.ts` | Typed wrappers for migrations 31/32 credit and durable provider-attempt RPCs; service-role-only mutation boundary. |
| `src/lib/orchestration/store.ts` | Worker-owned workflow/task/event persistence with compare-and-set transitions, run cancellation/failure helpers and owner cancellation; missing migration is reported, never faked. |
| `src/lib/orchestration/approval.ts`, `approval-store.ts`, `approval-service.ts`, `approval-gate.ts` | Artifact-bound deployment proposals: pure validity rules, owner-scoped SECURITY DEFINER RPC wrappers, service-layer proposal derivation, and the deploy-time atomic consume gate. |
| `src/components/workspace/v2/ProjectWorkflowPanel.tsx` | Agents & approvals panel: truthful workflow/check/finding state, reported cost, proposal create/approve/revoke and deploy-with-approval. |
| `supabase/migrations/29_multi_agent_orchestration.sql` | Workflow/task/event/proposal tables, owner RLS, SELECT-only grants, owner cancellation and proposal lifecycle/consume RPCs, and schema marker 29. Additive; apply after 28 and 16. |
| `docs/architecture/phase-10-multi-agent-orchestration.md`, `docs/runbooks/multi-agent-orchestration.md` | Phase 10 design, role authority, approval semantics, rollout, operator checks and known limitations. |
| `src/app/api/tenant/[[...path]]/route.ts` | The tenant runtime (internal path reached by the validated-host rewrite). |
| `src/lib/api-origin.ts` | Explicit credentialed-origin allowlist and cross-origin mutation policy. |
| `supabase/migrations/14_shared_hosting.sql` | Published versions/files, active-version RPCs, published-only public lookup, RLS and grants. |
| `supabase/migrations/15_shared_hosting_attempt_state.sql` | Status-independent resolver, atomic `activate_shared_publication`, and the `shared_hosting_schema_version` publish preflight. Additive; apply after 14. |
| `src/lib/vercel/` | Server-only opt-in config and the fixed-origin Vercel REST client, including project-domain assignment/verification. |
| `src/lib/deployments/` | Publish/unpublish orchestration, domain gating, provider-failure mapping and RLS-scoped deployment mapping. |
| `supabase/migrations/07_project_deployments.sql` | Deployment mapping table, constraints and ownership RLS. |
| `supabase/migrations/13_deployment_unpublish.sql` | `unpublishing`/`unpublished` statuses and `last_unpublished_at`; additive and non-destructive. |
| `supabase/migrations/09_mavly_deployment_domains.sql` | Mavly hostname/domain state on the deployment mapping, with legacy rows left NULL. |
| `supabase/migrations/08_figma_integration.sql` | Per-project encrypted Figma connection with project-inherited RLS. |
| `src/lib/project-ownership.ts` | Ownership registration helpers, idempotent insert, owned-id filtering. |
| `src/lib/vcaas-errors.ts` | Client error-code vocabulary, including `BACKEND_NOT_CONFIGURED`. |
| `supabase/migrations/` | `profiles`, `projects`, AI builder tables/RLS, Supabase connection/state tables, GitHub/Figma connections, encrypted project secrets, deployment mapping and Mavly domain state, backfill template. |

## Security invariants

1. **A session is verified server-side.** Use `getCurrentUser()` / `resolveVcaasContext()`;
   never infer identity from a cookie's presence, URL, body, or header.
2. **Project access is a row in `public.projects` for `(project_id, user_id)`**, read
   through the caller's RLS-scoped Supabase client. Missing and foreign rows must return
   the same non-enumerating 403. Lookup errors fail closed with 500.
3. **No secret reaches the browser.** Only `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` are public. `OPENROUTER_API_KEY`
   (text generation and images), `VERCEL_API_TOKEN`,
   `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`,
   `SUPABASE_SERVICE_ROLE_KEY`,
   `MAVLY_VERIFICATION_SANDBOX_ENABLED`, `MAVLY_VERIFICATION_REPAIR_ENABLED`,
   `MAVLY_ANDROID_BUILD_ENABLED`, `MAVLY_ANDROID_BUILD_PROJECTS`,
   `MAVLY_ANDROID_BUILD_IMAGE`, `MAVLY_ANDROID_ARTIFACT_BUCKET`,
   `MAVLY_BUSINESS_INTEGRATIONS_ENABLED`,
   `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET`, `NEON_API_KEY`, `E2B_API_KEY`,
   `MAVLY_MANAGED_BACKENDS_RPC_SECRET`,
   `MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY` and the worker's server-only configuration
   are server-only
   and must never be renamed with a `NEXT_PUBLIC_`
   prefix. Razorpay credentials are **never** environment variables on Mavly: they are
   entered per project, encrypted as project secrets, and decrypted only inside the
   owner test or gateway request. Never commit `.env*` files. The service-role client is
   confined to `src/lib/supabase/worker.ts`, the worker orchestrator and trusted
   Render/legacy scheduler entrypoints, the
   verification sandbox tick, the Android build worker, the managed-backend provisioning
   service that receives it from the worker, and the owner-checked Android
   artifact-download handler that mints a short-lived signed URL (it re-reads the build
   row scoped by project); nothing under `components/` or the
   browser catalog may import it. Sandbox provider credentials are used only by the
   server-side adapter and are never uploaded into a sandbox or returned in a build or
   verification result. Android artifact bucket/object keys are service-role only; the
   browser receives only the signed URL and safe metadata.
4. **Any future server route that fetches a client-supplied URL is an SSRF hole until it
   calls `publicUrlRejectionReason` (async, resolves DNS) from `src/lib/safe-url.ts`, with
   `redirect: "error"` and a timeout.** The synchronous `urlRejectionReason` is for IP
   literals only. Both must cover IPv4-mapped IPv6 and every private range. OpenRouter's
   chat-completions and image APIs and the Vercel API use fixed server-side URLs, not
   client-supplied ones.
5. **Never build an upstream URL from decoded route params.** OpenRouter's chat-completions
   and image API origins, and the Vercel API origin, are constant; route params only select a Supabase row after ownership is
   proved, and Vercel ids/names come from that row or server-side derivation. The Mavly
   hostname is derived only from the immutable, owned project id; a browser never supplies
   a hostname.
6. **Generated code is data, not code.** The agent's files are validated (`sanitizeProjectPath`,
   file/total size caps) and stored as text. Never import, transpile, `eval`, or run them
   on a Mavly host. The one exception is the opt-in verification build and its loopback
   runtime/health check, which run only inside a provider-isolated microVM on an immutable,
   manifest-validated snapshot with restricted egress and no project or service
   credentials; there is no local fallback, no public port and no preview URL. Bounded
   repair may produce a new immutable `repair` snapshot, but it never executes on a Mavly
   host and never edits `project_files` directly.
   Android source is likewise data: it is text-validated by
   `src/lib/android/contract.ts` and never built or run on a Mavly host. The only Android
   execution is the opt-in debug build inside the provider microVM (deny-all network, no
   credentials); there is no local fallback and no release-signing or AAB artifact.
   The preview is static HTML served with a CSP `sandbox` and no same-origin privileges.
   Generated website IMAGERY is public website content: it lives in the public-read
   `project-images` bucket at a server-derived, unguessable
   `<project_id>/<run_id>/<asset_key>.<ext>` path (no listing), while the plan and asset
   rows stay owner-only through `projects` RLS. No project file, secret, provider
   credential or APK is ever written to that bucket, and no provider URL is fetched.
7. **OAuth has two traps.** Do not send a custom `state` to Supabase (PKCE owns it), and
   the Mavly sign-in callback URL must be a bare `/auth/callback` with no query string. The
   destination rides in the `mavly_oauth_next` cookie. Keep Supabase's allowed-redirect
   list tight to Mavly sign-in callbacks only.
8. **Integration tokens and project secret values are ciphertext.** AES-256-GCM
   encryption uses `MAVLY_INTEGRATION_ENCRYPTION_KEY` for integration tokens and
   `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` for project secrets; both are server-only, and
   neither may be stored in the database or given a `NEXT_PUBLIC_` prefix. Stored Figma
   access tokens and project secret values/ciphertext must never be returned to the
   browser or written to logs.
9. **Child tables inherit ownership through `projects` RLS.** `project_files`,
   `project_messages`, `project_runs`, `project_deployments`, `figma_connections` and
   `project_secrets` are never queried with a service-role key; their policies require an
   owned parent row. `project_verifications` and
   `project_verification_repairs` are worker-owned: an authenticated user may only SELECT
   their own rows through `projects` RLS and cancel their own run through
   `cancel_verification`; every other mutation, including repair begin/finish, is a
   `service_role`-only RPC. `project_integrations`, `project_integration_payments` and
   `project_integration_events` are SELECT-only for their owner; every write goes through
   an owner or gateway SECURITY DEFINER RPC.10. **Two public API prefixes authenticate themselves.** `/api/app/v1/` carries two
different contracts: `/payments/*` requires a hashed project API key carrying
    `integrations:*` AND the server-only RPC hash on the gateway DB RPCs, and every RPC
    re-checks that the key belongs to the payment order's project; `/apps/{id}/*` (the
    generated-app data API) resolves one `ready` managed backend through the server-only
    managed-backend RPC hash, then authorizes rows by the end user's own session and never
    by a client-supplied user or owner id; `/api/integrations/webhooks/` resolves an
   unguessable per-integration token, requires the server-only
   `MAVLY_BUSINESS_INTEGRATIONS_RPC_SECRET` hash on its write RPCs, and verifies the
   provider HMAC-SHA256 over the **exact raw body before parsing**. Never add a route under either prefix that trusts
   the path. A payment is `paid` only from a verified checkout signature plus an
   authoritative provider read, or from a verified webhook; never from a redirect,
   client claim or amount the client supplied. Raw webhook bodies, provider secrets and
   authorization headers are never logged or stored.
11. **The admin console is gated twice.** The proxy requires a session for `/adminsh/*`,
    and `app/adminsh/layout.tsx` calls `public.current_user_is_admin()` server-side. A
    signed-in non-admin gets 404; a missing migration 18 or an RPC error also fails
    closed. A client-side `setTimeout`, a query parameter or a mock page is never
    authorization. The payment gateway's 30/60 per-minute budgets are fixed in SQL
    (migration 23), not caller-supplied, and are shared across instances; the gateway
    fails closed if the counter RPC is missing. Payment diagnostics and webhook-history
    views are metadata only: no amount, order/payment id, raw body, signature or secret.
12. **Project memory is subordinate context, never authority.** It is project-scoped
    through `projects` RLS; repository facts are derived from current files on every run;
    explicit user decisions and observed failure outcomes are the only stored categories;
    secrets/credentials/connection strings/contact data are rejected before storage; and
    retrieved text is explicitly framed as untrusted data that cannot override repository
    instructions, current files, the current user request, authorization, verification or
    deployment. A client cannot create or promote an observed failure into a decision, and
    memory cannot authorize deployment, payment, database or credential operations. With
    the feature flag/cohort off, generation behavior is unchanged.
13. **Android builds are isolated, snapshot-bound and off by default.** Only a fully
    configured cohort may build. The worker re-verifies the immutable snapshot hash and
    Android contract, runs one fixed offline Gradle task in a provider microVM with
    deny-all network and no credentials, validates the APK archive/package id/size/SHA-256,
    and writes `succeeded` only through a fenced RPC. APKs live in private Storage; a
    browser receives a short-lived signed URL only after an ownership check. No release
    signing, AAB, store publishing, emulator/device verification or public artifact URL is
    implemented. A missing prerequisite fails closed; no build row, log or artifact is
    fabricated.
14. **Multi-agent orchestration is observability, and deployment approval is the only
    gate.** Orchestration runs only in the durable worker and only for an explicit
    cohort; `project_runs` remains the only job/lease and `generateApp` the only writer
    of `project_files`. Workflow/task/event writes are worker-owned; the authenticated
    role has SELECT only, plus owner cancellation through `cancel_agent_workflow`.
    Planner, UI/UX and repair output is untrusted advisory data: it can never override
    repository instructions, current files, the current user request, authorization,
    verification or deployment, and it is never promoted into a passed check.
    A security scan or QA record is not a deployment authorization. When the approval
    gate is enabled, the deploy path re-derives the target/snapshot/source hash and
    atomically consumes an owner-approved, unexpired, single-use proposal; the browser
    never supplies the hash, no model can approve, and a consumed approval is not
    reusable even if the provider call later fails. With the gate off, legacy
    deployment behaviour is unchanged.
15. **Managed Neon provisioning is infrastructure-only and worker-owned.** It is off
    unless Neon Agent Plan approval is confirmed by an operator, all server-side
    prerequisites are valid, and the Mavly project is in an explicit cohort and a
    worker-dispatched run. The AI may return only a bounded database-requirement signal;
    it never receives the Neon API key or connection URI. Registry writes require the
    service-role RPCs and re-check `(project_id, user_id)` ownership. The encrypted URI
    is not selectable by authenticated users. Ambiguous project-create outcomes are
    reconciled by the unique server-derived project name; the code does not blindly
    retry a non-idempotent create. Application schema changes are additive only: the
    AI returns a validated data model, Mavly compiles it, and no `drop`/`truncate`/
    `alter column` exists in the compiler. `ready` requires a verified schema AND a
    verified connection AND a configured data gateway; a database alone is never ready.
    The public data gateway resolves one `ready` project through a server-only RPC
    proof, parameterizes every value, binds a user-owned row to the session's user id,
    and rejects a query builder call without an owner. Its residual risk is documented:
    the RPC proof is stored as a SHA-256 hash that an `anon`-key holder can present, so a
    database read compromise exposes that hash (not the encrypted URI's key). No
    automatic provider deletion, backup/restore, password reset, or generated-app
    hosting runtime is implemented.
16. **Credit accounting is authoritative, append-only and server-only.** Supabase is the
    source of truth. Authenticated users can read their own account, ledger,
    reservations and usage rows; they have no INSERT/UPDATE/DELETE grant and cannot
    directly admit, resume, release or terminalize a credit run. An enabled
    `credit_project_policies` row blocks authenticated legacy run writes and requires
    service-role admission/resume markers. Only successful settlement, balance and owner
    reconciliation are owner-checked; `grant_credits`, credit refunds, admission/resume,
    failure/cancellation release, per-role usage writes and the worker sweep are
    service-role only. The browser never
    supplies a balance, cost, refund amount or entitlement, and no model can mutate the
    ledger. A hold is never released for a completed run and a run is never charged
    without `finished_at` + `status = 'done'` + `stage = 'completed'`. Credits are
    whole `bigint` units and USD is `numeric(20,9)`; floating-point accounting is
    forbidden. Unknown provider cost stays NULL with an explicit
    `reconciliation_status`/`uncertain` marker, never zero.     with the flag or cohort off, the application calls no credit/usage RPCs. An enabled
    database policy remains an independent fail-closed run-write guard until the project
    is drained and the policy explicitly disabled.
17. **Live previews are isolated, disposable and never authoritative.** Only a fully
    configured deployment may start one; once `MAVLY_RUNTIME_SANDBOX_ENABLED` and its
    prerequisites are present, every eligible project the caller owns is authorized.
    `MAVLY_RUNTIME_SANDBOX_PROJECTS` is only an optional restriction. The browser
    carries no command, path, port, environment, provider key or sandbox id. Every
    lifecycle write is an
    owner-checked SECURITY DEFINER RPC whose transition is validated in SQL as well as in
    the service; the table is SELECT-only for its owner. The sandbox is materialized from
    `project_files` only and never writes back; generated lifecycle/package scripts are
    not executed; the adapter shell-quotes fixed arguments; files are path/secret/size
    filtered; logs are bounded and redacted. The preview URL is derived from the
    provider's host and re-validated on every read, and the iframe has no Mavly origin,
    top navigation or downloads. `ready` requires an actual readiness response, never a
    submitted command; a running preview is not a build, a QA pass, a verification
    `passed` or a deployment approval. Expiry, stop and cleanup are idempotent, and a
    provider failure is recorded truthfully without touching a run, checkpoint, image or
    credit settlement. The E2B preview host is public by URL unless the provider project
    configures otherwise; Mavly does not proxy it and must not describe a preview as
    private.

## UI conventions

- Preserve the existing UI unless the task explicitly allows visual or copy changes. Some
  remaining strings, billing links and feature labels still describe the removed Totalum
  backend; they are known-inaccurate and intentionally left until a UI task covers them.
- Most files under `components/workspace/*`, `components/prompt/*`,
  `components/primitives/*`, several `lib/*` modules and `src/i18n/en.ts` are copied from
  the former platform. Keep fixes minimal and consistent with those files.
- **Never re-copy `src/i18n/en.ts` wholesale.** It contains deliberate local values. Copy
  individual keys and diff afterwards.
- Mobile and desktop layouts are both mounted. Composer state that must not drift (prompt,
  attachments) belongs to the page, not `ChatPanel`.
- Long operations belong to the page, not the modal/popover that starts them.
- Shims (`components/credits/CreditsProvider.tsx`, `lib/usage.ts`, `i18n/en-more.ts`)
  exist only so copied components compile. Do not turn them into live backend calls.

## Boundaries

- Edit anything under `src/`, `README.md`, `AGENTS.md`, `MAVLY_CLEAN_BASELINE.md`,
  `.env.example`.
- Ask before changing the semantics of `src/app/api/vcaas/_shared.ts`, the ownership
  model, OAuth behaviour, copied platform files, or dependencies.
- Never: commit `.env*` or any API key; expose a server secret via `NEXT_PUBLIC_*`;
  reconnect Totalum or another hosted builder backend without approval; vendor external
  API documentation into this repo.

## Historical documents

These describe earlier architectures and are **not current instructions**:

- `AUDIT.md`
- `ROUTE_AUDIT.md`
- `TOTALUM_API_DEPENDENCY_AUDIT.md`
- `MAVLY_PRODUCT_ARCHITECTURE_REALITY_AUDIT.md`

For the current state, use `MAVLY_CLEAN_BASELINE.md`.

## Git

Small, single-purpose commits. The human developer runs the checks before opening a PR.
PR description: what changed, why, and what was inspected. Do not claim automated
verification under the policy above.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
