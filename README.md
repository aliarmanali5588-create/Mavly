# Mavly

Mavly is an AI app-builder built with Next.js 16, React 19, TypeScript and Tailwind 4. It
includes the dashboard, project workspace, prompt composer, preview frame, code/visual
editor surfaces and settings dialogs of an AI app builder.

> **Current status: local AI builder.** Supabase authentication and project ownership are
> real. OpenRouter, called only from the server, generates a complete frontend and backend
> project. Supabase stores the generated source, conversation and run state; the workspace
> previews the generated static `preview.html`. A user-owned Supabase account can also be
> connected through OAuth to list and select one of its projects. An **opt-in, off-by-default**
> publishing path can upload the standalone preview to a Mavly-managed Vercel account as a
> static site; it is not a dynamic backend host. Other platform features still return an
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
| Agent generation | OpenRouter, server-side, with validated file output |
| Conversations and run status | Persisted in Supabase and polled by the workspace |
| Project files | Generated source tree, file reads and file saves |
| Source download | ZIP built from stored project files |
| Preview | Sandboxed static `preview.html` |
| Supabase account connection | OAuth with PKCE, encrypted server-side tokens, organization/project discovery and one selected project |
| Figma design reference | Personal access token validated with Figma, encrypted per project, and a bounded design summary injected into generation |
| Publishing (opt-in, disabled by default) | Static `preview.html` → deterministic Vercel project, published at `<project-id>.mavly.xyz`; deployment and domain state persisted and polled. Requires `MAVLY_VERCEL_DEPLOYMENTS_ENABLED=1`, `VERCEL_API_TOKEN` and operator-configured `mavly.xyz` DNS/SSL. See [`MAVLY_VERCEL_DEPLOYMENTS.md`](MAVLY_VERCEL_DEPLOYMENTS.md). |
| `/api/config` | `200 { "ok": true, "data": { "configured": false } }` |
| Visual shell | Dashboard, workspace, chat, composer, dialogs and preview frame render |

Generated code is **never executed** on this server. A generated backend exists as source
files, not as a running service.

## What does not work yet

Uploads/attachments, rebuilds, database browsing, schema changes, SQL execution,
customer-owned custom domains, logs, analytics, mobile builds, payments, cron, usage,
credits, secrets, versions and visual edits do not have a local implementation. Publishing
is limited to the static preview: generated Next.js source is not built, and generated API
routes are not deployed. Dynamic hosting, customer custom domains and multi-file
deployments remain unavailable. Each new publish does get a Mavly-owned
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
   │      │      └── src/lib/ai/agent.ts → src/lib/ai/openrouter.ts
   │      └── src/lib/deployments/*      opt-in publish orchestration
   │             ├── store.ts            project_deployments (RLS)
   │             └── service.ts → src/lib/vercel/provider.ts → api.vercel.com
   ├── /api/vcaas/source-code/{id} auth + ownership → generated ZIP
   ├── /api/preview/{id}/…         auth + ownership → sandboxed preview.html
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
- **Generation:** `after()` in the route handler runs the agent after the response, reading
  the current files as context and validating every returned path and size before writing.
- **Publishing:** disabled unless `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` is one of
  `1`/`true`/`yes`/`on` and `VERCEL_API_TOKEN` is set. The server uploads only
  `preview.html` as a static `index.html`, creates one deterministic Vercel project per
  Mavly project, attaches the derived `<project-id>.mavly.xyz` domain, and records
  deployment plus domain status in `project_deployments`. Success requires both the
  deployment and the verified domain. The browser never calls Vercel and never supplies a
  Vercel id, URL or hostname.
- **Supabase connection:** authorization-code flow with PKCE, a single-use state row and
  AES-256-GCM encrypted access/refresh tokens. The selected external project is stored per
  Mavly account, separately from `public.projects.project_id`.
- **Client API surface:** components call the catalog in `src/lib/vcaas.ts`, never the
  route paths directly.

## Local setup

Requirements: Node.js 20+ and npm. Supabase is needed for sign-in, project access and
storage. An OpenRouter API key is needed for generation.

```bash
npm install
cp .env.example .env.local
```

Set these in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-key
NEXT_PUBLIC_APP_URL=http://localhost:3000
OPENROUTER_API_KEY=sk-or-...
MAVLY_DEFAULT_MODEL=deepseek/deepseek-v4.1-flash

SUPABASE_OAUTH_CLIENT_ID=your-oauth-app-client-id
SUPABASE_OAUTH_CLIENT_SECRET=your-oauth-app-client-secret
SUPABASE_OAUTH_REDIRECT_URI=http://localhost:3000/auth/supabase/callback
MAVLY_INTEGRATION_ENCRYPTION_KEY=your-32-byte-base64-key

# Optional, off by default. Read the eligibility warning first.
MAVLY_VERCEL_DEPLOYMENTS_ENABLED=
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_PREFIX=mavly
```

Only the two `NEXT_PUBLIC_SUPABASE_*` values and `NEXT_PUBLIC_APP_URL` are public.
`OPENROUTER_API_KEY`, the OAuth client secrets, `MAVLY_INTEGRATION_ENCRYPTION_KEY` and
`VERCEL_API_TOKEN` are server-only: never prefix them with `NEXT_PUBLIC_`, never commit
them, and set a spend limit at OpenRouter. Never put a service-role key in this app.

Apply the schema in `supabase/migrations/` with the Supabase CLI (`supabase db push`) or by
pasting the migrations into the Supabase SQL editor. `03_ai_builder.sql` creates the file,
message and run tables. `04_supabase_integration.sql` creates the encrypted connection and
OAuth state tables. `07_project_deployments.sql` creates the deployment mapping used only
when publishing is enabled, and `09_mavly_deployment_domains.sql` adds the Mavly-owned
domain state. `08_figma_integration.sql` creates the encrypted per-project Figma
connection. Configure the Mavly sign-in redirect as a bare `/auth/callback` URL
with no query string, and keep Supabase's redirect allow-list tight.

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
to start a run instead of pretending it did.

## Verification

The repository owner runs checks manually before merge:

```bash
npx tsc --noEmit
npm test          # Node 22.6+
npm run lint
npm run build && npm start
```

Unit tests cover the pure auth/redirect/ownership/scope modules and static route
invariants. They do not exercise a real Supabase session, OpenRouter, the Supabase OAuth
connection, or a generated app. A manual OAuth check needs a real Supabase OAuth app:
connect, verify organization/project discovery, save a selection, refresh the page,
disconnect, and confirm the grant is revoked. A manual publish check requires a real Vercel
token and explicit eligibility approval; see
[`MAVLY_VERCEL_DEPLOYMENTS.md`](MAVLY_VERCEL_DEPLOYMENTS.md). See [`AGENTS.md`](AGENTS.md) for the rules
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
