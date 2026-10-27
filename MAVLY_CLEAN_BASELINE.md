# Mavly — Clean Backend Baseline

**Status:** local AI builder, Phase 1 user-owned Supabase connection, an off-by-default
static-publishing path, an off-by-default durable generation worker, and an off-by-default
isolated verification sandbox implemented; the
rest of the platform backend remains unavailable.
**Scope:** the Totalum VCaaS integration stays removed. Supabase authentication, OAuth,
sessions, project ownership and RLS are preserved. Groq is the active server-only
website/code-generation provider. The existing OpenRouter chat client, model catalog and
key support are preserved but are not called by the active generation path; image
generation continues to use OpenRouter. Vercel is used only when an operator explicitly
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
| Project type and Android workspace | `public.projects.project_type` (migration 22) distinguishes `website` and `android`. Android projects are created idempotently (migration 25), appear as Android in dashboard cards, and open a Kotlin/Compose source workspace using the same authorized `/project/{id}` route. Android prompts use the same durable generation pipeline with a native profile; the resulting complete source is re-validated by `src/lib/android/contract.ts`. Optional, cohort-gated isolated debug builds are implemented in migration 26 and the generation worker: a pinned toolchain image builds an immutable snapshot offline, validates the APK and stores it privately for an owner-authorized short-lived download. Release signing, AABs, store publishing and emulator/device preview remain unavailable and are reported as such. |
| AI generation | The active `src/lib/mavly/run-agent.ts` → `src/lib/ai/agent.ts` → `src/lib/ai/provider.ts` → `src/lib/ai/groq.ts` pipeline serves both websites (Next.js profile) and Android apps (Kotlin/Compose profile). The default execution path is still the inline `after()` run; a durable worker is available opt-in per project cohort. Worker execution rechecks the persisted project type before generation and does not enqueue the Next.js verification sandbox for an Android run. |
| Durable generation worker (opt-in) | Off unless `MAVLY_GENERATION_WORKER_ENABLED`, a ≥32-char `MAVLY_GENERATION_WORKER_SECRET`, an explicit `MAVLY_GENERATION_WORKER_PROJECTS` cohort, `SUPABASE_SERVICE_ROLE_KEY` and the Supabase URL are all configured. Admission records `dispatch_mode`; only worker-dispatched runs are claimed. An operator-supplied scheduler calls `/api/generation/worker`, which executes one job per tick under a fenced lease, renews it, recovers expired leases into bounded retries or dead letters, and never deletes accepted work. Uncohort projects remain inline. See `docs/runbooks/generation-worker.md`. |
| Verification sandbox (opt-in) | Off unless `MAVLY_VERIFICATION_SANDBOX_ENABLED`, an explicit `MAVLY_VERIFICATION_SANDBOX_PROJECTS` cohort, a Vercel provider credential, `SUPABASE_SERVICE_ROLE_KEY` and the Supabase URL are all configured, and migrations 17 then 19 are applied. Only worker-dispatched runs enqueue one verification per completed run and ready snapshot. Later worker ticks re-validate the snapshot, build it in an isolated Vercel Sandbox microVM, start the validated production server on loopback and run a sandbox-local health check. `passed` requires the build, the runtime start and a `2xx`/`3xx` health response; build-only success is never `passed`. Stages run detached and are polled across ticks; every terminal path destroys the sandbox. Unsupported formats return `unsupported_runtime`. A separately opt-in bounded AI repair (default 1, hard cap 2) may create a new immutable snapshot for a source-level failure and rerun the checks. Preview stays unavailable because there is no authenticated proxy. Status appears only in the existing authorized `agent/status` / `agent/stop` responses. See `docs/architecture/phase-4-runtime-verification.md`. |
| Generation preview | New-project plans always include `preview.html`; it is generated in its own batch. Batch parsing accepts only requested paths. Progress stages use durable run state, manifest/checkpoints, and the static-preview resolver; the UI uses an indeterminate bar rather than estimated completion percentages. |
| Preserved provider | `src/lib/ai/openrouter.ts` and its model catalog remain available but are not used by active website-generation requests. |
| Conversation and runs | Persisted in `project_messages` and `project_runs`, polled by the workspace. |
| Project settings | Owner-editable name/description through `PATCH /projects/{id}`; the derived Mavly address is read-only. |
| Project secrets | Write-only AES-256-GCM ciphertext per project/environment; API responses carry metadata only. Values are not injected into the static output. |
| Project activity | Real run history aggregated from `project_runs`; visitor analytics are not collected. |
| Project files | `project_files`; tree/content reads and content writes. |
| Image generation | `POST …/images/generate` asks `black-forest-labs/flux.2-klein-4b` through OpenRouter's dedicated image API, validates the returned PNG/JPEG and returns it as base64 to the workspace. Nothing is persisted and nothing is billed. |
| Source archive | ZIP built from `project_files`. |
| Restore points | `project_snapshots` + `project_snapshot_files`; a "Restore Code" action in the chat. |
| GitHub | A GitHub App with user-to-server tokens: connect, push, import. |
| Preview | Generated static `preview.html`, or an imported static `index.html` / `public/index.html` with local assets, served with a CSP sandbox. Framework entry points that need a build are reported as unsupported. |
| Supabase account connection | OAuth + PKCE, encrypted access/refresh tokens, organization/project discovery, one selected project. |
| Static publishing (opt-in) | Off unless `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` and `VERCEL_API_TOKEN` are set. Uploads the generated `preview.html`, or an imported static site and its local assets, as a static Vercel site, attaches the derived `<project-id>.mavly.xyz` domain, and records mapping/deployment/domain status in `project_deployments`. Success requires a ready deployment and a verified domain. **Unpublish is a real Vercel takedown** (domain detach + production deployment removal) that records `unpublished`; project/files and the republish mapping are preserved. |
| Shared tenant hosting (opt-in) | Off unless `MAVLY_HOSTING_MODE=shared` and a project cohort is configured. A publish freezes an immutable `project_published_versions` / `project_published_files` artifact, then migration 15's `activate_shared_publication` atomically links it from `project_deployments.active_version_id` and marks the attempt `ready`. The public resolver serves from that active pointer, **not** the attempt status, so republishing or a failed attempt leaves the previous version live. It serves at `<project-id>.mavly.xyz` from Mavly's own tenant runtime, which re-checks the cohort after resolution. Public access is two published-only `SECURITY DEFINER` RPCs; drafts and `project_files` are never served publicly. Unpublish deactivates the mapping without deleting history. Wildcard DNS/TLS and provider eligibility remain operator prerequisites; see `MAVLY_SHARED_HOSTING.md`. |
| `/api/config` | Still returns `{ ok: true, data: { configured: false } }`. |
| Visual shell | Dashboard, workspace, chat, composer, dialogs and preview frame render. |

Generated code is **never executed** on the Mavly server. The only execution anywhere is
the opt-in verification build, loopback runtime start and sandbox-local health check inside
an isolated provider microVM, which never runs on a
Mavly host and exposes no public port or preview URL. The generated backend exists only as
source files; the preview is the
standalone `preview.html` the model also returns.

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

The app still uses the caller's own RLS-scoped Supabase client everywhere except the
durable worker. `SUPABASE_SERVICE_ROLE_KEY` is server-only and is confined to
`src/lib/supabase/worker.ts`, the worker orchestrator, `/api/generation/worker` and the
verification tick the worker invokes; the
worker re-verifies the project owner and cohort itself. RLS is unchanged. Sandbox provider
credentials are used only by the server-side adapter and are never uploaded into a sandbox.

`supabase/migrations/04_supabase_integration.sql` adds:

- `supabase_integrations`, one row per Mavly user, with encrypted access/refresh tokens and
  optional selected-project metadata;
- `supabase_oauth_states`, short-lived hashed state with an encrypted PKCE verifier;
- RLS policies for both tables and grants for `authenticated` only.

The user-owned Supabase connection continues to use the caller's RLS-scoped client; the
service-role exception described above is limited to the generation worker.

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

The user-owned Supabase routes run authentication at the Mavly account level; project
ownership is not involved because the connection is not attached to a Mavly project.

| Path | Behaviour |
| --- | --- |
| `POST /api/integrations/supabase/start` | Creates single-use state + PKCE and returns the Supabase authorize URL. |
| `GET /api/integrations/supabase/status` | Connection summary; never returns ciphertext. |
| `GET /api/integrations/supabase/organizations` | Organizations visible to the authorized account. |
| `GET /api/integrations/supabase/projects` | Projects visible to the authorized account. |
| `POST /api/integrations/supabase/select` | Re-fetches projects, then stores verified selection metadata. |
| `POST /api/integrations/supabase/disconnect` | Revokes the grant, then deletes the local encrypted row. |
| `GET /auth/supabase/callback` | Verifies the Mavly session, consumes state, exchanges code and stores tokens. |

### Image generation

`POST /api/vcaas/projects/{id}/images/generate` generates one image with
`black-forest-labs/flux.2-klein-4b` on OpenRouter's **dedicated image API**
(`POST https://openrouter.ai/api/v1/images`), which is a different contract from chat
completions. The catalog lives in `src/lib/ai/image-models.ts` — deliberately separate
from `models.ts`, so the website-generation model cannot resolve to an image model — and
records only the parameters the provider's endpoint record accepts: `aspect_ratio`
(1:1, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 21:9, auto), `output_format` (png, jpeg), `n: 1`
and `seed`. `resolution`, `quality`, `background`, streaming and reference images are
refused rather than silently ignored; reference images would need an upload path (not
implemented) or a server-side URL fetcher (an SSRF surface).

`MAVLY_IMAGE_MODEL` selects which catalog entry the route uses. The built-in default is
`black-forest-labs/flux.2-klein-4b`, so an unset variable changes nothing. The value is
**validated against the catalog rather than forwarded**: a slug with no entry (a typo, a
chat-completions model, another provider's model) resolves to the default and never
reaches OpenRouter. Catalog validation is what makes the enforced options trustworthy —
aspect ratios, formats, `n` and seed support all come from the entry. `MAVLY_DEFAULT_MODEL`
is a different variable for the website/code-generation model and is never read by the
image path; the two catalogs share no entry.

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

The image is returned as base64 and is **not stored**: there is no binary asset pipeline
(`project_files` is text served as text by the static preview), so the workspace shows it
for the session and offers a download. There is also **no credit charge** — this build has
no credit engine (no balance, reservation, finalisation or refund), and inventing a price
would be a fake debit. The provider's own cost stays inside its server-side metadata and
is deliberately **not** returned to the browser.

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

- `MAVLY_DEFAULT_MODEL` selects the default catalog model; the built-in default is
  `openai/gpt-oss-120b`, served by Groq. The only catalog entry is sent to Groq; an
  unsupported explicit or configured model never selects another provider.
- The run plans a manifest, then requests bounded file batches. The model must return JSON
  with full file contents; one focused repair is made per malformed/empty response.
- `finish_reason: "length"` is always a failure. The truncated response is discarded, the
  batch is split, and prior validated batches remain checkpointed.
- Paths are sanitized, `.env`/`.git`/`node_modules`/build output are refused, and per-file
  and total size caps apply before anything is written.
- New projects must include `package.json`, `app/layout.tsx`, `app/page.tsx` and
  `preview.html`.
- The agent runs after the HTTP response via Next.js `after()`; the UI polls the durable
  stage and checkpoint counts. `after()` is not a worker: a terminated invocation leaves an
  unfinished run that `agent/resume` can reopen, but nothing restarts it automatically.

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
| Data platform | database browsing, SQL execution, schema changes, migrations, backups, backup download |
| Integrations | customer-owned domains/DNS, environment files. Project secrets are stored and managed (see above) but not injected into generated sites. |
| Account/product | usage, credits, payments, an included scheduler (the durable worker requires an operator-provided one), mobile builds, visitor analytics, webhooks |
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
- **Missing Groq key:** `503 BACKEND_NOT_CONFIGURED`, before any project is created or run admitted.
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
3. `GROQ_API_KEY` is server-only for active generation; `OPENROUTER_API_KEY` remains
   server-only for the separate image feature and the preserved, inactive chat client.
   Only the `NEXT_PUBLIC_*` Supabase/URL values are public. No secret is committed.
4. The Groq and OpenRouter image URLs are constant. Route parameters only select a Supabase
   row after ownership is proved.
5. Generated output is text. It is validated and stored; it is never imported, transpiled,
   evaluated or executed on a Mavly host. The only exception is the opt-in verification
   build, which runs only inside an isolated provider microVM on a validated immutable
   snapshot with restricted egress and no project/service credentials.
6. The preview has a CSP `sandbox` without `allow-same-origin`, plus `default-src 'none'`,
   inline-only scripts/styles and `frame-ancestors 'self'`. It cannot act as the signed-in
   user.
7. Child-table RLS requires an owned `public.projects` row. The only privileged client is
   the durable worker's (`src/lib/supabase/worker.ts`), confined to the worker orchestrator,
   `/api/generation/worker` and the verification tick it invokes. `project_verifications`
   exposes only an owner SELECT policy and owner cancellation; all other mutations are
   service-role RPCs.
8. Mavly sign-in OAuth still sends no custom `state`, and its callback stays a bare
   `/auth/callback` with the destination in the `mavly_oauth_next` cookie.
9. The user-owned Supabase integration uses its own `/auth/supabase/callback`. It verifies
   the Mavly session, consumes a user-bound single-use state row and uses PKCE S256.
10. Integration access/refresh tokens and the PKCE verifier are AES-256-GCM ciphertext with
    user/purpose associated data. `MAVLY_INTEGRATION_ENCRYPTION_KEY` and the OAuth client
    secret are server-only. Tokens never reach the browser.

---

## 6. Files involved in implemented features

- `src/lib/ai/models.ts` — text-model catalog, default resolution, task routing scaffold.
- `src/lib/ai/image-models.ts` — image-model catalog and image-request validation.
- `src/lib/ai/openrouter-images.ts` — the image API client (`/api/v1/images`), response
  validation and bounded retry. Server-only key.
- `src/lib/mavly/image-limits.ts` — best-effort per-user/per-instance request admission.
- `src/lib/image-generation-options.ts` — aspect-ratio/format constants shared by the
  server validation and the workspace panel.
- `src/lib/ai/groq.ts` — the active outbound website/code-generation call; server-only key.
- `src/lib/ai/provider.ts` — the provider-neutral website-generation boundary, currently
  bound only to Groq.
- `src/lib/ai/openrouter.ts` — preserved chat-completions client and OpenRouter key support;
  not called by active website-generation paths.
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
- `src/lib/integrations/supabase/*` — config, encryption, OAuth client, store, token
  lifecycle, HTTP helpers and browser client.
- `src/app/api/integrations/supabase/*` — start/status/discovery/select/disconnect routes.
- `src/app/auth/supabase/callback/route.ts` — Supabase connection callback.
- `src/components/workspace/database-v2/SupabaseDatabasePanel.tsx` — Database-tab panel.
- `src/lib/project-activity.ts` — shared project-activity types and range helper.
- `src/components/workspace/v2/ProjectActivityModal.tsx` — real generation-run activity panel.
- `.env.example` — model placeholder plus server-only Supabase OAuth/encryption key
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
  `08_figma_integration.sql` before using Figma.
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
  Mavly address and real generation activity. API keys, an included scheduler, mobile
  builds, runtime logs,
  visitor analytics and custom domains have no local backend and render an explicit
  unavailable state instead of calling the former platform routes. Usage and payments
  remain deferred with the credits/billing scope.
- Project secrets require `supabase/migrations/11_project_secrets.sql` and the server-only
  `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` (32 random bytes, base64). The migration and key
  are not applied automatically.
- Website/code generation uses `GROQ_API_KEY` from the Next.js server runtime. The runtime
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
  `MAVLY_VERIFICATION_MAX_REPAIRS` (`0..2`, default 1) and also needs `GROQ_API_KEY`; it
  never changes whether verification itself is configured.
- Image generation is operator-cost-bearing but user-unbilled: it uses
  `OPENROUTER_API_KEY` and no credit policy exists to charge against. The restored
  OpenRouter chat client also reads that server key, but the active generation path never
  calls it. Enabling billing for
  it is a product decision that needs a real credit engine first. Generated images are not
  saved to the project and are not available to the generated app; they are shown in the
  More view's Image generation section until the user leaves it.
- A real Supabase OAuth app is required. Scopes are app-level:
  `organizations:read` and `projects:read`.
- Changing `MAVLY_INTEGRATION_ENCRYPTION_KEY`, the OAuth client ID or the OAuth app makes
  stored connections undecryptable; users must reconnect.
- `MAVLY_DEFAULT_MODEL` selects from the Groq catalog; the verified default is
  `openai/gpt-oss-120b`. The client refuses a model ID outside that catalog.

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
3. Verify any future Groq model IDs against the official Groq model catalog before adding
   them to `src/lib/ai/models.ts`.
4. Add a real build/run sandbox if generated backends must execute; do not fake it.
5. Implement uploads and rebuild status only behind explicit product approval. Static
   publishing already exists behind an operator flag; confirm Vercel plan eligibility
   before enabling it, and add dynamic hosting only after a separate product/security
   review.
6. Update remaining Totalum UI copy in a dedicated UI pass.
