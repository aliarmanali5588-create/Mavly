# ROUTE AUDIT — Mavly (ai-app-builder-open)

> **HISTORICAL DOCUMENT — NOT CURRENT INSTRUCTIONS.** This audit describes the routes as
> they were at an earlier commit, when Mavly forwarded requests to the hosted Totalum
> VCaaS API. That integration has since been removed and every backend-dependent route now
> returns `503 BACKEND_NOT_CONFIGURED`. The route map and upstream behaviour below are not
> current. For the current state, read `MAVLY_CLEAN_BASELINE.md`.

**Scope:** every page route, route handler, HTTP method, redirect, proxy and request-interception
point in this repository, plus the authentication, authorization, validation, redirect and
upstream-dependency behaviour of each one.

**Nature of this document:** an evidence-based audit only. Nothing in this repository was changed
to produce it. Every remediation is a *proposal*; no fix has been applied, and none will be until
it is explicitly approved (see §15, *Implementation order & dependencies*).

**Audit date:** 2026-10-21
**Commit audited:** `cdd6c01` ("fix vercel file") on branch `main`
**Companion document:** `AUDIT.md` (earlier 19-section audit; this document verifies its
route-level claims against the source and extends them)

> **Route map since this audit.** This document describes the routes as they were at the
> audited commit. The builder now lives at `/dashboard`; `/home` is its old address and
> answers a 308 redirect to `/dashboard`. The `src/app/home/page.tsx` row below is the
> builder, not a marketing page.

---

## 1. Executive summary

Mavly exposes **7 page routes** and **8 API route files** (17 exported HTTP handlers across 6
distinct methods; `OPTIONS` is auto-implemented by Next.js on all 8 files). It contains **no
authentication, no session, no ownership model and no rate limiting** — by design, and documented
as such in `README.md:149-158` and `AGENTS.md`.

That design is coherent *for a local, private-network, single-operator demo*, and the repository is
remarkably honest about it: `src/app/api/vcaas/_shared.ts:18-22` states in the source code itself
that the two route guards are no-ops and that "if you ever put real users behind this app, this is
the file that must stop being a no-op".

The problem this audit surfaces is not "there is no auth". It is that **the routing layer does not
line up with that design in three specific ways**:

1. **The guard seam does not cover the dangerous route.** `src/app/api/vcaas/_shared.ts` is called
   by 2 of the 8 API route files (`/api/preview/*` and `/api/visual-edit/*`). The catch-all
   `/api/vcaas/[...path]` — which reaches the *entire* upstream surface including project deletion,
   deployment, secrets and `.env` — never calls it. The remediation path the README and AGENTS.md
   point at ("make the two guards in `_shared.ts` real") therefore does not, by itself, protect the
   most dangerous route in the app. (R-01, R-02)

2. **The origin of the request is never established anywhere.** Not in `src/proxy.ts`, not in any
   handler, not in any client call. `resolveVcaasContext()` returns `{ ok: true, ctx: {}, team: {} }`
   unconditionally (`_shared.ts:48-50`). Consequently the project-ID → owner question is never asked
   on any route, including the three that read or mutate project state directly. (R-01 … R-05)

3. **Two trust boundaries cross inside the app.** The visual-editor preview proxy serves
   *untrusted, AI-generated application code* at **Mavly's own origin**, and the account-wide API
   proxy is mounted at that same origin. The platform's mitigation for this (the
   `PREVIEW_RUNTIME_SHIM` monkey-patch, copied verbatim from `totalum-platform`) was designed for
   a world where the platform origin and the account API origin differ. In Mavly they do not
   differ, and the copied code says so itself: *"a strong mitigation, NOT a sandbox"* and *"The real
   containment is that the proxy is only mounted while the editor is open; a dedicated preview
   origin would be the better long-term answer."* (`src/lib/visual-edit-agent.ts:113-127`). In
   Mavly, the preview origin **is** the API origin. (R-06)

Everything else found is smaller but real: an open redirect on `/login?redirect=`, an unbounded
server-side ZIP download, unbounded multipart buffering, client/server validation that disagrees
about the minimum project-name length, a catch-all that turns every unknown URL into a 307 to `/`
so the 404 page can never render, and a workspace that answers `200 OK` with "Project not found".

**Confirmed findings by severity:** P0 × 1 · P1 × 7 · P2 × 11 · P3 × 11 · Informational × 5
(35 findings, see §13). Highest-risk routes: `GET|POST|PUT|DELETE|PATCH /api/vcaas/[...path]`,
`GET /api/vcaas/env/[projectId]`, `GET|POST|PUT|PATCH|DELETE|HEAD /api/preview/[projectId]/[[...path]]`,
`POST /api/visual-edit/[projectId]/apply`.

---

## 2. Scope, method, limits, repo state

### 2.1 What was inspected

| Area | Files |
|---|---|
| Page routes | all 7 `page.tsx` files under `src/app/` |
| Route handlers | all 8 `route.ts` files under `src/app/api/` |
| Shared route code | `src/app/api/vcaas/_shared.ts` |
| Request interception | `src/proxy.ts` |
| Client API catalogue | `src/lib/vcaas.ts`, `src/lib/api.ts`, `src/lib/vcaas-types.ts`, `src/lib/vcaas-errors.ts` |
| Server API layer | `src/lib/vcaas-server.ts` |
| URL-safety helpers | `src/lib/safe-url.ts` |
| Slug rules | `src/lib/project-slug.ts` |
| Preview / visual-edit | `src/lib/preview-proxy.ts`, `src/lib/visual-edit-agent.ts`, `src/lib/visual-edit*.ts` |
| Upload / attachment rules | `src/lib/upload.ts`, `src/lib/attachments.ts`, `src/lib/composer-attachments.ts` |
| Config | `next.config.ts`, `tsconfig.json`, `package.json`, `vercel.json`, `public/_headers`, `.env.example` |
| Docs | `README.md`, `AGENTS.md`, `AUDIT.md` |
| Framework behaviour | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` |

### 2.2 Method

Static source reading of every route file, cross-referenced against every client call site
(`vcaasApi.*`, `api.*`, raw `fetch("/api/…")`), every navigation target (`href`, `router.push`,
`redirect()`), and every configuration surface that can alter routing
(`next.config.ts` `headers()`, `src/proxy.ts` `config.matcher`).

### 2.3 Runtime verification performed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** (types only — proves nothing about runtime behaviour; see §2.4) |
| `git status --short` | `?? AUDIT.md`, `?? ROUTE_AUDIT.md` — **no tracked file modified** |
| `git diff --name-only` | empty |
| `git diff --cached --name-only` | empty |
| Route-file census (`find src/app -name 'page.tsx' / 'route.ts'`) | 7 / 8 |
| `loading.tsx` / `not-found.tsx` / `error.tsx` / `global-error.tsx` census | 0 / 1 / 1 / 1 |
| Framework method semantics | read from `node_modules/next/dist/docs` |

### 2.4 What was NOT tested, and why

| Not tested | Reason |
|---|---|
| Every upstream Totalum response, status code and error shape | No `TOTALUM_VCAAS_API_KEY` is configured in this checkout (only `.env.example`, 60 bytes) and the task forbids calling the real API. |
| Browser behaviour of `/login?provider=google` (does it really "sign in"?) | Requires running the dev server against a real key; the source shows a 700 ms `setTimeout` and a toast — no identity is created. Marked NOT TESTED for the *rendered* result. |
| Whether the upstream API accepts 3-character project slugs | Upstream contract not inspectable from this repository; the local canonical rule (`src/lib/project-slug.ts:26`) says 4. |
| Vercel/deployment body-size limits | Platform behaviour, not repository behaviour. Marked runtime-dependent. |
| DNS resolution behaviour of `publicUrlRejectionReason` | Requires network egress; the code path was read, not executed. |

### 2.5 Repo state at audit time

```
branch: main
HEAD:   cdd6c01 fix vercel file
previous: a6805a3 Initial commit: Mavly
tracked files: 234
```

---

## 3. Page route inventory

| # | URL pattern | Type | Source file | Methods | Purpose | Actual behaviour | Auth | Authz | Input validation | Data access | Side effects | Error handling | Limits | Risk | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P-1 | `/` | page (client) | `src/app/page.tsx` (1003 ln) | GET | Dashboard: hero prompt, project list, create/clone/import/export | Renders project list from `GET /api/vcaas/projects`; prompt → name modal → `POST /api/vcaas/projects/launch` | **None** | **None** | Client-side slug normalisation `normalizeId` (`:333-334`), min-length 3 (`:354`, `:910`) | Full account project list, cross-tenant by construction | **Project create, delete, clone, import/export, Figma connect, uploads** | Toast/sonner; inline error strings | Client-side only; none server-side | **P0** | `page.tsx:266, 333-334, 354, 381, 423, 443, 510-514, 902, 910` |
| P-2 | `/home` | page (server) | `src/app/home/page.tsx` (50 ln) | GET | Marketing homepage | Composes `HomeNavigation`, `HeroSection`, `FeaturesSection`, `PricingSection`, `FAQSection`, `HomeFooter` | None | None | n/a | None | None | None | Low | `home/page.tsx:1-50` |
| P-3 | `/login` | page (client) | `src/app/login/page.tsx` (199 ln) | GET | Sign-in screen (Google / GitHub buttons) | **Simulated.** `handleOAuthLogin` shows a toast and, after 700 ms, calls `router.push(redirectTarget)` (`:26-31`). `?provider=` auto-triggers it (`:34-38`). No OAuth request, no callback, no cookie, no session, no logout anywhere in the repo. | None | None | `redirectTarget = searchParams.get("redirect") || "/"` (`:13`) — **not validated** | None | None | None | **Open redirect** | **P2** | `login/page.tsx:13, 18-32, 34-38` |
| P-4 | `/privacy` | page (server) | `src/app/privacy/page.tsx` | GET | Privacy policy | Static copy | None | None | n/a | None | None | None | Medium (claims) | `privacy/page.tsx:46-51, 67-71` |
| P-5 | `/terms` | page (server) | `src/app/terms/page.tsx` | GET | Terms of service | Static copy | None | None | n/a | None | None | None | Medium (claims) | `terms/page.tsx:60-63` |
| P-6 | `/project/[projectId]` | page (client) | `src/app/project/[projectId]/page.tsx` (1766 ln) | GET | Workspace shell: chat, preview, code, More, deploy | Loads project + conversation + GitHub/Figma status; polls `agent/status` every 10 s (`:534`); proxies preview through `/api/preview/{id}` (`:164, 923, 1106`) | **None** | **None** | `projectId` from `useParams()` (`:176`), **never validated** | Full project detail, conversation, logs, versions, secrets, domain, database | **Prompt send, deploy, rebuild, GitHub pull, version restore, server restart, agent stop** | Inline "Project not found" at `:1330` — **HTTP 200, not 404** | 60 × 8 s bounded operation watcher (`:906`) | **P0** | `page.tsx:176, 241, 456-463, 491, 498, 534, 550, 591, 629, 641, 665, 765, 923, 1106, 1132, 1148, 1165, 1198, 1221, 1255, 1330` |
| P-7 | `/[...slug]` | page (server) | `src/app/[...slug]/page.tsx` (10 ln) | GET | Catch-all fallback | **`redirect("/")`** for every unmatched URL (`:8-10`) | None | None | n/a | None | None | n/a | **P2** | **P2** | `[...slug]/page.tsx:8-10` |

### 3.1 Special files

| File | Scope | Notes |
|---|---|---|
| `src/app/layout.tsx` (57 ln) | root segment (covers every page) | `dynamic = "force-dynamic"`, `revalidate = 0` → **every page is dynamically rendered**; DM_Sans + Geist_Mono via `next/font/google` (build-time font fetch — a network dependency at build); mounts `GlobalErrorCatcher`, `Toaster`, `InsufficientCreditsModal`. |
| `src/app/error.tsx` (140 ln) | root segment error boundary | Covers **all** routes (no nested override exists). Offers a copy-to-clipboard "ask the AI to fix it" prompt. |
| `src/app/global-error.tsx` (93 ln) | root-layout failure | Client component, inline styles (no Tailwind — deliberate: it runs when the layout's CSS pipeline may be broken). |
| `src/app/not-found.tsx` (24 ln) | root 404 | **Unreachable** — `[...slug]` matches every unmatched path and redirects to `/` before the 404 boundary can render. |
| `src/app/favicon.ico` | — | Served from `src/app/favicon.ico`. |
| — | `loading.tsx` | **None anywhere** (0 files). No route-level loading UI; the dashboard and workspace use client-side skeletons instead. |

---

## 4. API route and method inventory

**8 route files · 17 exported handlers · 6 distinct methods · `OPTIONS` auto-implemented by Next.js
on all 8 files · unsupported methods → `405 Method Not Allowed`**
(Framework behaviour verified in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.)

### 4.1 Route handlers

| # | URL pattern | File | Methods | Calls the guard seam? | Purpose | Upstream | Risk |
|---|---|---|---|---|---|---|---|
| A-1 | `/api/config` | `src/app/api/config/route.ts` (12 ln) | `GET` | ✗ | Reports whether a Totalum key is configured | none (local env) | **P3** |
| A-2 | `/api/vcaas/[...path]` | `src/app/api/vcaas/[...path]/route.ts` (135 ln) | `GET` `POST` `PUT` `DELETE` `PATCH` | **✗** | Catch-all proxy to the whole upstream VCaaS surface | `GET/…/api/v1/vcaas/<path>` | **P0** |
| A-3 | `/api/vcaas/env/[projectId]` | `src/app/api/vcaas/env/[projectId]/route.ts` (34 ln) | `GET` | ✗ | Streams the project's `.env` as plain text | `GET /projects/{id}/env?env=dev\|live` | **P1** |
| A-4 | `/api/vcaas/source-code/[projectId]` | `src/app/api/vcaas/source-code/[projectId]/route.ts` (71 ln) | `GET` | ✗ | Downloads the source ZIP server-side | `GET /projects/{id}/source-code` → signed URL | **P1** |
| A-5 | `/api/vcaas/upload/[projectId]` | `src/app/api/vcaas/upload/[projectId]/route.ts` (89 ln) | `POST` | ✗ | Multipart upload proxy | `POST /projects/{id}/files/upload` | **P2** |
| A-6 | `/api/vcaas/git-diff` | `src/app/api/vcaas/git-diff/route.ts` (117 ln) | `GET` | ✗ | Downloads a diff from an upstream storage host | external signed URL (client-supplied) | Low–Medium (best-controlled route in the app) |
| A-7 | `/api/preview/[projectId]/[[...path]]` | `src/app/api/preview/[projectId]/[[...path]]/route.ts` (310 ln) | `GET` `POST` `PUT` `PATCH` `DELETE` `HEAD` | ✓ (both no-ops) | Same-origin proxy of the sandbox dev server; injects the visual-editor agent | `GET /projects/{id}` then the sandbox origin | **P1** |
| A-8 | `/api/visual-edit/[projectId]/apply` | `src/app/api/visual-edit/[projectId]/apply/route.ts` (834 ln) | `POST` | ✓ (both no-ops) | Writes visual edits into project source and rebuilds | `GET/PUT /projects/{id}/files/content`, `POST /projects/{id}/rebuild` | **P1** |

`src/app/api/vcaas/_shared.ts` (63 ln) is **not** a route — it is the shared guard module.

### 4.2 Method × route matrix

| Route | GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `/api/config` | ✓ | | | | | | auto |
| `/api/vcaas/[...path]` | ✓ | ✓ | ✓ | ✓ | ✓ | auto (from GET) | auto |
| `/api/vcaas/env/[projectId]` | ✓ | | | | | | auto |
| `/api/vcaas/source-code/[projectId]` | ✓ | | | | | | auto |
| `/api/vcaas/upload/[projectId]` | | ✓ | | | | | auto |
| `/api/vcaas/git-diff` | ✓ | | | | | | auto |
| `/api/preview/[projectId]/[[...path]]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | auto |
| `/api/visual-edit/[projectId]/apply` | | ✓ | | | | | auto |

### 4.3 Client → route contract check

Every client call was matched against the handler set. **No client call targets a missing route.**

| Client call | Target route | Handler | Result |
|---|---|---|---|
| `vcaasApi.*` (~40 methods) | `/api/vcaas/...` | A-2 | ✓ match |
| `api.get("/api/config")` (`page.tsx:219`) | `/api/config` | A-1 | ✓ match |
| `fetch("/api/vcaas/env/{id}?env=…")` (`v2/ProjectApiKeysModal.tsx:65`) | `/api/vcaas/env/[projectId]` | A-3 | ✓ match |
| `fetch("/api/visual-edit/{id}/apply")` (`visual-editor/use-visual-editor.ts:360`) | `/api/visual-edit/[projectId]/apply` | A-8 | ✓ match |
| `fetch("/api/preview/{id}/")` GET (`project page:164, 923`), HEAD (`:1106`) | `/api/preview/...` | A-7 | ✓ match |
| `vcaas.ts:1143` `/source-code/{id}?intent=` | `/api/vcaas/source-code/[projectId]` | A-4 | ✓ match |
| `vcaas.ts:1158` `/upload/{id}` | `/api/vcaas/upload/[projectId]` | A-5 | ✓ match |

Two apparent dead ends were checked and are **not** defects:

* `src/lib/visual-edit-agent.ts:117` (`/api/credits/…`) and `:462` (`/api/preview/my-app`) are
  inside **documentation comments / example strings**, not live calls.
* `src/components/workspace/v2/CronJobsModal.tsx:283, 384` (`/api/cron/…`) are **default values
  in a form** that ask the user's own generated app for a scheduled-job target URL — not calls
  Mavly makes.

---

## 5. Request execution flow

The order below is the order the code actually runs, verified by reading each layer. Note that
**`src/proxy.ts` is not an authorization layer** — it only attaches headers.

```
 Browser
   │
   │  ①  Next.js router → matches a page or a route handler
   ▼
 src/proxy.ts ────────────────────────────────────────────────────────────
   │  • OPTIONS → 204 + CORS/CSP headers                      (proxy.ts:54-59)
   │  • otherwise → NextResponse.next() + CORS/CSP headers    (proxy.ts:62-65)
   │  ✗ NO session lookup, NO origin check, NO auth           (proxy.ts:49-51)
   │  • matcher excludes _next/static, _next/image, favicon.ico, image files
   │                                                        (proxy.ts:68-79)
   ▼
 Page render OR route handler
   │
   ├── PAGE ──────────────────────────────────────────────────────────────
   │    • "use client" component fetches /api/vcaas/* itself
   │    • no server-side guard, no server-side data fetching
   ▼
   └── HANDLER ───────────────────────────────────────────────────────────
        │
        │  ②  route-specific guards
        │     A-2  catch-all:  ✗ none (no context, no scope, no path allowlist)
        │     A-3  env:       ✓ isRoutableProjectSlug + env∈{dev,live}   (:15-17)
        │     A-4  source:    ✗ projectId interpolated, unvalidated        (:12,16)
        │     A-5  upload:    ✗ projectId unvalidated, body unbounded      (:45,48)
        │     A-6  git-diff:  ✓ host allowlist + publicUrlRejectionReason  (:65-83)
        │     A-7  preview:   ✓ slug check (:179) + scope check (:200) — both no-ops
        │     A-8  visual:    ✓ slug check (:233) + scope check (:248) — both no-ops
        ▼
        │  ③  resolveVcaasContext()  →  { ok:true, ctx:{}, team:{} }      (_shared.ts:48-50)
        ▼
        │  ④  enforceProjectScope()  →  null                             (_shared.ts:57-62)
        ▼
        │  ⑤  upstream call
        │     • vcaasRequest       → api-key header + 10 s timeout        (vcaas-server.ts:118-130)
        │     • vcaasUploadRequest → api-key header, NO timeout           (vcaas-server.ts:148-152)
        │     • direct fetch(url)  → no key, no timeout (A-4, A-6, A-7)
        ▼
        │  ⑥  response normalisation
        │     • { errors, data } → normalizeVcaasError → { ok, error, code }  (A-2:99-102)
        │     • non-envelope refusal → 400/401/403 passthrough                (A-2:72-86)
        │     • VcaasPathError → 400 "Invalid path"                          (A-2:111-115)
        │     • anything else → 500 "Internal server error"                  (A-2:123-127)
        ▼
     Browser
```

**Three observations that follow directly from this diagram:**

* Steps ③ and ④ are **constants**, not decisions. `resolveVcaasContext` cannot fail
  (`_shared.ts:48-50`) and `enforceProjectScope` cannot refuse (`_shared.ts:57-62`).
* Step ⑤ for A-2 forwards the **client's HTTP method verbatim** to the upstream API, with no
  per-path method allowlist and no path allowlist beyond the `/api/v1/vcaas/` prefix
  (`vcaas-server.ts:54-72`).
* Step ② is skipped entirely for A-2 — the one route that reaches the most upstream surface has
  the least route-level validation.

---

## 6. Authentication and session findings

### 6.1 What exists

| Element | State | Evidence |
|---|---|---|
| OAuth initiation | **Absent.** No redirect to Google/GitHub, no `state`/`nonce`/`PKCE`, no provider SDK in `package.json`. | `login/page.tsx:18-32` (a `setTimeout`) |
| OAuth callback route | **Absent.** No `/api/auth/callback`, no `/auth/*` route of any kind. | route-file census (§2.3) |
| Session | **Absent.** No cookie is set, read or cleared anywhere in `src/`. | `rg` over `src/` finds no `cookies()` / `setCookie` |
| Logout | **Absent.** | route-file census |
| Server-side page protection | **Absent.** `src/proxy.ts` states it explicitly: *"Authentication has been removed — the platform is fully open and every route is public."* | `proxy.ts:49-51` |
| Client-side "signed in" state | **Absent.** No auth context/provider exists. | component census |
| Route-handler auth | **Present but inert.** `resolveVcaasContext()` always returns `ok:true`. | `_shared.ts:48-50` |

### 6.2 The sign-in journey is simulated, end to end

1. `src/components/home/HeroSection.tsx:327` and `:353` link to `/login?provider=google` and
   `/login?provider=github` — **these buttons must be preserved** (labels, order, placement,
   styling) in every remediation, including the one that makes the sign-in real.
2. `src/app/login/page.tsx:34-38` reads `?provider=` and calls `handleOAuthLogin` automatically.
3. `handleOAuthLogin` (`:18-32`) shows a loading toast, waits 700 ms, shows *"Signed in with
   Google. Welcome to Mavly!"*, and calls `router.push(redirectTarget)`.
4. **Nothing else happens.** No user is created, no cookie is set, no token is issued, no session
   exists on the next page load.

**Impact.** The message the product shows its users ("Signed in with Google") is not backed by
any state anywhere in the system. The sign-in is a UI affordance only. This is the single most
misleading behaviour in the routing layer, and it must be corrected *in the same shape* — the
buttons stay exactly where and as they are; only their handler changes.

**Status: confirmed by source reading.** The rendered result was NOT TESTED (no key/dev server in
scope).

### 6.3 Session handling — no session to handle

There is no session, so there is no expiry, no refresh, no revocation and no logout path. Any
remediation must introduce all of them at once; there is no partial state to migrate from.

### 6.4 Independent session checks on pages and APIs

| Surface | Session check |
|---|---|
| `/` (dashboard) | ✗ — loads the full project list and exposes create/delete/clone/import/export |
| `/project/[projectId]` | ✗ — loads project, conversation, GitHub/Figma status; can deploy, rebuild, restore, pull, restart, stop the agent |
| `/api/vcaas/*` | ✗ |
| `/api/preview/*` | ✗ (guard called, but it cannot refuse) |
| `/api/visual-edit/*/apply` | ✗ (guard called, but it cannot refuse) |
| `/api/config` | ✗ (intentional: it is a health probe) |

### 6.5 Findings

**R-26 (P2) — The sign-in is simulated; no identity is established.**
Affects `/login`, `/`, `/project/[projectId]`. Trigger: any click on "Continue with Google/GitHub".
Impact: users believe they are authenticated; the product promises account features it cannot
deliver; every future "add auth" change must preserve these two buttons while replacing the
handler. Confirmed. Remediation: keep the buttons and their journey intact, but route them to a
real provider initiation (`/api/auth/start?provider=…`) and add the matching callback route.

**R-27 (P2) — Open redirect via `/login?redirect=`.**
`redirectTarget` is read from the query string with no validation (`login/page.tsx:13`) and passed
straight to `router.push` (`:30`). Next's `router.push` accepts an absolute URL and navigates to
it. Trigger: `GET /login?redirect=https://attacker.example`. Impact: phishing — the victim starts
on the operator's own domain and is bounced to an attacker page that inherits the trust of the
landing. Confirmed. Note the compounding factor: this route is the natural home for the real
OAuth `returnTo` parameter, so the fix must be a *validator* (relative paths only), not the
removal of the parameter.

**R-28 (P3) — No logout, no session, no revocation.** Informational for a demo, P3 because it is
listed as a user-facing control that does not exist.

---

## 7. Authorization and ownership findings

### 7.1 Every endpoint that accepts or derives a project identifier

| Route | How the project id is obtained | Ownership enforced? | Effect if unauthorised |
|---|---|---|---|
| `/api/vcaas/[...path]` | From the URL path (`path[1]` when `path[0]==="projects"`) | **No** | Full upstream account surface |
| `/api/vcaas/env/[projectId]` | Route param; slug-validated (`:15`) | **No** | Read the project's `.env` (secrets) |
| `/api/vcaas/source-code/[projectId]` | Route param; **not validated** (`:12`) | **No** | Download the whole source tree |
| `/api/vcaas/upload/[projectId]` | Route param; **not validated** (`:45`) | **No** | Write files into the project |
| `/api/preview/[projectId]/[[...path]]` | Route param; slug-validated (`:179`) | **No** (`_shared.ts:57-62`) | Read the running app; serve it same-origin |
| `/api/visual-edit/[projectId]/apply` | Route param; slug-validated (`:233`) | **No** (`_shared.ts:57-62`) | **Write source files and rebuild** |

### 7.2 The account-wide catch-all is the whole surface

`src/lib/vcaas.ts` catalogues roughly 110 upstream paths across 15 namespaces — projects,
agent, deployments, versions, files, database, secrets, domains, GitHub, Figma, usage, groups,
analytics, mobile, payments. **Every one of them is reachable through
`GET|POST|PUT|DELETE|PATCH /api/vcaas/<any path>`**, and each of them is authorised upstream by
the single operator key (`src/lib/vcaas-server.ts:92-94, 118-120`).

Concretely reachable by an unauthenticated caller:

* `DELETE /api/vcaas/projects/{id}` — delete a project (`vcaas.ts` `projects.remove`, used at
  `src/app/page.tsx:514`).
* `POST /api/vcaas/projects/{id}/deployments/deploy` — publish (`page.tsx:1165`).
* `GET /api/vcaas/projects/{id}/agent/conversation` — read the full chat history (`page.tsx:461`).
* `POST /api/vcaas/projects/{id}/agent/start` — spend credits (`page.tsx:665`).
* `GET /api/vcaas/projects/{id}/secrets/…`, `…/domain`, `…/database/…`, `…/github/connect` —
  read and mutate every configured integration.
* `GET /api/vcaas/account`, `GET /api/vcaas/credit-costs`, `…/usage` — account-wide metadata.

The one real containment is the **path confinement** in `resolveVcaasUrl`
(`vcaas-server.ts:54-72`): a request may not leave `/api/v1/vcaas/`. That keeps the blast radius
inside the VCaaS surface — it does not protect anything *within* it.

### 7.3 Findings

**R-01 (P0) — The account-wide API proxy has no authentication, no ownership check and no
per-path allowlist.**
Route: `GET|POST|PUT|DELETE|PATCH /api/vcaas/[...path]`.
Evidence: `src/app/api/vcaas/[...path]/route.ts:28-135` — `handleRequest` never calls
`resolveVcaasContext` or `enforceProjectScope`, forwards the client's method verbatim (`:52-55`)
and forwards every path (`:34`).
Trigger: any request to the deployed URL.
Impact: unauthenticated read of every project, chat history, `.env`, secrets and source;
unauthenticated deletion of projects; unauthenticated publishing and credit spend.
Status: **Confirmed.** Also documented as intentional (`README.md:149-158`, `AGENTS.md`
"Boilerplate mode") — this audit records it as the top risk, not as a hidden defect. The
remediation must preserve the single-key local mode as a documented, explicit configuration.

**R-02 (P1) — The guard seam does not cover the catch-all; the documented remediation path is
therefore incomplete.**
6 of the 8 API route files never import `src/app/api/vcaas/_shared.ts`. Only A-7 and A-8 call the
guards, and both calls are no-ops. `README.md:188` and `AGENTS.md` both instruct the operator to
"make the two guards in `_shared.ts` real" — that alone would leave A-2 … A-6 open.
Remediation: call the seam in every API route file, and add a **path allowlist** to the catch-all
so that even a fully authenticated user cannot reach an unmodelled upstream path.

**R-03 (P1) — `.env` (secrets) are readable by anyone who knows a project slug.**
Route: `GET /api/vcaas/env/[projectId]?env=dev|live`.
Evidence: `env/[projectId]/route.ts:12-25` — slug and `env` are validated (`:15`), but there is no
auth and no ownership check; the upstream `.env` is returned as plain text (`:20-25`).
Impact: disclosure of API keys, database URLs and provider secrets for any project.
Note the contrast with the catch-all: this route **already validates its inputs**, which shows the
pattern is known in this codebase and simply was not applied here.

**R-04 (P1) — Any project's live preview is readable by anyone who knows its slug.**
Route: `GET|POST|PUT|PATCH|DELETE|HEAD /api/preview/[projectId]/[[...path]]`.
Evidence: `preview/.../route.ts:175-176` (`resolveVcaasContext` — no-op), `:179-181` (slug check),
`:200-201` (`enforceProjectScope` — no-op), `:142-147` (upstream resolves the project and returns
404 only if *upstream* says so — but upstream is queried with the **operator's** key, so it
answers for every project the key owns).
Impact: the contents of a user's running application are public to anyone who can guess or
enumerate the slug; the preview is also served **same-origin**, which is what makes R-06 possible.

**R-05 (P1) — Unauthenticated source modification and rebuild.**
Route: `POST /api/visual-edit/[projectId]/apply`.
Evidence: `visual-edit/[projectId]/apply/route.ts:229-230` (no-op context), `:233` (slug check),
`:248` (no-op scope), `:268-271` (`GET files/tree`), `:713` (`POST /projects/{id}/rebuild`).
Impact: an anonymous caller can rewrite a user's project source and trigger a rebuild — the
highest-impact write in the application.

**R-06 (P1) — Same-origin privilege confusion between untrusted generated code and the account API.**
Route: `GET /api/preview/[projectId]/…` (the served document) and `/api/vcaas/*` (the API it can
reach).
Evidence: the preview proxy serves the **generated app's** HTML at Mavly's own origin
(`preview/.../route.ts:286-292`), while the account-wide API proxy is mounted at the same origin
(`/api/vcaas/[...path]`). The copied mitigation, `PREVIEW_RUNTIME_SHIM`
(`src/lib/visual-edit-agent.ts:128-232`), rewrites root-absolute URLs to the preview base — its
own header states the assumption it was built under: *"The proxied document runs on the PLATFORM's
origin … the previewed app's own JavaScript could `fetch('/api/credits/…')` … with the user's
session cookie attached"* (`:113-118`) — an assumption that does not hold in Mavly, where the
platform origin **is** the API origin. The same header states the limit of the mitigation:
*"This is a strong mitigation, NOT a sandbox — code running in the same realm can always undo a
monkey-patch."* (`:125-127`).
Impact: when the visual editor is open, code from an AI-generated application executes with
same-origin access to the operator's account-wide API (projects, `.env`, secrets, deploy, delete).
Trigger: an operator opens the visual editor on a project whose source contains hostile code.
Status: **Confirmed code path**; end-to-end exploitation NOT TESTED (needs a live sandbox).

**R-07 (P1) — Credentialed cross-origin access to every route, including the API.**
Evidence: `src/proxy.ts:14-24` (`isAllowedOrigin`) — in development **any** origin is allowed
(`:15`); in production the app origin (`:16`), **any `https://<label>.totalum-project.com`**
(`:17`) and the same host (`:20-21`); `:31-36` — the request's `Origin` is reflected into
`Access-Control-Allow-Origin` together with `Access-Control-Allow-Credentials: true` (`:34`) and
`Access-Control-Max-Age: 86400` (`:35`).
Impact: a page served from any `*.totalum-project.com` host — the platform's own customer-app
domain, i.e. content the platform serves but does not author — can read and write the operator's
account API from the browser, with credentials.
Status: **Confirmed configuration.** Exploitation depends on the operator being publicly reachable
and on the platform serving user content at that wildcard domain (runtime-dependent).
Remediation: drop `Access-Control-Allow-Credentials` (nothing in the app uses cookies), restrict
the allowlist to the app origin + same-host, and confirm whether the `*.totalum-project.com`
entry is still needed now that Mavly proxies previews same-origin.

**R-12 (P2) — The preview origin cache is not keyed by the caller.**
Evidence: `preview/.../route.ts:138` — `` const cacheKey = `${ctx?.accountUserId ?? ""}:${projectId}` ``.
Today `ctx` is always `{}` (`_shared.ts:48-50`), so the key is `":<projectId>"` — project-only.
The file's own comment (`:94-98`) states that keying by project alone "would let one user's
successful resolution answer another user's request" and that `accountUserId` in the key is "a
security property, not a detail". The property is **not** currently delivered.
Impact: latent cross-tenant origin reuse the moment auth is added without populating
`accountUserId`. Confirmed latent.

**R-21 (P3) — The client comment documents a per-user scoping that does not exist.**
Evidence: `src/lib/vcaas.ts:244-248` — *"GET /vcaas/projects — list the SIGNED-IN USER's projects …
the request carries the caller's own account-scoped key, so it is already per-user."*
In Mavly the browser calls `/api/vcaas/projects` on its own origin, the server adds the **single
operator key** (`vcaas-server.ts:92-94, 118-120`), and there is no per-user key anywhere. The
comment describes the platform's architecture, not this one. A reader following it would wrongly
conclude the dashboard is tenant-scoped.

---

## 8. Input validation and request security

### 8.1 Validation applied per route

| Route | Path/id validation | Query validation | Body validation | Size limit | Timeout | Redirect policy | SSRF guard |
|---|---|---|---|---|---|---|---|
| `/api/config` | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `/api/vcaas/[...path]` | `/api/v1/vcaas/` prefix confinement (`vcaas-server.ts:54-72`); encoded-traversal rejection (`:66`) | none | none | **none** (`route.ts:45` `await req.text()`) | 10 s (`:129`) | follows upstream | n/a |
| `/api/vcaas/env/[projectId]` | ✓ slug + `env∈{dev,live}` (`:15`) | ✓ | n/a | n/a | 10 s | follows upstream | n/a |
| `/api/vcaas/source-code/[projectId]` | **✗** (`:12, 16`) | ✗ | n/a | **none** (`:52` `arrayBuffer()`) | **none** (`:44`) | **follows** (`:44`) | **✗** |
| `/api/vcaas/upload/[projectId]` | **✗** (`:45`) | ✗ | none | **none** (`:48` `formData()`) | **none** (no signal in `vcaasUploadRequest`) | n/a | n/a |
| `/api/vcaas/git-diff` | ✓ https-only + host allowlist (`:27-35, 65`) | ✓ `url` required (`:40`) | n/a | 10 MiB declared + actual (`:18, 99-106`) | 20 s (`:89`) | `redirect:"error"` (`:88`) | ✓ `publicUrlRejectionReason` (`:80`) |
| `/api/preview/[projectId]/[[...path]]` | ✓ slug (`:179`); path segments re-encoded (`:231`) | n/a | none | **none** (`:249` `arrayBuffer()`) | **none** (`:246`) | `redirect:"manual"` + cross-origin → 502 (`:250, 268-281`) | origin is resolved server-side (`:142-168`) — good |
| `/api/visual-edit/[projectId]/apply` | ✓ slug (`:233`) | n/a | per-change validation | 200 files (`:59`), 12 MiB/asset (`:177`) | 20 s (`:373`) | n/a | ✓ `publicUrlRejectionReason` (`:369`) |

### 8.2 Findings

**R-08 (P1) — The source-code route fetches an unbounded archive from an unvalidated URL.**
Route: `GET /api/vcaas/source-code/[projectId]`.
Evidence: `source-code/[projectId]/route.ts:12, 16` — `projectId` is interpolated into the
upstream path without validation or encoding; `:44` — `fetch(downloadUrl)` with **no timeout, no
`redirect` policy and no size cap**; `:52` — `await zipRes.arrayBuffer()` buffers the entire
archive in memory.
Impact: (a) a compromised or misconfigured upstream can make the server fetch an arbitrarily large
body (memory exhaustion on a serverless instance) or redirect to an internal address; (b) a
crafted `projectId` is forwarded upstream unchecked, unlike every sibling route that validates it.
Contrast: `/api/vcaas/git-diff` solves exactly this problem (allowlist + `publicUrlRejectionReason`
+ `redirect:"error"` + timeout + size cap) — the pattern exists in the codebase and was not applied
here.

**R-09 (P2) — The upload route buffers the whole multipart body and has no upstream timeout.**
Route: `POST /api/vcaas/upload/[projectId]`.
Evidence: `upload/[projectId]/route.ts:48` — `await req.formData()` parses the entire body into
memory with no server-side cap; `:49-52` → `vcaasUploadRequest`, which sets no `AbortSignal`
(`vcaas-server.ts:144-153`) so the upstream call can hang indefinitely, holding the invocation.
The **client** caps at 8 MB (`src/lib/upload.ts:34`) and at 12 MB in a second place
(`src/lib/attachments.ts:44`) — but `next.config.ts` sets no `bodySizeLimit` and the deployment
target applies its own limit (Vercel's serverless request-body limit is 4.5 MB — **runtime-dependent,
not verified in this repository**). The client-side check is therefore the only limit, and it is
inconsistent between two files.

**R-10 (P2) — The preview proxy has no upstream timeout and no request-body limit.**
Evidence: `preview/.../route.ts:246-252` — `fetch(target, { … })` with no `signal`; `:249` —
`await request.arrayBuffer()` for every non-GET/HEAD method, unbounded.
Impact: a slow sandbox holds a serverless invocation open indefinitely; a large POST body is
buffered in memory. The route *does* correctly strip `cookie` and `origin` from forwarded headers
(`:68-71`) and drop `set-cookie` from the response (`:75`) — the missing piece is only the limit.

**R-11 (P2) — `vcaasUploadRequest` has no timeout.**
Evidence: `src/lib/vcaas-server.ts:144-153` — `fetch(…)` with `method`, `headers`, `body` and no
`signal`, while `vcaasRequest` sets `AbortSignal.timeout(10_000)` at `:129`.

**R-13 (P2) — Project-name validation disagrees between the dashboard and the canonical rule.**
Evidence: `src/app/page.tsx:333-334` (`normalizeId`), `:354` and `:910` (minimum **3**), `:902`
(the UI copy says "3-35 chars"), versus `src/lib/project-slug.ts:24-30`
(`PROJECT_SLUG_MIN_LENGTH = 4`, `PROJECT_SLUG_MAX_LENGTH = 35`, `RESERVED_SLUG_FRAGMENT = "-dev-"`)
and the upstream contract quoted in that file's header (`project-slug.ts:9`).
Impact: a user naming a project `abc` passes the client check and receives an upstream `400`;
a name containing `-dev-` is rejected upstream as `RESERVED_PROJECT_NAME` after the client
accepted it. `src/lib/project-slug.ts` already provides `slugify` (`:132`), `suggestProjectSlug`
(`:183`) and `nextAvailableSlug` (`:211`) — the dashboard uses none of them, so the canonical
implementation exists and is unused by the very flow it was written for.

**R-14 (P2) — Security headers are minimal and the frame policy is maximally permissive.**
Evidence: `src/proxy.ts:43-47` — `Content-Security-Policy: frame-ancestors *` and
`X-Frame-Options` deleted, on **every** response. There is no `default-src`, no `script-src`, no
`object-src`, no `Referrer-Policy`, no `Strict-Transport-Security`, no `X-Content-Type-Options`.
`frame-ancestors *` means any site can frame the dashboard and the workspace (clickjacking); the
impact today is low (no sessions), and it becomes P1 the moment auth lands.
Note: `next.config.ts` `headers()` applies `Cache-Control: no-cache, no-store, must-revalidate` to
`/:path*` — a genuinely good control (no caching of sensitive responses anywhere), though it also
applies to static assets such as `/logo/Mavly.png` (1.2 MB, re-fetched on every load).

**R-15 (P2) — No rate limiting anywhere.**
Evidence: no rate-limit middleware, no `Map`-based limiter, no dependency on a rate-limit library
in `package.json`. The only abuse control in the app is `Access-Control-Max-Age: 86400`
(`proxy.ts:35`), which is a preflight cache, not a limit.
Impact: the credit-spending endpoints (`agent/start`, `deployments/deploy`, `projects/launch`,
`files/*`, `rebuild`) and the free-but-expensive ones (`agent/status` polling every 10 s from
every open tab) can be driven by a single unauthenticated caller.

**R-16 (P3) — `/api/config` publicly reports key presence.**
Route: `GET /api/config`. Evidence: `api/config/route.ts` (12 lines) returns
`{ ok:true, data:{ configured: <boolean> } }` with no auth.
Impact: low on its own — it confirms to an attacker whether the deployment is live — but it is a
free, unauthenticated health oracle that distinguishes "misconfigured" from "wrong key", and it
turns the app's configuration state into a public fact. Worth keeping the route (the UI uses it at
`page.tsx:219`) but it should not be unauthenticated on a public deployment.

**R-30 (P3) — The client's upload caps disagree with each other and are enforced nowhere
server-side.**
Evidence: `src/lib/upload.ts:34` — `MAX_UPLOAD_BYTES = 8 * 1024 * 1024`; `src/lib/attachments.ts:44`
— `MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024`; `upload/[projectId]/route.ts:48` — the server parses
the whole multipart body with no cap of its own. The upstream's own limit is 12 MB
(`upload/[projectId]/route.ts:10`), and the deployment platform applies a third limit
(Vercel serverless: 4.5 MB — runtime-dependent, not verified here). Three numbers, one enforced
cap, and the enforcement is client-side only.

**R-22 (P3) — Undocumented environment variables.**
Evidence: `.env.example` lists only `TOTALUM_VCAAS_API_KEY`, `TOTALUM_API_URL`,
`NEXT_PUBLIC_APP_URL`. The code also reads `VCAAS_API_KEY` (legacy fallback,
`vcaas-server.ts:93`) and `TOTALUM_SOURCE_TAGS` (`src/lib/visual-edit-upgrade.ts`).
Impact: an operator who sets only the documented variables is fine; an operator who sets the
legacy name gets a working but undocumented key source. No secret values were read or reported.

### 8.3 Controls that are already correct (do not remove)

| Control | Location | Why it matters |
|---|---|---|
| Upstream path confinement to `/api/v1/vcaas/` | `vcaas-server.ts:54-72` | The single most important containment in a single-key app |
| Encoded-traversal rejection (`%2e`, `%2f`, `%5c`) in the path | `vcaas-server.ts:66` | Stops double-decoding attacks upstream |
| Query string left untouched | `vcaas-server.ts:62-64` | `files/content?path=src%2Fapp%2Fpage.tsx` is legitimate |
| `resolveVcaasUrl` on **both** request helpers | `vcaas-server.ts:126, 148` | No route can forget it |
| SSRF stack: https-only + host allowlist + DNS-resolving guard + `redirect:"error"` + timeout + size cap | `git-diff/route.ts:27-35, 65-83, 86-106` | The reference implementation to copy |
| `publicUrlRejectionReason` (async, DNS-resolving) | `src/lib/safe-url.ts:214` | Blocks private ranges and rebinding |
| Server-resolved preview origin (never taken from the request) | `preview/.../route.ts:142-168, 231-233` | The request cannot name a target host |
| Protocol allowlist on the preview URL | `preview/.../route.ts:160-162` | `javascript:` / `file:` refused |
| `cookie`/`origin` stripped from forwarded preview requests | `preview/.../route.ts:68-71` | No session or referrer leak to the previewed app |
| `set-cookie`, CSP and `X-Frame-Options` stripped from preview responses | `preview/.../route.ts:73-77` | The previewed app cannot set cookies on the operator's origin |
| Cross-origin redirects blocked (502) | `preview/.../route.ts:268-281` | The proxy's remit cannot be escaped |
| `isRoutableProjectSlug` on env / preview / visual-edit | `_shared.ts:3`, `project-slug.ts:91-94` | Path-traversal defence on three of four project routes |
| `encodeURIComponent` on every project id built by the client | `vcaas.ts:237`, `vcaas.ts:1143, 1158` | No separator injection |
| `api-key` never sent to the browser | `vcaas-server.ts:118-120` (server-only module) | The key stays server-side |
| `no-store` on all responses | `next.config.ts` `headers()` | No caching of sensitive responses |
| Upstream error envelope normalised to one stable shape | `vcaas-errors.ts`, `[...path]/route.ts:99-102` | The UI can branch on `code` |
| Upstream refusal status forwarded, not swallowed | `[...path]/route.ts:72-86`, `upload/.../route.ts:63-75` | The user is told what actually happened |
| `AbortSignal.timeout(10_000)` on the main upstream helper | `vcaas-server.ts:129` | The app does not hang on a slow upstream |

---

## 9. Redirects, rewrites, 404 behaviour

### 9.1 Every redirect in the application

| From | To | Kind | Trigger | Notes |
|---|---|---|---|---|
| `/[...slug]` (any unmatched URL) | `/` | `redirect()` — 307 | any unmatched path | `[...slug]/page.tsx:8-10` |
| `/login` (after the 700 ms "sign-in") | `?redirect=` value, default `/` | `router.push` (client) | sign-in simulation | `login/page.tsx:13, 30` — **unvalidated, can be an absolute external URL** |
| `/api/preview/{id}/…` upstream redirect | rewritten to `/api/preview/{id}{path}` | 3xx pass-through | sandbox redirect | `preview/.../route.ts:268-281` — cross-origin → 502 |
| `/api/preview/{id}/…` cross-origin redirect | — | 502 JSON | sandbox redirect off-origin | `preview/.../route.ts:274` |
| Dashboard project card | `/project/{projectId}` | `Link` | click | `page.tsx` card link |
| Workspace menu | `/` | `router.push` | click | `page.tsx:1339, 1343` |
| Login page logo / back | `/home` | `Link` | click | `login/page.tsx:47, 56` |
| Hero legal notice | `/terms`, `/privacy` | `Link` | click | `HeroSection.tsx:369, 373` |

### 9.2 Rewrites and header rules

| Mechanism | Location | Effect |
|---|---|---|
| `next.config.ts` `headers()` | `/:path*` | `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `src/proxy.ts` matcher | `proxy.ts:68-79` | excludes `_next/static`, `_next/image`, `favicon.ico`, `*.svg|png|jpg|jpeg|gif|webp` from the proxy |
| `src/proxy.ts` OPTIONS | `proxy.ts:54-59` | 204 + CORS/CSP headers, short-circuits every OPTIONS request |
| `next/image` remote patterns | `next.config.ts` | `placeholders.io`, `ik.imagekit.io` only — the image optimiser cannot be pointed elsewhere |
| `public/_headers` | file | **Cloudflare Workers static-assets convention — inert under Next.js/Vercel.** It looks like a security-headers file and is not one. |

### 9.3 404 behaviour

**There is no 404 in this application.**

* `src/app/not-found.tsx` (24 lines) exists and is well-formed — and **can never render**:
  `[...slug]` matches every path that no more specific route claims, and it calls `redirect("/")`.
  Next resolves the more specific match first, so every unknown URL becomes a **307 to `/`**.
* Consequences: broken links and mistyped URLs land on the dashboard instead of an error page;
  crawlers see a soft redirect instead of a 404; a mistyped project URL shows the dashboard; the
  application cannot distinguish "unknown path" from "home page" in logs or analytics.
* The workspace does not use `notFound()` either: `src/app/project/[projectId]/page.tsx:1330`
  renders an inline *"Project not found"* card — **with HTTP status 200**, because it is a client
  component that fetched a missing project. Search engines and uptime monitors will read every
  missing project as a healthy page.

### 9.4 Findings

**R-17 (P2) — Every unknown URL silently redirects to the dashboard; the 404 page is dead code.**
Evidence: `src/app/[...slug]/page.tsx:8-10` vs `src/app/not-found.tsx` (unreachable).
Remediation: replace the redirect with `notFound()` so the root 404 renders. The stated intent in
the file's own comment (`old locale links like /en or /es, the former /dashboard path`) can be
preserved with explicit redirects for *those* known paths only.

**R-18 (P2) — A missing project answers `200 OK`.**
Evidence: `src/app/project/[projectId]/page.tsx:1330`. The page is a client component, so the
status is already sent before the project is fetched; the fix is to resolve the project on the
server (or issue a 404 from a server-side check) rather than to render a card.

**R-19 (P3) — `public/_headers` is inert.** It reads like a security policy and is applied by
neither Next.js nor Vercel. Anything it claims to set is not set. The equivalent real mechanism
is `next.config.ts` `headers()`.

---

## 10. Upstream dependency map

Every Mavly route ultimately depends on the **Totalum API** (`https://builder-api.totalum.app/api/v1/vcaas`,
overridable with `TOTALUM_API_URL`). The upstream implementation is **not inspectable from this
repository** — only its public Markdown reference is. All statements in this section about upstream
behaviour are therefore taken from (a) the API reference, (b) the code comments in this repo, and
(c) the observed upstream error codes; none were executed.

### 10.1 Per-route dependency

| Route | Client method | Upstream endpoint | Kind | Credential | Errors | Timeout | Retry safety |
|---|---|---|---|---|---|---|---|
| `/api/vcaas/[...path]` | `vcaasApi.*` (~40 methods, ~110 paths, 15 namespaces) | `any path under /api/v1/vcaas/` | read + write + **credit spend** + deploy | `api-key` header, server-side (`vcaas-server.ts:118-120`) | normalised via `normalizeVcaasError`; 401/403 → "invalid or revoked key" (`[...path]/route.ts:72-86`) | 10 s | **Depends on the upstream path.** Writes are not idempotent by construction (the client does not retry them; the upload route sets `retryable:false` for permanent refusals — `upload/.../route.ts:71`) |
| `/api/vcaas/env/[projectId]` | `vcaasApi.env.read` / `ProjectApiKeysModal.tsx:65` | `GET /projects/{id}/env?env=dev\|live` | read (secrets) | `api-key` | upstream `{errors}` → own envelope (`env/.../route.ts:26-30`) | 10 s | safe |
| `/api/vcaas/source-code/[projectId]` | `vcaas.ts:1143` | `GET /projects/{id}/source-code` → signed URL → storage | read | `api-key` | 404/402/400/502 mapping (`source-code/.../route.ts:28-38`) | 10 s + **none** for the ZIP | safe |
| `/api/vcaas/upload/[projectId]` | `vcaas.ts:1158` | `POST /projects/{id}/files/upload` | write (file) | `api-key` | upstream status forwarded; `retryable` flag (`upload/.../route.ts:63-75`) | **none** | **not safe** — a retry re-uploads; the route correctly marks permanent refusals non-retryable |
| `/api/vcaas/git-diff` | `DiffViewer` | external signed storage URL | read | none (public signed URL) | 400/410/413/502/500 | 20 s | safe |
| `/api/preview/[projectId]/…` | `preview/.../route.ts:142` + workspace fetch | `GET /projects/{id}` → sandbox origin | read + **the sandbox app's own traffic** | `api-key` | 404 project / 409 no preview / 502 unreachable (`preview/.../route.ts:145-167, 254-257`) | 10 s + **none** for the sandbox | safe (GET/HEAD); the proxy forwards POST/PUT/PATCH/DELETE to the app |
| `/api/visual-edit/[projectId]/apply` | `use-visual-editor.ts:360` | `GET /projects/{id}/files/tree?limit=5000`, `GET/PUT /projects/{id}/files/content`, `POST /projects/{id}/rebuild` | **write + rebuild** | `api-key` | per-file error reporting; `rebuildStarted`/`rebuildCode` returned (`apply/route.ts:806-807`) | 10 s + 20 s per asset | **not safe** — writes are applied file by file, then a rebuild is started; a partial failure leaves the project half-written (`apply/route.ts:549`) |
| `/api/config` | `page.tsx:219` | none | local | none | n/a | n/a | n/a |

### 10.2 Upstream surfaces the catch-all can reach

| Namespace | Representative paths | Cost / effect |
|---|---|---|
| `projects` | list, get, create, delete, launch, clone, import, export, groups | write |
| `agent` | start, status, stop, full-conversation, restart-server, clear-context | **credit spend** |
| `deployments` | deploy, status | **publish + credit** |
| `files` | tree, content (GET/PUT), write, upload | **write** |
| `database` | schema, rows, records, sql, ask, backups | **write** |
| `secrets` | list/set/delete | **write (credentials)** |
| `domain` | buy, connect, DNS, transfer | write |
| `github` | status, connect, disconnect, pull | write |
| `figma` | status, connect, disconnect, validate | write |
| `versions` | list, recover | **write** |
| `rebuild` | status, start | write |
| `usage` / `credit-costs` / `account` | — | read (account-wide) |
| `analytics`, `mobile`, `payments`, `cron`, `mcp` | — | read/write |

**Routes that must change if the Totalum dependency is abstracted or replaced** (per the
"backend abstraction" question in §17): every one of the 8 API route files, plus
`src/lib/vcaas.ts` (the ~40 client methods), `src/lib/vcaas-server.ts` (the only key holder),
`src/lib/vcaas-types.ts` (the response contracts) and `src/lib/vcaas-errors.ts` (the error-code
mapping). The UI layer above them needs no change — which is the correct layering and worth
preserving.

### 10.3 Credit-spending endpoints (metering points)

`agent/start` · `projects/launch` · `deployments/deploy` · `versions/*/recover` ·
`agent/server/start-or-restart` · `domain` · `files/*` · `rebuild` — all reachable
**unauthenticated** through the catch-all. `AGENTS.md` lists exactly these as the set to gate
when a balance is introduced. The UI already raises the global `INSUFFICIENT_CREDITS` signal from
a single chokepoint (`src/lib/vcaas.ts:183-188, 195-197`), so a 402 gate on the server side would
plug into existing UI.

---

## 11. Broken links, client/server mismatches, route correctness

### 11.1 Internal link inventory

| Link | Target | Exists? |
|---|---|---|
| Hero "Continue with Google" | `/login?provider=google` | ✓ (`login/page.tsx`) |
| Hero "Continue with GitHub" | `/login?provider=github` | ✓ |
| Hero legal notice | `/terms`, `/privacy` | ✓ |
| Login header "Back to Mavly", logo | `/home` | ✓ |
| Dashboard → workspace | `/project/{projectId}` | ✓ (dynamic) |
| Workspace menu → dashboard | `/` | ✓ |
| Login → dashboard (after sign-in) | `/` or `?redirect=` | ✓ |
| Dashboard "Sign in" | `/login` | ✓ |

**No dead internal links were found.** Every `href` and every `router.push` in `src/` resolves to
an existing route.

### 11.2 Client/server contract mismatches

| Mismatch | Client | Server | Effect |
|---|---|---|---|
| Minimum project-name length | 3 (`page.tsx:354, 902, 910`) | 4 (`project-slug.ts:26`) | Upstream `400` after the client accepted the name |
| Reserved name fragment | not blocked | `-dev-` reserved (`project-slug.ts:30`) | Upstream `400 RESERVED_PROJECT_NAME` |
| Slug generation | `suggestName` (`page.tsx:336-340`) | `suggestProjectSlug` (`project-slug.ts:183`) | Two implementations of the same rule; the canonical one is unused by the create flow |
| Attachment size | 8 MB (`upload.ts:34`) vs 12 MB (`attachments.ts:44`) | platform limit (4.5 MB on Vercel — runtime-dependent) | Client may accept a file the platform rejects |
| Upload size vs upstream limit | client refuses > 8 MB | upstream refuses > 12 MB (`upload/.../route.ts:10`) | Client is stricter — safe, but the two numbers are unrelated |
| `GET /api/preview/{id}/` | HEAD used for a liveness probe (`page.tsx:1106`) | `HEAD` exported (`preview/.../route.ts:310`) | ✓ match |

### 11.3 Duplicated and overlapping logic

| Duplication | Locations | Note |
|---|---|---|
| Slug normalisation | `page.tsx:333-334` vs `project-slug.ts:132-161` | **Three** implementations of the same rule (`normalizeId`, `suggestName`, `slugify`/`suggestProjectSlug`) |
| Error envelope | `src/lib/api.ts` vs `src/lib/vcaas.ts:190-209` | Two client fetch layers with the same contract; `vcaas.ts` adds `code`/`status`/`retryable` |
| Upstream error text | `[...path]/route.ts:72-86` and `upload/.../route.ts:32-38` | Both map upstream refusals to human text, differently |
| Long-operation watching | `page.tsx:902-1014` (page-owned) | Correct by design — do not move it into a modal |

### 11.4 HTTP semantics and status codes

| Issue | Location | Note |
|---|---|---|
| `OPTIONS` is answered by the proxy (204) before any handler runs | `proxy.ts:54-59` | Every route's real preflight semantics are replaced by the proxy's blanket 204; the `Allow` header Next.js would generate is lost |
| Unsupported methods → 405 | Next.js default | Not overridden anywhere — correct |
| `405`/`404`/`500` bodies are JSON `{"ok":false,…}` | consistent across routes | Good, except A-1 and A-7 which use their own shapes |
| `GET` on a mutation-shaped upstream path | possible through A-2 | The catch-all forwards the method verbatim with no per-path method allowlist |
| `DELETE` with a body | `vcaas.ts:230-231` (`deleteWithBody`) | Legal, and the code documents why it is separate |

### 11.5 Missing route states

| Missing | Where it should be | Consequence |
|---|---|---|
| `loading.tsx` | none anywhere (0 files) | No streamed shell; the workspace waits for a client-side fetch before anything meaningful appears |
| 401 state | no route | No way to render "sign in required" — because no route requires one |
| 403 state | no route | No way to render "not your project" — because no route checks |
| 404 for a missing project | `project/[projectId]/page.tsx:1330` | 200 + inline card (R-18) |
| 404 for an unknown path | `not-found.tsx` | Unreachable (R-17) |

### 11.6 Test coverage of routes

**None.** There is no test suite in the repository. `src/lib/project-slug.ts:20` and `:145` both
cite `src/lib/__tests__/project-slug.test.ts` — **that file does not exist** (verified by
filesystem search). The slug validator that guards three project routes is therefore untested, and
the reference to a missing test file will mislead the next maintainer into believing it exists.

---

## 12. Positive controls (what is already right)

These are load-bearing and must survive every remediation:

1. **Path confinement to `/api/v1/vcaas/`** — `vcaas-server.ts:54-72`, applied inside both request
   helpers, so no route can forget it. In a single-key app this is the containment that matters
   most.
2. **Encoded-traversal rejection** — `vcaas-server.ts:66`.
3. **A real SSRF stack on the git-diff route** — https-only, host allowlist, DNS-resolving
   `publicUrlRejectionReason`, `redirect:"error"`, 20 s timeout, 10 MiB cap
   (`git-diff/route.ts:27-35, 65-106`). This is the template the other two fetch routes should
   follow.
4. **The preview origin is resolved server-side from the project**, never taken from the request
   (`preview/.../route.ts:142-168, 231-233`), with a protocol allowlist (`:160-162`) and
   cross-origin redirects refused (`:268-281`).
5. **Credential hygiene in the proxy** — `cookie`, `origin`, `referer` stripped outbound; `set-cookie`,
   CSP and `X-Frame-Options` stripped inbound (`preview/.../route.ts:68-77`).
6. **The key is read in exactly one server-only module** and never reaches the browser
   (`vcaas-server.ts:92-94`; the module is never imported by a client component).
7. **One stable error envelope**, normalised once at a single chokepoint
   (`vcaas.ts:190-209`, `vcaas-errors.ts`), with the upstream's own code preserved in
   `upstreamCode` — this is what lets the workspace distinguish "still starting" from "broken".
8. **Upstream refusals are forwarded, not swallowed** — including the upstream status and a
   human-readable reason (`[...path]/route.ts:72-86`, `upload/.../route.ts:32-38, 63-75`).
9. **`no-store` on every response** (`next.config.ts` `headers()`).
10. **Bounded long-operation watchers** owned by the page, not the modal that started them
    (`project/[projectId]/page.tsx:902-1014`, 60 × 8 s, with an honest "we stopped watching"
    message).
11. **The visual-edit engine's own guards** — 200-file cap, 12 MiB per asset, per-asset SSRF
    check, 20 s timeout, and a rebuild that is started only after the writes
    (`apply/route.ts:59, 177, 369-373, 713`).
12. **The document-level honesty** — `_shared.ts:18-22`, `proxy.ts:49-51`, `README.md:149-158` all
    state plainly that there is no auth. This is rare and valuable; the remediation should keep it
    true rather than paper over it.

---

## 13. Findings by severity

Severity is assigned by **exploitability against the deployed application as written**, not by
theoretical worst case. No finding is inflated: where a prerequisite is outside this repository it
is marked *runtime-dependent*; where a finding is a deliberate, documented design decision it is
labelled *by design*.

### P0 — Critical (1)

| ID | Title | Affected routes | Evidence | Status |
|---|---|---|---|---|
| **R-01** | Unauthenticated access to the entire account-wide Totalum API surface | `GET\|POST\|PUT\|DELETE\|PATCH /api/vcaas/[...path]` | `src/app/api/vcaas/[...path]/route.ts:28-135` (no guard calls; method and path forwarded verbatim at `:34, 52-55`); `_shared.ts:48-62`; `README.md:149-158` | **Confirmed** (by design for local/private use; critical for any public deployment) |

### P1 — High (7)

| ID | Title | Affected routes | Evidence | Status |
|---|---|---|---|---|
| **R-02** | The guard seam is not called by 6 of 8 API route files, so the documented auth remediation path does not cover the catch-all | A-1 … A-6 | `[...path]/route.ts:28-135`; `_shared.ts:18-22`; `README.md:188` | **Confirmed** |
| **R-03** | `.env` secrets readable without authentication or ownership | `GET /api/vcaas/env/[projectId]` | `env/[projectId]/route.ts:12-25` | **Confirmed** |
| **R-04** | Any project's live preview readable without ownership | `GET\|POST\|PUT\|PATCH\|DELETE\|HEAD /api/preview/[projectId]/[[...path]]` | `preview/.../route.ts:175-201` | **Confirmed** |
| **R-05** | Unauthenticated source writes and rebuild | `POST /api/visual-edit/[projectId]/apply` | `apply/route.ts:229-248, 268-271, 713` | **Confirmed** |
| **R-06** | Same-origin privilege confusion: untrusted generated app code can reach the account API | `/api/preview/[projectId]/…` + `/api/vcaas/*` | `preview/.../route.ts:286-292`; `visual-edit-agent.ts:113-127` | **Confirmed code path**; exploitation NOT TESTED |
| **R-07** | Credentialed CORS for any `*.totalum-project.com` origin (and any origin in dev) on every route | all routes | `src/proxy.ts:14-24, 31-36` | **Confirmed config**; exploitation runtime-dependent |
| **R-08** | Unbounded, unvalidated server-side archive fetch | `GET /api/vcaas/source-code/[projectId]` | `source-code/[projectId]/route.ts:12, 16, 44, 52` | **Confirmed** |

### P2 — Medium (11)

| ID | Title | Affected routes | Evidence | Status |
|---|---|---|---|---|
| **R-09** | Unbounded multipart buffering; no upstream timeout on upload | `POST /api/vcaas/upload/[projectId]` | `upload/[projectId]/route.ts:45, 48-52`; `vcaas-server.ts:144-153` | **Confirmed** (platform body limit runtime-dependent) |
| **R-10** | No upstream timeout; unbounded request body in the preview proxy | `/api/preview/[projectId]/…` | `preview/.../route.ts:246-252` | **Confirmed** |
| **R-11** | `vcaasUploadRequest` has no `AbortSignal` | upload | `vcaas-server.ts:144-153` | **Confirmed** |
| **R-12** | Preview origin cache is not keyed by the caller | `/api/preview/…` | `preview/.../route.ts:138` vs `:94-98` | **Confirmed latent** |
| **R-13** | Client/server disagreement on project-name rules (3 vs 4 chars; `-dev-` not blocked) | `/` | `page.tsx:333-334, 354, 902, 910` vs `project-slug.ts:24-30` | **Confirmed** |
| **R-14** | `frame-ancestors *`, no CSP beyond it, no other security headers | all routes | `src/proxy.ts:43-47`; `next.config.ts` `headers()` | **Confirmed** |
| **R-15** | No rate limiting on any route, including credit-spending ones | all routes | repository-wide search; `proxy.ts:35` is the only abuse control | **Confirmed absence** |
| **R-17** | Every unknown URL redirects to `/`; the 404 page is unreachable | `/[...slug]` | `[...slug]/page.tsx:8-10`; `not-found.tsx` | **Confirmed** |
| **R-18** | A missing project answers `200 OK` | `/project/[projectId]` | `project/[projectId]/page.tsx:1330` | **Confirmed** |
| **R-26** | The sign-in is simulated; the product claims an identity it never creates | `/login` | `login/page.tsx:18-32, 34-38` | **Confirmed** (rendered result NOT TESTED) |
| **R-27** | Open redirect via `/login?redirect=` | `/login` | `login/page.tsx:13, 30` | **Confirmed** |

### P3 — Low (11)

| ID | Title | Affected routes | Evidence | Status |
|---|---|---|---|---|
| **R-16** | `/api/config` publicly reports key presence | `GET /api/config` | `api/config/route.ts` | **Confirmed** |
| **R-19** | `public/_headers` is a Cloudflare convention and is inert | n/a | file vs `next.config.ts` | **Confirmed** |
| **R-20** | The catch-all forwards the client's HTTP method verbatim, with no per-path method allowlist | `/api/vcaas/[...path]` | `[...path]/route.ts:52-55` | **Confirmed** |
| **R-21** | Client comment documents per-user scoping that does not exist | `/` | `vcaas.ts:244-248` vs `vcaas-server.ts:92-94` | **Confirmed** |
| **R-22** | Undocumented environment variables (`VCAAS_API_KEY`, `TOTALUM_SOURCE_TAGS`) | n/a | `vcaas-server.ts:93`; `src/lib/visual-edit-upgrade.ts`; `.env.example` | **Confirmed** |
| **R-23** | Upstream "hosted preview" origin assumption baked into a copied comment | preview | `visual-edit-agent.ts:113-118` | **Confirmed** |
| **R-24** | `sessionStorage` carry-over keys use the upstream product prefix `vibebuild:` | `/` → `/project/[id]` | `page.tsx:465`; `project/[projectId]/page.tsx:868-879` | **Confirmed** (cross-brand leftover) |
| **R-25** | The pending prompt is auto-submitted on arrival with no confirmation | `/project/[projectId]` | `project/[projectId]/page.tsx:861-881` | **Confirmed** (by design) |
| **R-28** | No logout / no session / no revocation | `/login` | repository-wide | **Confirmed absence** |
| **R-29** | The canonical slug validator cites a test file that does not exist | n/a | `project-slug.ts:20, 145` | **Confirmed** |
| **R-30** | The client's upload caps disagree (8 MB vs 12 MB) and are enforced nowhere server-side | upload | `upload.ts:34`; `attachments.ts:44`; `upload/[projectId]/route.ts:48` | **Confirmed** (platform limit runtime-dependent) |

### Informational (5)

| ID | Note |
|---|---|
| **I-01** | Next.js auto-implements `OPTIONS` on all 8 route handlers and answers unsupported methods with `405` (`node_modules/next/dist/docs/.../route.md`). `src/proxy.ts:54-59` intercepts every `OPTIONS` first, so the framework's own `Allow` header is never seen. |
| **I-02** | `next.config.ts` sets `allowedDevOrigins: ["*"]` — dev-only, but it allows any origin to reach the dev server. |
| **I-03** | `next.config.ts` sets no `bodySizeLimit`; it only affects Server Actions, and this app has none — route-handler body limits are the platform's. |
| **I-04** | `next.config.ts` `headers()` applies `no-store` to `/:path*`, including the 1.2 MB `/logo/Mavly.png`. |
| **I-05** | `src/app/api/vcaas/_shared.ts` re-exports `isRoutableProjectSlug` from `@/lib/project-slug` — the one place the canonical rule is wired into the routing layer. |

### 13.1 Count

**P0: 1 · P1: 7 · P2: 11 · P3: 11 · Informational: 5 — 35 findings.**

---

## 14. Route-by-route remediation matrix

Every sensitive endpoint, with the concrete control to add. **Nothing here has been implemented.**
Prerequisites are listed in §15.

| Route | Method(s) | Current risk | Auth to add | Ownership to add | Validation to add | Limits to add | Findings |
|---|---|---|---|---|---|---|---|
| `/api/vcaas/[...path]` | GET, POST, PUT, DELETE, PATCH | **P0** | Session check via `resolveVcaasContext` | Project scope check for every `projects/*` path | Per-path allowlist of upstream paths + per-path method allowlist | `req.text()` body cap; keep the 10 s upstream timeout | R-01, R-02, R-20 |
| `/api/vcaas/env/[projectId]` | GET | **P1** | Session check | Owner check on `projectId` | Already validates slug + `env` — keep | Keep `no-store` | R-03 |
| `/api/vcaas/source-code/[projectId]` | GET | **P1** | Session check | Owner check | `isRoutableProjectSlug` + `encodeURIComponent` | Timeout on the ZIP fetch; `redirect:"error"`; max bytes; stream instead of `arrayBuffer()` | R-08 |
| `/api/vcaas/upload/[projectId]` | POST | **P2** | Session check | Owner check | `isRoutableProjectSlug` | Server-side byte cap (8 MB, matching `upload.ts:34`); `AbortSignal` timeout; reject non-multipart | R-09, R-11, R-30 |
| `/api/vcaas/git-diff` | GET | Low–Med | Session check (optional) | n/a (no project) | **Already correct** — keep | **Already correct** — keep | — |
| `/api/preview/[projectId]/[[...path]]` | GET, POST, PUT, PATCH, DELETE, HEAD | **P1** | Session check (exists, inert) | Owner check (exists, inert) | Slug check exists — keep | Upstream fetch timeout; request-body cap; **serve on a separate origin** | R-04, R-06, R-10, R-12, R-23 |
| `/api/visual-edit/[projectId]/apply` | POST | **P1** | Session check (exists, inert) | Owner check (exists, inert) | Slug check exists — keep | Existing caps (200 files / 12 MiB) — keep | R-05 |
| `/api/config` | GET | **P3** | Optional: return `configured` only to an authenticated caller | n/a | n/a | n/a | R-16 |
| `/` (dashboard) | GET | **P0** (via the API) | Page-level gate (redirect to `/login`) | Filter the list to the caller's projects | Use `project-slug.ts` helpers | n/a | R-01, R-13, R-21, R-24 |
| `/project/[projectId]` | GET | **P0** (via the API) | Page-level gate | Owner check | Validate `projectId` | n/a | R-01, R-18, R-25 |
| `/login` | GET | **P2** | — | — | Allow only **relative** `redirect` values | — | R-26, R-27, R-28 |
| `/[...slug]` | GET | **P2** | — | — | — | — | R-17 |
| `/home`, `/terms`, `/privacy` | GET | Low | — | — | — | — | R-14 (headers) |
| `src/proxy.ts` | all | **P1** | Page/session gate for `/` and `/project/*` | — | — | — | R-07, R-14, R-15 |
| `next.config.ts`, `public/_headers`, `.env.example`, `src/lib/project-slug.ts` | n/a (configuration & libraries) | **P3** | — | — | — | — | R-19, R-22, R-29 |

---

## 15. Implementation order and dependencies

**Nothing below has been implemented.** The order is chosen so that each phase is independently
deployable and testable, and so that no phase makes a later one harder.

### Priority 1 — Authentication on the privileged API surface
* **Routes:** `/api/vcaas/[...path]`, `/api/vcaas/env/[projectId]`, `/api/vcaas/source-code/[projectId]`, `/api/vcaas/upload/[projectId]`, `/api/visual-edit/[projectId]/apply`, `/api/preview/[projectId]/[[...path]]`.
* **Files:** `src/app/api/vcaas/_shared.ts` (make the two guards real), the six route files above.
* **Prerequisites:** a chosen auth provider; a decision on the key-per-user vs operator-key model; **a decision on the local single-user mode** (it must keep working — a documented `AUTH_MODE=local|multi` switch is the least disruptive shape).
* **Expected result:** every sensitive endpoint answers `401` without a session.
* **Tests:** unauthenticated `GET /api/vcaas/projects` → 401; the dashboard's own read path still works in local mode.

### Priority 2 — Project ownership and isolation
* **Routes:** all project-scoped routes above + `/` and `/project/[projectId]`.
* **Files:** `_shared.ts`, `src/proxy.ts` (page gate), `src/app/page.tsx` (filter the list), `src/app/project/[projectId]/page.tsx`.
* **Prerequisites:** Priority 1; a `projectId ↔ user` mapping (Supabase table, per `AGENTS.md`).
* **Expected result:** user A cannot read, write, preview or delete user B's project — verified per route, not just in the UI.
* **Tests:** cross-tenant matrix — for each of the 6 project-scoped routes, request with user B's project id and assert 403/404.

### Priority 3 — Environment, source, database and file operations
* **Routes:** `/api/vcaas/env/[projectId]`, `/api/vcaas/source-code/[projectId]`, `/api/vcaas/upload/[projectId]`.
* **Files:** those three route files, `src/lib/vcaas-server.ts`.
* **Prerequisites:** Priority 2.
* **Expected result:** secrets require ownership; the source download is bounded and streamed; uploads are capped server-side.
* **Tests:** over-size upload → 413; a source download over the cap → 413; a redirecting download URL → refused.

### Priority 4 — Preview proxy and visual-edit write authorisation
* **Routes:** `/api/preview/[projectId]/[[...path]]`, `/api/visual-edit/[projectId]/apply`.
* **Files:** the preview route, `apply/route.ts`, `src/lib/preview-proxy.ts`, `src/lib/visual-edit-agent.ts`.
* **Prerequisites:** Priorities 1-2. **Decision required:** serve the preview from a dedicated origin (the long-term answer named in `visual-edit-agent.ts:126`), or accept the same-origin risk with a documented mitigation.
* **Expected result:** the preview is only reachable for owned projects, and the generated app's code cannot reach the account API.
* **Tests:** owned vs unowned project; the generated app attempting `fetch("/api/vcaas/projects")` from inside the preview frame.

### Priority 5 — OAuth callbacks, sessions and redirects
* **Routes:** `/login`, plus new `/api/auth/start` and `/api/auth/callback`.
* **Files:** `src/app/login/page.tsx`, `src/components/home/HeroSection.tsx` (**buttons preserved verbatim**), new callback route.
* **Prerequisites:** Priority 1 (the provider decision).
* **Expected result:** the sign-in creates a real session; the buttons work; `?redirect=` accepts relative paths only.
* **Tests:** sign-in → session cookie → `/` loads the signed-in dashboard; `?redirect=https://evil.example` is refused.

### Priority 6 — CORS, CSP and security headers
* **Routes:** all (in `src/proxy.ts` and `next.config.ts`).
* **Files:** `src/proxy.ts`, `next.config.ts`, delete or replace `public/_headers`.
* **Prerequisites:** Priority 5 (the CORS policy depends on whether sessions use cookies).
* **Expected result:** no credentialed cross-origin access from `*.totalum-project.com`; a real CSP; `frame-ancestors` restricted to the app origin.
* **Tests:** preflight from a disallowed origin → no `Access-Control-Allow-Origin`; `curl -I /` shows the CSP.

### Priority 7 — Validation, upload/download limits, timeouts, rate limiting
* **Routes:** A-2, A-4, A-5, A-7 + `src/lib/project-slug.ts` adoption in the dashboard.
* **Files:** the four route files, `src/lib/vcaas-server.ts`, `src/app/page.tsx`.
* **Prerequisites:** Priorities 1-3.
* **Expected result:** every body read is bounded; every upstream fetch has a timeout; the client and the server agree on the project-name rules; a per-IP rate limit exists on the credit-spending paths.
* **Tests:** oversized body → 413; a hung upstream → the route answers within its timeout; a 3-character project name is refused **client-side** with the same message the server would give.

### Priority 8 — HTTP semantics, broken links, error states, tests
* **Routes:** `/[...slug]`, `/project/[projectId]`, `/api/vcaas/[...path]` (method allowlist), `not-found.tsx`.
* **Files:** `[...slug]/page.tsx`, `project/[projectId]/page.tsx`, `not-found.tsx`, `src/lib/project-slug.ts` (add the missing test file it already references).
* **Prerequisites:** all of the above.
* **Expected result:** unknown URLs return 404; a missing project returns 404; every route has a `loading`/error state; the slug validator has the test its own comments claim exists.
* **Tests:** `GET /definitely-not-a-route` → 404 (not 307); `GET /project/nope` → 404.

---

## 16. Safe test plan per phase

Every check below is read-only or local. **None requires a Totalum key, and none touches a real
project.**

| # | Check | Command / method | Pass criterion | Phase |
|---|---|---|---|---|
| T-01 | Route census unchanged | `find src/app -name 'page.tsx' -o -name 'route.ts'` | 7 pages / 8 handlers before and after | all |
| T-02 | Types | `npx tsc --noEmit` | exit 0 | all |
| T-03 | No tracked file drift | `git status --short`, `git diff --name-only` | only the intended file changed | all |
| T-04 | Unauthenticated API is refused | `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/vcaas/projects` | `401` (multi mode) | 1 |
| T-05 | Local mode still works | same request with `AUTH_MODE=local` | `200` + `{ok:true}` | 1 |
| T-06 | Cross-tenant isolation | request each project-scoped route with a foreign project id | `403` or `404` | 2 |
| T-07 | Env secrets gated | `curl …/api/vcaas/env/<project>?env=dev` | `401`/`403` without a session | 3 |
| T-08 | Over-size upload refused | `curl -F file=@big.bin …/api/vcaas/upload/<project>` | `413`, and the body is not buffered | 3 |
| T-09 | Source download bounded | request the source route with a large archive | `413` above the cap; no `arrayBuffer()` of the full body | 3 |
| T-10 | Preview is owner-only | request `/api/preview/<foreign-project>/` | `403`/`404` | 4 |
| T-11 | Generated code cannot reach the API | in the preview frame, `fetch("/api/vcaas/projects")` | blocked (separate origin) or refused | 4 |
| T-12 | Sign-in creates a session | complete the provider flow in a browser | a session cookie exists and `/` renders the signed-in dashboard | 5 |
| T-13 | Redirect validation | `GET /login?redirect=https://evil.example` | the browser does not leave the origin | 5 |
| T-14 | Buttons preserved | visual diff of `HeroSection.tsx` before/after | labels, order, placement and styling unchanged | 5 |
| T-15 | CORS tightened | preflight from `https://evil.totalum-project.com` | no `Access-Control-Allow-Origin` | 6 |
| T-16 | Headers present | `curl -I http://localhost:3000/` | CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors` restricted | 6 |
| T-17 | Body caps | POST a 20 MB body to the catch-all | `413` | 7 |
| T-18 | Upstream timeout | point `TOTALUM_API_URL` at a non-routable host in a local run | the route answers within its timeout, not indefinitely | 7 |
| T-19 | Name rules agree | try a 3-character name and a `-dev-` name | refused **client-side** with the server's message | 7 |
| T-20 | 404 semantics | `GET /definitely-not-a-route`; `GET /project/does-not-exist` | `404` in both cases | 8 |
| T-21 | Slug unit test | add `src/lib/__tests__/project-slug.test.ts` (the file `project-slug.ts:20` already promises) and run it | passes | 8 |

**Explicitly excluded from all testing:** publishing, restoring a version, pulling from GitHub,
deleting a project, running the AI agent, and any request to a production Totalum endpoint. These
spend credits or mutate real projects and are outside the scope of this audit.

---

## 17. Operator and vendor confirmation questions

These cannot be answered from the repository and change the severity or shape of the remediation.

1. **Deployment model.** Is this instance public on the internet, or private/local only? P0-01
   changes from "documented and acceptable" to "blocking" depending on the answer.
2. **Key model.** Is there one operator key shared by all users (as the code assumes), or is a
   per-user key expected? `src/lib/vcaas.ts:244-248` asserts the latter; the code implements the
   former.
3. **Single-user mode.** Should local/private single-operator use be preserved as an explicit
   `AUTH_MODE=local` switch, or should the app require auth unconditionally?
4. **Platform terms.** Does the Totalum licence permit white-label resale of this UI, and does it
   constrain the "no auth" posture? (`AGENTS.md` flags this as operator/legal territory.)
5. **`*.totalum-project.com` in CORS.** Does any Mavly flow genuinely need cross-origin access from
   that wildcard domain? If not, `src/proxy.ts:17` should be removed.
6. **Preview origin.** Is a dedicated preview origin acceptable (it is the containment the copied
   code itself recommends), or must the preview stay same-origin?
7. **Deployment target.** Vercel, Docker, or something else? The upload and body-size findings
   (R-09) depend on the platform's request-body limit.
8. **Totalum API contract.** What is the real minimum project-name length and the reserved-name
   list? The repo asserts 4 and `-dev-` (`src/lib/project-slug.ts:9, 26, 30`); the dashboard
   implements 3 and nothing (`src/app/page.tsx:333-334, 354`).
9. **`totalum-platform` provenance.** Which of the copied files are still maintained upstream, so
   that a fix there is not lost on the next re-copy? (Rule 1 in `AGENTS.md`.)
10. **Legal pages.** The Terms and Privacy pages describe accounts, authentication and data export
    (`terms/page.tsx:60-63`, `privacy/page.tsx:46-51, 67-71`) that this build does not implement.
    Should they be rewritten to match the product, or is the product meant to gain those features?

---

## Appendix A — Files read in full during this audit

```
src/app/[...slug]/page.tsx                                   src/app/api/config/route.ts
src/app/api/preview/[projectId]/[[...path]]/route.ts          src/app/api/vcaas/[...path]/route.ts
src/app/api/vcaas/_shared.ts                                 src/app/api/vcaas/env/[projectId]/route.ts
src/app/api/vcaas/git-diff/route.ts                           src/app/api/vcaas/source-code/[projectId]/route.ts
src/app/api/vcaas/upload/[projectId]/route.ts                 src/app/api/visual-edit/[projectId]/apply/route.ts
src/app/error.tsx  src/app/global-error.tsx  src/app/layout.tsx  src/app/not-found.tsx
src/app/home/page.tsx  src/app/login/page.tsx  src/app/page.tsx
src/app/project/[projectId]/page.tsx
src/proxy.ts
src/lib/vcaas-server.ts  src/lib/vcaas.ts (partial)  src/lib/project-slug.ts (partial)
src/lib/visual-edit-agent.ts (partial)  src/lib/safe-url.ts (partial)
src/components/home/HeroSection.tsx (partial)
next.config.ts  tsconfig.json  package.json  vercel.json  public/_headers  .env.example
```

## Appendix B — Verification statement

* `npx tsc --noEmit` → exit 0.
* `git status --short` → `?? AUDIT.md`, `?? ROUTE_AUDIT.md` only.
* `git diff --name-only` → empty. `git diff --cached --name-only` → empty.
* **No tracked file in this repository was modified by this audit.** The only new files are
  `AUDIT.md` (the earlier audit) and this document.
* No dependency was installed, upgraded or removed; no configuration was changed; no route
  handler was edited; no deployment, publish, restore, pull or delete was performed; no request
  was made to any Totalum endpoint or any other production service; no secret value was read,
  printed or recorded — only environment-variable **names** and their presence.
