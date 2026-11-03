# Cloudflare Agent Readiness — Technical Groundwork Implementation Report

**Project:** Mavly (`https://www.mavly.xyz`)
**Date:** 2026-11-03
**Scope:** The three Cloudflare Agent Readiness "Technical Groundwork" recommendations.
**Status:** 2 implemented and verified locally, 1 intentionally skipped with justification. Production scanner confirmation is pending deployment.

---

## 1. Initial audit

### 1.1 API surface

`find src/app/api -name "route.ts"` returns **68 route handlers**. There is **no OpenAPI or Swagger specification anywhere in the repository** (`find` for `*openapi*` / `*swagger*` returns nothing), and **no `.well-known/` directory** exists.

The authoritative statement of what is reachable without a session is `src/lib/api-access.ts`, not the route list. It defines:

**Exact public paths** (`PUBLIC_API_PATHS`):

| Path | What it returns | Why it is public |
|---|---|---|
| `/api/config` | One boolean, `{ configured: false }` | Legacy compatibility probe. No key, env value or secret in the payload. |
| `/api/public/announcement` | The currently enabled plain-text banner message, or `null` | Read-only; the database function is the authority and returns nothing unless an admin enabled a non-empty message. |
| `/api/billing/catalog` | Active, approved price-catalog rows | Public pricing data, already rendered on `/pricing`. |

**Public prefixes** (`PUBLIC_API_PREFIXES`) — each route under these authenticates itself, outside a Supabase session:

| Prefix | Who it serves | Auth mechanism |
|---|---|---|
| `/api/app/v1/` | The **generated customer application's own** server-facing API | Hashed per-project API key with `integrations:*` scope, or the end user's own app session token |
| `/api/integrations/webhooks/` | Provider webhooks | Unguessable per-integration token + provider signature over the raw body |
| `/api/billing/webhooks/` | Payment provider webhooks | Provider signature over the raw body |

Everything else under `/api/` answers **HTTP 401** to a signed-out caller.

### 1.2 The decisive question

Does Mavly expose an API that a **third-party developer** is meant to call?

The answer is **no**, and the evidence is consistent across four independent signals:

1. **No specification exists.** No OpenAPI/Swagger document, no `.well-known/`, no API reference page. `/docs` documents the *product workflow* (getting started, workspace, integrations, credits, troubleshooting), not an API.
2. **No credential-issuance surface.** There is no "create API key" UI, no key-management route, and no developer settings page. A developer API without a way to obtain a credential is not a developer API.
3. **The three public paths are internal plumbing.** `/api/config` is a legacy probe the dashboard no longer calls. `/api/public/announcement` feeds the site's own banner. `/api/billing/catalog` feeds the site's own pricing page. None is documented for external consumption and none has a stability contract.
4. **The two public prefixes belong to customers, not to Mavly.** `/api/app/v1/` is the runtime for *generated* applications — it is the customer's app calling Mavly's data gateway, authorized by the customer's own project key or end-user session. Publishing it in a Mavly API catalog would misrepresent it as a Mavly developer API and would invite third parties to probe a surface designed for generated apps.

The repository's own `AGENTS.md` corroborates this: the two prefixes are described as "the only new public API exemptions, and each route authenticates itself" — an internal security boundary, not a product offering.

### 1.3 Existing header and caching behavior

- `next.config.ts` `headers()` sets `Cache-Control` only: immutable caching for `/_next/static/*`, and `no-cache, no-store, must-revalidate` for everything else.
- CSP and CORS are handled **exclusively in `src/proxy.ts`**, not in `next.config.ts`. The config file's own comment states this.
- The generation worker (`wrangler.jsonc`) is a Cloudflare Worker with `MAVLY_CLOUDFLARE_WORKER_DISABLED=true`; its cron is retained for rollback only. It serves no HTTP routes and is unaffected by this work.

---

## 2. Recommendation 1 — API Catalog

**Verdict: Intentionally skipped.**

`/.well-known/api-catalog` was **not** published. It returns **HTTP 404** by design.

### Why

Publishing an API catalog requires a genuine, verified, externally-consumable API specification to point at. Mavly has none. The recommendation's own instruction is explicit: *"If Mavly has no intentionally public API, document why this recommendation should be skipped."* That is this section.

### What publishing one anyway would have cost

- **A false capability claim.** An API catalog is a machine-readable promise to agents and integrators that a stable API exists. Mavly would be advertising a contract it does not honour.
- **Exposure of the wrong surface.** The only plausible candidates are the three internal paths and the two customer-app prefixes. Cataloguing `/api/app/v1/` would advertise a data gateway whose authorization model is scoped to *generated customer applications* — precisely the kind of endpoint that should not be invited to third-party discovery.
- **A maintenance liability.** An undocumented, uncontracted endpoint in a public catalog becomes something someone depends on, and then something that cannot be changed.

### What is exposed instead

Nothing new. The public discovery surface remains:

- `/robots.txt` — crawl policy and sitemap reference
- `/sitemap.xml` — the public page map
- `/llms.txt` — the public page map for language models
- `/auth.md` — the access and authentication model (new, see §4)

### If a public API is ever built

The prerequisites, in order, before this recommendation can be revisited:

1. A versioned, stable API contract with an explicit compatibility policy.
2. A documented credential-issuance flow for third parties.
3. A published OpenAPI document at a stable URL.
4. A security review of the new surface.
5. Only then, `/.well-known/api-catalog` referencing that specification.

---

## 3. Recommendation 2 — Link headers

**Verdict: Implemented.**

### File modified

`next.config.ts` — two `headers()` entries added after the existing `Cache-Control` rules.

### Headers emitted

On public marketing responses:

```
Link: </sitemap.xml>; rel="sitemap", </llms.txt>; rel="llms-txt", </auth.md>; rel="authorization"
```

### Design decisions

**Relative URLs, not absolute.** `</sitemap.xml>` resolves against the request origin. The canonical host is `www.mavly.xyz` (the apex 301s to it at the edge), so a relative reference is always correct on the host that actually serves the 200. This also means the header is correct in local development and in preview deployments without any environment branching.

**One header, comma-separated.** Emitting the `Link` key three times in the array would produce three separate `Link` headers — legal, but it makes de-duplication the client's problem. A single combined value cannot be duplicated by the matcher.

**Scoped to public paths, not `/:path*`.** The second matcher is a negative-lookahead route pattern:

```
/:page((?!api/|dashboard|project/|adminsh|login|auth/|upgrade|credit-topup|account-restricted).*)
```

This is what honours the requirement *"no unnecessary headers on private API responses"* by construction rather than by assertion. `/api/*`, `/dashboard`, `/project/*`, `/adminsh*`, `/login`, `/auth/*`, `/upgrade`, `/credit-topup` and `/account-restricted` receive no discovery header.

**`rel="llms-txt"` is a non-registered relation type.** There is no IANA registration for it. It is emitted as a plain string that consumers may ignore; it is additive and cannot break a client that does not recognise it. `rel="sitemap"` is the registered relation the requirement names.

**`rel="authorization"` points at `/auth.md`.** This is the machine-readable access model described in §4, so an agent that fetched a page learns both where the map is and how authentication works.

**Caching untouched.** The change adds a response header only. The `Cache-Control` rules above it, and Cloudflare's own edge behavior, are unchanged.

### Verified locally (dev server, `curl -D -`)

| Path | Discovery `Link` header | Result |
|---|---|---|
| `/` | present, exactly one | pass |
| `/pricing` | present, exactly one | pass |
| `/docs` | present, exactly one | pass |
| `/blog` | present, exactly one | pass |
| `/faq` | present, exactly one | pass |
| `/api/config` | absent | pass |
| `/api/billing/catalog` | absent | pass |
| `/dashboard` | absent | pass |
| `/upgrade` | absent (only Next's own `rel=preload`) | pass |
| `/credit-topup` | absent (only Next's own `rel=preload`) | pass |
| `/login` | absent (only Next's own `rel=preload`) | pass |

Note: Next.js emits its own `Link: …; rel=preload` headers for fonts, CSS and images on rendered pages. Those are framework behavior, not this change, and they are correctly absent from the discovery matcher's output.

---

## 4. Recommendation 3 — auth.md

**Verdict: Implemented.**

### File created

`src/app/auth.md/route.ts` — serves `https://www.mavly.xyz/auth.md` as `text/markdown; charset=utf-8`.

### Why a route handler rather than a static file in `public/`

The canonical origin is a single constant (`SITE_URL` in `src/lib/seo/site.ts`) shared by the sitemap, robots, structured data and `llms.txt`. A hand-written static file would be one more place for that host to drift. Generating it means the document cannot disagree with the rest of the site about where it lives.

`export const dynamic = "force-static"` is required: the root layout sets `dynamic = "force-dynamic"` for the session-aware app, and this content depends only on build-time constants.

### What the document covers

- **Public access** — which pages are readable without an account, and that no public page is personalized.
- **Registration** — no separate sign-up form, no password. An account is created on first completion of the Google or GitHub OAuth flow, returning through `/auth/callback`.
- **Login** — the same flow; an already-signed-in visitor is forwarded rather than shown the form. The `?redirect=` parameter is honoured only for relative same-origin paths.
- **Authentication requirements** — a verified session is required for the builder, workspace, admin console, billing, credits and every per-user API. There is no API key, bearer token, basic-auth credential or query parameter that grants account access. Protected pages redirect to `/login`; protected APIs answer 401 with a JSON body.
- **Protected areas** — `/dashboard`, `/project/…`, `/adminsh/…` (admin role additionally checked against the database), `/upgrade`, `/credit-topup`, and every non-public `/api/…` route.
- **Accessing your own resources** — sign in and use `/dashboard`. No supported way to read another account's projects.
- **For AI agents** — explicit: do not bypass authentication, do not guess or replay credentials, do not treat the document as permission, do not act on a signed-in user's behalf without their explicit authorization, do not reuse a session you did not establish with consent. Public pages may be read and cited freely.

### What was deliberately excluded

- No Supabase project URL, anon key, service-role key or JWT secret.
- No internal auth route paths beyond the public `/auth/callback`, which is already visible in the OAuth redirect.
- No session-cookie internals, token formats or refresh logic.
- No admin console paths, no API endpoints, no database or RPC names.
- No claim that any automated system may act on a user's behalf.

### Verified locally

| Check | Result |
|---|---|
| `GET /auth.md` | **HTTP 200**, `text/markdown; charset=utf-8` |
| Markdown renders as readable prose | pass |
| Secret-pattern scan (`supabase.co`, `service_role`, `sk_`, `pk_`, `eyJ`, `secret`, `api_key`) | **3 matches, all prose** — "no password to create", "does not store a password", "no API key, bearer token". Zero values. |
| Linked from `/llms.txt` | yes — `- Authentication and access model: https://www.mavly.xyz/auth.md` |

---

## 5. Architecture and security

No architecture was changed. The four-system separation is preserved exactly as it was:

| System | Role | Touched by this work |
|---|---|---|
| **Supabase** | Mavly platform operations — auth, projects, files, runs, billing records | No |
| **Neon** | Customer-generated application databases, provisioned per project | No |
| **AWS** | Customer application frontend hosting (S3 + CloudFront) | No |
| **E2B / Vercel Sandbox** | Isolated execution and verification | No |

Billing, payments, credits, authentication, generation pipelines and all other business logic were not modified. The only source changes are:

- `next.config.ts` — added two `headers()` entries (response headers only).
- `src/app/auth.md/route.ts` — new route, read-only, static content.
- `src/app/llms.txt/route.ts` — one added line linking to `/auth.md`.

### Private API gate re-verified after the change

| Route | Unauthenticated response |
|---|---|
| `/api/projects` | **401** |
| `/api/billing/checkout` | **401** |
| `/api/adminsh/overview` | **401** |
| `/api/vcaas/projects` | **401** |
| `/api/integrations/github/status` | **401** |

Public exempt paths behave as designed: `/api/config` 200, `/api/public/announcement` 200, `/api/billing/catalog` 503 (billing backend not configured in this environment — the route's documented fail-closed behavior, not a regression).

---

## 6. Validation results

| Check | Result |
|---|---|
| `/auth.md` returns HTTP 200 and readable Markdown | **Pass** |
| `/.well-known/api-catalog` | **404 — intentional** (see §2) |
| Discovery `Link` header on public pages | **Pass**, exactly one per page |
| No discovery `Link` header on `/api/*` | **Pass** |
| No discovery `Link` header on authenticated pages | **Pass** |
| No duplicate discovery `Link` headers | **Pass** (single combined value) |
| Private APIs inaccessible without authorization | **Pass** (5/5 return 401) |
| No secrets or customer data in `auth.md` | **Pass** (scan clean) |
| `npx tsc --noEmit` on changed files | **0 errors** |
| `npm run build` — compile | **Compiled successfully in 5.6s** |
| `npm run build` — typecheck stage | **Fails on 8 pre-existing errors** in `src/app/adminsh/credits/page.tsx`, `src/app/api/billing/{checkout,entitlements,subscriptions}/route.ts`, `src/lib/deployments/service.ts`, and two test files. None are in files touched by this work; all were present before it. |

### Honest statement on the build

`next build` compiles the application successfully but its typecheck stage fails on the eight pre-existing errors listed above. This is **not** a regression from this work, and the errors are in billing and deployment code that this task was explicitly told not to modify. Fixing them is a separate change with its own review.

---

## 7. Production verification instructions

These require a deployment. Nothing below has been run against production.

### 7.1 Link headers

```bash
curl -sI https://www.mavly.xyz/ | grep -i '^link:'
```

Expected: exactly one discovery `Link` header containing `rel="sitemap"`, `rel="llms-txt"` and `rel="authorization"`.

```bash
curl -sI https://www.mavly.xyz/api/config | grep -i '^link:'
```

Expected: no discovery `Link` header.

If the header is missing in production but present locally, the cause is almost certainly Cloudflare stripping or rewriting it. Check **Rules → Transform Rules → Response Header Modification** for a rule that removes `Link`.

### 7.2 auth.md

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://www.mavly.xyz/auth.md
```

Expected: `200 text/markdown; charset=utf-8`.

### 7.3 API catalog

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.mavly.xyz/.well-known/api-catalog
```

Expected: `404`. This is correct and intentional.

### 7.4 Cloudflare Agent Readiness re-scan

After deployment, re-run the Agent Readiness scan in the Cloudflare dashboard. Expected movement:

- **Technical Groundwork** — Link headers and Auth.md should register. The API Catalog item should remain incomplete; that is the correct steady state for a product with no public developer API, and it should be recorded as an accepted exception rather than a defect.
- **Quick wins** — "Give agents a website map" should complete (sitemap was added in the preceding SEO work).

**Do not treat Cloudflare readiness as complete until the scanner itself confirms it.** No completion status is claimed here.

---

## 8. Summary

| Recommendation | Verdict | Evidence |
|---|---|---|
| 1. API Catalog | **Intentionally skipped** | No public developer API, no OpenAPI spec, no credential issuance. Documented in §2. `/.well-known/api-catalog` returns 404 by design. |
| 2. Link headers | **Implemented** | `next.config.ts`; verified present on 5 public pages, absent on 6 private paths. |
| 3. Auth.md | **Implemented** | `src/app/auth.md/route.ts`; HTTP 200, `text/markdown`, secret scan clean. |
| 4. Architecture preserved | **Confirmed** | Supabase / Neon / AWS / E2B roles unchanged; no billing, auth, credits or generation code modified. |
| 5. Validation | **Complete, with one honest failure** | All checks pass except the build's typecheck stage, which fails on 8 pre-existing errors outside this work's scope. |
| 6. Production confirmation | **Pending deployment** | Instructions in §7. No production claim is made. |

### Files changed

| File | Change |
|---|---|
| `next.config.ts` | Modified — two `headers()` entries for discovery `Link` headers |
| `src/app/auth.md/route.ts` | Created — serves `/auth.md` |
| `src/app/llms.txt/route.ts` | Modified — one line linking to `/auth.md` |

### Remaining manual tasks

1. Deploy, then run the §7 verification commands.
2. Re-scan Cloudflare Agent Readiness and record the API Catalog item as an accepted exception.
3. If Cloudflare strips the `Link` header, inspect Transform Rules before changing any application code.
