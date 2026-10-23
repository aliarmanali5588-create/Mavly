# Mavly — Repository Audit, Security Posture & Path to Mavly-Controlled Infrastructure

> **HISTORICAL DOCUMENT — NOT CURRENT INSTRUCTIONS.** This audit describes an earlier
> architecture in which Mavly called the hosted Totalum VCaaS API. That integration has
> since been removed and the backend is intentionally disconnected. Do not follow the
> upstream setup, API or deployment guidance below. For the current state, read
> `MAVLY_CLEAN_BASELINE.md`.

**Audit date:** 2026-10-21 · **Commit:** `cdd6c01` (branch `main`, clean tree) · **Method:** static read of all 234 tracked files + `tsc --noEmit` + `npm audit`
**Scope:** no code, config, dependency or infrastructure change was made. No Totalum API call was made against real projects.

> **Note on section numbering.** The brief's 19 sections and its A–H conclusion were reconstructed from the audit request because the original prompt text was not recoverable from the repository or the session. Section titles below are the audit's own canonical titles; the A–H conclusion answers the same eight questions the brief asked for.

> **Route map since this audit.** This document describes the app as it was at the audited
> commit. The route map has since changed twice: `/` is now the public marketing page, the
> builder lives at `/dashboard` (it was `/home`, whose old address answers a 308 redirect),
> and `/login` runs a real Supabase OAuth flow. The findings below are about the code as
> audited and are not a description of the current routes.

---

## 1. Executive summary

Mavly is **a thin, well-crafted UI over Totalum's hosted VCaaS API**. The repository contains a complete, polished builder UI — prompt-to-app, live preview, visual editor, code editor, database explorer, deploy, domains, GitHub, logs, versions, analytics, cron, mobile builds, payments — and almost none of the machinery those features run on.

Measured on the actual tree:

| Asset | Reality |
|---|---|
| Totalum endpoints called | **~110 distinct upstream paths** across 15 client namespaces |
| Lines of Mavly-authored platform logic | **~6,600 LOC** (visual-edit engine only) |
| Auth SDK / session code | **0** — `/login` is a 700 ms toast (`src/app/login/page.tsx:26-31`) |
| Authentication enforcement points | **0** — `resolveVcaasContext()` always returns `ok: true` (`_shared.ts:48-50`) |
| Tenant isolation | **0** — `enforceProjectScope()` always returns `null` (`_shared.ts:57-62`) |
| `npm audit` | **10 vulnerabilities (1 critical, 8 high, 1 low)** — AGENTS.md requires zero |
| Typecheck | **clean** (`npx tsc --noEmit` → exit 0) |
| Test suite | **none** — and `src/lib/__tests__/project-slug.test.ts` referenced at `project-slug.ts:20` **does not exist** |

The critical conclusion: **the product is deployable and safe today only because it is private.** The moment it is reachable on a public URL, every anonymous visitor gets read/write access to every project the operator's single Totalum key owns, plus the operator's credit balance.

Three things must be true before this can be called "Mavly" rather than "a Totalum console": real authentication, real per-user tenancy, and truthful legal pages. All three are days-to-weeks of work, and the repository was deliberately built to make them possible — `AGENTS.md` names the exact hooks (`src/app/api/vcaas/_shared.ts` and `src/proxy.ts`) and `README.md:149-158` warns about it in bold.

---

## 2. Scope, method and evidence base

**What was inspected:** every tracked file (234), including all 8 route handlers, 14 client namespaces, the `src/lib/visual-edit*` subsystem (6 files / 6,642 LOC), both legal pages, both marketing pages, the i18n dictionary, and all configuration.

**Commands run (read-only):** `npx tsc --noEmit` (exit 0), `npm audit --json` (10 vulns), `git ls-files`, `rg` searches. No build, no install, no API call, no migration.

**Evidence classification used throughout:**

| Tag | Meaning |
|---|---|
| **CONFIRMED** | Demonstrated by reading the code path; reproducible from the cited lines |
| **RISK** | Depends on deployment, configuration, or an upstream behaviour that was not exercised |
| **VERIFIED FACT** | A factual statement about the repo (counts, versions, contents) |
| **RECOMMENDATION** | Engineering judgement, not a defect |
| **UNVERIFIED** | Requires external confirmation (Totalum's hosted terms, upstream platform licence, third-party asset provenance) |

**Not inspected:** the Totalum backend itself (not in this repo), the `totalum-platform` source this repo was copied from (not published here), and Totalum's contractual terms.

---

## 3. Repository inventory and architecture map

```
browser ── vcaasApi (src/lib/vcaas.ts, 1,171 LOC, 15 namespaces)
   │  same-origin fetch → /api/vcaas/*
   ▼
src/app/api/vcaas/[...path]/route.ts  ── adds `api-key` header ── src/lib/vcaas-server.ts
   │                                                                        │
   │  + 7 dedicated routes: env · source-code · upload · git-diff ·
   │    preview/* · visual-edit/*/apply · config
   ▼
https://builder-api.totalum.app/api/v1/vcaas   (TOTALUM_API_URL overrides the host)
```

**Route inventory (`src/app/api/`):**

| Route | Purpose | Auth | Notes |
|---|---|---|---|
| `vcaas/[...path]/route.ts` | Catch-all proxy, GET/POST/PUT/DELETE/PATCH | none | `resolveVcaasUrl` confines paths to `/api/v1/vcaas/` |
| `vcaas/env/[projectId]/route.ts` | Project `.env` as `text/plain` | none | **Plaintext secrets, unauthenticated** |
| `vcaas/source-code/[projectId]/route.ts` | Source ZIP as binary stream | none | Unbounded in-memory buffer, no timeout |
| `vcaas/upload/[projectId]/route.ts` | Multipart passthrough | none | No request-body size cap |
| `vcaas/git-diff/route.ts` | Fetches a signed diff URL | none | Allowlist + SSRF guard + 10 MiB cap |
| `preview/[projectId]/[[...path]]/route.ts` | Same-origin proxy of the sandbox | no-op scope guard | Injects the visual-editor agent |
| `visual-edit/[projectId]/apply/route.ts` | Applies visual edits to source | no-op scope guard | **Writes files and rebuilds** |
| `config/route.ts` | `{ configured: boolean }` | n/a | Leaks only whether a key exists |

**Pages:** `/` dashboard · `/home` marketing · `/login` simulated OAuth · `/project/[projectId]` workspace · `/terms` `/privacy` legal · `src/app/[...slug]/page.tsx` catch-all that redirects every unknown path to `/`.

---

## 4. Runtime and framework stack

| Layer | Version | Notes |
|---|---|---|
| Next.js | `^16.2.10` (`devDependencies`) | **Misfiled** — see SEC-09 |
| React | `^19.2.7` | |
| TypeScript | `5.8.3` | `strict: false` — see SEC-10 |
| Tailwind | `^4.1.1` | via `@tailwindcss/postcss` |
| Node | ≥20 | `next dev -p 3000 -H 0.0.0.0` |
| Output | `standalone` unless `VERCEL=1` | `next.config.ts:9` |

**Configuration surface:** `next.config.ts` (image `remotePatterns` = `placeholders.io`, `ik.imagekit.io`; `allowedDevOrigins: ["*"]`; global `no-store` cache headers), `vercel.json`, `public/_headers`.

---

## 5. Dependency inventory and supply-chain posture

**Runtime dependencies (37):** Radix UI (16), `lucide-react`, `sonner`, `cmdk`, `next-themes`, `cva`, `clsx`, `tailwind-merge`, `@monaco-editor/react`, `react-hook-form`, `react-day-picker`, `fflate`, `postcss`.

**Dev dependencies (10):** `next`, `eslint`, `eslint-config-next`, `typescript`, `ts-node`, Tailwind/PostCSS toolchain, `@types/*`.

**Confirmed absent:** `better-auth`, `stripe`, `bcrypt`, `jsonwebtoken`, `date-fns`, `recharts`, the AI SDK, `@supabase/supabase-js`, `@supabase/ssr`, NextAuth/Auth.js, Clerk, Firebase, Lucia, Passport, `ioredis`, `pg`, `prisma`, `drizzle-orm`.

**Interpretation (VERIFIED FACT):** the app is not a *thin* client by accident — it ships no database driver, no auth library, no payment SDK and no AI SDK, because the Totalum API absorbs all four. GitHub, Figma, Stripe (for generated apps), domain purchase, mobile store upload and MCP hosting are all reached through Totalum endpoints, not through vendor SDKs. There is exactly **one** external integration point: the Totalum API.

**`npm audit` — 10 vulnerabilities (CONFIRMED, conflicts with AGENTS.md "keep npm audit at zero"):**

| Package | Sev | Advisory | Reachable? |
|---|---|---|---|
| `next` | **critical** | RCE in `next/og` `ImageResponse`; cache poisoning; dev MCP info disclosure; **SSRF in image optimization** | `next/og` is **not imported** anywhere (grep: 0 hits) → the RCE is not reachable today; **image optimization is live** (`next.config.ts:11-20`) → the SSRF path is reachable |
| `next` | critical | draft-mode/`use cache` content leak, ISR poisoning | Cache headers are `no-store` app-wide (`next.config.ts:29-40`), reducing impact |
| `sharp` | high | `CVE-2026-96889` librsvg (transitive via `next`'s image optimizer) | Reachable through `/ _next/image` for the two allowlisted hosts |
| `source-map-js` | high | event-loop DoS | Build-time only |
| `dompurify` | low | `IN_PLACE` detached-subtree XSS | Override `^3.4.15` present (`package.json:66-68`) but the advisory still reports — the resolved version does not clear it |
| `eslint-config-next` + `fast-glob`/`micromatch`/`braces`/`brace-expansion` | high | DoS via nested patterns | Dev-time only; "fix" offered is a semver-major **downgrade** to `14.2.35` |

**Takeaway:** the critical `next` advisory is mostly not exploitable here, but the image-optimization SSRF is, and the repo's own documented policy is already violated.

---

## 6. Environment variables and secrets handling

| Variable | Read where | Notes |
|---|---|---|
| `TOTALUM_VCAAS_API_KEY` | `vcaas-server.ts:93` | The only credential. Server-only. |
| `VCAAS_API_KEY` | `vcaas-server.ts:93` | **Undocumented legacy fallback** — not in `.env.example`, not in README |
| `TOTALUM_API_URL` | `vcaas-server.ts:20` | Origin only; `/api/v1/vcaas` is appended |
| `NEXT_PUBLIC_APP_URL` | `proxy.ts:5`, `next.config.ts` | Used for the production CORS allowlist |
| `NODE_ENV`, `VERCEL`, `PORT` | `proxy.ts:4`, `next.config.ts:9`, `package.json:10` | Platform vars |
| `TESTING_MODE` | **only** `package.json:10` | Dead flag — no code reads it. Not a bypass. |

**Secrets handling — correct.** The key is read only in `src/lib/vcaas-server.ts` (never a `NEXT_PUBLIC_*` var), the browser talks only to same-origin `/api/vcaas/*`, and `resolveVcaasUrl()` (`vcaas-server.ts:54-72`) re-resolves the final URL and refuses anything that leaves `/api/v1/vcaas/` — including `%2e`/`%2f`/`%5c` in the path. That is a well-designed defence against the account-key path-traversal class, and it is the strongest security control in the repository.

**But:** the key's *authority* is unbounded. The key authorises the whole VCaaS account; the app's only protection is the path prefix. `README.md:254` states credits belong to the operator — and `InsufficientCreditsModal` links to the operator's own billing page, which `AGENTS.md` explicitly flags to remove before selling.

---

## 7. Authentication and session model — current state

**CONFIRMED: there is no authentication. The login page is a simulation.**

| Element | Evidence |
|---|---|
| Google button | `login/page.tsx:109-138` → `handleOAuthLogin("google")` |
| GitHub button | `login/page.tsx:141-159` → `handleOAuthLogin("github")` |
| The "sign-in" | `login/page.tsx:26-31` — `setTimeout(700)` → `toast.success` → `router.push(redirectTarget)` |
| Auto-trigger | `login/page.tsx:34-38` — `?provider=google|github` fires the same fake flow on load |
| OAuth callback route | **does not exist** |
| Session / cookie / JWT | **does not exist** |
| Logout | **does not exist** |
| Auth SDK | **not installed** (see §5) |

The two buttons are **presentation-only**. No token is issued, nothing is stored, and every page and API route is reachable without them. The homepage (`src/components/home/HeroSection.tsx`) links to `/login?provider=google` / `?provider=github`, so the entire user journey — click "Continue with Google" → "Signed in with Google. Welcome to Mavly!" → dashboard — completes without a single authenticated request.

**Why this matters beyond the obvious:** the operator's browser holds a session at `builder-api.totalum.app` and the *Mavly* app holds the key. The UI gives every visitor the operator's identity.

---

## 8. Authorization, tenancy and project ownership

**CONFIRMED: tenancy is structurally absent, and the repository is candid about it.**

`src/app/api/vcaas/_shared.ts` is the designated seam. In this repo it is two honest no-ops:

```ts
export async function resolveVcaasContext(): Promise<VcaasAuthResult> {
    return { ok: true, ctx: {}, team: {} };          // _shared.ts:48-50
}
export function enforceProjectScope(_team, _method, _path): NextResponse | null {
    return null;                                      // _shared.ts:57-62
}
```

The file's own comment (lines 18-21) says: *"IF YOU EVER PUT REAL USERS BEHIND THIS APP, THIS IS THE FILE THAT MUST STOP BEING A NO-OP … every user reaches every project the key owns."*

**The gap is wider than the README suggests.** `AGENTS.md` ("Boilerplate mode", step 5) says only `/api/preview/*` and `/api/visual-edit/*` call the guards, and that `[...path]`, `upload`, `source-code` and `git-diff` do not. Verified:

| Handler | Calls the guard? | Consequence |
|---|---|---|
| `vcaas/[...path]/route.ts` | **No** | Every upstream VCaaS method reachable anonymously |
| `vcaas/env/[projectId]/route.ts` | **No** | Plaintext secrets anonymously |
| `vcaas/source-code/[projectId]/route.ts` | **No** | Full source archives anonymously |
| `vcaas/upload/[projectId]/route.ts` | **No** | Write into any project anonymously |
| `vcaas/git-diff/route.ts` | **No** | Fetch diffs anonymously |
| `preview/[projectId]/...` | Yes — but a no-op | |
| `visual-edit/[projectId]/apply` | Yes (`route.ts:229,248`) — but a no-op | Any visitor can rewrite any project's source |

There is also **no project-existence scoping of any kind**: `GET /api/vcaas/projects` returns every project the key owns, and the dashboard renders them all. `README.md:76` advertises "Multi-tenant" and the comparison table (line 346) claims "Multi-tenant out of the box ✅". That claim is only true if the operator provisions one Totalum project per customer *and* filters the list — which the app does not do.

---

## 9. API surface inventory — the Totalum dependency

Extracted from `src/lib/vcaas.ts` (client catalog) and `src/lib/vcaas-server.ts` (server). **~110 distinct upstream paths**, all under `/api/v1/vcaas`.

### 9.1 Namespace map

| Namespace | Upstream surface | Mutation | Cost |
|---|---|---|---|
| `projects` | list/get/create/launch/delete/rename/export/import/duplicate/state/pause/resume/credit-limits | yes | create + launch billable |
| `agent` | start/stop/status/progress/clear-context/system-prompt/full-conversation/server start-or-restart/mcp-servers(+verify) | yes | **billable** |
| `deployments` | deploy/status | yes | **billable** |
| `files` | tree/content (GET+PUT)/upload | yes | **PUT billable (1 credit)** |
| `rebuild` | rebuild + rebuild/status | yes | billable |
| `github` | connect/status/env/pull/pull-status | yes | billable |
| `figma` | validate (account) / connect / status (project) | yes | |
| `secrets` | list/create/update/delete | yes | |
| `domain` | project domain GET/PUT/DELETE | yes | |
| `versions` | list / diff / recover | yes | recover billable |
| `projectGroups` | CRUD | yes | |
| `logs` | backend dev/prod logs | no | free |
| `webhooks` | account + project webhooks, rotate-secret | yes | |
| `v2` | database (schema/rows/sql/ask/backups/restore/time-travel/undo/bookmarks/migrate-provider), analytics, usage, credit-limits, cron-jobs(+run/executions), api-keys(+rotate), mobile (builds/stores/signing/settings/store-uploads), payments (mode/status/onboarding-link), limits, preview/rotate-url, runaway/release, version-diff | yes | **billable** |

### 9.2 Full path appendix

<details>
<summary>Every upstream path the app can reach (verbatim from <code>src/lib/vcaas.ts</code>)</summary>

```
/projects                                  /projects/launch
/projects/{id}                             /projects/credit-limits/at-limit
/projects/{id}/agent/start                 /projects/{id}/agent/stop
/projects/{id}/agent/status                /projects/{id}/agent/progress
/projects/{id}/agent/clear-context         /projects/{id}/agent/system-prompt
/projects/{id}/agent/full-conversation     /projects/{id}/agent/server/start-or-restart
/projects/{id}/agent/mcp-servers           /projects/{id}/agent/mcp-servers/{id}
/projects/{id}/agent/mcp-servers/verify    /projects/{id}/deployments/deploy
/projects/{id}/deployments/status          /projects/{id}/files/tree
/projects/{id}/files/content               /projects/{id}/files/upload
/projects/{id}/rebuild                     /projects/{id}/rebuild/status
/projects/{id}/secrets                     /projects/{id}/secrets/{id}
/projects/{id}/versions                    /projects/{id}/versions/{id}/recover
/projects/{id}/version-diff                /projects/{id}/github/connect
/projects/{id}/github/status               /projects/{id}/github/env
/projects/{id}/github/pull                 /projects/{id}/github/pull-status
/projects/{id}/figma/connect               /projects/{id}/figma/status
/projects/{id}/domain                      /projects/{id}/export
/projects/{id}/import                      /projects/{id}/state
/projects/{id}/pause                       /projects/{id}/resume
/projects/{id}/limits                      /projects/{id}/usage
/projects/{id}/credit-limits              /projects/{id}/webhook
/projects/{id}/webhook/rotate-secret       /projects/{id}/backend/dev/logs
/projects/{id}/backend/prod/logs           /projects/{id}/analytics/site
/projects/{id}/database/schema             /projects/{id}/database/rows
/projects/{id}/database/sql                /projects/{id}/database/ask
/projects/{id}/database/backups            /projects/{id}/database/backups/{id}
/projects/{id}/database/backups/{id}/download
/projects/{id}/database/backups/{id}/restore
/projects/{id}/database/restore            /projects/{id}/database/time-travel/restore
/projects/{id}/database/undo-run           /projects/{id}/database/bookmarks
/projects/{id}/database/migrate-provider   /projects/{id}/database/usage
/projects/{id}/cron-jobs                   /projects/{id}/cron-jobs/{id}
/projects/{id}/cron-jobs/{id}/run          /projects/{id}/cron-jobs/{id}/executions
/projects/{id}/api-keys                    /projects/{id}/api-keys/{id}
/projects/{id}/api-keys/{id}/rotate        /projects/{id}/mobile/builds
/projects/{id}/mobile/builds/{id}/cancel   /projects/{id}/mobile/builds/{id}/download
/projects/{id}/mobile/builds/{id}/log      /projects/{id}/mobile/builds/{id}/store-upload
/projects/{id}/mobile/settings             /projects/{id}/mobile/signing/{ios|codemagic}
/projects/{id}/mobile/stores               /projects/{id}/mobile/store-uploads
/projects/{id}/payments/mode               /projects/{id}/payments/status
/projects/{id}/payments/onboarding-link    /projects/{id}/preview/rotate-url
/projects/{id}/runaway/release
/domains                                    /domains/search
/domains/purchase                           /domains/contacts
/domains/contacts/{id}/resend-verification
/domains/{id}                              /domains/{id}/attach
/domains/{id}/detach                       /domains/{id}/dns/records
/domains/{id}/dns/records/{id}             /domains/{id}/export
/domains/{id}/export/cancel                /domains/{id}/forwarding
/domains/{id}/renew
/project-groups                             /project-groups/{id}
/figma/validate                             /webhooks
/webhooks/{id}                             /usage
/credit-costs?engine={v2|legacy}           /git-diff?url=
/source-code/{id}?intent=                  /upload/{id}
```

</details>

### 9.3 The single hardest dependency

`PUT /projects/{id}/files/content` **does not store what you send it.** The Totalum backend mounts a global `sanitizeMiddleware` that runs `sanitize-html` over every string in every request body, so React source posted to it is parsed as HTML and stripped: `className` is removed, `<script>` is deleted whole. This is documented at length in `visual-edit/[projectId]/apply/route.ts:72-108` and 527-580, where the app works around it by base64-encoding writes (`fileWriteBody`, line 102) and by running a **fidelity canary** before any real write (`probeWriteFidelity`, line 123).

**Consequences for a Mavly-owned platform:** any write path that sends source as UTF-8 text is corrupted upstream. The base64 door must be replicated, and the canary (`bytesWritten` comparison) must be replicated. This is a concrete, documented, non-obvious requirement that is easy to lose in a migration.

---

## 10. Internal server routes — detailed findings

### 10.1 `vcaas/[...path]/route.ts` — the catch-all

Good: forwards method/path/query/body verbatim; normalises the upstream `{errors,data}` envelope into `{ok,error,code,upstreamCode}`; forwards `401/403` as `INVALID_API_KEY` with an actionable message (lines 72-86); maps a `VcaasPathError` to a plain 400 with no hint of what the key could reach (lines 111-116); logs the real cause instead of swallowing it (line 123).

Bad: **no authentication, no rate limit, no per-route allowlist.** Anything under `/api/v1/vcaas/` is reachable, including the account-wide surfaces the key can reach inside that prefix.

### 10.2 `vcaas/env/[projectId]/route.ts` — plaintext secrets

`GET /api/vcaas/env/{projectId}?env=dev|live` returns the project's `.env` **as `text/plain`** (lines 20-25). It validates the slug and the env name (line 15) — the only route that does — but authenticates nobody. Combined with SEC-01 this is **mass secret disclosure**: one anonymous request per project returns every API key, DB URL and webhook secret belonging to every app on the account.

### 10.3 `vcaas/source-code/[projectId]/route.ts` — unbounded archive fetch

- `projectId` is interpolated **without `encodeURIComponent` and without `isRoutableProjectSlug`** (line 16) — inconsistent with every sibling route. Traversal is still blocked downstream by `resolveVcaasUrl`, so this is hardening, not an exploit.
- `fetch(downloadUrl)` has **no timeout, no `redirect` policy and no size cap** (line 44), and the whole archive is buffered into memory via `arrayBuffer()` (line 52). A large project is a memory spike on a public route.
- `downloadUrl` is minted upstream, so it is not client-controlled → not an SSRF hole today, but the route fetches an external URL without the `publicUrlRejectionReason` discipline used elsewhere.

### 10.4 `vcaas/upload/[projectId]/route.ts` — no body cap

`await req.formData()` (line 48) buffers the **entire** request body in the Node process before anything is checked. `next.config.ts` sets no `bodySizeLimit`, and App Router route handlers have no default request-body limit. The client-side caps (`MAX_UPLOAD_BYTES = 8 MB` in `lib/upload.ts:34`, `MAX_ATTACHMENT_BYTES = 12 MB` in `lib/attachments.ts:44`) are irrelevant to an anonymous caller. Upstream enforces 12 MB, but the memory is already spent.

### 10.5 `vcaas/git-diff/route.ts` — the best route in the repo

Allowlist of four Totalum hosts + the configured API origin (lines 20-35), `publicUrlRejectionReason` DNS resolution (line 80), `redirect: "error"` (line 88), 20 s timeout, and a 10 MiB cap enforced on both `content-length` and the decoded body (lines 99-106). The comment at lines 72-79 documents exactly why the allowlist alone was insufficient — a customer app on `*.totalum-project.com` can redirect the server to a metadata endpoint. **This is the pattern the other two fetching routes should copy.**

### 10.6 `preview/[projectId]/[[...path]]/route.ts` — same-origin sandbox proxy

Proxies the project's dev server through the app's origin (required by the visual editor) and injects the visual-editor agent script. It calls `resolveVcaasContext()` + `enforceProjectScope()` — both no-ops. It is the origin the iframe loads, which is why the app can manipulate the preview DOM.

### 10.7 `visual-edit/[projectId]/apply/route.ts` — the write path

The most consequential route in the repo, and the best engineered:

| Control | Evidence | Verdict |
|---|---|---|
| Identity + scope | `route.ts:229,248` — **both no-ops** | **BROKEN (SEC-01/AUTH-01)** |
| Batch limit | 100 changes (line 258) | good |
| File cap | 200 source files, ranked (lines 280-308) | good |
| SSRF on asset copy | `publicUrlRejectionReason` + `redirect:"error"` + media content-type check + 12 MB cap (lines 369-390) | good |
| Non-destructive failure | asset copy failure keeps the original URL (lines 414-422) | good |
| Resolve-before-write | `resolveChangesDeep` then `applyEdits` (line 432) | good |
| Write verification | `verifyEdits` drops any file that does not verify (lines 498-512) | good |
| Upstream fidelity canary | `probeWriteFidelity` (line 123) | good, **but** see SEC-12 |
| Credit metering | `charged: false, reason: "not-metered-in-this-app"` (lines 746-750) | **no per-user metering** |
| Rebuild | `POST /rebuild` (line 713) | fine |

---

## 11. Database, storage and data flows

**CONFIRMED: Mavly owns no database.** No `pg`, `prisma`, `drizzle`, `mysql` or `sqlite` driver is installed; no migrations exist; `supabase/.temp` contains **CLI linkage metadata only** (project `Mavly`, ref `cazmezhpanwdjgsqugzr`) with no schema, no migrations and no `@supabase/supabase-js` dependency.

The database surface the UI exposes is entirely Totalum's, and it is the widest one:

| Capability | Endpoint | Notes |
|---|---|---|
| Schema | `database/schema?env=dev\|live` | dev/live split |
| Rows | `database/rows` | paged, searchable, sortable |
| Raw SQL | `database/sql` | **write-capable; the highest-blast-radius surface in the app** |
| Natural-language query | `database/ask` | |
| Backups | `database/backups` (+download/restore) | |
| Time travel | `database/time-travel/restore` | |
| Undo | `database/undo-run` | |
| Migration | `database/migrate-provider` | |
| Usage | `database/usage` | |

The raw-SQL surface is the one to reason about carefully in a public deployment: a single anonymous `POST /api/vcaas/projects/{id}/database/sql` can drop tables in any project on the account. The UI applies its own confirmations (`confirmDestructive`, `src/components/workspace/v2/`), but confirmations live in the client and the client is not the trust boundary.

**Storage:** Totalum owns project file storage, the signed ZIP source archive (`storage.googleapis.com`), uploaded images, and the database. Mavly owns nothing but its own `public/` assets and the browser's in-memory attachment state.

---

## 12. Billing, credits and payments

| Layer | Owner | Evidence |
|---|---|---|
| AI credits | **Totalum account** | `GET /credit-costs?engine=` (`vcaas.ts:1103`), `projects/credit-limits/at-limit` |
| Spend meter | **None in this app** | `vcaas.ts:183-188` raises a DOM event on `INSUFFICIENT_CREDITS`; `visual-edit` route reports `charged:false` |
| Buy-credits UI | Links to the **operator's** billing page | `InsufficientCreditsModal.tsx` — `AGENTS.md` flags this for removal before selling |
| Plan capability counters | **Stubbed out** | `components/plan/CapabilityProvider.tsx:10-12` → `refresh: async () => {}` |
| Stripe | **Not installed** | Generated apps' Stripe is provisioned by Totalum (`payments/mode`, `payments/onboarding-link`) |
| User billing for Mavly itself | **None** | No checkout, no webhook, no balance table |

**Conclusion:** today the product has a single billable identity — the operator. There is no mechanism to bill, meter, or ration an individual user's usage. `AGENTS.md` "Boilerplate mode" specifies the shape (402 on spend-shaped paths, `profiles.credits`, Stripe webhook), and the UI already listens for `INSUFFICIENT_CREDITS` and opens a modal — so the seam exists.

---

## 13. External integrations and outbound network calls

**Complete list of network destinations (VERIFIED FACT, from code + config):**

| Destination | Direction | Purpose |
|---|---|---|
| `builder-api.totalum.app/api/v1/vcaas` | server → external | **The product.** Every feature |
| `storage.googleapis.com` | server → external | Signed source ZIP + diffs |
| `*.totalum-project.com` | browser + server | Published customer apps, preview hosts |
| `webapp-project.com` | browser | Legacy published hosts |
| `placeholders.io`, `ik.imagekit.io` | browser (Next image optimizer) | Placeholder + hosted images |
| `api.totalum.app` / `totalum.app` | browser | Docs, marketing links |
| `api-accounts.totalum.app` | server | Legacy alias of the API host (`vcaas-server.ts:16-18`) |

**No direct integration exists with:** GitHub, Figma, Stripe, Google, Supabase, ImageKit's API (only its CDN), or any AI provider. All of them are Totalum sub-surfaces. Google and GitHub appear only as OAuth-looking buttons that call nothing.

**Outbound-request discipline (a genuine strength):** every route that fetches a client-supplied URL calls `publicUrlRejectionReason` from `src/lib/safe-url.ts` (async DNS resolution; covers IPv4-mapped IPv6 and every private range) and uses `redirect: "error"` with a timeout — `git-diff/route.ts:80-90`, `visual-edit/.../apply/route.ts:369-377`. The sync `urlRejectionReason` is reserved for IP literals. `AGENTS.md` rule 8 documents this and it is correctly implemented.

---

## 14. Security findings (severity-ranked)

| ID | Finding | Severity | Classification | Evidence |
|---|---|---|---|---|
| **SEC-01** | **No authentication on any route.** `/api/vcaas/*` is an anonymous, unrate-limited proxy to an account-wide privileged key. Anonymous → list projects, read source, read `.env`, spawn agents, deploy, spend credits. | **Critical** | CONFIRMED | `_shared.ts:48-62`; `[...path]/route.ts:52`; `proxy.ts:49-65`; `README.md:149-158` |
| **AUTH-01** | **No tenant isolation.** `enforceProjectScope()` returns `null`; the catch-all does not call it at all. Any visitor reaches every project on the account. | **Critical** | CONFIRMED | `_shared.ts:57-62`; `visual-edit/.../apply/route.ts:248` |
| **SEC-02** | **Plaintext `.env` disclosure.** `GET /api/vcaas/env/{id}?env=dev\|live` returns secrets as `text/plain` with no auth. | **Critical** | CONFIRMED | `env/[projectId]/route.ts:19-25` |
| **SEC-03** | **Credentialed CORS over a wide origin set.** Production allows `*.totalum-project.com` (any customer app — attacker-controllable) with `Access-Control-Allow-Credentials: true`. **In development every origin is allowed.** | **High** | CONFIRMED (impact RISK until sessions exist) | `proxy.ts:14-24, 31-35` |
| **SEC-04** | **`frame-ancestors *` and `X-Frame-Options` deleted** → the entire builder is frameable by any site. Combined with SEC-01/SEC-03 this is a working clickjacking target against an operator whose browser holds the Totalum session. | **High** | CONFIRMED | `proxy.ts:42-47` |
| **SEC-05** | **Visual-edit writes any project's source with no auth.** `POST /api/visual-edit/{id}/apply` → `files/content` PUT + `rebuild`. | **High** | CONFIRMED | `visual-edit/.../apply/route.ts:229-249, 586-633, 713` |
| **SEC-06** | **Critical `next` advisories** (RCE in `next/og`, image-optimizer SSRF, cache poisoning). `next/og` unused → RCE not reachable; the image-optimizer SSRF **is** reachable. | **High** | CONFIRMED (reachability RISK) | `npm audit`; `next.config.ts:11-20`; grep: 0 imports of `next/og` |
| **SEC-07** | **`npm audit` is not zero** (1 critical, 8 high, 1 low), directly violating the repo's own rule. `sharp` (librsvg CVE) is reachable via the image optimizer; `dompurify` override does not clear its advisory. | **High** | CONFIRMED | `npm audit --json`; `package.json:66-68` |
| **SEC-08** | **Dev server is internet-reachable.** `dev` binds `0.0.0.0`; `allowedDevOrigins: ["*"]`; CORS allows every origin. Any website a developer visits can drive the local Totalum key. | **High** | CONFIRMED (dev-only) | `package.json:5`; `next.config.ts:25`; `proxy.ts:15` |
| **SEC-09** | **`next` is in `devDependencies`.** `npm ci --omit=dev` produces an image without `next` — `npm start` fails. `postcss` is misfiled in the other direction. | **Medium** | CONFIRMED | `package.json:12-64` |
| **SEC-10** | **`strict: false`** in tsconfig (plus `noImplicitAny:false`, `noUncheckedIndexedAccess:false`) → the code carries manual narrowing workarounds (e.g. `isUnsafe`, `bridgeFailed`). | **Medium** | CONFIRMED | `tsconfig.json:11,33-43`; `visual-edit/.../apply/route.ts:504-506` |
| **SEC-11** | **No rate limiting or quota anywhere.** `agent/start`, `deployments/deploy`, `files/content` PUT and `rebuild` are billable and unauthenticated. | **Medium** | CONFIRMED | `[...path]/route.ts`; no limiter in `proxy.ts` |
| **SEC-12** | **The visual-edit canary pollutes user projects.** `probeWriteFidelity` writes `.totalum/visual-edit-write-check.txt` into the project and never deletes it; it costs 1 credit on the first apply per process. | **Medium** | CONFIRMED | `visual-edit/.../apply/route.ts:123-147, 562-564` |
| **SEC-13** | **No request-body size limit on upload.** `req.formData()` buffers the whole body before any check; App Router has no default cap and `next.config.ts` sets none. | **Medium** | CONFIRMED | `upload/[projectId]/route.ts:48`; `next.config.ts` |
| **SEC-14** | **Unbounded source-archive fetch.** `fetch(downloadUrl)` with no timeout/redirect policy/size cap, then `arrayBuffer()` — a memory spike on an unauthenticated route. | **Medium** | CONFIRMED | `source-code/[projectId]/route.ts:44, 52` |
| **SEC-15** | **Open redirect on the login page.** `redirectTarget = searchParams.get("redirect")` flows into `router.push()` unchecked. | **Medium** | CONFIRMED (impact RISK) | `login/page.tsx:13, 30` |
| **SEC-16** | **Inconsistent client upload limits**: 8 MB (`lib/upload.ts:34`) vs 12 MB (`lib/attachments.ts:44`) vs 12 MB (`visual-edit/.../apply/route.ts:177`). `AGENTS.md` states the limit is 8 MB. | **Low** | CONFIRMED | as cited |
| **SEC-17** | **`projectId` interpolated without validation** in `source-code` and `upload` (unlike `env` and `visual-edit`). Traversal is blocked downstream by `resolveVcaasUrl`, so this is inconsistency, not an exploit. | **Low** | CONFIRMED | `source-code/.../route.ts:16`; `upload/.../route.ts:50` |
| **SEC-18** | **Catch-all route hides 404s.** Every unknown path 302s to `/`, so typos, scanners and broken links are indistinguishable. | **Low** | CONFIRMED | `src/app/[...slug]/page.tsx:8-10` |
| **SEC-19** | **Stale test reference.** `project-slug.ts:20` cites `src/lib/__tests__/project-slug.test.ts`; the directory does not exist. The repository has no test suite. | **Low** | CONFIRMED | `project-slug.ts:20`; `ls src/lib/__tests__` → not found |
| **SEC-20** | **Two servers run the same process-wide canary state.** `writeFidelity` is a module-level mutable, so a multi-tenant server shares one probe verdict across all users. | **Low** | CONFIRMED | `visual-edit/.../apply/route.ts:70` |

**Positive controls worth keeping (VERIFIED):** the `/api/v1/vcaas/` path confinement with encoded-traversal rejection (`vcaas-server.ts:54-72`); the SSRF discipline in `safe-url.ts` with DNS resolution, `redirect:"error"` and timeouts; the diff-route allowlist + 10 MiB cap; the visual-edit resolve-before-write, verify-before-write and fidelity-canary chain; the error-envelope normalisation (`vcaas-errors.ts`) that keeps upstream codes intact; `isRoutableProjectSlug` as a structural path guard separate from the creation rules.

---

## 15. Privacy, legal and compliance posture

**CONFIRMED — the published legal pages describe a product that does not exist.**

| Page | Claim | Reality |
|---|---|---|
| `terms/page.tsx:60-63` | *"When creating an account with Google, GitHub, or email authentication, you agree to maintain the security of your credentials…"* | There is no account, no credential, no email auth. §3 describes a security model the product does not implement. |
| `privacy/page.tsx:46-51` | *"When you sign up or log in to Mavly, we collect basic account information (such as your name and email address provided by your authentication provider)…"* | Nothing is collected. The privacy policy asserts data collection that does not occur — and, read the other way, the app processes *everyone's* prompts and code under a single operator identity with no data-controller boundary at all. |
| `privacy/page.tsx:67-71` | *"You have the right to access, export, or delete your personal data and projects at any time through your account settings…"* | There are no account settings, no export and no deletion path for the builder's own data. |
| `privacy/page.tsx:40-42` | "Last updated: October 2026" | Fine. |
| `login/page.tsx:165-173` | "By continuing, you agree to our Terms of Service and Privacy Policy." | The "continue" performs no authentication; consenting to terms is tied to a button that does nothing. |

**The real disclosure gap:** the builder transmits user prompts, source code, uploaded files, database contents and generated-app secrets to a **third-party host (Totalum) and, for diffs and source archives, to Google Cloud Storage**. Neither the Terms of Service nor the Privacy Policy names Totalum as a processor/sub-processor, mentions the AI agent that reads prompts and source, or discloses that generated apps are hosted on `*.totalum-project.com`.

**Severity:** this is a compliance/misrepresentation exposure (GDPR Art. 13/14 disclosure, unfair-commercial-practices risk on the Terms claims) rather than a technical vulnerability — but it is *more* urgent than it looks, because the pages are the ones a regulator or a customer would read, and they are currently false.

---

## 16. Licensing, attribution and third-party asset provenance

| Item | Finding | Classification |
|---|---|---|
| Repository licence | **MIT**, `Copyright (c) 2026 Totalum Labs` — requires the copyright and permission notice in all copies. `README.md:367` says "Free for personal and commercial use". | VERIFIED FACT |
| Scope of the MIT grant | Covers **the repository's code only**. It grants nothing over the Totalum hosted API, the "Totalum" name/mark, Totalum-generated assets, or the terms of a paid service. | RECOMMENDATION |
| "White-label" claim | `README.md:182` — *"It is your codebase and your UI. Rebrand it"*. The MIT grant does permit rebranding the **UI**. It does **not** grant rights to the Totalum name, logo, `totalum.app` links, or the right to resell the service. | VERIFIED FACT + UNVERIFIED (contractual) |
| Copied platform code | `AGENTS.md` rule 1: `components/workspace/*`, `components/prompt/*`, `components/primitives/*`, `lib/{format,logs,domain-status,env-parse,diff-parse,github-repo}.ts` and `i18n/en.ts` are **straight copies of totalum-platform**. That source is not published in this repo, and its licence is not referenced here. If totalum-platform is not MIT, the "MIT" claim over its copies is incomplete. | **UNVERIFIED — highest-priority licence question** |
| `src/i18n/en.ts` | AGENTS.md rule 6 requires that new user-facing strings be added to totalum-platform's `en.ts` first, then copied here — i.e. the platform dictionary is the upstream of truth and **the platform is assumed to be a single dictionary, not a fork**. | VERIFIED FACT |
| Bundled assets | `public/logo/Mavly.png` (Mavly's own mark, provenance undocumented), `.github/assets/ai_app_builder_open_demo.gif` (upstream demo). No `NOTICE` or `TRADEMARKS` file exists. | UNVERIFIED |
| Third-party runtime code | Radix (MIT), `lucide-react` (ISC), `sonner` (MIT), `cmdk` (MIT), `next-themes` (MIT), `cva` (MIT), `clsx` (MIT), `tailwind-merge` (MIT), `@monaco-editor/react` (MIT + `monaco-editor` MIT), `react-hook-form` (MIT), `react-day-picker` (MIT), `fflate` (MIT). No copyleft. | VERIFIED FACT |
| Fonts / imagery | None bundled — icons are `lucide-react`; placeholder imagery is remote. | VERIFIED FACT |
| Generated-app licensing | The apps the agent builds may embed third-party code; their licence is the user's question, and this repo says nothing about it. | UNVERIFIED |

**Action:** obtain (a) the licence of `totalum-platform` and confirm MIT-equivalent terms, (b) written confirmation that the Totalum API may be resold under a different brand, and (c) a trademark position on "Totalum" in the UI strings, the `SetupBanners` copy and the `totalum.app` links.

---

## 17. Vendor lock-in and replaceability

### 17.1 What Totalum owns

| Capability | Endpoints | Replaceability |
|---|---|---|
| AI agent (model routing, tools, context) | `agent/*` | **Very hard** — the product's core |
| Sandbox lifecycle (create/archive/wake) | `agent/server/start-or-restart`, `pause`, `resume` | Hard |
| Preview hosting + URL semantics | `preview/rotate-url`, `temporalDevelopmentProjectUrl` | Hard |
| Source storage + **write fidelity** | `files/tree`, `files/content` | **Hard + non-obvious** (the sanitizer, §9.3) |
| Rebuild | `rebuild` | Medium |
| Deploys | `deployments/*` | Medium |
| Dev/live SQL databases, backups, restore, time travel | `database/*` | Hard |
| Analytics | `analytics/site` | Medium |
| Cron | `cron-jobs/*` | Medium (easy to move to a scheduler) |
| Project API keys | `api-keys/*` | Medium |
| Mobile builds + store uploads | `mobile/*` | Hard |
| Payments provisioning | `payments/*` | Medium |
| Custom domains + purchase + DNS + renewal | `domain`, `domains/*` | Hard (registrar + DNS + CDN) |
| GitHub sync | `github/*` | **Easy** (GitHub API) |
| Figma | `figma/*` | Easy (Figma REST) |
| Secrets | `secrets/*` | Easy (any secret manager) |
| Versions + diff + restore | `versions/*`, `version-diff` | Medium |
| Logs | `backend/*/logs` | Easy |
| Usage/credits | `usage`, `credit-costs`, `credit-limits` | Medium |
| MCP hosting | `agent/mcp-servers*` | Easy |
| Project transfer / groups | `import`, `export`, `project-groups` | Easy |

### 17.2 What Mavly owns (and therefore already owns the right to)

| Asset | Size | Portability |
|---|---|---|
| **Visual-edit engine** (`src/lib/visual-edit*.ts`) | **6,642 LOC / 6 files** | **High** — pure TypeScript over file contents; no network, no Totalum types except `VisualChange`. The single most valuable portable asset. |
| Error normalisation | `src/lib/vcaas-errors.ts` (287 LOC) | High |
| Attachment handling | `src/lib/attachments.ts` (499) | High |
| Operation state machine | `src/lib/project-operation.ts` (475) | High |
| Project status / badge / preview-URL rules | `src/lib/project-status.ts` (383) | High (encodes upstream quirks worth keeping) |
| Agent progress parsing | `src/lib/agent-progress.ts` (414) | High |
| Diff parser | `src/lib/diff-parse.ts` (307) | High |
| Domain status | `src/lib/domain-status.ts` (293) | High |
| SSRF guards | `src/lib/safe-url.ts` (239) | High |
| Slug rules | `src/lib/project-slug.ts` (225) | High |
| UI, i18n, styling, components | ~90% of `src/components` | High — this *is* the product's surface |
| i18n dictionary | `src/i18n/en.ts` | Medium — must stay in sync with the platform (AGENTS.md rule 6) |

### 17.3 Lock-in rating

**Overall: HIGH (≈8/10).** One account-wide key fronts ~110 endpoints, and the four hardest-to-replace capabilities (agent, sandbox+preview, source storage with its write semantics, dev/live databases) are precisely the ones that make the product work. The *interface* is cleanly separated (`src/lib/vcaas.ts` is the only client, `src/lib/vcaas-server.ts` the only key holder), which is what makes a staged exit possible.

**Mitigating fact:** the repository is not a fork of Totalum's platform — it is a UI that was *copied from* one, plus its own visual-edit engine. The lock-in is in the **API dependency**, not in vendored backend code.

---

## 18. Deployment and operations posture

| Area | State |
|---|---|
| Build | `npm run build` → `next build`; `output: standalone` unless `VERCEL=1` (`next.config.ts:9`) |
| Run | `npm start` → `next start` on `$PORT` |
| Cache | `no-cache, no-store, must-revalidate` on every path (`next.config.ts:29-40`) |
| Health check | **None** — no `/api/health`, no readiness probe |
| Logging | `console.error`/`console.info` only; no structured logger, no request IDs, no tracing |
| Metrics | **None** — Totalum's analytics describe *generated apps*, not Mavly |
| Rate limiting | **None** |
| Secrets management | Environment variables only |
| CI/CD | **None in the repo** — no `.github/workflows`, no Dockerfile, no compose file |
| Containers | `standalone` output implies a Docker path, but no Dockerfile is committed |
| Backups of Mavly's own data | **None needed** — Mavly stores no user data |
| Migrations | None |
| Disaster recovery | The product is stateless; all state is in Totalum. Losing the key means losing access to every project. |
| Vercel | `vercel.json` + a one-click deploy button in the README |

**Operational reality:** the single highest-value operational asset is the `TOTALUM_VCAAS_API_KEY`. It is the account identity for every project, every customer app, every credit balance and every custom domain. There is no rotation procedure, no second key, no key-scoped fallback, and no documented recovery path — and per `README.md:154` anyone who reaches the URL can spend it.

---

## 19. Migration strategy and phased roadmap to Mavly-controlled infrastructure

### 19.1 Three strategies

| | **A — Harden in place** | **B — Adapter + staged replacement** ⭐ | **C — Full re-implementation** |
|---|---|---|---|
| Shape | Keep Totalum; add auth, tenancy, metering, legal fixes | Introduce a `BuilderBackend` interface behind `vcaasApi`; swap implementations capability by capability | Rebuild agent, sandbox, preview, DB, deploy on Mavly infra |
| Effort | **3–6 weeks** | **6–12 months** | **18–36 months** |
| Risk | Low | Medium | Very high |
| Value | Makes it safe to run as a product; does not reduce lock-in | Preserves the product, reduces lock-in incrementally, keeps optionality | Full control; almost certainly not worth it for a UI-led business |
| Reversibility | Full | Full | Low |
| Blocks | Nothing | Nothing — A is a subset | Everything |

**Recommendation: A now, B's *first half* immediately after, C never.** Specifically: do A, and while doing it put the `BuilderBackend` seam in place (§19.3). A is a strict prerequisite for B: an unauthenticated single-tenant app cannot be migrated incrementally, because there is no per-user boundary to migrate *within*.

### 19.2 Phased roadmap

**Phase 0 — Legal and disclosure truth (1–3 days, blocks launch)**
1. Rewrite `/terms` and `/privacy` to match reality, or ship the auth layer first and make them true afterwards. Name Totalum as a sub-processor; disclose the AI agent, the `*.totalum-project.com` hosting and GCS transfer. Remove the fabricated "Google, GitHub or email authentication" clause. **LEGAL-01.**
2. Obtain the `totalum-platform` licence confirmation and a written white-label/resale permission from Totalum. **LICENSE-01/02/03.**

**Phase 1 — Make the secret safe (2–5 days, blocks any public deployment)**
3. Add real auth behind the existing `useT`/component structure — Supabase Auth (already provisioned: ref `cazmezhpanwdjgsqugzr`) or any OIDC provider — with a session cookie. Keep the existing Google/GitHub buttons; point them at the real provider.
4. Make `resolveVcaasContext()` real: read the session, return `401` when absent, populate `ctx.accountUserId` and `team.userId`. **SEC-01.**
5. Make `enforceProjectScope()` real: check `path[0] === "projects" && path[1]` against the user's ownership table; return `403` otherwise. **AUTH-01.**
6. **Wire the two guards into the five routes that never call them**: `[...path]`, `env`, `source-code`, `upload`, `git-diff`. This is the step `AGENTS.md` itself flags and this audit confirms. **SEC-01/AUTH-01.**
7. Persist `projectId ↔ user` on every successful `POST /projects` and `/projects/launch`; filter `GET /projects` in the catch-all route.
8. Protect the pages in `src/proxy.ts` (`/`, `/project/*`, `/home` as appropriate) by redirecting unauthenticated users to `/login`.

**Phase 2 — Remove the browser-side traps (2–4 days)**
9. Replace `frame-ancestors *` with an explicit allowlist of the preview hosts the app actually needs; restore `X-Frame-Options` outside the preview routes. **SEC-04.**
10. Narrow the credentialed CORS allowlist: drop `*.totalum-project.com` from the API origin, drop `Access-Control-Allow-Credentials` unless cookies are actually used, and make dev allowlist explicit rather than `*`. **SEC-03.**
11. Bind `next dev` to `127.0.0.1` and set `allowedDevOrigins` to explicit hosts. **SEC-08.**
12. Validate `redirect` in `login/page.tsx` against an allowlist of internal paths. **SEC-15.**

**Phase 3 — Dependency and deployment hygiene (2–3 days)**
13. Update `next` to a patched release; re-run `npm audit` until it is zero, including the `dompurify` override and `sharp`. **SEC-06/07.**
14. Move `next` to `dependencies` (or ship a Dockerfile that installs dev deps); move `postcss` to `devDependencies`. **SEC-09.**
15. Turn on `strict` incrementally (`strictNullChecks` first) and delete the manual narrowing helpers it obsoletes. **SEC-10.**
16. Add a request-body size limit to the upload route and a timeout + size cap + `redirect:"error"` to the source-code route, copying the git-diff route's discipline. **SEC-13/14.**
17. Add `/api/health`, structured logging with request IDs, and per-user rate limits on the billable paths. **SEC-11.**

**Phase 4 — Metering and billing (1–2 weeks)**
18. Add `profiles(user_id, credits)`; intercept the spend-shaped paths and return `402 INSUFFICIENT_CREDITS` when the balance is empty — the UI already opens `InsufficientCreditsModal` on that code. Change `BUY_CREDITS_URL` to your own checkout.
19. Stripe Checkout + webhook to top up credits; decrement on `agent/status === "done"` (`creditsSpent` is on the response) or via Totalum webhooks.
20. Delete the operator-facing credit copy and the "buy credits" link to the operator's billing page.

**Phase 5 — Portability seam (2–4 weeks, the strategically important one)**
21. Extract a `BuilderBackend` interface from `vcaasApi` — one method per capability, returning `vcaas-types.ts` shapes unchanged.
22. Implement `TotalumBackend` (the current code) and a `LocalBackend` for the cheap wins.
23. Move the first real workloads off Totalum: **GitHub sync → the GitHub API**; **secrets → a real secret manager**; **cron → a scheduler**; **logs → your own sink**. Each is a self-contained module with no downstream coupling.
24. Replace `totalum-platform` copy drift with a one-way import: keep the platform as the upstream of `en.ts`, or fork it deliberately and stop the two-way copy discipline.

**Phase 6 — Decide the core deliberately (ongoing)**
25. The agent, the sandbox, the preview and the databases are the hard core. Do **not** attempt them. If total independence from Totalum is a strategic requirement, evaluate the commercial terms (a dedicated Totalum plan with its own SLA, higher limits, white-label contract) before considering any rebuild. **This decision is a business one and should be made explicitly rather than by drift.**

### 19.3 The seam to build first

```ts
// src/lib/backend/types.ts
export interface BuilderBackend {
    projects: { list(): Promise<ProjectSummary[]>; create(input: NewProject): Promise<Project> };
    agent:    { start(p: ProjectId, prompt: string): Promise<RunHandle>; status(p: ProjectId): Promise<RunStatus> };
    files:    { tree(p: ProjectId): Promise<FileTree>; read(p: ProjectId, path: string): Promise<string>; write(p: ProjectId, path: string, content: string): Promise<void> };
    deploy:   { deploy(p: ProjectId): Promise<DeployHandle> };
    database: { schema(p: ProjectId, env: Env): Promise<Schema>; rows(...): Promise<Rows>; sql(p: ProjectId, sql: string, env: Env): Promise<SqlResult> };
    // …one interface per capability, no Totalum vocabulary leaking through
}
```

The constraint that makes this worth doing: **the visual-edit engine must keep working.** It is 6,642 lines of Mavly code that speaks in *file contents* and *change descriptors*, not in Totalum paths. It survives any backend that can read and write files — which makes it the natural first-class citizen of a Mavly-owned platform, and the reason the migration is worth starting.

---

## A–H — Conclusions

### A. Overall verdict
**Safe to run privately; not safe to publish as-is.** The engineering quality inside the app is high — the SSRF discipline, the path confinement, the visual-edit verification chain and the error normalisation are all better than most production codebases of this size. The problem is not the code that exists; it is the code that does not: **no authentication, no tenancy, no metering, no honest legal pages.** All four are known to the repository's own authors and are named in `README.md:149-158` and `AGENTS.md`.

### B. The four things that must be fixed before any public launch
1. **Real authentication** at `src/app/api/vcaas/_shared.ts:48` + page protection in `src/proxy.ts`. (SEC-01)
2. **Real per-user project scoping**, wired into all seven route handlers — not just the two that call the guard today. (AUTH-01)
3. **Honest `/terms` and `/privacy`**, including Totalum as a sub-processor. (LEGAL-01)
4. **A patched `next`** and `npm audit` back to zero. (SEC-06/07)

### C. The single most dangerous line in the repository
`src/app/api/vcaas/env/[projectId]/route.ts:19-25` — an unauthenticated `GET` that returns every project's `.env` as plain text. One request per project id discloses the API keys, database URLs and webhook secrets of every application the operator has ever built.

### D. What is genuinely good and should not be disturbed
`resolveVcaasUrl`'s path confinement with encoded-traversal rejection; `safe-url.ts`'s DNS-resolving SSRF guard; the git-diff route's allowlist + redirect refusal + 10 MiB cap; the visual-edit resolve-before-write / verify-before-write / fidelity-canary chain; `vcaas-errors.ts`'s preservation of upstream error codes; `isRoutableProjectSlug` separating *path safety* from *creation rules*; and the `en.ts`-as-a-copy discipline that keeps UI fixes portable. These are the reason the migration is tractable at all.

### E. Lock-in: high, but the exit is designed-in
Roughly 8/10 against Totalum, concentrated in the agent, the sandbox+preview, source storage (with its non-obvious base64 write semantics) and the dev/live databases. The client/server split in `src/lib/vcaas.ts` / `src/lib/vcaas-server.ts` and the 6,642-LOC platform-independent visual-edit engine mean the exit is a **staged** one: GitHub, secrets, cron, logs and MCP first; the core never, unless the commercial terms make independence worth it.

### F. Recommended path
**Strategy A immediately, Strategy B's seam immediately after, Strategy C never.** A is a strict prerequisite for B: you cannot migrate per-user between backends while every user shares one identity. Expected outcome in ~8 weeks: a deployable, sellable, multi-tenant product with real auth, real tenancy, per-user metering and correct legal pages — still on Totalum, but no longer one key away from a total compromise.

### G. Effort and sequence
| Phase | Scope | Estimate | Blocks launch? |
|---|---|---|---|
| 0 | Legal truth + licence confirmation | 1–3 days | **Yes** |
| 1 | Auth, tenancy, guard wiring, page protection | 2–5 days | **Yes** |
| 2 | CSP/CORS/dev-origin/open-redirect fixes | 2–4 days | **Yes** |
| 3 | Dependency, deployment, type-safety, body limits, health/logging | 2–3 days | **Yes** |
| 4 | Per-user metering + Stripe | 1–2 weeks | No |
| 5 | `BuilderBackend` seam + first workload ports | 2–4 weeks | No |
| 6 | Core-platform decision | Ongoing | No |

### H. The one decision to make now
**Is Mavly a Totalum console with better UX, or the front end of a platform Mavly owns?** The answer determines whether Phases 4–5 are worth the 3–6 months. Nothing in the code forces the answer: the repository is explicitly built so the UI, the dictionary and the visual-edit engine remain portable, and the copy discipline in `AGENTS.md` keeps them that way. But the current build has quietly converged on "console": 110 Totalum endpoints, one key, zero tenancy, and legal pages describing a different product. Phases 1–3 are needed either way. Phase 5 is the one that buys optionality, and it is cheap only if it starts before the codebase accumulates more Totalum-shaped assumptions.

---

## Next implementation prompt

> Implement Phase 0 and Phase 1 of `AUDIT.md` on this repository, as a sequence of small reviewable commits. Preserve the existing Google and GitHub buttons and all current copy and styling — do not rename, remove, duplicate or restyle them.
>
> **Phase 0 (legal truth).** Rewrite `src/app/terms/page.tsx` and `src/app/privacy/page.tsx` so every statement matches the code: no account is created by the current buttons until Phase 1 lands, and after Phase 1 it is the provider you actually configure. Name Totalum as a sub-processor, disclose that prompts, source code, uploads and generated-app secrets are transmitted to it, that generated apps are hosted on `*.totalum-project.com`, and that source archives and diffs pass through Google Cloud Storage. Remove the fabricated "Google, GitHub or email authentication" clause from Terms §3 and the fabricated account-settings export/delete promise from Privacy §4. Keep the existing layout, logo, links and `mavly-*` classes.
>
> **Phase 1 (make the key safe).**
> 1. Add authentication. Supabase is already provisioned (project ref `cazmezhpanwdjgsqugzr`) — use `@supabase/supabase-js` + `@supabase/ssr`, or an OIDC provider of the operator's choosing, and say which you picked and why. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` to `.env.example` (names only, never values). Replace the simulated flow at `src/app/login/page.tsx:18-38` with a real redirect to the provider and a real callback route; **keep both buttons and their labels**, and keep the auto-trigger behaviour.
> 2. Create `profiles(user_id uuid pk, credits integer default 0)` and `projects(project_id text pk, user_id uuid, created_at)` with RLS.
> 3. Make `src/app/api/vcaas/_shared.ts:48-62` real: `resolveVcaasContext()` reads the session and returns `401` when absent, else `{ ok: true, ctx: { accountUserId }, team: { userId } }`; `enforceProjectScope(team, method, path)` returns `403` when `path[0] === "projects" && path[1]` and the project is not owned by `team.userId`. Keep the exported signatures and `VcaasAuthResult`/`authFailed` shape intact — copied platform files depend on them.
> 4. Wire both guards into **every** handler, including the five that skip them today: `vcaas/[...path]/route.ts`, `vcaas/env/[projectId]/route.ts`, `vcaas/source-code/[projectId]/route.ts`, `vcaas/upload/[projectId]/route.ts`, `vcaas/git-diff/route.ts`.
> 5. On a successful `POST /projects` or `/projects/launch`, insert the returned `projectId` for the caller. In the catch-all route, intersect `GET /projects` with the caller's own rows so the client stays a verbatim copy.
> 6. Protect the pages in `src/proxy.ts`: unauthenticated `/` and `/project/*` redirect to `/login`; `/home`, `/terms`, `/privacy` stay public.
>
> **Verification.** `npx tsc --noEmit` clean; `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` clean; `npm run build` succeeds; `npm audit` reports no new advisory; then exercise in a browser with a real key: sign in with Google, land on the dashboard, open a project, confirm the workspace loads, and confirm a second signed-in user cannot see or open the first user's project by typing its id into `/project/<id>` — that negative test is the deliverable. Do not publish, restore, pull or delete against a real project, and do not commit any `.env*` file or key.
