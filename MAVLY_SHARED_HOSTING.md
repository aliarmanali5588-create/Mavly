# Mavly shared hosting (`<project-id>.mavly.xyz`)

**Status: implemented in code, DISABLED by default, NOT production-ready until the
operator steps in “Provider prerequisites” are complete.**

The legacy per-project Vercel path (`MAVLY_VERCEL_DEPLOYMENTS.md`) remains the default and
is still fully supported. Shared hosting is a second, opt-in backend that stores an
immutable published artifact in Supabase and serves it from Mavly's own tenant runtime.

Nothing in this document asserts that wildcard DNS, a wildcard certificate, or Vercel
plan/terms eligibility has been verified. Those are operator checks, not code.

---

## 1. Request flow

```
browser ── https://<project-id>.mavly.xyz/path
   │
   ▼  src/proxy.ts
      · parseTenantHost(Host)  ── invalid / reserved / other domain ⇒ 404, nothing else runs
      · shared runtime disabled ⇒ 404
      · rewrite to /api/tenant/<path>   (Host preserved; no session refresh, no API gate)
   │
   ▼  src/app/api/tenant/[[...path]]/route.ts
      ▼ src/lib/hosting/serve.ts
         1. resolve_published_tenant(hostname)        ← anon RPC, published-only
         2. read_published_file(hostname, version, p) ← pinned to the ACTIVE version
         3. serve content-type + nosniff + no-store
   │
   ▼  Supabase (SECURITY DEFINER, fixed search_path)
      project_published_versions (status = active)
      project_published_files    (exact bytes of that version)
      project_deployments        (status = ready, active_version_id = version, mavly_hostname)
```

The Mavly app (dashboard, `/api/vcaas/*`, preview, auth) is **unreachable** from a tenant
host: every path is rewritten to the tenant route, which only reads published files.

## 2. Immutable published versions

`supabase/migrations/14_shared_hosting.sql` adds:

| Table | Contents |
| --- | --- |
| `project_published_versions` | one row per publish attempt: project, status (`draft`/`active`/`superseded`/`failed`), SHA-256 `content_hash`, `entry_path`, `spa_fallback`, counts, timestamps |
| `project_published_files` | the frozen bytes: `version_id`, `path`, `content`, `content_type`, `sha256`, `size_bytes` |

`project_deployments.active_version_id` links the version the runtime may serve; the mapping
also carries `provider` (`vercel` | `shared`).

### Invariants

1. **`project_files` is never served publicly.** Only a published version is.
2. Editing draft files does not change live content until the next publish.
3. A version is inserted as `draft`, its files are written, and only then is
   `activate_published_version` called. A failure before activation leaves the previous
   active version serving.
4. Activation is one transaction: previous active → `superseded`, new → `active`,
   deployment link → new id. A partial unique index allows at most one active version.
5. Unpublish deactivates the mapping immediately (the resolver requires an active version
   **and** a ready deployment row), and keeps version history.
6. Retention: the newest `PUBLISHED_VERSION_RETENTION` (5) superseded versions are kept;
   older ones are pruned after a successful publish. The active version is never pruned.
7. Restore points (`project_snapshots`) are a separate concept and never affect a published
   version.

### Storage decision

Database-backed text rows, not object storage. The existing pipeline is text-only
(`project_files.content` is `text`; the Vercel upload encodes UTF-8), and a publish is
capped at 1,000 files / 8,000,000 bytes. A version is therefore at most a few MB. No new
provider or credential is introduced. If measured sizes ever justify object storage, the
version id is already the natural object prefix and the serving contract does not change.

## 3. Public lookup contract

Two functions are the whole public surface. Both are `SECURITY DEFINER` with
`search_path = public, pg_temp`, fully qualified objects, and explicit grants.

```sql
resolve_published_tenant(p_hostname text)
  → (project_id, version_id, published_at, content_hash, entry_path, spa_fallback)
  -- no row unless: normalized hostname matches mavly_tenant_hostname,
  -- version.status = 'active', deployment.status = 'ready',
  -- deployment.active_version_id = version.id, deployment.mavly_hostname = hostname

read_published_file(p_hostname text, p_version_id uuid, p_path text)
  → (path, content, content_type, sha256)
  -- only when the hostname resolves to that ACTIVE version and the version id matches
```

* `anon` may execute **only** these two functions. It has no privilege on the tables.
* Neither function accepts a project id, so an unauthenticated caller cannot name another
  tenant.
* Neither returns user records, project metadata, drafts, secrets, or unpublished files.
* `mavly_tenant_hostname` refuses ports, paths, userinfo, deeper names (`a.b.mavly.xyz`),
  overlong labels, `xn--` labels, malformed labels and every reserved label.

## 4. Hostname policy

* Shape: exactly one label beneath `mavly.xyz`, same structural rule as a routable project
  id (`^[a-z]([a-z0-9]|-(?!-))*(?<!-)$`, ≤ 63).
* Normalization: lowercase, one trailing dot stripped, a plain decimal port stripped.
  Anything else malformed is **refused**, never repaired.
* Reserved labels (`src/lib/reserved-hostnames.ts`) are applied in four places: project
  creation, slug generation, publish validation, and request routing. The database mirrors
  the list as a `NOT VALID` CHECK on `project_deployments.mavly_hostname`, so an existing
  legacy row is never rewritten.
* Existing project ids are **not** renamed. A project whose id is reserved cannot claim a
  new Mavly hostname; its existing data is untouched.

## 5. Publish / republish / unpublish / delete

| Operation | Shared mode |
| --- | --- |
| Publish | Claim the deployment slot (`provider = shared`), validate + hash the static set, insert a draft version and its files, activate atomically, probe the public lookup, persist `ready` + domain state |
| Readiness | `verified` means **Mavly's resolver returns this exact version and its entry document can be read**. It does not prove DNS/TLS; a failed probe leaves the row `pending` (never success) |
| Republish | New version; activation switches atomically; failed attempt leaves the previous version live |
| Unpublish | `deactivate_published_version` clears the mapping/active version, then the existing lease+`finishUnpublish` records `unpublished`. No Vercel call, no deletion of versions |
| Delete project | Database cascade removes the mapping, versions and files. `discardVercelProject` is a **no-op for shared rows**, so a tenant delete can never delete the shared application |

Legacy rows (`provider = vercel`) keep their entire existing behaviour, including the
domain detach and production-deployment removal on unpublish.

## 6. Configuration

Server-only environment names (never secret values in this document):

| Variable | Meaning |
| --- | --- |
| `MAVLY_HOSTING_MODE` | unset / `vercel` (default) = per-project Vercel. `shared` (also `1`/`true`/`yes`/`on`) enables the tenant runtime |
| `MAVLY_SHARED_HOSTING_PROJECTS` | comma-separated project ids for the cohort, or `*`. **Empty = no project uses shared hosting** |
| `NEXT_PUBLIC_APP_URL` | canonical app origin; used by the API origin allowlist |
| `MAVLY_ALLOWED_ORIGINS` | optional extra exact origins allowed to make credentialed API calls. Never add a tenant host |

Existing Vercel variables keep their meaning for the legacy path. A shared publish needs
**no** `VERCEL_API_TOKEN` at all.

## 7. Security properties

* Tenant identity comes only from the validated `Host`. No query/body/cookie/header project
  id is accepted by the serving path.
* `/api/tenant/...` requested directly on the app host is gated like any other API route
  (401 when signed out) and the handler refuses non-tenant hosts.
* Published responses are `no-store`. Caching is deliberately off until a host + version
  keyed cache is proven; a host-blind cache would be a cross-tenant leak.
* The API origin allowlist no longer derives trust from `Host`. Credentialed mutations from
  `same-site` (which includes every tenant) or `cross-site` are refused with 403 unless the
  `Origin` is explicitly allowlisted.
* Per-instance publish/unpublish admission limits exist (`src/lib/hosting/publish-limits.ts`).
  They are a guardrail, not a distributed quota.
* Generated server code is still never executed; only static bytes are served.

## 8. Provider prerequisites (operator — not automated here)

**Pending, and required before enabling this in production:**

1. **Vercel plan/terms.** Mavly-managed customer hosting is the “Vercel for Platforms”
   model. Confirm eligibility with Vercel directly. This repository does not claim any plan
   is eligible.
2. **Wildcard domain.** Verify on the account that a wildcard domain (`*.mavly.xyz`) can be
   attached to a project, that certificates are issued for tenant hosts, and what the
   domain/alias limits are. Do **not** assume adding the wildcard automatically enables
   multi-tenant hosting.
3. **DNS.** One wildcard record for `*.mavly.xyz` → the shared application, once, instead of
   one record per tenant. Preserve apex, `www`, MX, SPF, DKIM and DMARC.
4. **External routing.** This repository contains no Cloudflare Worker/route configuration.
   If a Worker or proxy sits in front of `*.mavly.xyz`, review it separately; the open 522
   investigation in `MAVLY_VERCEL_DEPLOYMENTS.md` is still external. Do not invent a Worker
   origin or hardcode one.
5. **Attach nothing yet.** Do not detach existing project domains or delete existing Vercel
   projects as part of the initial rollout.
6. **Moving an already-published project into the cohort.** Its Vercel project still owns the
   exact `<project-id>.mavly.xyz` domain. Detach that exact project domain (operator action)
   so the wildcard/shared origin serves the host, or the Vercel mapping may shadow it. The
   shared publish itself does not detach anything; a legacy publish of a project that leaves
   the cohort deactivates its shared version first (the code path is in `publishProject`).

**Verified by code (not by the provider):** the tenant route refuses malformed/reserved
hosts; resolution is published-only; the app's APIs are unreachable from tenant hosts;
cross-origin mutations are rejected; migration 14 enforces the grants.

## 9. Migration and rollback

**Apply `supabase/migrations/14_shared_hosting.sql` BEFORE deploying this build**, after
`13_deployment_unpublish.sql`. It is additive — no existing row is rewritten and the
reserved-label constraint is `NOT VALID` — but the deployment mapping now SELECTs
`active_version_id`, so applying it first keeps the legacy path working during the rollout.
It is safe to apply while `MAVLY_HOSTING_MODE` is unset; nothing is served from the new
tables until the mode and a cohort are configured.

**Rollout**

1. Apply migration 14. Publish a test project with `MAVLY_HOSTING_MODE=shared` and
   `MAVLY_SHARED_HOSTING_PROJECTS=<test-project>`.
2. Confirm the deployment row is `ready`, `provider = shared`, `mavly_domain_status =
   verified`, and `active_version_id` is set.
3. Attach the wildcard domain to the app **after** the code is deployed (operator).
4. Verify the host end to end; then expand the cohort. Use `*` only after the cohort is
   proven.

**Rollback**

1. Unset `MAVLY_HOSTING_MODE` (or set `vercel`). The tenant runtime immediately answers 404;
   the legacy Vercel domains — never removed by this change — keep serving.
2. Remove project ids from `MAVLY_SHARED_HOSTING_PROJECTS` to roll back individual sites.
3. Do **not** detach the wildcard or delete versions as part of a rollback. Published
   versions are inert while the mode is `vercel`.

## 10. Human-run verification checklist

Agents do not run any of these (see `AGENTS.md`).

1. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
2. Publish a cohort project from the normal workspace. Confirm `Publish` succeeds and the
   live URL shown is `<project-id>.mavly.xyz`.
3. Edit a project file; confirm the live page is unchanged until republish, then changes.
4. Republish; confirm the previous version is `superseded`, the new one `active`, and the
   host serves the new bytes.
5. Unpublish; confirm the host returns 404 immediately and the workspace shows
   `Unpublished`. Republish and confirm the same address serves again.
6. Unknown host, reserved host, uppercase host, trailing dot and `a.b.mavly.xyz`:
   confirm 404 / correct handling.
7. Two tenants: confirm neither serves the other's content and a version id from one cannot
   be read through the other's hostname.
8. Confirm the main app, `/api/*`, auth callbacks and an existing legacy `.vercel.app` site
   still work.
9. With `MAVLY_HOSTING_MODE` unset, confirm tenant hosts 404 and a legacy publish still
   detaches/attaches its Vercel domain exactly as before.
10. Confirm a shared project's deletion does not delete the shared Vercel application.

## 11. Known limitations

* Static, text-only. No framework build, no server code, no binary asset pipeline.
* A generated preview is published as one `index.html` with `spa_fallback = true`; an
  imported site keeps literal 404s unless it has directory `index.html` files.
* No CDN caching yet (deliberate).
* No autonomous cleanup of abandoned draft versions beyond retention pruning after a
  successful publish.
* The readiness probe proves Mavly-side resolution only; DNS/TLS remain operator checks.
