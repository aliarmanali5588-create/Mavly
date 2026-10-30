# Mavly — Clean Backend Baseline

**Status:** local AI builder, no customer-owned Supabase integration, an off-by-default
static-publishing path, a platform-wide production durable generation worker, and an off-by-default
isolated verification sandbox implemented; the
rest of the platform backend remains unavailable.
**Scope:** the Totalum VCaaS integration stays removed. Supabase authentication, OAuth,
sessions, project ownership and RLS are preserved. OpenRouter is the active server-only
website/code-generation provider, and the same server-only key serves the image path.
`cohere/north-mini-code:free` is an opt-in model for explicit project cohorts configured
with `MAVLY_NORTH_MINI_CODE_PROJECTS`; it does not replace the default model.
Vercel is used only when an operator explicitly
enables publishing.

No Totalum endpoint is called. No deployment, GitHub push, production SQL, secret
revocation or database mutation was performed while preparing this document.

---

## 1. Current state

| Area | State |
| --- | --- |
| Marketing homepage (`/`) | Loads. |
| Sign-in page (`/login`) | Loads. Google and GitHub OAuth start are unchanged. |
| Supabase authentication | `@supabase/ssr` clients, session refresh in `src/proxy.ts`, `/auth/callback`, `/auth/signout`. |
| Session-gated pages | `/dashboard` and `/project/*` redirect signed-out visitors to `/login`. |
| API session gate | `/api/*` returns JSON `401 UNAUTHENTICATED` without a verified session. |
| Project ownership | `public.projects`, RLS, `registerProjectOwnership`, `checkProjectAccess`, `enforceProjectScope`. |
| Project CRUD | Create/list/launch/get/update/delete, stored in Supabase. |
| Project type and Android workspace | `public.projects.project_type` (migration 22) distinguishes `website` and `android`. Android projects are created idempotently (migration 25), appear as Android in dashboard cards, and open a Kotlin/Compose source workspace using the same authorized `/project/{id}` route. Android prompts use the same durable generation pipeline with a native profile; the resulting complete source is re-validated by `src/lib/android/contract.ts`. Optional, cohort-gated isolated debug builds are implemented in migration 26 and the generation worker: a pinned toolchain image builds an immutable snapshot offline, validates the APK and stores it privately for an owner-authorized short-lived download. The reproducible image definition lives in `infra/android-build/` (digest-pinned base, checksum-verified JDK 17/Gradle 8.9/SDK 35, seed-warmed offline Gradle cache); the repository does not build or publish it. Release signing, AABs, store publishing and emulator/device preview remain unavailable and are reported as such. |
| AI generation | The active `src/lib/mavly/run-agent.ts` → `src/lib/ai/agent.ts` → `src/lib/ai/provider.ts` → `src/lib/ai/openrouter.ts` pipeline serves both websites (Next.js profile) and Android apps (Kotlin/Compose profile). Production admissions use the durable worker; local development and Vercel previews retain the inline `after()` path. Worker execution rechecks the persisted project type before generation and does not enqueue the Next.js verification sandbox for an Android run. |
| Durable generation worker (Cloudflare Cron) | Every production generation admission is written to the existing `project_runs` queue and dispatched without a project allowlist or worker-specific enable/secret configuration. The dedicated Cloudflare Worker runs `workers/generation-scheduler.ts` on `* * * * *`, directly invokes one existing worker tick, and preserves atomic claims, fenced leases, verified checkpoints, bounded retry/recovery, cancellation and ownership checks. Local development and Vercel previews remain inline. No new migration is needed; the worker preflight requires schema marker 32 and migration 36's handoff remains unchanged. Cloudflare deployment, runtime compatibility and Cron operation are not verified; see `docs/runbooks/generation-worker.md`. |
| Verification sandbox (opt-in) | Off unless `MAVLY_VERIFICATION_SANDBOX_ENABLED`, an explicit `MAVLY_VERIFICATION_SANDBOX_PROJECTS` cohort, a Vercel provider credential, `SUPABASE_SERVICE_ROLE_KEY` and the Supabase URL are all configured, and migrations 17 then 19 are applied. Only worker-dispatched runs enqueue one verification per completed run and ready snapshot. Later worker ticks re-validate the snapshot, build it in an isolated Vercel Sandbox microVM, start the validated production server on loopback and run a sandbox-local health check. `passed` requires the build, the runtime start and a `2xx`/`3xx` health response; build-only success is never `passed`. Stages run detached and are polled across ticks; every terminal path destroys the sandbox. Unsupported formats return `unsupported_runtime`. A separately opt-in bounded AI repair (default 1, hard cap 2) may create a new immutable snapshot for a source-level failure and rerun the checks. Preview stays unavailable because there is no authenticated proxy. Status appears only in the existing authorized `agent/status` / `agent/stop` responses. See `docs/architecture/phase-4-runtime-verification.md`. |
| Live runtime preview (opt-in) | Off unless `MAVLY_RUNTIME_SANDBOX_ENABLED`, server-only `E2B_API_KEY`, the Supabase URL and migration 34 are all configured. There is no per-project allowlist: `MAVLY_RUNTIME_SANDBOX_PROJECTS` is an optional temporary restriction and empty/`*` means every eligible project. For a supported React + Vite website project, Mavly copies the authoritative `project_files` into an isolated E2B sandbox, installs with `npm ci|install --ignore-scripts`, starts the installed Vite binary with fixed arguments, and marks the session `ready` only after a server-side request to the validated `*.e2b.app` preview host returns 2xx/3xx. One durable row per project enforces a single active sandbox; ready sessions are reused, Restart rebuilds, Stop and expiry are idempotent. The sandbox never writes back to `project_files`. Unsupported frameworks (including the Next.js sites Mavly generates) get an exact reason and keep the static preview. **Not verified against a live E2B account.** See `docs/architecture/phase-13-live-runtime-preview.md`. |
| Generation preview | New-project plans always include `preview.html`; it is generated in its own batch. Batch parsing accepts only requested paths and refuses an incomplete HTML document. Progress stages use durable run state, manifest/checkpoints, and the static-preview resolver; the UI uses an indeterminate bar rather than estimated completion percentages. The workspace labels the preview `ready`/`stale`/`incomplete`/`unavailable` from the saved entry plus the latest durable run, and offers `agent/resume` when a failed run can be recovered. |
| Text generation | `src/lib/ai/provider.ts` serves every website/Android generation request through OpenRouter (`src/lib/ai/openrouter.ts`). The production default is `deepseek/deepseek-v4.1-flash`; `cohere/north-mini-code:free` is selectable only when the project is in the server-configured `MAVLY_NORTH_MINI_CODE_PROJECTS` cohort. Models must pass the catalog and project-cohort checks before a request leaves the server; the shared chat contract lives in `src/lib/ai/chat-contract.ts`. Requests are **streamed**: each call class has one absolute cap plus a shorter idle-progress window (`src/lib/ai/budget.ts`), and the streamed-accumulation and completion rules live in `src/lib/ai/stream-contract.ts`. A cancelled, unknown-reason or prematurely closed stream is a failure even when text arrived; a timeout on a batch is answered by reducing scope, never by repeating the same request; and a run stops at its provider-attempt ceiling (`MAVLY_MAX_PROVIDER_ATTEMPTS_PER_RUN`, 4–40, default 12). |
| Conversation and runs | Persisted in `project_messages` and `project_runs`, polled by the workspace. |
| Project settings | Owner-editable name/description through `PATCH /projects/{id}`; the derived Mavly address is read-only. |
| Project secrets | Write-only AES-256-GCM ciphertext per project/environment; API responses carry metadata only. Values are not injected into the static output. |
| Managed Neon databases + app data API (opt-in) | Only worker-dispatched projects in an explicit cohort can provision one quota-bounded Neon project per Mavly project. A validated `dataModel` is compiled into additive, idempotent steps and applied by a ledgered, advisory-locked runner that reads the schema back before anything is called ready. `ready` separately requires a verified connection, a verified schema and a configured data gateway; `provisioned` alone is only "a database exists". Generated apps call `/api/app/v1/apps/{projectId}/data|auth/*`, which executes only Mavly-authored parameterized SQL and scopes user rows by the end user's own session; no connection credential ever reaches the model, browser or project files. End-user accounts (scrypt + hashed opaque sessions) live in the customer database. Requires approved Neon Agent Plan access, migrations 30 and 35, and explicit server configuration. **Not implemented:** a hosting runtime for generated server code, password reset, automatic database deletion/cleanup, backup/restore and Mavly credit pricing for databases. No live provisioning, schema run or gateway request has been verified. |
| Project activity | Real run history aggregated from `project_runs`; visitor analytics are not collected. |
| Project files | `project_files`; tree/content reads and content writes. |
| Image generation | The locked model is `recraft/recraft-v4.1-flash` on OpenRouter's dedicated image API. Planning-driven website imagery (off by default, migration 33) persists approved assets and gives the coding agent their URLs; the standalone `POST …/images/generate` route uses the same model, returns base64, persists nothing and has no UI caller. Nothing is charged to user credits. |
| Source archive | ZIP built from `project_files`. |
| Restore points | `project_snapshots` + `project_snapshot_files`; a "Restore Code" action in the chat. |
| GitHub | A GitHub App with user-to-server tokens: connect, push, import. |
| Preview | Generated static `preview.html`, or an imported static `index.html` / `public/index.html` with local assets, served with a CSP sandbox. Framework entry points that need a build are reported as unsupported. For an enabled React + Vite project, the workspace may instead show the validated live E2B preview; the static panel stays mounted as the fallback. |
| Supabase account connection | OAuth + PKCE, encrypted access/refresh tokens, organization/project discovery, one selected project. |
| Customer publishing | Retired. The publish, unpublish, and deployment-status APIs fail closed with `BACKEND_NOT_CONFIGURED`; no provider is called and no deployment success is fabricated. Historical deployment rows/migrations remain untouched. |
| Shared tenant hosting (opt-in) | Off unless `MAVLY_HOSTING_MODE=shared` and a project cohort is configured. A publish freezes an immutable `project_published_versions` / `project_published_files` artifact, then migration 15's `activate_shared_publication` atomically links it from `project_deployments.active_version_id` and marks the attempt `ready`. The public resolver serves from that active pointer, **not** the attempt status, so republishing or a failed attempt leaves the previous version live. It serves at `<project-id>.mavly.xyz` from Mavly's own tenant runtime, which re-checks the cohort after resolution. Public access is two published-only `SECURITY DEFINER` RPCs; drafts and `project_files` are never served publicly. Unpublish deactivates the mapping without deleting history. Wildcard DNS/TLS and provider eligibility remain operator prerequisites; see `MAVLY_SHARED_HOSTING.md`. |
| `/api/config` | Still returns `{ ok: true, data: { configured: false } }`. |
| Visual shell | Dashboard, workspace, chat, composer, dialogs and preview frame render. |

Generated code is **never executed** on the Mavly server. Execution happens only inside an
isolated provider microVM: the opt-in verification build, loopback runtime start and
sandbox-local health check (which exposes no public port or preview URL), and the opt-in
Phase 13 **live preview** (an E2B sandbox running `npm install --ignore-scripts` and the
fixed Vite dev server, with a provider-hosted preview URL). Neither runs on a Mavly host,
and neither makes generated code authoritative. The generated backend otherwise exists
only as source files; the default preview is the standalone `preview.html` the model also
returns.

Publishing does not change that rule. When enabled, the server uploads `index.html` (the
preview bytes) and Vercel serves it as a static site with `framework: null`. Each publish
also attaches the exact `<project-id>.mavly.xyz` project domain; the deployment is not
reported as successful until Vercel verifies that domain. Generated Next.js source, API
routes, environment secrets and dependencies are never built or run. Vercel's
commercial/plan eligibility for Mavly-managed customer hosting is **not verified** by this
document; see `MAVLY_VERCEL_DEPLOYMENTS.md` for DNS/SSL prerequisites as well.

Unpublishing is not a local flag. The server detaches the Mavly project domain at Vercel and
removes the project's production deployments, and only then records `unpublished`. The Mavly
project, generated files, snapshots, Vercel project mapping and hostname remain, so the same
address can be published again. Shared `mavly.xyz` DNS/wildcard records are never deleted.

---

## 2. Implemented locally

### Data

`supabase/migrations/03_ai_builder.sql` adds:

- `projects.label`, `projects.description`, `projects.updated_at` and
  `projects_update_own`;
- `project_files` (`project_id`, `path`, `content`, `updated_at`);
- `project_messages` (author, text, message type, created time);
- `project_runs` (status, model, prompt, timestamps, error);
- RLS policies for every child table, each requiring an owned parent row;
- one in-flight run per project (`project_runs_one_init_per_project`).

`supabase/migrations/10_generation_jobs.sql` adds:

- the durable `stage`, heartbeat, idempotency, provider-usage and checkpoint columns on
  `project_runs`;
- `project_run_batches`, one validated batch per row with per-path SHA-256 hashes and RLS
  inherited from the owning project;
- one unfinished run per project (`project_runs_one_active_per_project`) and a
  project-scoped idempotency index;
- `create_generation_job`, the SECURITY DEFINER admission gate (ownership, stale recovery,
  idempotency, one active run per project, 2 per user, 8 global, serialized by a Postgres
  advisory lock).

Apply migration `10` before deploying code that reads these columns. By default the inline
`after()` path starts the run opportunistically; the user-authenticated `agent/resume`
endpoint reopens a failed/interrupted run from its verified checkpoints.

`supabase/migrations/16_durable_generation_worker.sql` adds the opt-in durable worker:

- queue/lease/retry columns on `project_runs` (`lease_token`, `lease_expires_at`,
  `job_attempt`, `max_job_attempts`, `next_attempt_at`, `enqueued_at`, `dispatched_at`,
  `dead_lettered_at`, `worker_id`, `trace_id`, `dispatch_mode`, sanitized error class and
  summary, reported cost);
- a `retry_wait` stage that is ready but not executing;
- indexes for the ready queue, expired leases, dead letters, trace lookup and worker
  heartbeat;
- `claim_generation_job` (`FOR UPDATE SKIP LOCKED`, service-role only), lease renewal,
  bounded retry scheduling, expired-lease recovery and an owner-only resume RPC;
- a column-level UPDATE grant for `authenticated` that excludes every worker-owned field,
  plus a `generation_worker_schema_version()` preflight (returns 16).

The admission RPC gains a `p_dispatch_mode` argument, so a run is either inline or worker
before it exists and the two mechanisms never compete. Apply migration `16` after `10`
(and after `14`/`15` when shared hosting is used) and before enabling the worker.

`supabase/migrations/17_verification_sandbox.sql` adds the opt-in verification sandbox:

- `project_verifications`, one row per generation run, linked to the owned project, run and
  ready snapshot with its `source_hash`; statuses cover in-flight stages plus `passed`,
  `failed`, `timed_out`, `cancelled`, `unsupported_runtime`, `configuration_error` and
  `infrastructure_error`;
- a fencing lease (`lease_token`, `lease_expires_at`, `worker_id`), attempt and hard
  deadline, bounded/sanitized diagnostics, exit code and durable cleanup state;
- `enqueue_verification` (service-role, idempotent on `run_id`, re-checks the completed run
  and snapshot hash, bounded by 1 active per project / 2 per user / 8 global),
  `claim_verification` (`FOR UPDATE SKIP LOCKED`, never starts a second sandbox),
  fenced stage/renew/release RPCs, idempotent `complete_verification`,
  `recover_expired_verification_leases`, bounded `claim_verification_cleanup` /
  `mark_verification_cleanup`, and owner-only `cancel_verification`;
- RLS: users may SELECT only their own rows through `projects` and may not INSERT/UPDATE/
  DELETE; worker RPCs are executable only by `service_role`; lease tokens, worker ids and
  raw provider sandbox ids are outside the authenticated column grant;
- a `verification_schema_version()` preflight (migration 17 returns 17; migration 19
  raises it to 19, which the current worker requires).

Apply migration `17` after `16` and before enabling verification. It is additive and does
not modify `project_runs`, `project_files`, snapshots or hosting tables. A disabled or
misconfigured deployment never enqueues work, and a missing marker fails closed.

`supabase/migrations/19_runtime_verification.sql` adds the Phase 4 runtime, health,
preview and repair state:

- effective snapshot/hash, `build_passed`, `runtime_started`, `health_passed`, runtime
  profile/port/exit/health-status and their timestamps, and a preview status/reason
  constrained to `unavailable`/`disabled`;
- `repair_status`, bounded `repair_attempts`/`repair_max_attempts` and
  `repaired_snapshot_id`, plus `project_verification_repairs` (one row per attempt, unique
  on verification+attempt, service-role-only writes);
- a terminal write that rejects `passed` without the build, runtime and health booleans
  (`PASSED_REQUIRES_RUNTIME`), a 7-argument enqueue, repair begin/finish RPCs and updated
  recovery/cancellation;
- `project_snapshots.kind` accepts `repair`; users still see only documented public result
  fields and never the sandbox/lease/worker columns;
- `verification_schema_version()` returns 19.

Apply `19` after `17` (and after `18` in file order) and before enabling runtime
verification. It is additive and non-destructive.

`supabase/migrations/34_runtime_sandboxes.sql` adds the opt-in Phase 13 live preview:

- `project_runtime_sandboxes`, one durable lifecycle row per live preview sandbox, with
  owner/project/run references, a server-only provider sandbox id, state, source hash,
  synced path manifest, validated port and preview URL, bounded logs/diagnostics, timing
  and expiry;
- a partial unique index and advisory lock that allow exactly one active sandbox per
  project, plus a database transition table (`ready` only from `starting`) and a `ready`
  constraint requiring the provider id, port and preview URL;
- owner-checked `SECURITY DEFINER` `begin_runtime_sandbox`,
  `update_runtime_sandbox` and `stop_runtime_sandbox`, a `service_role`-only bounded
  `expire_runtime_sandboxes` sweep, SELECT-only owner RLS and schema marker 34.

Apply `34` after `33` and before setting `MAVLY_RUNTIME_SANDBOX_ENABLED`. It is additive
and non-destructive; it does not alter generation runs, credits, images, verification,
payments or deployment. With the flag off no sandbox is created and the static preview is
unchanged. A real E2B sandbox, install and Vite server have **not** been exercised.

The app still uses the caller's own RLS-scoped Supabase client everywhere except the
durable worker. `SUPABASE_SERVICE_ROLE_KEY` is server-only and is confined to
`src/lib/supabase/worker.ts`, the worker orchestrator, the scheduled Cloudflare entrypoint
and the verification tick it invokes; the worker re-verifies the project owner itself.
RLS is unchanged. Sandbox provider
credentials are used only by the server-side adapter and are never uploaded into a sandbox.

`supabase/migrations/04_supabase_integration.sql` is retained as historical customer-
integration schema. Its runtime integration routes and modules have been retired. Do not
add a destructive migration or drop these tables automatically.

### API paths

The project routes run authentication → path scope → ownership → handler:

| Path | Behaviour |
| --- | --- |
| `GET /api/vcaas/projects` | Lists only the caller's projects. |
| `POST /api/vcaas/projects` | Creates a project row; a taken id gets a random suffix. |
| `POST /api/vcaas/projects/launch` | Creates the project, admits one durable run, inserts the first message and schedules generation. |
| `GET/PATCH/DELETE /api/vcaas/projects/{id}` | Read, update metadata, delete. |
| `POST /api/vcaas/projects/{id}/agent/start` | Atomically admits a run and schedules generation after the response. |
| `POST /api/vcaas/projects/{id}/agent/resume` | Reopens the latest failed/interrupted run from its manifest and verified checkpoints. |
| `POST /api/vcaas/projects/{id}/agent/stop` | Cooperatively cancels the active run; completed batches stay. |
| `GET /api/vcaas/projects/{id}/agent/status` | Latest run state plus messages since that run started. |
| `GET /api/vcaas/projects/{id}/agent/full-conversation` | Windowed message history. |
| `GET /api/vcaas/projects/{id}/files/tree` | Flat folders + files, filtered/paged. |
| `GET/PUT /api/vcaas/projects/{id}/files/content` | Read a file; save UTF-8 or base64 content. |
| `POST /api/vcaas/projects/{id}/images/generate` | One image from the server-side image model; returned as base64, not stored. |
| `GET /api/vcaas/source-code/{id}` | ZIP of the generated files. |
| `GET/HEAD /api/preview/{id}/…` | Sandboxed static preview: `preview.html`, `index.html`, or `public/index.html` plus local assets. |
| `GET /api/runtime/{id}` | Authenticated live-preview status and bounded diagnostics; never creates a sandbox. |
| `POST /api/runtime/{id}` | Fixed `start` / `restart` / `stop` / `build` actions for an owned, cohort-enabled project. |

The customer-owned Supabase OAuth connection is not implemented and no such routes are
available. Mavly's own Supabase infrastructure remains required for authentication, RLS,
project storage, runs, snapshots, and worker state.

### Image generation

The image catalog lives in `src/lib/ai/image-models.ts` — deliberately separate from
`models.ts`, so the website-generation model cannot resolve to an image model — and has
**one entry**: `recraft/recraft-v4.1-flash`, called on OpenRouter's **dedicated image
API** (`POST https://openrouter.ai/api/v1/images`), which is a different contract from
chat completions. Its parameters come from the provider's own endpoint record
(`GET /api/v1/images/models/recraft/recraft-v4.1-flash/endpoints`, checked 2026-10-29):
`aspect_ratio` is the enum 1:1, 4:3, 3:4, 16:9, 9:16, auto; `n` is 1..6 (Mavly always sends
1); `supports_streaming` is false; billing is $0.007 per output image. The record lists no
`output_format`, `seed`, `resolution`, `quality` or `background`, so none of those is ever
sent. Mavly-specific request validation still refuses them rather than silently ignoring
them; reference images would need an upload path (not implemented) or a server-side URL
fetcher (an SSRF surface).

`MAVLY_IMAGE_MODEL` is a **selector over that one-entry catalog, not an injection point**:
a slug with no entry (a typo, a chat-completions model, another provider's model)
resolves to the locked model and never reaches OpenRouter. There is no second image model
and no fallback. Catalog validation is what makes the enforced options trustworthy —
aspect ratios and format support all come from the entry. `MAVLY_DEFAULT_MODEL` is a
different variable for the website/code-generation model and is never read by the image
path; the two catalogs share no entry.

The response is validated, not trusted: the base64 has to decode, be non-empty, be within
**3,000,000 bytes**, and start with a PNG or JPEG signature. The size cap is set by the
delivery path, not by memory: Mavly's own app builds for Vercel, whose Function response
body is limited to 4.5 MB, and base64 expands by 4/3. A larger provider image is reported
as `IMAGE_TOO_LARGE` instead of becoming a paid generation that fails at the platform
layer. A URL-only response is refused instead of fetched. At most one retry is made, and
only after a 429/502/503 — the provider's documented "nothing was generated" answers. A
timeout is never retried, because the first generation may already have completed and been
billed upstream.

Admission is a best-effort, per-instance request window: **5 per user per 10 minutes** and
**40 per instance per 10 minutes**, consumed after validation and before the provider call
(`src/lib/mavly/image-limits.ts`). It lives in module memory, so it does not coordinate
across serverless instances; a hard cap needs a persisted admission RPC and a migration,
which is not implemented. Over-limit requests answer `429 RATE_LIMITED` with `retry-after`.

On this standalone route the image is returned as base64 and is **not stored**, and no UI
calls it. Images are **not charged**: the credit foundation below covers generation runs
only, it is off by default, and no image price was invented. The provider's own cost stays
inside its server-side metadata and is deliberately **not** returned to the browser.

#### Planning-driven website imagery (off by default, migration 33)

The generation path, not that route, is where images now come from. When
`MAVLY_IMAGE_PLANNING_ENABLED` is truthy the planner returns `siteType` plus a bounded
`images` array inside its existing plan JSON. `src/lib/images/manifest.ts` validates every
entry (lowercase ids, unique ids, unique placements, site-relative paths, aspect ratios
from the model's own enum, bounded prompts/alt text) and rejects the whole plan on any
defect. `approveImagePlan` then decides **from backend policy only** how many assets are
paid for: required assets first, then priority, then id; anything over the count or USD
ceiling is recorded as **deferred** rather than dropped. The planner cannot raise either
limit — `MAVLY_IMAGE_MAX_ASSETS` (default 40, clamped 1..40),
`MAVLY_IMAGE_MAX_RUN_COST_USD` (default 0.30, clamped 0..1) and an explicit
`MAVLY_IMAGE_LARGE_CATALOG_PROJECTS` cohort (80 assets, and only when the plan names a
`catalog`) are the only sources of authority.

`src/lib/images/service.ts` runs one bounded stage inside the existing durable run,
between the persisted plan and the first code batch: it persists the approved plan and its
asset rows, **claims** each asset in the database before the paid call, validates the
returned bytes (PNG/JPEG signature, size), uploads them to the public-read
`project-images` bucket at a server-derived `<project_id>/<run_id>/<asset_key>.<ext>`, and
only then writes `ready` through `complete_image_asset`. A finished row is reused instead
of regenerated on resume; a claim held by another worker yields no provider call; the
stage stops at its own deadline slice, concurrency limit, attempt cap and approved count,
and reports what is pending truthfully. Provider cost is recorded per attempt with
`cost_known`; a timeout stays `uncertain` with a NULL cost. **No credit is reserved,
charged, refunded or settled for an image** — this adds no charging policy and alters no
credit, payment or pricing table. The coding prompt lists only persisted URLs, and a
deferred or failed placement is named as unavailable so the generated page keeps its slot
with a placeholder instead of inventing a URL; `preview.html` never references remote
images at all.

### Credits (opt-in foundation)

`supabase/migrations/31_credit_foundation.sql` adds authoritative, append-only credit
accounting for generation runs. It is **OFF BY DEFAULT**: nothing is charged unless
`MAVLY_CREDITS_ENABLED` is truthy, an explicit `MAVLY_CREDITS_PROJECTS` cohort exists, and
`MAVLY_CREDITS_GENERATION_COST` is a whole number between 1 and 100000. Credited projects
must also be explicitly worker-dispatched and have a matching service-managed
`credit_project_policies` row; the database policy is an independent write guard and must
be disabled only after all runs/holds are drained. Projects outside the enabled database
policy retain the existing generation behavior.

- **Tables:** `credit_accounts` (whole-credit `balance_credits`/`reserved_credits`, both
  `bigint`, with `balance >= reserved >= 0`), service-managed `credit_project_policies`,
  `credit_reservations`, `credit_ledger` (append-only; an UPDATE/DELETE raises),
  `ai_cost_rates` (empty by default) and `ai_usage_attempts` (per provider attempt). USD is
  `numeric(20,9)`; credits are never stored as floating point.
- **Atomic admission:** `create_generation_job_with_credits` calls the existing
  `create_generation_job` and then takes the hold in the SAME transaction. It is
  service-role-only, verifies project ownership and the database policy's fixed price, and
  requires worker dispatch. Insufficient available credits RAISE, rolling back the job
  insert, so no orphan run or partial reservation exists. The RPC also rejects a reused
  idempotency key whose prompt/model differ (`idempotency_key_reused`). A database trigger
  blocks authenticated direct use of legacy generation admission/resume RPCs on enabled
  credit projects.
- **Lifecycle:** reserve at admission; `settle_generation_reservation` consumes the hold
  only when the run is finished, `status = 'done'` and `stage = 'completed'`;
  successful runs can be settled by the worker or owner reconciliation.
  `release_generation_reservation` is service-role-only and returns the hold only for a
  terminal unsuccessful run. A service-role terminal handler atomically writes failed or
  cancelled state and releases; worker settlement/release is recoverable through the
  durable sweep. Only a `reserved` row is acted on, so duplicate settlement/release is
  harmless.
- **Resume:** `resume_generation_job_with_credits` reopens a failed/interrupted run and
  is service-role-only, verifies owner/policy/cost and requires worker dispatch. It takes a
  fresh hold only when the previous hold was released. A duplicate resume of a run that is
  still active is refused (`run_active`) without starting or charging a second execution;
  a terminal run whose hold was never released has that hold released in the same
  transaction before the new one is taken (one live hold per run is a partial unique
  index). A resumed run can never start unpaid.
- **Refund:** `refund_generation_reservation` is **service-role only** and audited. No
  automatic customer refund policy is invented; a refund is an operator action.
- **Recovery:** settlement/release follow the fenced terminal run write. A crash between
  them is repaired by the durable worker's `maintain_credit_reservations` sweep and by the
  owner's bounded `reconcile_owner_credits` on the balance read. That sweep also runs
  `release_orphaned_credit_reservations`: a deleted project cascades its runs, and a hold
  keyed to a run that no longer exists could otherwise never be settled or released, so it
  is returned with a ledger entry after a one-hour grace window. The launch path releases
  the hold itself before it deletes a project it just created.
- **Usage metering:** `record_ai_usage_attempts` derives one row per provider attempt from
  the server-written `project_runs.provider_attempts` (no client payload). Cached-token
  fields are recorded when the provider reports them. `actual_cost_usd` is the
  provider-reported cost only; `estimated_cost_usd` exists only when an operator has
  installed a row in `ai_cost_rates`. A timeout/network failure after dispatch is
  `uncertain = true`, never zero.
- **Access:** authenticated users may SELECT only their own account/ledger/reservations/
  usage rows and call owner-checked successful settlement, balance and reconciliation
  RPCs. They have no INSERT/UPDATE/DELETE grant on credit tables and cannot directly
  admit, resume, release or terminalize a credit run. An enabled database policy blocks
  authenticated legacy run writes. Credit admission/resume, failure/cancellation release,
  grants/refunds, per-role usage writes and the worker sweep are service-role only.
- **Funding is not implemented in the product.** There is no Mavly credit-pack or
  subscription grant flow: credits can only be created by the service-role `grant_credits`
  RPC (an operator or a future payment integration). Enabling a charge before granting
  credits therefore refuses generation with `402 INSUFFICIENT_CREDITS`. This is a known
  product gap, not a hidden default.

Not verified live: migration 31, its RLS/RPCs, settlement under a real Supabase session,
and the workspace balance indicator have not been exercised against a database.

### Restore points

`supabase/migrations/05_restore_snapshots.sql` adds:

- `project_snapshots` — the metadata of one recovery point: the project, the owner,
  the run, the kind (`baseline`, `result`, `pre_restore`, `import`, `manual`), a
  description, a content hash, the changed paths and the restore bookkeeping;
- `project_snapshot_files` — the COMPLETE file state of that point, one row per
  path. A diff could not be replayed onto a state that has since diverged; a file
  set can;
- `project_messages.restore_snapshot_id` — the link that binds the chat's
  "Restore Code" action to one execution.

Every completed AI execution that changes the source captures the state it started
from (`baseline`) and the state it produced (`result`). The chat renders the
**Restore Code** action on the message that carries the baseline, and restoring it
puts the project back exactly as it was: added files are removed, changed files are
rewritten, deleted files come back. The restore captures the pre-restore state
first, so a restore is itself recoverable, and a stale restore (the project changed
since the recovery point was opened) is refused with `409 SOURCE_CONFLICT`.

This is Mavly's own recovery mechanism. It does not depend on GitHub, on a
deployment, or on any external service.

### GitHub

`supabase/migrations/06_github_integration.sql` adds `github_connections` (the
user's encrypted OAuth token), `github_oauth_states` (single-use PKCE state) and
`github_repository_connections` (which repository and branch a project is connected
to).

The integration is a **GitHub App used with user-to-server tokens**: the user
authorizes Mavly in GitHub's own screen, Mavly stores that user's token encrypted
with `MAVLY_INTEGRATION_ENCRYPTION_KEY`, and every repository operation runs as that
user. It is not a personal access token of the platform owner.

Repository discovery is installation-scoped: Mavly lists the user's installations and
then each installation's repositories. A user access token cannot use `/user/repos` to
see repositories outside the installation selection. Repository-creation failures report
the runtime App ID/slug, installation URL and approved installation permissions, and
distinguish a missing installation, a suspended installation, and a stale permission
approval without exposing a token.

Implemented under `/api/integrations/github/`: start, status, repositories, branches,
connect, disconnect, push and import; the callback is `/auth/github/callback`.

- A push builds ONE tree and ONE commit on top of the branch's current head and
  moves the reference with `force: false`. A branch that moved is reported as a
  conflict — with an explicit, separate confirmation before committing on top of it.
  History is never rewritten and a push is never automatic.
- An existing repository can connect only to a branch GitHub reports. A genuinely
  empty repository is detected from an empty branch list plus repository metadata
  (`size === 0` and no `pushed_at`); it connects to an intended branch name and is
  marked `first_push_pending`. The first successful push creates the initial tree,
  commit (`parents: []`) and ref; import is disabled until that branch exists. Mavly
  never claims an uncreated branch exists or creates an empty placeholder commit.
- An import answers its PLAN first (added / modified / removed) and replaces the
  project's source only after the user confirms. The project's current source is
  captured as a recovery point before anything is written. An import never starts the
  agent and never publishes.
- A file-inclusion policy refuses environment files, private keys, dependency
  directories, build output and caches, oversized files, and anything that looks
  like a credential — in both directions.

### Figma

`supabase/migrations/08_figma_integration.sql` adds `figma_connections`: one
encrypted personal access token per project, plus the Figma account metadata used
for display. The table inherits ownership from `public.projects` through RLS.

The user creates a token in Figma with `current_user:read` and
`file_content:read`. Mavly validates it against `GET /v1/me` before storing it,
encrypts it with `MAVLY_INTEGRATION_ENCRYPTION_KEY`, and never returns it to the
browser. `GET …/figma/status` can optionally re-verify the token; an invalid token
is reported as `tokenValid: false`, not silently discarded. Connect and disconnect
are under `…/projects/{id}/figma/*`; the account-level validation endpoint is
`POST /api/vcaas/figma/validate`.

When an agent prompt contains a Figma link, `run-agent.ts` reads the selected frame
through `src/lib/integrations/figma/*` and injects a bounded text summary of its
layout, typography, colours and copy. A file-level link is resolved only when the file
has one top-level design; ambiguous files fail with a request for a frame link rather
than sending a partial page index. It does not download images, nothing from Figma is executed,
and the stored token never reaches the model or a log.

### Generation

- Website and native Android source generation use OpenRouter only. `MAVLY_DEFAULT_MODEL`
  may override the default only with an entry in the OpenRouter catalog;
  `deepseek/deepseek-v4.1-flash` remains the built-in default. The Cohere North Mini Code
  testing model is admitted only for explicit project IDs in
  `MAVLY_NORTH_MINI_CODE_PROJECTS` and only when requested by its exact model ID.
  Unsupported, unconfigured or out-of-cohort model requests never reach the wire.
- The run plans a manifest, then requests bounded file batches. The model must return JSON
  with full file contents; one focused repair is made per malformed/empty response.
- `finish_reason: "length"` is always a failure. The truncated response is discarded, the
  batch is split, and prior validated batches remain checkpointed. A `preview.html` that is
  not a structurally complete document (`src/lib/preview-document.ts`) is also refused
  before persistence, even when the JSON envelope parsed.
- One run has one absolute deadline (`src/lib/ai/budget.ts`): a finalization reserve is
  never spent on a provider call, every attempt is planned against the time actually left,
  and an attempt is not started below the minimum useful window.
- Paths are sanitized, `.env`/`.git`/`node_modules`/build output are refused, and per-file
  and total size caps apply before anything is written.
- New projects must include `package.json`, `app/layout.tsx`, `app/page.tsx` and
  `preview.html`.
- The agent runs after the HTTP response via Next.js `after()`; the UI polls the durable
  stage and checkpoint counts. `after()` is not a worker: a terminated invocation leaves an
  unfinished run that `agent/resume` can reopen, and nothing restarts it automatically once
  the invocation has ended. Within one inline invocation, one bounded continuation may run
  immediately for a timeout, transient failure or truncation, reusing the persisted
  manifest and verified checkpoints; the durable worker keeps its own retry/lease path.

---

## 3. What remains unavailable

Every path below still authenticates, checks ownership where applicable, and then answers
the explicit 503. No mock data, fabricated id or fake success is returned.

| Area | Examples |
| --- | --- |
| Uploads / attachments | `POST /api/vcaas/upload/{id}`; prompt `inputFiles` are ignored |
| Rebuild / runtime | `rebuild`, `rebuild/status`, server wake, agent stop/clear-context |
| Dynamic deploy / hosting | building generated source, server/API hosting, customer custom domains, deployment logs. Static preview publishing with a Mavly-owned address is implemented behind an operator flag. |
| Versions / visual edits | versions, Git diff, `/api/visual-edit/.../apply` |
| Data platform | database browsing, arbitrary SQL execution, manual schema editing, backups, backup download. Managed additive migrations for generated apps are implemented server-side (Phase 14), but no dashboard exposes them and no destructive change is supported. |
| Integrations | customer-owned domains/DNS, environment files. Project secrets are stored and managed (see above) but not injected into generated sites. |
| Account/product | usage, credits, payments, the platform-wide Cloudflare Cron generation scheduler, mobile builds, visitor analytics, webhooks |
| Project transfer | export, import, duplicate |

Those routes return:

```json
{
  "ok": false,
  "error": "The Mavly backend is not implemented yet.",
  "code": "BACKEND_NOT_CONFIGURED",
  "data": null
}
```

with HTTP **503** and `cache-control: private, no-store, max-age=0`.

---

## 4. Response and failure behaviour

- **Unauthenticated:** `401 UNAUTHENTICATED`.
- **Malformed project id:** `400 VALIDATION`.
- **Foreign / unregistered project:** the same non-enumerating `403 FORBIDDEN`.
- **Ownership lookup failure:** `500` (fail closed).
- **Unknown API path:** `404 NOT_FOUND` from the scope allowlist.
- **Authenticated, authorized, unimplemented:** `503 BACKEND_NOT_CONFIGURED`.
- **Agent run conflicts:** `409`; stale in-flight runs are closed after ten minutes.
- **Missing OpenRouter key:** `503 BACKEND_NOT_CONFIGURED`, before any project is created or run admitted.
- **Supabase integration not configured:** `503 SUPABASE_INTEGRATION_NOT_CONFIGURED`.
- **Not connected / reconnect required:** `409`; no upstream call is attempted after a
  terminal refresh failure.
- **OAuth state missing or expired:** `400`; the callback redirects with a stable reason.
- No secrets, stack traces, token ciphertext or filesystem paths are returned in API
  responses.

---

## 5. Security invariants

1. Identity comes from `getCurrentUser()` / `resolveVcaasContext()`, never from a cookie's
   presence, URL, body or header.
2. Project access is an owned row read through the caller's RLS client. Missing and foreign
   rows are indistinguishable.
3. `OPENROUTER_API_KEY` is server-only; it serves active generation and the separate image
   feature. Only the `NEXT_PUBLIC_*` Supabase/URL values are public. No secret is committed.
4. The OpenRouter chat-completions and image URLs are constant. Route parameters only select a Supabase
   row after ownership is proved.
5. Generated output is text. It is validated and stored; it is never imported, transpiled,
   evaluated or executed on a Mavly host. The only exception is the opt-in verification
   build, which runs only inside an isolated provider microVM on a validated immutable
   snapshot with restricted egress and no project/service credentials. Generated website
   imagery is public content in the public-read `project-images` bucket at a server-derived
   path; its plan/asset rows stay owner-only through `projects` RLS, and no project file,
   secret, provider credential or APK is ever written there.
6. The preview has a CSP `sandbox` without `allow-same-origin`, plus `default-src 'none'`,
   inline-only scripts/styles and `frame-ancestors 'self'`. It cannot act as the signed-in
   user.
7. Child-table RLS requires an owned `public.projects` row. The only privileged client is
   the durable worker's (`src/lib/supabase/worker.ts`), confined to the worker orchestrator,
   scheduled Cloudflare entrypoint and the verification tick it invokes. `project_verifications`
   exposes only an owner SELECT policy and owner cancellation; all other mutations are
   service-role RPCs.
8. Mavly sign-in OAuth still sends no custom `state`, and its callback stays a bare
   `/auth/callback` with the destination in the `mavly_oauth_next` cookie.
9. Customer-owned Supabase OAuth is retired. Mavly sign-in remains the internal
   `/auth/callback` OAuth path only.
10. Integration tokens where implemented are AES-256-GCM ciphertext with
    user/purpose associated data. `MAVLY_INTEGRATION_ENCRYPTION_KEY` and the OAuth client
    secret are server-only. Tokens never reach the browser.

---

## 6. Files involved in implemented features

- `src/lib/ai/models.ts` — text-model catalog, default resolution, task routing scaffold.
- `src/lib/ai/image-models.ts` — the one-entry image-model catalog (locked Recraft slug,
  verified aspect-ratio enum, $0.007/image) and image-request validation.
- `src/lib/images/policy.ts`, `manifest.ts`, `prompt.ts`, `service.ts`, `store.ts`,
  `asset-store.ts` — planning-driven website imagery: backend-owned limits and approval,
  plan validation, prompts, the bounded stage, the migration-33 RPC wrappers and Storage.
- `src/lib/ai/openrouter-images.ts` — the image API client (`/api/v1/images`), response
  validation and bounded retry. Server-only key.
- `src/lib/mavly/image-limits.ts` — best-effort per-user/per-instance request admission.
- `src/lib/image-generation-options.ts` — aspect-ratio/format constants shared by the
  server validation and the workspace panel.
- `src/lib/ai/chat-contract.ts` — the provider-neutral chat-completions contract used by
  OpenRouter: result types, response parsing, token/cost extraction and failure
  classification. Pure.
- `src/lib/ai/openrouter.ts` — the default OpenRouter chat-completions call, its streamed
  transport (idle-progress and absolute caps), catalog gate and redacted failures;
  server-only key.
- `src/lib/ai/stream-contract.ts` — pure SSE accumulation and the strict completion
  verdict (partial text is never a result).
- `src/lib/ai/provider.ts` — the fixed OpenRouter boundary for completion calls and
  configuration errors.
- `src/lib/ai/agent.ts` — prompt, JSON parsing/repair, path and size validation.
- `src/lib/mavly/store.ts` — Supabase persistence through the caller's client.
- `src/lib/mavly/run-agent.ts` — claim → baseline → checkpointed batches → complete/fail.
- `src/lib/ai/retry.ts` — bounded retry/backoff/`Retry-After`.
- `src/lib/mavly/checkpoints.ts` — verification of resumed batch hashes.
- `src/lib/mavly/api.ts` — implemented route handlers and response mapping.
- `src/lib/mavly/snapshots.ts` — restore-point storage and the content hash.
- `src/lib/runtime/` — generated-project runtime detection (App Router only), package
  manifest validation, the bounded build plan and the fixed loopback runtime start.
- `src/lib/sandbox/adapter.ts` — provider-neutral verification operations and typed
  failures.
- `src/lib/sandbox/vercel-sandbox.ts` — the Vercel Sandbox microVM adapter (upload,
  detached commands, logs, destruction). `src/lib/sandbox/e2b.ts` is a typed
  `not_implemented` stub; there is no local fallback.
- `src/lib/sandbox/policy.ts` — snapshot/path/secret/hash validation, script safety,
  fixed runtime/health commands, egress allowlist and diagnostics redaction.
- `src/lib/sandbox/state.ts` | `config.ts` | `store.ts` | `enqueue.ts` |
  `verification.ts` — the public result model and budgets, opt-in verification/repair
  configuration, fenced persistence, idempotent enqueue and the bounded tick.
- `src/lib/sandbox/repair.ts` — bounded repair eligibility, context, protected-path
  refusal, response parsing and one provider call per attempt.
- `supabase/migrations/17_verification_sandbox.sql` — verification table, leases, fenced
  completion, recovery, orphan cleanup, owner cancellation and schema marker 17.
- `supabase/migrations/19_runtime_verification.sql` — runtime/health/preview/repair state,
  the runtime-enforced `passed` rule and schema marker 19.
- `docs/architecture/phase-3-verification-sandbox.md`,
  `docs/architecture/phase-4-runtime-verification.md` and
  `docs/runbooks/verification-sandbox.md` — baseline, current design and operator runbook.
- `src/lib/mavly/restore.ts` — the restore itself, with its recovery point.
- `src/lib/integrations/github/` — the GitHub App client, the file policy and the
  store.
- `src/lib/integrations/figma/` — the Figma PAT client, encryption, store, live
  validation and bounded design-context reader.
- `src/lib/figma-url.ts` — pure Figma link parsing shared by the composer and server.
- `src/lib/github-client.ts` — the browser's GitHub catalog (no credential).
- `src/app/api/vcaas/[...path]/route.ts` — auth/scope/ownership, then dispatcher or 503.
- `src/app/api/vcaas/source-code/[projectId]/route.ts` — generated ZIP.
- `src/app/api/preview/[projectId]/[[...path]]/route.ts` — sandboxed preview.
- `supabase/migrations/03_ai_builder.sql` — tables, indexes, RLS and update policy.
- `supabase/migrations/04_supabase_integration.sql` — connection/state tables and RLS.
- `supabase/migrations/07_project_deployments.sql` — one deployment mapping per project,
  constrained status, RLS inherited from `public.projects`.
- `supabase/migrations/13_deployment_unpublish.sql` — `unpublishing`/`unpublished` statuses
  and `last_unpublished_at`, additive over the existing mapping rows.
- `supabase/migrations/08_figma_integration.sql` — the encrypted per-project Figma
  connection, with ownership inherited from `public.projects`.
- `supabase/migrations/09_mavly_deployment_domains.sql` — Mavly hostname and domain
  verification state on the deployment mapping; legacy rows stay NULL.
- `src/lib/mavly-hostname.ts` — pure `<project-id>.mavly.xyz` derivation.
- `src/lib/vercel/config.ts` — opt-in gate and server-only Vercel configuration.
- `src/lib/vercel/provider.ts` — fixed-origin Vercel REST client, deterministic names,
  project-domain assignment/verification, domain detach and deployment removal.
- `src/lib/deployments/store.ts` — RLS-scoped deployment persistence, publish claim and the
  optimistic unpublish claim/finish/release lease.
- `src/lib/deployments/service.ts` — publish/unpublish/status orchestration, domain gating,
  stale-claim reconciliation and cleanup.
- `src/lib/project-activity.ts` — shared project-activity types and range helper.
- `src/components/workspace/v2/ProjectActivityModal.tsx` — real generation-run activity panel.
- `.env.example` — model placeholders plus server-only integration encryption keys
  placeholders. It contains no real secrets.

The Totalum client `src/lib/vcaas-server.ts` remains deleted and must not be recreated.

---

## 7. Remaining references and limitations

- `src/lib/vcaas.ts` remains the same-origin client catalog. Its comments and some response
  types still describe the former platform.
- Some UI copy and billing links still name Totalum. They are display text, not runtime
  dependencies, and are intentionally untouched until a UI task covers them.
- Uploads are not implemented. A prompt with attachments still runs, but the files are not
  sent to the model.
- The preview is static. Editing source files does not rebuild or rerun the generated app;
  `preview.html` must itself be regenerated by the agent for a visual change. An imported
  static site is served as-is; a framework entry point that needs a build is reported as
  unsupported.
- `rebuildRequired` is `false` after a file save because there is no rebuild service.
- Migrations are not applied automatically. Apply `03_ai_builder.sql` before using the
  builder, `04_supabase_integration.sql` before using the Supabase connection,
  `07_project_deployments.sql`, `09_mavly_deployment_domains.sql` and
  `13_deployment_unpublish.sql` before enabling publishing/unpublishing,
  `14_shared_hosting.sql` + `15_shared_hosting_attempt_state.sql` before enabling shared
  hosting, `16_durable_generation_worker.sql` before enabling the durable worker,
  `17_verification_sandbox.sql` (after 16) and then `19_runtime_verification.sql` (after
  17) before enabling verification, and
  `08_figma_integration.sql` before using Figma. Apply
  `30_managed_backends.sql` after `29_multi_agent_orchestration.sql`, and
  `35_managed_backend_runtime.sql` after 34 and 30, before enabling managed Neon
  provisioning and the generated-app data API; both also require the approved Neon Agent
  Plan enrollment and server-only operator configuration (including
  `MAVLY_APP_GATEWAY_ORIGIN` and `MAVLY_MANAGED_BACKENDS_RPC_SECRET`).
- The verification sandbox is off by default, applies only to worker-dispatched runs, and
  is not proven against a live provider by this document. `passed` means the production
  build exited `0`, the validated runtime started on loopback, and a sandbox-local health
  request returned `2xx`/`3xx`; it does not prove correctness, backend execution, a browser
  render, or a hosted preview. Unsupported formats return `unsupported_runtime`. Preview is
  unavailable because no authenticated proxy exists. Bounded repair is separately opt-in
  and never edits `project_files`. Wildcard/plan prerequisites and cost limits remain
  operator decisions; see `docs/runbooks/verification-sandbox.md`.
- Publishing is disabled by default and publishes only the static preview. It does not
  build generated source, does not host generated APIs and does not provide
  customer-supplied custom domains. Each new publish does get a Mavly-owned
  `<project-id>.mavly.xyz` address once the deployment and Vercel domain verification are
  ready. Unpublishing detaches that domain and removes the production deployments; it keeps
  the project, files and mapping for a republish. Deleting a Mavly project attempts a
  best-effort Vercel cleanup; a failure leaves an orphan Vercel project and does not fail the
  local delete.
- The Supabase connection is account-level. It is not linked to individual Mavly
  `projects.project_id` rows, and it grants no SQL/schema/data access in Phase 1.
- The workspace More view supports project metadata editing, project secrets, the derived
  Mavly address and real generation activity. API keys, visitor analytics and custom
  domains have no local backend and render an explicit unavailable state instead of
  calling the former platform routes. Usage and payments remain deferred with the
  credits/billing scope. The former scheduler, mobile-builds and runtime-logs sections
  were removed from More; Android source generation and its debug build remain.
- Project secrets require `supabase/migrations/11_project_secrets.sql` and the server-only
  `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` (32 random bytes, base64). The migration and key
  are not applied automatically.
- Website/code generation uses server-only `OPENROUTER_API_KEY` from the Next.js runtime;
  the same key serves image generation. The runtime
  is Vercel/Next.js `nodejs` with `after()` scheduling; this repository has no Supabase
  Edge Function or autonomous worker that needs the key. Configure it in Vercel Project
  Environment Variables and redeploy, and in local `.env.local` for development.
- Verification requires the durable-worker prerequisites plus
  `MAVLY_VERIFICATION_SANDBOX_ENABLED`, an explicit `MAVLY_VERIFICATION_SANDBOX_PROJECTS`
  cohort, `MAVLY_VERIFICATION_SANDBOX_PROVIDER=vercel`, and either `VERCEL_OIDC_TOKEN` +
  `VERCEL_PROJECT_ID` or the access-token triple `VERCEL_TOKEN` + `VERCEL_TEAM_ID` +
  `VERCEL_PROJECT_ID`. All are server-only. A half-configured deployment disables
  verification and leaves generation unchanged; `e2b` is not implemented. Bounded repair
  is separately opt-in through `MAVLY_VERIFICATION_REPAIR_ENABLED` and
  `MAVLY_VERIFICATION_MAX_REPAIRS` (`0..2`, default 1) and also needs `OPENROUTER_API_KEY`; it
  never changes whether verification itself is configured.
- Image generation is operator-cost-bearing but user-unbilled: it uses
  `OPENROUTER_API_KEY` and is outside the generation credit foundation. The active
  generation path reads the same server key, so both share one provider account. Pricing
  images is a separate product decision; no image charge was invented. The standalone
  `/images/generate` route persists nothing and has no caller. Planning-driven website
  imagery is the persisted path: it needs `MAVLY_IMAGE_PLANNING_ENABLED`, migration 33 and
  the model's verified provider price ($0.007/image) as an operator budget; nothing about
  it is charged to user credits.
- A real Supabase OAuth app is required. Scopes are app-level:
  `organizations:read` and `projects:read`.
- Changing `MAVLY_INTEGRATION_ENCRYPTION_KEY`, the OAuth client ID or the OAuth app makes
  stored connections undecryptable; users must reconnect.
- `MAVLY_DEFAULT_MODEL` selects from the OpenRouter catalog; the verified default is
  `deepseek/deepseek-v4.1-flash`. The client refuses a model ID outside that catalog.

---

## 8. Historical verification results at disconnection time (exact)

These results belong to the earlier disconnection task. They are **not** a verification of
the AI builder or the Supabase connection, neither of which has been run under this
document.

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | 467 packages installed; 10 pre-existing advisories reported |
| Unit tests | `npm test` | **152 tests, 152 pass, 0 fail** |
| Typecheck | `npx tsc --noEmit` | **Pass** (no output) |
| Lint | `npm run lint` | **0 errors**, 16 warnings (all pre-existing unused disable directives) |
| Production build | `npm run build` | **Pass** |
| Homepage smoke | `GET http://localhost:3010/` | `200 text/html` |
| Sign-in page smoke | `GET /login` | `200 text/html` |
| Signed-out dashboard | `GET /dashboard` | `303` → `/login?redirect=%2Fdashboard&error=not_configured` |
| Config contract | `GET /api/config` | `200` → `{"ok":true,"data":{"configured":false}}` |
| Anonymous backend call | `GET /api/vcaas/projects` | `401` → `{"ok":false,"code":"UNAUTHENTICATED"}` |
| Anonymous project read | `GET /api/vcaas/projects/demo` | `401` → `UNAUTHENTICATED` |
| Anonymous source download | `GET /api/vcaas/source-code/demo` | `401` → `UNAUTHENTICATED` |
| Anonymous preview | `GET /api/preview/demo` | `401` → `UNAUTHENTICATED` |
| Anonymous visual edit | `POST /api/visual-edit/demo/apply` | `401` → `UNAUTHENTICATED` |

**Ongoing rule:** agents must not run tests, lint, typecheck, builds, dev/start servers,
browser automation or smoke probes. The human developer runs those checks before merge.
Static inspection and `git diff` remain allowed. See `AGENTS.md`
("Non-negotiable verification policy").

---

## 9. Next steps

1. Apply `03_ai_builder.sql` and `04_supabase_integration.sql`; run the human verification
   suite.
2. Run a real OAuth check with a configured Supabase app: connect, discover, select,
   refresh, disconnect and confirm revocation.
3. Verify any future OpenRouter model IDs against the official OpenRouter model catalog
   before adding them to `src/lib/ai/models.ts`.
4. Add a real build/run sandbox if generated backends must execute; do not fake it.
5. Implement uploads and rebuild status only behind explicit product approval. Static
   publishing already exists behind an operator flag; confirm Vercel plan eligibility
   before enabling it, and add dynamic hosting only after a separate product/security
   review.
6. Update remaining Totalum UI copy in a dedicated UI pass.
