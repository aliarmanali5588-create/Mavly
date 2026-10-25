# AGENTS.md — Mavly

Mavly is an AI app-builder built with Next.js 16, React 19, TypeScript and Tailwind 4.
Supabase Auth (Google + GitHub OAuth) is real and gates the builder pages. The builder now
has a local, server-side AI implementation: OpenRouter generates frontend and backend
source files, Supabase stores projects/files/messages/runs, and the workspace previews a
generated static `preview.html`. A separate user-owned Supabase connection lets a signed-in
user authorize read-only organization/project access and select one external project.

Read `MAVLY_CLEAN_BASELINE.md` before changing anything under `src/app/api/`,
`src/lib/ai/`, `src/lib/mavly/` or `src/lib/vcaas*`. It records what was removed and what
the current implementation does.

> **Do not reconnect Totalum or add another hosted builder backend implicitly.** The old
> Totalum integration stays removed and is documented only for historical context below.
> OpenRouter is the approved model provider. Any additional provider or backend is a
> product decision that needs explicit approval and a security review.

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
cp .env.example .env.local       # Supabase + OpenRouter + OAuth + optional publishing
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
`07_project_deployments.sql` and `09_mavly_deployment_domains.sql` before enabling
publishing, and `08_figma_integration.sql` before using Figma. `npm test` covers the pure
auth/redirect/ownership/scope modules and static route invariants. It does not exercise a
real Supabase session, OpenRouter, the Supabase OAuth connection, Vercel publishing, or a
generated app.

---

## Current backend status

- The builder's only model dependency is **OpenRouter**, called server-side from
  `src/lib/ai/openrouter.ts`. Do not add another model provider or hosted builder backend
  without approval.
- **Vercel publishing is an optional, off-by-default hosting path**, not a builder backend.
  It is enabled only by `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` (accepted: `1`, `true`, `yes`,
  `on`) plus `VERCEL_API_TOKEN`, and uploads only static files. It prefers the generated
  standalone `preview.html`; an imported repository is publishable only when it already
  contains `index.html` or `public/index.html` and its sibling static assets. Each publish
  attaches the server-derived `<project-id>.mavly.xyz` domain; success requires both the
  deployment and a Vercel-verified domain. The operator must configure
  `mavly.xyz` DNS/wildcard resolution and confirm certificates before enabling. Do not
  enable it in a real deployment until the operator has confirmed Vercel plan/terms
  eligibility for Mavly-managed customer hosting; see `MAVLY_VERCEL_DEPLOYMENTS.md`.
- `src/lib/vcaas-server.ts` was deleted and must not be recreated. No Totalum host, key or
  forwarding remains.
- Implemented paths authenticate, check `/api/vcaas` scope and project ownership, then use
  Supabase through the caller's RLS-scoped client:
  - project list/create/launch/get/update/delete;
  - `agent/start`, `agent/status`, `agent/full-conversation`;
  - `files/tree`, `files/content` (GET/PUT);
  - `deployments/deploy` (POST) and `deployments/status` (GET), which fail closed with
    `BACKEND_NOT_CONFIGURED` unless publishing is explicitly enabled and configured.
- Dedicated routes serve the generated source ZIP (`/api/vcaas/source-code/{id}`) and the
  sandboxed static preview (`/api/preview/{id}/`).
- The user-owned Supabase connection is account-level and separate from Mavly
  `public.projects`. Implemented: OAuth start, status, organization/project discovery,
  verified selection and disconnect under `/api/integrations/supabase/`; callback at
  `/auth/supabase/callback`. Tokens are AES-256-GCM ciphertext in
  `supabase_integrations`; single-use OAuth state lives in `supabase_oauth_states`.
  Database browsing, SQL, schema changes and per-project linking are not implemented.
- **Generation jobs are durable per run.** `project_runs.stage` records
  `queued/validating/generating/retrying/completed/failed/cancelled/interrupted`;
  `project_run_batches` stores a validated batch and per-path SHA-256 hashes. A run plans a
  manifest, generates bounded batches and checkpoints each one; `finish_reason: "length"`
  is never success, and a resume skips only paths whose current content still matches.
  `create_generation_job` is the atomic admission gate (one active run per project, 2 per
  user, 8 global, serialized with a Postgres advisory lock; a trigger re-checks the
  limits on resume). `agent/resume` and `agent/stop` are user-authenticated. Run,
  manifest and heartbeat writes carry the run's `claimed_at` lease (checkpoints are
  written between lease checks), so a resumed run cannot be finalized by a stale worker. `after()` is still opportunistic: there is no
  autonomous worker, so an external worker would need a service-role design and review.
- **Restore points are implemented.** Every completed AI execution that changes the
  project's source leaves a durable snapshot (`project_snapshots` +
  `project_snapshot_files`). The chat renders a **Restore Code** action on that execution,
  and `POST /api/vcaas/projects/{id}/snapshots/{snapshotId}/restore` puts the project back
  to the state from BEFORE the run. The restore captures the pre-restore state first, so a
  restore is itself recoverable. It needs no GitHub connection.
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
- Anything not implemented (uploads, rebuild, dynamic hosting, domains,
  versions, secrets, usage, visual-edit apply, …) still authenticates and authorizes, then
  returns:

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
- Generated code is **never executed** on the Mavly server. There is no build sandbox, so
  the preview is a static entry point: the generated `preview.html`, or an imported
  `index.html` / `public/index.html` with its local assets. Backend endpoints exist only as
  source in the project files. Publishing uploads those static bytes; it does not build
  generated or imported source. A framework entry point that needs a build is reported as
  unsupported, not shown as a blank success.
- `OPENROUTER_API_KEY` is server-only. `MAVLY_DEFAULT_MODEL` selects the default catalog
  model; the built-in default is `deepseek/deepseek-v4.1-flash`. `VERCEL_API_TOKEN` is also
  server-only and is never stored in the database or returned to a browser.
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
   │      ├── src/lib/mavly/run-agent.ts background run after the response
   │      │      └── src/lib/ai/agent.ts → src/lib/ai/openrouter.ts
   │      └── src/lib/deployments/*      opt-in static publish
   │             ├── store.ts            project_deployments (RLS)
   │             └── service.ts → src/lib/vercel/provider.ts → api.vercel.com
   ├── /api/vcaas/source-code/{id} auth + ownership → ZIP from project_files
   ├── /api/preview/{id}/…         auth + ownership → sandboxed static site
   ├── /api/vcaas/upload|env|git-diff
   │                               auth + ownership → 503
   ├── /api/visual-edit/.../apply  auth + ownership → 503
   ├── /api/vcaas/backup-download  auth + ownership → 503
   ├── /api/integrations/supabase/* auth → encrypted OAuth connection
   │      └── src/lib/integrations/supabase/* → api.supabase.com
   ├── /auth/supabase/callback      auth → state/PKCE → encrypted token save
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
| `src/lib/mavly/run-agent.ts` | Background run: claim → baseline → checkpointed batches → complete/fail; cooperative cancel. |
| `src/lib/ai/retry.ts` | Bounded exponential retry, jitter and `Retry-After` parsing. |
| `src/lib/mavly/checkpoints.ts` | Pure verification of resumed batch hashes. |
| `supabase/migrations/10_generation_jobs.sql` | Run lifecycle columns, batch checkpoints, admission RPC and RLS. |
| `src/lib/mavly/snapshots.ts` | Restore points: create, list, read, and the content hash of a source state. |
| `src/lib/mavly/restore.ts` | Restoring a source state, with the pre-restore recovery point and the stale-restore check. |
| `src/lib/integrations/github/` | The GitHub App client: config, encryption, OAuth, the Git database API, the file policy, the store, the service. |
| `src/lib/integrations/figma/` | The Figma PAT client: config, encryption, token store, `/v1/me` validation, frame reading, file-link resolution and the agent's bounded design context. |
| `src/lib/figma-url.ts` | Pure, host-anchored Figma link parsing shared by the composer and the server. |
| `src/lib/github-client.ts` | The browser's GitHub catalog. It never carries a credential. |
| `src/lib/ai/agent.ts` | Prompt, JSON parsing/repair, path and size validation. |
| `src/lib/ai/openrouter.ts` | The only outbound builder call; server-only key. |
| `src/lib/ai/models.ts` | Model catalog and task routing scaffold. |
| `src/lib/mavly-hostname.ts` | Pure derivation of `<project-id>.mavly.xyz` from the immutable, owned project id. |
| `src/lib/vercel/` | Server-only opt-in config and the fixed-origin Vercel REST client, including project-domain assignment/verification. |
| `src/lib/deployments/` | Publish orchestration, domain gating and RLS-scoped deployment mapping. |
| `supabase/migrations/07_project_deployments.sql` | Deployment mapping table, constraints and ownership RLS. |
| `supabase/migrations/09_mavly_deployment_domains.sql` | Mavly hostname/domain state on the deployment mapping, with legacy rows left NULL. |
| `supabase/migrations/08_figma_integration.sql` | Per-project encrypted Figma connection with project-inherited RLS. |
| `src/lib/project-ownership.ts` | Ownership registration helpers, idempotent insert, owned-id filtering. |
| `src/lib/vcaas-errors.ts` | Client error-code vocabulary, including `BACKEND_NOT_CONFIGURED`. |
| `src/lib/integrations/supabase/` | Server-only OAuth client, encryption, state/token storage, token refresh and browser API client. |
| `src/app/api/integrations/supabase/` | Account-level start/status/discovery/select/disconnect routes. |
| `src/app/auth/supabase/callback/route.ts` | User-owned Supabase OAuth callback. |
| `supabase/migrations/` | `profiles`, `projects`, AI builder tables/RLS, Supabase connection/state tables, GitHub/Figma connections, deployment mapping and Mavly domain state, backfill template. |

## Security invariants

1. **A session is verified server-side.** Use `getCurrentUser()` / `resolveVcaasContext()`;
   never infer identity from a cookie's presence, URL, body, or header.
2. **Project access is a row in `public.projects` for `(project_id, user_id)`**, read
   through the caller's RLS-scoped Supabase client. Missing and foreign rows must return
   the same non-enumerating 403. Lookup errors fail closed with 500.
3. **No secret reaches the browser.** Only `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` are public. `OPENROUTER_API_KEY` and
   `VERCEL_API_TOKEN` are server-only and must never be renamed with a `NEXT_PUBLIC_`
   prefix. Never commit `.env*` files.
4. **Any future server route that fetches a client-supplied URL is an SSRF hole until it
   calls `publicUrlRejectionReason` (async, resolves DNS) from `src/lib/safe-url.ts`, with
   `redirect: "error"` and a timeout.** The synchronous `urlRejectionReason` is for IP
   literals only. Both must cover IPv4-mapped IPv6 and every private range. OpenRouter and
   the Vercel API are fixed server-side URLs, not client-supplied ones.
5. **Never build an upstream URL from decoded route params.** The OpenRouter and Vercel API
   origins are constant; route params only select a Supabase row after ownership is
   proved, and Vercel ids/names come from that row or server-side derivation. The Mavly
   hostname is derived only from the immutable, owned project id; a browser never supplies
   a hostname.
6. **Generated code is data, not code.** The agent's files are validated (`sanitizeProjectPath`,
   file/total size caps) and stored as text. Never import, transpile, `eval`, or run them.
   The preview is static HTML served with a CSP `sandbox` and no same-origin privileges.
7. **OAuth has two traps.** Do not send a custom `state` to Supabase (PKCE owns it), and
   the Mavly sign-in callback URL must be a bare `/auth/callback` with no query string. The
   destination rides in the `mavly_oauth_next` cookie. Keep Supabase's allowed-redirect
   list tight. The user-owned Supabase integration has its own callback
   (`/auth/supabase/callback`) where a custom state is required and verified.
8. **Integration tokens are ciphertext.** AES-256-GCM encryption uses
   `MAVLY_INTEGRATION_ENCRYPTION_KEY`, which is server-only. OAuth access/refresh tokens,
   PKCE verifiers and stored Figma access tokens must never be returned to the browser or
   written to logs.
   `SUPABASE_OAUTH_CLIENT_SECRET` is also server-only. Scopes are `organizations:read` and
   `projects:read`; do not add write scopes without explicit approval.
9. **Child tables inherit ownership through `projects` RLS.** `project_files`,
   `project_messages`, `project_runs`, `project_deployments` and `figma_connections` are
   never queried with a service-role key; their policies require an owned parent row.
   `supabase_integrations` and `supabase_oauth_states` are user-scoped through their own
   RLS policies.

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
