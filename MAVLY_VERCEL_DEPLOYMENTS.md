# Mavly-managed Vercel publishing

**Status:** implemented, **disabled by default**, and limited to static sites.
**Do not enable this in a production deployment until the eligibility prerequisite below is
confirmed by the operator.**

## Eligibility prerequisite

This feature makes Mavly submit customer apps to a Vercel account that Mavly operates. That
is hosting on behalf of third parties, not ordinary single-team use. Vercel's platform
terms restrict reselling or providing the service to third parties, and the "Vercel for
Platforms" product is the documented path for this model.

- Review <https://vercel.com/legal/terms> and
  <https://vercel.com/docs/platforms/multi-project-platforms/quickstart>.
- Confirm the commercial/plan terms directly with Vercel. Vercel routes "Vercel for
  Platforms" enquiries to sales.
- **This repository does not claim that a Hobby or Pro plan is eligible** for Mavly-managed
  customer hosting. Plan limits quoted in code comments or docs are technical limits, not a
  grant of permission.
- The feature stays behind an environment flag so it cannot be enabled accidentally.

## What gets published

Static files are published and deployed with `framework: null`. The generated
`preview.html` is uploaded as `index.html`. An imported repository is accepted only when it
already contains `index.html` or `public/index.html`; that document becomes `index.html`
and its sibling files under the same static root are uploaded alongside it.

Not published, built or executed:

- source that needs a framework build, such as `pages/`, `app/`, or a Vite/CRA entry;
- generated or imported API routes and backend code;
- project dependencies;
- environment variables or secrets;
- customer-supplied custom domains, redirects or server functions. Mavly does attach its
  own `<project-id>.mavly.xyz` hostname to the static deployment.

The generated preview is standalone HTML with inline CSS/JS and no external resources.
An imported static site is uploaded with its local assets. Either way the deployment is a
static site, not the generated full-stack application.

## Configuration

All values are server-only. Never add a `NEXT_PUBLIC_` prefix.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` | yes to enable | Accepted: `1`, `true`, `yes`, `on` (case-insensitive). Anything else leaves publishing disabled. |
| `VERCEL_API_TOKEN` | yes to enable | Vercel access token. Never stored in the database or returned to a browser. |
| `VERCEL_TEAM_ID` | no | Team that owns created projects. Empty ⇒ the token's account. |
| `VERCEL_PROJECT_PREFIX` | no | Prefix for generated project names. Default `mavly`; sanitized server-side. |

Apply `supabase/migrations/07_project_deployments.sql` before enabling, then
`supabase/migrations/09_mavly_deployment_domains.sql` for the Mavly hostname columns. The
first creates `public.project_deployments` and its ownership RLS; the second adds the
Mavly-owned domain state.

## Data model

`public.project_deployments` holds one row per Mavly project:

- `project_id` — primary key and foreign key to `public.projects`, `on delete cascade`;
- `provider` — currently only `vercel`;
- `vercel_project_id`, `vercel_project_name` — created server-side, never client-supplied;
- `vercel_deployment_id` — latest deployment, used only for server-side status reads;
- `status` — `queued`, `building`, `ready`, `error` or `canceled`;
- `url`, `error_code`, `error_message`;
- `mavly_hostname` — `<project-id>.mavly.xyz`, or NULL for a legacy mapping;
- `mavly_domain_status` — `pending`, `verified`, `error`, or NULL when no Mavly hostname
  was assigned;
- `mavly_domain_error`, `mavly_domain_checked_at`;
- `created_at`, `updated_at`, `last_published_at`.

`mavly_hostname` is unique when present and constrained to exactly
`lower(project_id) + '.mavly.xyz'`, so it cannot name an unrelated project. Existing rows
keep NULL in every new domain column, so their prior deployment URL remains the truthful
address and is never rewritten.
A publish that assigned a Mavly hostname never reports success until both the deployment is
ready and `mavly_domain_status = 'verified'`.

No credential is stored in this table. Access uses the caller's RLS-scoped Supabase client;
the policy requires an owned row in `public.projects`. Anon has no privileges.

## Request flow

```
browser
  └─ src/lib/vcaas.ts → POST /api/vcaas/projects/{id}/deployments/deploy
       → session check → vcaas scope → project ownership
       → src/lib/deployments/service.ts
            → resolve the static entry point from project_files
             → src/lib/vercel/provider.ts (fixed https://api.vercel.com origin)
                  → create/reuse one deterministic Vercel project
                  → attach <project-id>.mavly.xyz to that project
                  → ask Vercel to verify the domain
                  → upload index.html and the static site's local assets
                  → create a production deployment with no build
            → record ids/status/domain state in project_deployments
```

Status polling calls `GET …/deployments/status`. A terminal row with a verified domain is
authoritative; a `queued`/`building` row triggers a remote read and is then persisted. A
`ready` row with a pending domain triggers a domain verification check. A transient remote
read failure keeps the last recorded state instead of inventing a build or domain failure.

For a new Mavly publish, `productionProjectUrl` is the verified
`<project-id>.mavly.xyz`. A legacy row with no Mavly hostname keeps its existing Vercel
address. The UI gates the link on `deployment.status === "success"`, which now requires
both the deployment and (when assigned) the Mavly domain to be ready.

## Public addresses and DNS

Every new publish assigns exactly:

```
<project-id>.mavly.xyz
```

The project id is globally unique and immutable in `public.projects`, and the service also
enforces uniqueness on `mavly_hostname`. The hostname is derived server-side from that id;
a browser cannot choose it. Each exact hostname is attached to that project's own Vercel
project, not to a shared multi-tenant project.

**Operator prerequisite — not automated by this repository:**

1. `mavly.xyz` must be controlled by the Vercel account/team identified by
   `VERCEL_API_TOKEN` (and `VERCEL_TEAM_ID` when set).
2. Wildcard DNS must resolve every `<project-id>.mavly.xyz` to Vercel. Vercel's wildcard
   documentation requires Vercel nameservers (`ns1.vercel-dns.com`,
   `ns2.vercel-dns.com`) for wildcard subdomains; the apex and `*.mavly.xyz` should be added
   in Vercel DNS. If DNS stays elsewhere, configure the equivalent wildcard delegation to
   the CNAME target Vercel shows for the account and confirm certificate issuance.
3. Confirm Vercel plan/eligibility and that Vercel will issue certificates for the exact
   project hostnames. Do not enable the feature until this is confirmed.

The code never edits DNS, nameservers or production domain settings. It only calls Vercel's
project-domain API for the exact derived hostname. While DNS or certificate verification is
pending, the deployment remains `deploying`; it is never reported as a successful Mavly
address. A pre-existing legacy row keeps its old URL and is not forced onto `mavly.xyz`.

## Project naming and isolation

The Vercel project name is deterministic:

```
sanitize(prefix + "-" + mavlyProjectId) + "-" + sha256(userId + "\0" + projectId).slice(0, 8)
```

- Stable across republishes. The name is stored with the mapping and reused; changing
  `VERCEL_PROJECT_PREFIX` does not rename existing projects or break their host.
- Owner-bound: two Mavly accounts cannot share a Vercel project even if a project id were
  recreated.
- Derived entirely on the server. The browser cannot choose a name, project id or team.
- The Mavly project row is the tenant boundary; the service re-reads it through RLS before
  every publish/status call.

## Failure behaviour

| Condition | Result |
| --- | --- |
| Flag unset or token missing | `503 BACKEND_NOT_CONFIGURED`; no Vercel request |
| No static entry point | `400 VALIDATION` with an actionable message |
| Framework build required | `400 VALIDATION`; no build is run |
| Static site over 1,000 files or 8,000,000 bytes | `400 VALIDATION` |
| Publish already in flight | `409 VALIDATION`; concurrent publishes cannot both proceed |
| Project id cannot form a Mavly hostname | `400 VALIDATION`; no Vercel resource is created |
| Mavly hostname assigned to another Vercel project | `409 DOMAIN_CONFLICT`; no deployment is submitted |
| Mavly hostname attached but DNS/certificate not verified | Deployment remains `deploying`; no success URL |
| Domain disappears or verification is unauthorized | Domain status becomes `error`; not a successful publish |
| Vercel 401/403 | `503 BACKEND_NOT_CONFIGURED` |
| Vercel 429 | `429 RATE_LIMITED` with `retry-after` when supplied |
| Vercel 400/409/422 | `400 VALIDATION` unless it is a domain conflict |
| Vercel timeout / transport failure | `504 UNKNOWN` |
| Other Vercel failure | `502 UNKNOWN` |
| Local mapping write fails after submission | `500 UNKNOWN` with an explicit message that Vercel may still have the deployment |

Insert-first plus a terminal-status-only update claims the single deployment slot. A
previous attempt that created the Vercel project but failed before recording its id is
recovered by name on a `409`, rather than creating a duplicate. A row abandoned in
`queued`/`building` for more than 15 minutes can be taken over with an optimistic
`updated_at` check; a live concurrent publish still receives `CONFLICT`. A stale queued row
with no deployment id is surfaced as an error instead of polling for ever.

Deleting a Mavly project deletes the mapping by cascade and schedules a best-effort Vercel
project delete after the response. A cleanup failure is logged without credentials and
never turns a successful local delete into an error; it can leave an orphan Vercel project.

## Security invariants

1. `VERCEL_API_TOKEN` is server-only, env-only, and never persisted or returned.
2. The Vercel origin is the constant `https://api.vercel.com`; no request value becomes
   a URL host or path. Project/deployment ids come from the owned Supabase row or server-side
   derivation. The domain is always `<project-id>.mavly.xyz`, derived from the immutable
   owned project id; a browser cannot supply a hostname.
3. Every request is authenticated and ownership-checked before the service runs. The
   service repeats the project read through the caller's RLS client.
4. Vercel credentials, ids and raw responses are not logged.
5. Generated source is never built, imported, transpiled or executed by Mavly.
6. The browser never talks to Vercel directly.

## Limits and operations

Technical limits observed in Vercel's documentation (not an eligibility statement):

- Hobby: 100 deployments/day, 100/hour, 60/5 min; 200 projects.
- Pro: 6000 deployments/day, 450/hour, 120/5 min; unlimited projects.

Publishing is therefore unsuitable for high-volume anonymous use. Rate-limit responses are
surfaced as `RATE_LIMITED` rather than retried in a loop.

To disable, unset `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` (or set it to any value other than
`1`/`true`/`yes`/`on`). Existing deployments remain on Vercel; Mavly stops creating and
updating them. To rotate the token, replace `VERCEL_API_TOKEN` and redeploy; no database
migration is needed.

## Verification (human-run)

Agents must not run any of these. The repository owner should:

1. Apply `07_project_deployments.sql`, then `09_mavly_deployment_domains.sql`.
2. Confirm `mavly.xyz` DNS/nameservers, wildcard resolution, Vercel domain control and SSL
   issuance as described above.
3. With the flag unset, confirm deploy/status return `503 BACKEND_NOT_CONFIGURED` and create
   no Vercel resource.
4. With a scoped token and the flag enabled, publish a project with a generated preview and
   confirm `<project-id>.mavly.xyz` is attached to its Vercel project and verified.
5. Confirm the status stays `deploying` while the domain is pending, then becomes `success`
   only after both the deployment and domain are ready.
6. Reload the workspace and confirm the status survives; confirm the production link only
   appears on success.
7. Publish a legacy-style row with NULL `mavly_hostname` and confirm its old URL is retained.
8. Delete the project and confirm the mapping is gone and the Vercel project is removed (or
   the cleanup failure is logged without breaking the delete).
9. Verify a second account cannot read or publish the first account's project, including its
   Mavly hostname.
10. Run `npx tsc --noEmit`, `npm run lint`, `npm test` and `npm run build` per `AGENTS.md`.

## Custom-hostname 522 — external investigation (NOT fixed by this repository)

**Status: open.** A production host such as `https://meri-ek-car-ki.mavly.xyz/` answering
Cloudflare `522` is an edge-to-origin problem. This repository cannot change Cloudflare
routing, a Worker's configuration or DNS, so **no change here fixes or explains that
response**. The site is not resolved until the hostname serves the correct generated page
over HTTPS, end to end, and that has not been demonstrated.

### What this repository does establish

- `mavly.xyz` is expected to be served by **Vercel** (see "Public addresses and DNS"
  above). This repository contains **no Cloudflare Worker, route or origin
  configuration**. (`public/_headers` is a Workers static-assets convention and is inert
  under Next.js/Vercel.) Any Worker in front of `*.mavly.xyz` is external and cannot be
  reviewed from this codebase.
- `public.project_deployments.url` stores the `url` Vercel returns for the deployment
  created by that publish. The create request uses `target: "production"` and
  `projectSettings.framework: null`. It is a **per-deployment host** — it changes on every
  publish — not the project's production alias and not the verified custom hostname. It is
  written after the deployment is created, cleared (`url = null`) when a re-publish claims
  the row, refreshed by status polling, and rewritten once the next deployment is
  recorded. It is therefore also **null while a publish is in flight**.
- `deploymentHost()` / `wireDeploymentStatus()` never read `row.url`. The published
  address is the Vercel-verified `<project-id>.mavly.xyz`, or — for a legacy row with no
  Mavly hostname — `<vercel_project_name>.vercel.app`. A publish is `success` only when
  the deployment is ready **and** `mavly_domain_status = 'verified'`.
- `tests/deployment-host.test.ts` pins these rules down: derivation, the unverified-host
  gate, the legacy fallback, and that `row.url` never becomes the published address.

### Why `row.url` is not a routing origin

It identifies the deployment that one publish created, but it is not stable enough to be
an origin: it is `null` during a re-publish, it changes with every publish, and it says
nothing about whether the custom hostname is attached or verified. The stable identities
for a project are its Vercel project (`vercel_project_id` / `vercel_project_name`) and its
verified Vercel project domain (`mavly_hostname`). Any external router should be checked
against those, not against the saved deployment URL.

### Hypothesis (UNVERIFIED)

Cloudflare proxies `*.mavly.xyz` and a Worker/route resolves its origin to a hostname that
itself resolves back through the same Cloudflare edge — for example the same custom
hostname, or `mavly.xyz` — so the edge never reaches an origin and reports `522`. This is
consistent with the symptom but is **not confirmed by this repository**. A `522` can
equally be a genuine origin timeout, an origin DNS/firewall failure, or an origin that is
not publicly resolvable.

### Operator checklist (external — inspect before changing anything)

Record what you observe at each step; do not infer it from the expected setup.

1. **DNS.** Resolve the custom hostname and `mavly.xyz` (`dig +short`, and the `CNAME` /
   `NS` records). Note whether the answer is Cloudflare-proxied addresses, Vercel, or
   nothing. Confirm which zone actually serves `mavly.xyz`.
2. **Edge response.** `curl -sSI https://meri-ek-car-ki.mavly.xyz/` and a full GET. Capture
   `server: cloudflare`, `cf-ray`, the status, and whether the body is Cloudflare's error
   page. A `522` means the edge could not open a connection to the configured origin.
3. **Worker routing.** In the Cloudflare dashboard, read the route/trigger pattern that
   matches the hostname and the literal upstream/origin the Worker is configured to use.
   Do not change it yet.
4. **Loop check.** If that upstream is the same custom hostname or another `*.mavly.xyz`
   host that itself resolves through the same proxy, the origin is self-referential — the
   unverified hypothesis above. If it is a different host, record what it is.
5. **Origin reachability.** From outside Cloudflare, request the origin directly and
   confirm it returns the expected generated page (and note any Vercel authentication or
   deployment-protection response). If it does not answer at all, the `522` is an origin
   problem, not a routing loop.
6. **Vercel state.** For the project's Vercel project, confirm `meri-ek-car-ki.mavly.xyz`
   is attached, `verified: true`, and has an issued certificate; confirm the latest
   deployment is `READY`. Compare with `project_deployments` (`status`, `url`,
   `mavly_domain_status`).
7. **Smallest safe fix.** Change one hop only, after step 3–6 identify it: point the
   Worker's origin at the intended Vercel target (project host or verified project
   domain) that is reachable directly, or stop intercepting that hostname so it reaches
   Vercel directly. **Do not delete existing production DNS records** and do not rewrite
   unrelated hostnames.
8. **Verify end to end.** Request the hostname again: correct generated HTML (compare a
   distinctive string from the project's `preview.html`), valid TLS, no redirect loop, a
   second path (for example `/index.html`), and a second project's host to confirm the fix
   did not break other tenants. Only then is the issue resolved.
