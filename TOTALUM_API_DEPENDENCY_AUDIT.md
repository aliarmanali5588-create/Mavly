# Mavly — Totalum API Dependency Audit

> **HISTORICAL DOCUMENT — NOT CURRENT INSTRUCTIONS.** This audit records the Totalum
> dependency as it existed at an earlier commit. The integration has since been removed:
> there are no outbound builder-API calls, `src/lib/vcaas-server.ts` was deleted, and every
> backend-dependent route returns `503 BACKEND_NOT_CONFIGURED` after its auth and ownership
> checks. Do not restore the endpoints or configuration described below. For the current
> state, read `MAVLY_CLEAN_BASELINE.md`.

**Audit date:** 2026-10-22 · **Tree state:** branch `main` @ `bdc1b3e`, clean working tree at audit start (this report is the only added file) · **Method:** static read of the working tree (all `src/` routes, libs, components, config, tests, docs) + `rg` full-repository searches. **No code, configuration, environment variable, or schema was modified. No Totalum API was called. No secret was read, printed, or copied into this report.**

> **Relationship to the existing `AUDIT.md` / `ROUTE_AUDIT.md`.** Those documents audited an earlier commit (`cdd6c01`) and are partially stale: they predate the Supabase auth layer (login, callback, `src/proxy.ts` session refresh) that now exists. This report describes the **current tree** and focuses exclusively on Totalum dependency, as requested.

---

## 1. Executive Summary

Mavly is a **thin UI over Totalum's hosted VCaaS API**. Every capability a user would call "the product" — creating a project, running the AI agent, previewing, editing code, rebuilding, publishing, databases, logs, GitHub, Figma, domains, mobile builds, payments, credits — is executed by Totalum's backend behind one account-wide API key. Mavly owns the presentation, the visual-edit engine (~6,600 LOC), the routing/proxy plumbing, the Supabase login, and the error-normalisation layer. It owns almost none of the machinery.

**Headline numbers (evidence-backed, counted from the current tree):**

| Metric | Count |
|---|---|
| Unique confirmed Totalum endpoint **method + path** combinations in active use | **127** |
| Unique confirmed endpoint **path templates** in active use | **102** |
| Path templates defined in the client catalog (incl. unused) | **110** |
| Internal Mavly API routes that invoke Totalum (API or Totalum-hosted storage) | **7 of 8** |
| Confirmed **direct** integrations (UI → internal route → Totalum, one upstream call) | **120** method+path combos |
| Confirmed **indirect / server-composed** integrations (one internal request → multiple upstream calls or a second Totalum-hosted fetch) | **7** internal routes, covering **13** upstream combos |
| Critical product workflows that depend on Totalum | **8 of 9** (authentication does not) |
| Catalog methods defined but never called by this app | **13** |
| Security findings (Critical 2 · High 2 · Medium 4 · Low 3 · Info 1) | **12** |

**The three facts that matter most:**

1. **The product cannot run without Totalum.** There is no local agent, sandbox, host, or database engine in this repository. Removing Totalum stops project creation, generation, preview, editing, publishing, and every v2 feature at once.
2. **The API surface is open today.** `src/proxy.ts:70-75` deliberately excludes `/api/*` from the session gate, the route guards in `src/app/api/vcaas/_shared.ts:48-62` are documented no-ops, and the catch-all proxy never calls them anyway. Any unauthenticated visitor who can reach the deployment can list, read, edit, publish, and delete every project the operator's key owns, and spend the operator's credits.
3. **All traffic funnels through one choke point.** `src/lib/vcaas-server.ts` + `src/app/api/vcaas/[...path]/route.ts` are the only code that holds the key and speaks to `builder-api.totalum.app`. That is the single place a migration adapter, a tenancy gate, or a Totalum decommission must be built.

---

## 2. Audit Methodology and Repository Scope

### 2.1 What was searched

Every tracked and untracked file under the repository root (excluding `node_modules/`, `.next/`), with targeted `rg` sweeps for: `totalum`, `builder-api.totalum.app`, `api-accounts.totalum.app`, `TOTALUM_`, `VCAAS`, `vcaasApi.`, `vcaasRequest`, `vcaasUploadRequest`, `getVcaasApiKey`, `totalum-sdk`, `totalum-project.com`, `webapp-project.com`, `fetch(`, `process.env`, WebSocket/EventSource. Package manifests, lockfile, tests, docs (`AGENTS.md`, `README.md`, `AUDIT.md`, `ROUTE_AUDIT.md`), Supabase migrations, `next.config.ts`, `vercel.json`, `.github/`, `.aistudio/` were all inspected.

### 2.2 Call-chain method

For every endpoint, the chain was walked in full:

```
UI component / lib helper
  → internal Mavly route (`/api/vcaas/*`, `/api/preview/*`, `/api/visual-edit/*`)
    → `vcaasRequest` / `vcaasUploadRequest` (src/lib/vcaas-server.ts)
      → `resolveVcaasUrl` (path-containment guard)
        → fetch(`https://builder-api.totalum.app/api/v1/vcaas/<path>`, headers: { api-key })
```

Two shapes exist:

- **Catalogued (direct):** the browser calls a typed `vcaasApi.*` function (`src/lib/vcaas.ts`) → same-origin `/api/vcaas/<path>` → catch-all proxy. One internal hop per upstream call.
- **Server-composed (indirect):** an internal route makes its own `vcaasRequest` calls and/or fetches a Totalum-hosted signed URL / sandbox origin (preview proxy, visual-edit apply, source-code, env, git-diff, upload).

### 2.3 Classification vocabulary

| Tag | Meaning |
|---|---|
| **Confirmed active** | A live code path in this tree calls it; caller cited |
| **Conditionally active** | Called only behind a feature gate (v2 engine, paid plan upstream, user action in a modal) |
| **Unused** | Defined in the client catalog; no caller anywhere in `src/` |
| **Uncertain / likely broken** | Called with a path that does not match the documented catalog, or behaviour that cannot be verified statically |
| **Legacy** | Preserved for an older engine or older upstream format; still reachable |

### 2.4 What could not be verified

- Totalum's own backend (not in this repo). Upstream behaviour, credit costs, rate limits, and undocumented paths are inferred from comments and error handling in this codebase, not from the live service.
- `.env.local` exists on disk but was **not read** (it may contain the live key; the audit rule forbids exposing secrets). Its variable *names* are documented in `.env.example`.
- `totalum-platform` (the source repo many files were copied from) is not present; verbatim-copy claims come from in-file comments and `AGENTS.md`.
- The live upstream route map at `https://www.totalum.app/totalum-api.md` was **not fetched** (no network calls made during this audit). Endpoint semantics are taken from this repository's own typed catalog and comments.

---

## 3. Confirmed Totalum API Endpoint Inventory

**Base URL (all endpoints):** `https://builder-api.totalum.app/api/v1/vcaas` (origin overridable via `TOTALUM_API_URL`; prefix always appended — `src/lib/vcaas-server.ts:20-21`). The older host `api-accounts.totalum.app` is mentioned in comments as answering the same paths but is **never used in code**.

**Authentication:** every upstream request carries header `api-key: <TOTALUM_VCAAS_API_KEY>` injected server-side (`vcaas-server.ts:118-120, 150`). No endpoint is ever called from the browser with the key.

**Shared properties (apply to every row unless noted):**

- *Request data categories:* JSON body (prompt text, file paths, base64 file content, tokens supplied by the user, flags). No Mavly-held secret is ever placed in a request body; the only credential sent is the account key in the header, plus user-supplied tokens (GitHub PAT, Figma token, Stripe/Play credentials) that the user typed for that purpose.
- *Response handling:* upstream `{ errors, data }` envelope normalised by the catch-all into `{ ok, data }` / `{ ok:false, error, code, upstreamCode, details }` (`[...path]/route.ts:88-107`, `vcaas-errors.ts`).
- *Auth/authorization before invocation (internal):* **none** on the catch-all path — no session check, no ownership check (see §10). `isRoutableProjectSlug` format validation exists only on the dedicated env/preview/visual-edit routes.
- *`projectId` source:* URL segment of the Mavly page (`/project/[projectId]`), or the id returned by `POST /projects` / `POST /projects/launch` (which may differ from the requested slug — `vcaas.ts:356-360`).

Where a call **creates / updates / deletes / publishes / charges**, the table says so. Credit costs quoted below are the ones documented in this repo's comments (`launch` 1 credit + run; `deploy` ~1 credit; `rebuild` 1; `files.write` 1; `export` 2; `import` 6; `versions.recover` 2; `source-code` 1; `createBackup` 1; visual-edit apply upstream-metered 0.3 in the platform, unmetered here).

### 3.1 Projects

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 1 | GET | `/projects?limit&skip&search&sortDirection&sortField&groupId&createdFrom&createdTo` | Dashboard project list; workspace clone-name check | read | Confirmed | `BuilderDashboard.tsx` (`projects.list`), `project/[projectId]/page.tsx:241` |
| 2 | GET | `/projects/{projectId}` | Workspace load; preview-origin resolution; server-wake polling; domain panel | read (triggers upstream sandbox probes) | Confirmed | `page.tsx:457`, `use-server-wake.ts:311`, preview `route.ts:142` |
| 3 | POST | `/projects` | Create with attachments (dashboard), import target | **creates project (charged)** | Confirmed | `BuilderDashboard.tsx:486`, `ProjectTransferDialogs.tsx` |
| 4 | POST | `/projects/launch` | Hero prompt → create + first agent run in one call | **creates project + starts agent (charged)** | Confirmed | `BuilderDashboard.tsx:443-449` |
| 5 | PATCH | `/projects/{projectId}` | v2 live-host suffix switch (`liveHostSuffix`) | **updates project** | Confirmed (via `v2.setLiveHostSuffix`) | `vcaas.ts:905-906`, `V2ProjectSettings.tsx` |
| 6 | DELETE | `/projects/{projectId}` | Dashboard delete | **deletes project** | Confirmed | `BuilderDashboard.tsx` (`projects.remove`) |
| 7 | POST | `/projects/{projectId}/export` | Export dialog | **charges 2 credits**, rate-limited upstream | Confirmed | `ProjectTransferDialogs.tsx` |
| 8 | POST | `/projects/{projectId}/import` | Import dialog (destructive) | **charges 6 credits**, drops target data | Confirmed | `ProjectTransferDialogs.tsx` |

### 3.2 Agent

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 9 | GET | `/projects/{id}/agent/status` | 10 s poll while a run is active; undo-db panel | read | Confirmed | `page.tsx:498`, `UndoDbChange.tsx` |
| 10 | GET | `/projects/{id}/agent/full-conversation?limit&offsetFromEnd` | Chat history load | read (windowed by our proxy) | Confirmed | `page.tsx:461` |
| 11 | POST | `/projects/{id}/agent/start` | Send prompt / follow-up (chat, auto-submit) | **starts paid agent run** | Confirmed | `page.tsx:665` |
| 12 | POST | `/projects/{id}/agent/clear-context` | Run options → clear context | resets agent session (free) | Confirmed | `page.tsx` (`agent.clearContext`) |
| 13 | POST | `/projects/{id}/agent/stop` | Stop-run confirm dialog | stops run (already paid) | Confirmed | `page.tsx` (`agent.stop`) |
| 14 | POST | `/projects/{id}/agent/server/start-or-restart` | Auto-wake on touching an archived project; manual restart | **starts sandbox (charged)** | Confirmed | `page.tsx:765, 1198` |

### 3.3 Deployments

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 15 | GET | `/projects/{id}/deployments/status` | 10 s poll while publishing | read | Confirmed | `page.tsx:550` |
| 16 | POST | `/projects/{id}/deployments/deploy` | Publish button / publish-anyway | **publishes to production (charged)** | Confirmed | `page.tsx:1165`, `use-server-wake.ts` replay |

### 3.4 GitHub

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 17 | GET | `/projects/{id}/github/status` | Composer button tint; modal open | read | Confirmed | `page.tsx:491`, `GithubModal.tsx`, `GithubPromptButton.tsx` |
| 18 | GET | `/projects/{id}/github/pull-status` | Poll during pull/rebuild | read | Confirmed | `page.tsx` (`github.pullStatus`) |
| 19 | POST | `/projects/{id}/github/connect` | Link repo (token + direction) | **updates project (stores user PAT)** | Confirmed | `GithubModal.tsx` |
| 20 | DELETE | `/projects/{id}/github/connect` | Unlink | **updates project** | Confirmed | `GithubModal.tsx` |
| 21 | POST | `/projects/{id}/github/pull` | Pull latest | **rewrites files on sandbox (charged/wake)** | Confirmed | `page.tsx:1221` |
| 22 | GET | `/projects/{id}/github/env` | View synced `.env` | read | Confirmed | `GithubModal.tsx` |

### 3.5 Figma

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 23 | GET | `/projects/{id}/figma/status?verify=` | Composer tint; modal | read (verify = live Figma call) | Confirmed | `page.tsx:629`, `FigmaModal.tsx` |
| 24 | POST | `/projects/{id}/figma/connect` | Connect token (dashboard pending mode + modal) | **stores user token** | Confirmed | `BuilderDashboard.tsx:506`, `FigmaModal.tsx` |
| 25 | DELETE | `/projects/{id}/figma/connect` | Disconnect | **updates project** | Confirmed | `page.tsx:641`, `FigmaModal.tsx` |
| 26 | POST | `/figma/validate` | Validate a token before a project exists | outbound call to Figma with user token; rate-limited upstream | Confirmed | `vcaas.ts:613-614`, `FigmaModal.tsx` |

### 3.6 Secrets, domain (project-scoped), versions

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 27 | POST | `/projects/{id}/secrets` | Secrets modal; chat quick-add | **writes secret** | Confirmed | `SecretsModal.tsx`, `ChatPanel.tsx` |
| 28 | DELETE | `/projects/{id}/secrets/{secretId}` | Secrets modal | **deletes secret** | Confirmed | `SecretsModal.tsx` |
| 29 | PUT | `/projects/{id}/domain` | Connect custom hostname | **updates routing (paid plan)** | Confirmed | `DomainModal.tsx` |
| 30 | DELETE | `/projects/{id}/domain` | Remove custom domain | **updates routing** | Confirmed | `DomainModal.tsx` |
| 31 | GET | `/projects/{id}/versions?limit&skip` | Versions modal; diff viewer | read | Confirmed | `VersionsModal.tsx`, `DiffViewer.tsx` |
| 32 | POST | `/projects/{id}/versions/{versionId}/recover` | Restore version | **overwrites files (2 credits)** | Confirmed | `page.tsx:1255` |
| 33 | GET | `/projects/{id}/version-diff?commitSha=` | Diff viewer (needs running sandbox) | read | Confirmed | `DiffViewer.tsx` |

### 3.7 Files, rebuild, logs, source, env, upload

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 34 | GET | `/projects/{id}/files/tree?path&limit&offset` | Route picker; visual-edit apply | free | Confirmed | `PathPicker.tsx`, visual-edit `route.ts:271` |
| 35 | GET | `/projects/{id}/files/content?path=` | Code panel (MigrationsPanel); visual-edit apply (N reads) | free | Confirmed | `MigrationsPanel.tsx`, visual-edit `route.ts:318` |
| 36 | PUT | `/projects/{id}/files/content` | Code panel save; visual-edit apply (base64 body) | **writes file (1 credit), needs rebuild** | Confirmed | `CodePanel.tsx`, visual-edit `route.ts:587` |
| 37 | POST | `/projects/{id}/files/upload` | Attachment upload (multipart) | **stores file (quota upstream)** | Confirmed | `upload/[projectId]/route.ts:49-51` ← `lib/upload.ts:79` |
| 38 | POST | `/projects/{id}/rebuild` | Code save; visual-edit apply | **rebuild (1 credit, 1-4 min)** | Confirmed | `CodePanel.tsx`, visual-edit `route.ts:713` |
| 39 | GET | `/projects/{id}/rebuild/status` | Poll after rebuild; workspace adopt-on-load | read | Confirmed | `CodePanel.tsx`, `page.tsx:591` |
| 40 | GET | `/projects/{id}/backend/dev/logs` | Logs panel (Dev tab) | read | Confirmed | `LogsPanel.tsx` |
| 41 | GET | `/projects/{id}/backend/prod/logs?getOnlyLastLogs&from&to&regexSearch` | Logs panel (Prod tab, Cloudflare Logpush) | read; 429 when plan limit hit | Confirmed | `LogsPanel.tsx` |
| 42 | GET | `/projects/{id}/source-code` | Code tab archive read; download | **charges 1 credit** (view and download both) | Confirmed | `source-code/[projectId]/route.ts:16` ← `vcaasApi.sourceCode` |
| 43 | GET | `/projects/{id}/env?env=dev\|live` | More → API keys (.env copy/save) | read | Confirmed | `env/[projectId]/route.ts:19` ← `ProjectApiKeysModal.tsx:65` |
| 44 | GET | `/projects/{id}/database/backups/{backupId}/download` | *(catalogued only)* | would return signed dump URL | **Unused via catalog**; UI instead links a different path — see §9 | `vcaas.ts:935-936` vs `BackupsPanel.tsx:19-20` |

### 3.8 v2 engine — state, lifecycle, database

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 45 | GET | `/projects/{id}/state` | DB settings, backups panels (preview versionId) | read | Confirmed | `DatabaseSettingsPanel.tsx`, `BackupsPanel.tsx` |
| 46 | GET | `/projects/{id}/agent/progress` | Live run timeline (chat + loader) | read | Confirmed | `RunActivity.tsx:28` |
| 47 | POST | `/projects/{id}/pause` | v2 settings pause | **pauses project** | Confirmed | `V2ProjectSettings.tsx` |
| 48 | POST | `/projects/{id}/resume` | V2Banner resume | **resumes project** | Confirmed | `V2Banner.tsx` |
| 49 | POST | `/projects/{id}/runaway/release` | Emergency-stop release | unpauses (free) | Confirmed | `RunawayNotice.tsx` |
| 50 | GET | `/projects/{id}/database/schema?env=` | DB explorer schema view | free | Confirmed | `SqlDatabasePanel.tsx`, `UndoDbChange.tsx` |
| 51 | GET | `/projects/{id}/database/usage` | DB settings usage | free, read-only | Confirmed | `DatabaseSettingsPanel.tsx` |
| 52 | POST | `/projects/{id}/database/migrate-provider` | D1 → Turso move | **one-way migration (fixed credits)** | Confirmed | `DatabaseSettingsPanel.tsx` |
| 53 | POST | `/projects/{id}/database/rows` | Table browser, record panel, migrations | read/write rows (`allowWrites`) | Confirmed | `TableDataView.tsx`, `RecordPanel.tsx`, `SqlDatabasePanel.tsx`, `MigrationsPanel.tsx` |
| 54 | POST | `/projects/{id}/database/sql` | Raw SQL panel | read/write (`allowWrites`, `confirmLive`) | Confirmed | `SqlPanels.tsx`, `TableDataView.tsx` |
| 55 | POST | `/projects/{id}/database/ask` | Plain-language question | read (LLM-assisted) | Confirmed | `SqlPanels.tsx`, `TableDataView.tsx` |
| 56 | GET | `/projects/{id}/database/bookmarks?runId=` | Restore points; undo-run | free | Confirmed | `BackupsPanel.tsx`, `UndoDbChange.tsx` |
| 57 | GET | `/projects/{id}/database/backups?env=` | Backups panel | free | Confirmed | `BackupsPanel.tsx` |
| 58 | POST | `/projects/{id}/database/backups` | Take backup | **1 credit, 1/10 min** | Confirmed | `BackupsPanel.tsx` |
| 59 | POST | `/projects/{id}/database/backups/{backupId}/restore` | Restore backup | **restore (priced as time-travel)** | Confirmed | `BackupsPanel.tsx` |
| 60 | DELETE | `/projects/{id}/database/backups/{backupId}` | Delete backup | **deletes backup** | Confirmed | `BackupsPanel.tsx` |
| 61 | POST | `/projects/{id}/database/restore` | Restore to bookmark | free, undoable | Confirmed | `BackupsPanel.tsx` |
| 62 | POST | `/projects/{id}/database/time-travel/restore` | Restore to timestamp | **2 credits** | Confirmed | `BackupsPanel.tsx` |
| 63 | POST | `/projects/{id}/database/undo-run` | Undo an agent run's DB changes | **reverts DB + code version** | Confirmed | `UndoDbChange.tsx` |

### 3.9 v2 engine — analytics, cron, agent config, API keys, usage, limits

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 64 | GET | `/projects/{id}/analytics/site?…` | Site analytics modal | free | Confirmed | `SiteAnalyticsModal.tsx` (query from `lib/site-analytics.ts`) |
| 65 | GET | `/projects/{id}/cron-jobs` | Scheduled jobs modal | free | Confirmed | `CronJobsModal.tsx` |
| 66 | POST | `/projects/{id}/cron-jobs` | Create job | **creates job** | Confirmed | `CronJobsModal.tsx` |
| 67 | PATCH | `/projects/{id}/cron-jobs/{jobId}` | Enable/pause, failure policy | **updates job** | Confirmed | `CronJobsModal.tsx` |
| 68 | POST | `/projects/{id}/cron-jobs/{jobId}/run` | Run now | **executes job** | Confirmed | `CronJobsModal.tsx` |
| 69 | DELETE | `/projects/{id}/cron-jobs/{jobId}` | Delete job | **deletes job** | Confirmed | `CronJobsModal.tsx` |
| 70 | GET | `/projects/{id}/cron-jobs/{jobId}/executions?limit` | Job history | free | Confirmed | `CronJobsModal.tsx` |
| 71 | GET | `/projects/{id}/agent/system-prompt` | v2 settings | free | Confirmed | `V2ProjectSettings.tsx` |
| 72 | PUT | `/projects/{id}/agent/system-prompt` | v2 settings (base64 body) | **updates prompt** | Confirmed | `V2ProjectSettings.tsx` |
| 73 | GET | `/projects/{id}/agent/mcp-servers` | v2 settings | free | Confirmed | `V2ProjectSettings.tsx` |
| 74 | POST | `/projects/{id}/agent/mcp-servers/verify` | Verify custom MCP | outbound tool call | Confirmed | `V2ProjectSettings.tsx` |
| 75 | POST | `/projects/{id}/agent/mcp-servers` | Add MCP | **stores server + headers** | Confirmed | `V2ProjectSettings.tsx` |
| 76 | PATCH | `/projects/{id}/agent/mcp-servers/{mcpId}` | Enable/disable | **updates** | Confirmed | `V2ProjectSettings.tsx` |
| 77 | DELETE | `/projects/{id}/agent/mcp-servers/{mcpId}` | Remove | **deletes** | Confirmed | `V2ProjectSettings.tsx` |
| 78 | GET | `/projects/{id}/api-keys` | API keys modal | free | Confirmed | `ProjectApiKeysModal.tsx` |
| 79 | POST | `/projects/{id}/api-keys` | Create key (returns plaintext once) | **creates credential** | Confirmed | `ProjectApiKeysModal.tsx` |
| 80 | POST | `/projects/{id}/api-keys/{keyId}/rotate` | Rotate | **rotates credential** | Confirmed | `ProjectApiKeysModal.tsx` |
| 81 | DELETE | `/projects/{id}/api-keys/{keyId}` | Revoke | **revokes credential** | Confirmed | `ProjectApiKeysModal.tsx` |
| 82 | POST | `/projects/{id}/preview/rotate-url` | New preview address | **invalidates old URL** | Confirmed | `ProjectApiKeysModal.tsx` |
| 83 | GET | `/projects/{id}/usage?env&groupBy&from&to` | Usage modal | free | Confirmed | `UsageLimitsModal.tsx:72` |
| 84 | GET | `/projects/{id}/limits` | Usage modal; mobile panel | free | Confirmed | `UsageLimitsModal.tsx`, `MobilePanel.tsx` |
| 85 | PUT | `/projects/{id}/limits` | Toggle features / caps | **updates limits** | Confirmed | `UsageLimitsModal.tsx`, `MobilePanel.tsx` |
| 86 | GET | `/projects/{id}/credit-limits` | Usage modal | free | Confirmed | `UsageLimitsModal.tsx` |
| 87 | PATCH | `/projects/{id}/credit-limits` | Set monthly caps | **updates limits** | Confirmed | `UsageLimitsModal.tsx` |

### 3.10 v2 engine — payments, webhook, mobile

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 88 | GET | `/projects/{id}/payments/status?mode=` | Payments modal | free | Confirmed | `PaymentsModal.tsx` |
| 89 | POST | `/projects/{id}/payments/onboarding-link?mode=` | Stripe onboarding | creates Stripe link | Confirmed | `PaymentsModal.tsx` |
| 90 | PUT | `/projects/{id}/payments/mode` | Test/live switch | **updates mode** | Confirmed | `PaymentsModal.tsx` |
| 91 | GET | `/projects/{id}/webhook` | Payments webhook config | free | Confirmed | `PaymentsModal.tsx` |
| 92 | PUT | `/projects/{id}/webhook` | Set webhook URL | **updates** | Confirmed | `PaymentsModal.tsx` |
| 93 | POST | `/projects/{id}/webhook/rotate-secret` | Rotate secret | **rotates credential** | Confirmed | `PaymentsModal.tsx` |
| 94 | GET | `/projects/{id}/mobile/builds` | Mobile panel | free | Confirmed | `MobilePanel.tsx` |
| 95 | POST | `/projects/{id}/mobile/builds` | Start Android/iOS build | **starts build (credits)** | Confirmed | `MobilePanel.tsx` |
| 96 | GET | `/projects/{id}/mobile/stores` | Store connections | free | Confirmed | `MobilePanel.tsx` |
| 97 | GET | `/projects/{id}/mobile/store-uploads` | Upload history | free | Confirmed | `MobilePanel.tsx` |
| 98 | POST | `/projects/{id}/mobile/builds/{buildId}/store-upload` | Upload to store | **store submission** | Confirmed | `MobilePanel.tsx` |
| 99 | POST | `/projects/{id}/mobile/builds/{buildId}/cancel` | Cancel queued build | refunds reserved credits | Confirmed | `MobilePanel.tsx` |
| 100 | GET | `/projects/{id}/mobile/builds/{buildId}/download` | Artifact URL | free | Confirmed | `MobilePanel.tsx` |
| 101 | GET | `/projects/{id}/mobile/builds/{buildId}/log` | Build log URL | free | Confirmed | `MobilePanel.tsx` |
| 102 | PUT | `/projects/{id}/mobile/stores/google-play` | Connect Play (service-account JSON) | **stores credential** | Confirmed | `MobilePanel.tsx` |
| 103 | PUT | `/projects/{id}/mobile/signing/ios` | iOS signing (`.p8`, key id, issuer) | **stores credential** | Confirmed | `MobilePanel.tsx` |
| 104 | PUT | `/projects/{id}/mobile/stores/app-store` | Connect App Store | **stores** | Confirmed | `MobilePanel.tsx` |
| 105 | DELETE | `/projects/{id}/mobile/stores/{store}` | Disconnect store | **deletes** | Confirmed | `MobilePanel.tsx` |
| 106 | GET | `/projects/{id}/mobile/signing/codemagic` | Own build key status | free | Confirmed | `MobilePanel.tsx` |
| 107 | PUT | `/projects/{id}/mobile/signing/codemagic` | BYOK Codemagic token | **stores credential** | Confirmed | `MobilePanel.tsx` |
| 108 | DELETE | `/projects/{id}/mobile/signing/codemagic` | Remove BYOK | **deletes** | Confirmed | `MobilePanel.tsx` |
| 109 | GET | `/projects/{id}/mobile/settings` | Mobile settings | free | Confirmed | `MobilePanel.tsx` |
| 110 | PUT | `/projects/{id}/mobile/settings` | Save settings | **updates** | Confirmed | `MobilePanel.tsx` |

### 3.11 Account-scoped domains (registrar reseller)

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 111 | GET | `/domains` | Domain panel list | free | Confirmed | `ProjectDomainPanel.tsx`, `DomainModal.tsx` |
| 112 | GET | `/domains/search?q=` | Buy panel search | free | Confirmed | `DomainBuyPanel.tsx` |
| 113 | GET | `/domains/contacts` | Buy panel | free | Confirmed | `DomainBuyPanel.tsx` |
| 114 | POST | `/domains/contacts` | Registrant contact form | **creates contact (PII to registrar)** | Confirmed | `DomainContactForm.tsx` |
| 115 | POST | `/domains/purchase` | Buy domain (with `projectId`, `canonicalHost`) | **charges card + registers domain** | Confirmed | `DomainBuyPanel.tsx` |
| 116 | PATCH | `/domains/{domainId}` | Auto-renew toggle | **updates** | Confirmed | `ProjectDomainPanel.tsx` |
| 117 | POST | `/domains/{domainId}/attach` | Attach to project (+ prefix) | **attaches (may charge)** | Confirmed | `ProjectDomainPanel.tsx` |
| 118 | POST | `/domains/{domainId}/detach` | Detach | **detaches** | Confirmed | `ProjectDomainPanel.tsx` |
| 119 | GET | `/domains/{domainId}/dns/records` | DNS table | free | Confirmed | `DomainManager.tsx` |
| 120 | POST | `/domains/{domainId}/dns/records` | Add record | **mutates DNS** | Confirmed | `DomainManager.tsx` |
| 121 | PATCH | `/domains/{domainId}/dns/records/{recordId}` | Edit record | **mutates DNS** | Confirmed | `DomainManager.tsx` |
| 122 | DELETE | `/domains/{domainId}/dns/records/{recordId}` | Delete record | **mutates DNS** | Confirmed | `DomainManager.tsx` |
| 123 | GET | `/domains/{domainId}/forwarding` | Forwarding rules | free | Confirmed | `DomainManager.tsx` |
| 124 | PUT | `/domains/{domainId}/forwarding` | Set forwarding | **mutates** | Confirmed | `DomainManager.tsx` |
| 125 | POST | `/domains/{domainId}/renew` | Renew | **charges card** | Confirmed | `DomainManager.tsx` |
| 126 | POST | `/domains/{domainId}/export` | Transfer-out auth code | **unlocks domain** | Confirmed | `DomainManager.tsx` |
| 127 | POST | `/domains/{domainId}/export/cancel` | Cancel transfer-out | **relocks** | Confirmed | `DomainManager.tsx` |

### 3.12 Account-scoped misc

| # | Method | Path | Trigger / feature | Side effects | Status | Evidence |
|---|---|---|---|---|---|---|
| 128 | GET | `/credit-costs?engine=` | Credit price table for UI copy | free | Confirmed | `CreditsProvider.tsx:22` |

> **Note on count reconciliation.** The inventory above contains **128 numbered rows**, of which row 44 is classified **Unused via catalog** (its path is still reachable through the catch-all — see §9). The headline figure of **127 confirmed active method+path combinations** counts rows 1–43, 45–128 and treats `GET /projects/{id}/database/backups/{backupId}/download` as not confirmed. `PATCH /projects/{id}` (row 5) is confirmed only through `setLiveHostSuffix`, not through the unused `projects.update` catalog entry.

---

## 4. Internal Mavly Routes and Their Totalum Call Chains

Eight API route handlers exist under `src/app/api/`. Seven invoke Totalum infrastructure; one only reports key presence.

| Internal route | Methods | Upstream call(s) | Caller | Auth/ownership gate | Notes |
|---|---|---|---|---|---|
| `/api/vcaas/[...path]` (catch-all) | GET, POST, PUT, DELETE, PATCH | `ALL` catalogued paths → `builder-api.totalum.app/api/v1/vcaas/<path>` | every `vcaasApi.*` JSON call | **none** (no `_shared` import) | Path-containment guard `resolveVcaasUrl` blocks traversal outside `/api/v1/vcaas/` (`vcaas-server.ts:54-72`); 10 s timeout; error normalisation + `INSUFFICIENT_CREDITS` DOM event |
| `/api/vcaas/env/[projectId]` | GET | `GET /projects/{id}/env?env=` | `ProjectApiKeysModal.tsx:65` (raw fetch) | slug format only | Plain-text passthrough (upstream does not use JSON envelope here) |
| `/api/vcaas/source-code/[projectId]` | GET | `GET /projects/{id}/source-code` **then** `fetch(downloadUrl)` of the signed archive | `vcaasApi.sourceCode` → `CodePanel.tsx` | **none** | Server-side ZIP download avoids browser CORS; forwards `x-files-count`, `x-commit-sha` |
| `/api/vcaas/upload/[projectId]` | POST | `POST /projects/{id}/files/upload` (multipart) | `vcaasApi.upload` → `lib/upload.ts` | **none** | Forwards upstream status; `retryable` flag for 5xx/429 |
| `/api/vcaas/git-diff` | GET | **Not the VCaaS API** — fetches the conversation message's signed `gitDiffUrl` (Totalum storage / `*.totalum-project.com`) | `vcaasApi.gitDiff` → `DiffViewer.tsx` | host allowlist + `publicUrlRejectionReason` + `redirect:"error"` + 20 s timeout + 10 MB cap | Totalum-hosted storage dependency |
| `/api/preview/[projectId]/[[...path]]` | GET, POST, PUT, PATCH, DELETE, HEAD | 1) `GET /projects/{id}` (resolve preview origin, memoised 15 s); 2) `fetch` of the **Totalum-hosted sandbox origin** for every asset | workspace preview health checks (`page.tsx:164,923,1106`); visual editor (injects `__totalum-visual-editor.js`) | `resolveVcaasContext` + `enforceProjectScope` — **both no-ops** | Same-origin rewrite for the visual editor; drops `set-cookie`; refuses cross-origin redirects |
| `/api/visual-edit/[projectId]/apply` | POST | `GET files/tree`; N× `GET files/content`; N× `PUT files/content` (base64); optional source-tag install (R/W); `POST /rebuild`; one-time write-fidelity probe (PUT+GET of `.totalum/visual-edit-write-check.txt`) | `VisualEditorPanel` / `use-visual-editor` | `resolveVcaasContext` + `enforceProjectScope` — **both no-ops** | Nothing written until every change resolves; `bytesWritten` fidelity check; asset internalisation with SSRF guard (`publicUrlRejectionReason`) |
| `/api/config` | GET | **None** — reads `getVcaasApiKey().trim().length > 0` | `SetupBanners` / dashboard setup UX | none (by design) | Discloses only a boolean |

**Client-side call sites of the catalog (43 files).** Every `vcaasApi.*` consumer imports `@/lib/vcaas` and never hardcodes `/api/vcaas/...` paths — with three deliberate exceptions: `ProjectApiKeysModal` (env route), `CodePanel` (`sourceCode`), `page.tsx` (preview health fetches). `lib/upload.ts` is the single upload helper.

---

## 5. Totalum SDKs, Environment Variables, and External Services

### 5.1 SDKs and packages

- **No Totalum SDK is installed.** `package.json` contains no `totalum*` package; the lockfile confirms it. The i18n copy references `totalum-sdk` only as *user-facing documentation text* for generated apps (`en-more.ts:662`).
- The client catalog (`src/lib/vcaas.ts`, 1,171 lines) is a hand-written typed wrapper and is a **verbatim copy of totalum-platform's client** (per its header and `AGENTS.md`).

### 5.2 Environment variables

| Variable | Read by | Exposure | Purpose |
|---|---|---|---|
| `TOTALUM_VCAAS_API_KEY` | `vcaas-server.ts:93` (server-only) | **Server-only.** Never `NEXT_PUBLIC_*`; never sent to the browser; injected as `api-key` header server-side | The single account-wide credential for all Totalum calls |
| `VCAAS_API_KEY` | same line (fallback) | server-only | Legacy name, still accepted |
| `TOTALUM_API_URL` | `vcaas-server.ts:20` | server-only | Alternate Totalum origin (origin only; `/api/v1/vcaas` appended here) |
| `TOTALUM_SOURCE_TAGS` | `visual-edit-upgrade.ts:65` | server-side of generated projects | Disables the source-tag webpack loader (`"0"`) — applies to *generated* apps, not Mavly itself |
| `NEXT_PUBLIC_APP_URL` | `proxy.ts:9` | public | CORS allow-list origin (not Totalum, but interacts with `*.totalum-project.com` origins) |

`.env.example` documents the two Totalum variables (lines 1-3). `.env.local` is gitignored (`.gitignore`: `.env*`, `.env*.local`) and was not read.

### 5.3 Totalum-hosted URLs the product depends on

| Host / URL pattern | Role | Where referenced |
|---|---|---|
| `https://builder-api.totalum.app/api/v1/vcaas` | The API | `vcaas-server.ts:20-21` |
| `api-accounts.totalum.app` | Older API host — **comment only, never called** | `vcaas-server.ts:16` |
| `*.totalum-project.com` | Default dev-preview and production hostnames; CORS allow-list; git-diff allowlist | `project-status.ts:331-343`, `proxy.ts:21`, `git-diff/route.ts:22`, `page.tsx:566` |
| `*.webapp-project.com` | Alternate live-host suffix (v2 setting) | `vcaas.ts:905`, `V2ProjectSettings.tsx` |
| `storage.googleapis.com` (signed URLs) | Attachment storage; git-diff text; source archives; visual-edit asset internalisation | `git-diff/route.ts:24`, `visual-edit apply:152-166`, conversation `gitDiffUrl` |
| `https://platform.totalum.app/billing` | "Buy credits" link (operator's own billing page) | `InsufficientCreditsModal.tsx:32`, `DomainBuyPanel.tsx:199` |
| `https://www.totalum.app/totalum-api.md` | API reference (linked, never vendored) | `vcaas.ts:6`, `AGENTS.md` |
| Cloudflare (via Totalum) | Production hosting + Logpush prod logs | `vcaas.ts:816-820` comments |
| Codemagic (via Totalum) | Mobile builds | `vcaas.ts:1034`, `en-more.ts:875` |
| Stripe Connect (via Totalum) | Generated-app payments | `vcaas.ts:1011-1019` |
| name.com (via Totalum) | Domain registrar | `vcaas.ts:1089-1097` comments |

### 5.4 What is Mavly-owned vs Totalum-provided

| Capability | Implemented by |
|---|---|
| Marketing site, login UI, dashboard, workspace shell, all panels/modals | **Mavly** (much of it copied from totalum-platform) |
| Visual-edit engine (`visual-edit*.ts`, ~6.6k LOC), preview agent injection | **Mavly** (originally platform code) |
| Supabase authentication (Google/GitHub OAuth, cookies, session refresh) | **Supabase** (Mavly wiring) |
| API key custody, path containment, error normalisation, wake/credit UX | **Mavly** |
| AI agent, model routing, sandboxes, code execution, builds | **Totalum** |
| Preview + production hosting, custom-domain routing, redirects | **Totalum** (Cloudflare) |
| Project databases (D1/Turso), backups, time-travel, migrations | **Totalum** |
| Logs (dev sandbox + prod Logpush), site analytics | **Totalum** |
| GitHub sync execution, Figma reads, mobile builds, Stripe Connect, domain registrar | **Totalum** |
| Credits ledger and every metered charge | **Totalum** |

---

## 6. Critical Workflow Dependency Maps

### A. User submits a prompt to build a website

`HeroSection`/`BuilderDashboard` textarea → name dialog → **`POST /projects/launch`** (create + agent start + optional Figma, one call; `BuilderDashboard.tsx:443`). On `agent.started === false`, prompt stashed in `sessionStorage` (`vibebuild:pendingPrompt:<id>`) and re-sent by the workspace. With attachments: `POST /projects` → `POST /projects/{id}/files/upload` per file → navigate → workspace auto-submits `POST /projects/{id}/agent/start`. **Fully Totalum-dependent.** Failure handling: launch `warnings[]` surfaced as toasts; taken slug resolved upstream (`requestedProjectId`); `INSUFFICIENT_CREDITS` → global modal event.

### B. A new project is created

Same as A (`launch` or `create`). The returned `projectId` — **not** the requested slug — is the only id used thereafter (`vcaas.ts:356-360`). Engine pinned to `"v2"`. **Fully Totalum-dependent.** No local project record exists in Mavly's Supabase (migration explicitly defers project ownership — `supabase/migrations/01_create_user_profiles.sql`, "NEXT PHASE" comment).

### C. The AI agent generates or edits code

`POST /agent/start` → poll `GET /agent/status` every 10 s (plus v2 `GET /agent/progress` for the timeline) until `done`/`idle` → `GET /projects/{id}` + `GET /agent/full-conversation`. All execution happens in Totalum sandboxes. **Fully Totalum-dependent.** Guards: `pendingRunRef` prevents concluding on a stale terminal status; wake-claim on `SERVER_NOT_READY`.

### D. The generated app preview becomes available

After each finished run the workspace refetches the project and picks the URL named by `developmentUrlFieldToUse`, defaulting to `temporalDevelopmentProjectUrl` (`page.tsx:55-57`, `project-status.ts:206-229`). The iframe points **directly at the Totalum-hosted sandbox** (`*.totalum-project.com`); the same-origin proxy `/api/preview/*` is used only for health probes and the visual editor. First build shows a loader, never the temporal URL (`page.tsx:1304-1320`). **Fully Totalum-dependent** (hosting + URL discovery).

### E. A user makes a follow-up change

Composer → `POST /agent/start` (same project) → poll as in C → preview swap. Run options (`model`/`effort`/`fastMode` legacy; agent tier v2) are sent only when chosen (`optionsForEngine`). **Fully Totalum-dependent.**

### F. A user publishes the generated app

`DeployControl` / menu → `handleDeploy` (`page.tsx:1161-1196`) → `POST /deployments/deploy` → poll `GET /deployments/status` every 10 s → on success: `getPublishedHost` (`{projectId}.totalum-project.com` or `productionProjectUrl`), dialog + chat message; preview reloaded via `waitForPreview` (health checks through `/api/preview/*`). Wake-claim and `SANDBOX_NOT_REACHABLE` blocked-dialog handling in between. **Fully Totalum-dependent** (Cloudflare publishing via Totalum).

### G. A user connects GitHub or exports source

**GitHub:** `GithubModal` / composer button → `GET github/status` → `POST github/connect` (user PAT + repo + direction) → `POST github/pull` → `GET github/pull-status` poll; `GET github/env` for synced env; `DELETE github/connect` to unlink. UI is local; **execution is Totalum** (sandbox-side git).
**Export source:** `vcaasApi.sourceCode(id, "view"|"download")` → internal route → upstream `GET /projects/{id}/source-code` (1 credit) → signed ZIP URL fetched server-side → streamed to browser. `CodePanel` uses `view`; download intent is paid-gated upstream. **Project transfer export/import** (`POST …/export`, `…/import`) moves database + source reference via an `importCode`. **Partially Mavly** (UI, ZIP streaming, fflate decompression), **execution fully Totalum**.

### H. A user accesses project data, files, settings, deployment status

Dashboard: `GET /projects`. Workspace: `GET /projects/{id}` + conversation + github/figma status + rebuild status on mount (`page.tsx:587-618`). Code panel: `files/tree` → `files/content` → `PUT files/content` → `rebuild` + status. More view (v2): the entire database explorer, analytics, cron, API keys, env download, usage/limits, payments, mobile, domain manager — all per §3.8-3.11. **Fully Totalum-dependent.**

### I. Authentication and project-level authorization

**Authentication:** Supabase Auth (Google/GitHub OAuth) — **independent of Totalum**. Session in cookies; `src/proxy.ts` refreshes it and redirects signed-out users from `/dashboard` and `/project/*`. API routes are explicitly *not* session-gated (`proxy.ts:70-75`).
**Project-level authorization:** **not implemented.** `resolveVcaasContext()` and `enforceProjectScope()` are deliberate no-ops (`_shared.ts:48-62`), and the catch-all/upload/source-code/env routes never call them. The only real gate is upstream's answer to the operator's account-wide key: every project the key owns is reachable by every caller of these internal routes. The Supabase migration defers a `projects ↔ user` table to a future "route-hardening phase".

---

## 7. Features Fully Dependent on Totalum

Everything below stops working entirely if Totalum becomes unavailable:

1. Project creation, listing, deletion, rename-grouping, export/import.
2. AI generation and every follow-up edit (the agent itself, model routing, run timeline, conversation persistence).
3. Sandbox lifecycle: wake, archive, restart, pause/resume, runaway release.
4. Live preview hosting and discovery (`temporalDevelopmentProjectUrl` / `cachedDevelopmentUrl` / `preview.temporalLinkUrl`).
5. Code reading/writing as served to the user (files API), rebuilds, version history, version restore, diffs (both `version-diff` and stored `gitDiffUrl`).
6. Production publishing and production logs.
7. Databases: schema, rows, SQL, AI questions, backups, restore points, time-travel, undo-run, provider migration.
8. GitHub sync execution; Figma design reads; attachments storage (signed GCS URLs).
9. Custom domains: purchase, DNS, forwarding, renew, transfer, apex redirect service.
10. Mobile builds, store uploads, signing management (Codemagic/Play/App Store via Totalum).
11. Payments (Stripe Connect), project webhooks, cron jobs, MCP servers, project API keys, site analytics, usage/limits/credit-limits, credit-cost table.
12. Every credit charge and the insufficient-credits gate.

## 8. Features Partially Dependent on Totalum

| Feature | Mavly-owned part | Totalum part |
|---|---|---|
| Visual editor | Entire engine: hit-testing agent, matcher (parsed + source-tag + regex tiers), edit application, verification, source-tag installer, apply route | Reading/writing files, rebuild, asset host |
| Source download/unzip | ZIP streaming route, fflate decompression, Code panel rendering | Archive generation, signed URL, 1-credit metering |
| Git-diff viewer | Proxy with allowlist/SSRF guards, diff parser/renderer | Serving the signed diff text |
| Preview proxy (editor mode) | Origin resolution, HTML/CSS rewrite, agent injection, redirect containment | The sandbox being proxied |
| Attachments | Composer UI, 8 MB client gate, retry policy, history rehydration | Storage, upload endpoint, URL persistence in conversation |
| Authentication | Full Supabase flow (Mavly) | None — Totalum-independent |
| Marketing site, legal pages, i18n shell | Full (Mavly) | None (copy mentions Totalum URLs as marketing content) |
| Error handling / wake UX | `vcaas-errors.ts` normalisation, `use-server-wake`, credit modal event | The underlying error codes and `SERVER_NOT_READY` semantics |

## 9. Legacy, Unused, and Uncertain Integrations

### 9.1 Defined in the catalog but never called (13 methods / 11 path templates)

| Catalog method | Path | Classification | Evidence |
|---|---|---|---|
| `projectGroups.list/get/create/update/remove` (5) | `/project-groups[/{id}]` | **Unused** — no caller in `src/` | full-repo `rg`; only `vcaas.ts:691-723` defines them |
| `webhooks.list/register/remove` (3) | `/webhooks[/{id}]` | **Unused** (an i18n string `webhooks.loadFailed` exists but no UI calls the API) | `en.ts:1238`; no `vcaasApi.webhooks` usage |
| `v2.atLimit` | `GET /projects/credit-limits/at-limit` | **Unused** | `vcaas.ts:1006`; no caller |
| `v2.resendDomainVerification` | `POST /domains/contacts/{id}/resend-verification` | **Unused** | `vcaas.ts:1090`; no caller |
| `v2.backupDownload` | `GET /projects/{id}/database/backups/{backupId}/download` | **Unused via catalog** — see 9.2 | `vcaas.ts:935`; UI uses a different href |
| `projects.update` (PATCH label/description/group) | `PATCH /projects/{id}` | **Partially unused** — the *method* is live via `v2.setLiveHostSuffix`, but the label/description/group patch has no caller | `vcaas.ts:405-409` vs `905-906` |
| `v2.usage` account-level variant (`projectId: null` → `GET /usage`) | `GET /usage` | **Uncertain / effectively unused** — the only caller always passes a `projectId` | `UsageLimitsModal.tsx:72` |

### 9.2 Uncertain / likely broken

- **Backup download link mismatch.** `BackupsPanel.tsx:19-20` builds `/api/vcaas/backup-download/{projectId}/{backupId}` ("the platform's own download route"). No such dedicated route exists in this repo, so the **catch-all** forwards it upstream as `GET /backup-download/{projectId}/{backupId}` — which is **not** in the documented catalog (the catalog path is `GET /projects/{id}/database/backups/{backupId}/download`). Either upstream has an undocumented alias, or the download button 404s. **Cannot be verified without calling the API (forbidden in this audit).** If it works, it is also reachable unauthenticated like every other catch-all path.
- **`api-accounts.totalum.app`** — documented in comments as a legacy alias; never called. Treat as legacy documentation.

### 9.3 Legacy behaviours preserved on purpose

- `VCAAS_API_KEY` env fallback (`vcaas-server.ts:93`).
- `SANDBOX_NOT_REACHABLE` split (`starting` vs `app_error`) and `SERVER_NOT_READY` wake flow — upstream error vocabulary the UI depends on.
- Base64 file writes (`encoding: "base64"`) — a workaround for the upstream global HTML sanitizer; load-bearing (`vcaas.ts:757-777`, visual-edit apply route).
- `windowConversation` server-side paging of `full-conversation` (upstream has no cursor; 1000-message cap).
- Legacy engine support in types (`engineVersion: "legacy"`) although the app always creates `"v2"`.
- Older conversation messages storing `gitDiffUrl` as a bare storage path → git-diff route answers 410 (`git-diff/route.ts:51-63`).

## 10. Security and Authorization Findings

Severity legend: **Critical** = exploitable today for full account takeover of the Totalum surface · **High** = material risk of resource theft or server-side compromise · **Medium** = meaningful weakness with mitigations or limited blast radius · **Low** · **Info**.

### F-1 · CRITICAL — All `/api/*` routes are outside the session gate
**Where:** `src/proxy.ts:70-75` (`requiresSession` returns `false` for every `/api/` path; comment at 65-68 states API protection is a "separate, tracked phase").
**Evidence:** Any request to `/api/vcaas/projects`, `/api/vcaas/projects/{id}/agent/start`, `/api/vcaas/projects/{id}/deployments/deploy`, `/api/vcaas/projects/{id}` (DELETE), etc., is served without a Supabase session.
**Impact:** Anonymous callers who can reach the deployment can enumerate and control every project the operator's key owns, read all source and secrets-adjacent surfaces, and spend credits.
**Remediation (do not implement in this audit):** extend the matcher to require a session for `/api/vcaas/*`, `/api/preview/*`, `/api/visual-edit/*` (keep `/api/config` public if needed); then add real ownership checks per F-2.

### F-2 · CRITICAL — Guards are documented no-ops; no tenant isolation exists
**Where:** `src/app/api/vcaas/_shared.ts:48-62` (`resolveVcaasContext` always `{ok:true}`; `enforceProjectScope` always `null`). Additionally, the catch-all, upload, source-code, and env routes **never call the guards at all** (imports absent — verified). Only preview and visual-edit apply call them, where they no-op.
**Evidence:** one `TOTALUM_VCAAS_API_KEY` acts for every visitor; `supabase/migrations/01_create_user_profiles.sql` explicitly defers a `projects ↔ user` table.
**Impact:** Even after adding login, every signed-in user would share one Totalum account with cross-user read/write on all projects (the exact failure `AGENTS.md` and `_shared.ts` warn about).
**Remediation:** implement the two guards against Supabase session + a `projects(owner_id)` table; wire them into **every** Totalum-invoking route including the catch-all; backfill ownership.

### F-3 · HIGH — Credit-spending and destructive endpoints are callable without any authorization
**Where:** catalog rows 4, 6-8, 11, 14, 16, 21, 32, 36, 38, 52, 58-63, 95, 115, 125 (launch, delete, export/import, agent start, server start, deploy, recover, file write, rebuild, DB migrations/backups/restores, mobile builds, domain purchase, renew).
**Evidence:** no auth on the chain (F-1/F-2); the catch-all forwards any method/path under `/api/vcaas/`.
**Impact:** direct financial abuse (credits, card-on-file domain purchases/renewals) and irreversible data loss (import wipes target; delete removes projects).
**Remediation:** as F-1/F-2, plus an explicit server-side credit/plan gate and confirmation requirements mirrored from the UI.

### F-4 · HIGH — Unvalidated server-side fetch of an upstream-returned URL (source-code route)
**Where:** `src/app/api/vcaas/source-code/[projectId]/route.ts:44` — `const zipRes = await fetch(downloadUrl);` then `await zipRes.arrayBuffer()`.
**Evidence:** no `publicUrlRejectionReason`, no `redirect: "error"`, no `AbortSignal.timeout`, no size cap. Contrast with the hardened git-diff route (`git-diff/route.ts:80-90`) and visual-edit asset fetch (`apply/route.ts:369-377`).
**Impact:** if the upstream response were ever manipulated (or a future upstream bug returned an attacker-influenced URL), the Mavly server would fetch it with full egress, follow redirects into private ranges, and buffer an unbounded body (memory exhaustion). The URL is not directly user-controlled today, which is why this is High rather than Critical.
**Remediation:** apply the same guard stack as git-diff (scheme/host check via `publicUrlRejectionReason`, `redirect:"error"`, timeout, `content-length` + streamed cap).

### F-5 · MEDIUM — No rate limiting or quota on internal proxies
**Where:** all eight API routes; no limiter present anywhere in `src/`.
**Impact:** amplifies F-1/F-3 (credit drain, upload spam, agent-run spam) and provides a free egress proxy (git-diff) and preview proxy.
**Remediation:** per-session and per-IP limits at the edge or in the routes; per-user credit ledger (boilerplate-mode plan §Payments).

### F-6 · MEDIUM — Catch-all proxies the entire present-and-future VCaaS surface with the operator key
**Where:** `src/app/api/vcaas/[...path]/route.ts` forwards any path; only containment to `/api/v1/vcaas/` is enforced (`vcaas-server.ts:54-72`).
**Impact:** any endpoint Totalum ever adds — including account/billing surfaces outside the catalog if containment were ever relaxed — is instantly reachable by Mavly users. The containment guard is strong (URL-resolved check, encoded-traversal refusal) and is the main control.
**Remediation:** replace the catch-all with an explicit allow-list of the 127 confirmed paths (the catalog already enumerates them).

### F-7 · MEDIUM — Git-diff proxy can fetch arbitrary content on allowlisted hosts
**Where:** `git-diff/route.ts:20-35` allowlists `*.totalum.app`, `*.totalum-project.com`, `*.webapp-project.com`, `storage.googleapis.com`; any customer app on those hosts serves attacker-written content.
**Mitigations present:** HTTPS-only, `publicUrlRejectionReason` (DNS + private-range), `redirect:"error"`, 20 s timeout, 10 MB cap, text-only rendering (no `dangerouslySetInnerHTML` in `DiffViewer`).
**Residual risk:** content spoofing (diff text is trusted enough to render), minor SSRF surface on the allowlist.
**Remediation:** restrict to the exact signed-URL host pattern observed in conversation messages; consider HMAC/signed URL validation.

### F-8 · MEDIUM — Backup-download href targets an unverified upstream path (functional + security overlap)
**Where:** `BackupsPanel.tsx:19-20` → catch-all → `GET /backup-download/{projectId}/{backupId}` (see §9.2).
**Impact:** likely broken feature; if the alias exists upstream it is unauthenticated like F-1.
**Remediation:** switch the UI to the catalogued `GET /projects/{id}/database/backups/{backupId}/download` via a dedicated streaming route with auth (mirroring source-code), or fix the href after verifying upstream.

### F-9 · MEDIUM — Preview proxy is a general same-origin reverse proxy to sandbox origins
**Where:** `preview/[projectId]/[[...path]]/route.ts`.
**Mitigations present:** origin resolved server-side from `GET /projects/{id}` (never from the request), memoised per `accountUserId:projectId`, cross-origin redirects refused, `set-cookie` stripped, hop-by-hop headers stripped, agent served from our origin.
**Residual risk:** with F-1/F-2 open, it is an unauthenticated reader of every project's running app; also forwards POST bodies (form submissions) into the sandbox.
**Remediation:** session + ownership gate (F-1/F-2).

### F-10 · LOW — `/api/config` discloses key presence
**Where:** `config/route.ts:7-11`. Boolean only; no secret. Acceptable for setup UX; document it.

### F-11 · LOW — Error messages and logs echo upstream text
**Where:** catch-all maps 401/403 to operator-facing copy naming the env var (`[...path]/route.ts:72-85`); `console.error` of proxy failures (line 123) and visual-edit asset failures. No credentials observed in any message path; upstream messages are described in `vcaas-errors.ts` as never containing credentials. Residual risk: upstream message content is uncontrolled.

### F-12 · INFO — Split-brain security model (pages protected, API not)
Documented as intentional ("this phase does not make them more open, and does not close them either" — `proxy.ts:65-68`). Correct as a snapshot of a tracked phase; unacceptable as a production posture. This finding is the umbrella for F-1/F-2.

**Security findings by severity: Critical 2 (F-1, F-2) · High 2 (F-3, F-4) · Medium 5 (F-5, F-6, F-7, F-8, F-9) · Low 2 (F-10, F-11) · Info 1 (F-12) = 12 findings.**

## 11. Source-Code Ownership and Export Considerations

**What Mavly owns in this repository:**
- The entire Next.js UI, the visual-edit subsystem, the proxy/guard plumbing, error normalisation, wake/credit UX, Supabase auth wiring, i18n dictionary (copied from totalum-platform under that project's terms — the open repo itself is MIT per `AGENTS.md`).
- **Not** the generated applications' code at rest: those live on Totalum sandboxes/GCS and are reachable only through Totalum APIs.

**Export paths that exist today (all metered by Totalum):**
1. **View/download source archive** — 1 credit per call, either intent (`vcaas.ts:1126-1141`). Download intent is refused on free plans upstream.
2. **GitHub connect + push/pull** — the durable, code-owner path; requires a paid plan upstream (`PLAN_REQUIRED` gate noted in `vcaas.ts:539-540`).
3. **Project export (`…/export`, 2 credits)** — database + source reference → secret `importCode`; import into another project costs 6 credits and is destructive.

**Ownership risks to weigh before migration:**
- Databases, cron jobs, secrets, payments accounts, domains, and mobile signing material are all stored **by Totalum**, not exportable through any endpoint found in this catalog. Leaving Totalum without a replacement strands them unless upstream provides out-of-band extraction (not visible in this repo).
- Conversation history (including attachment URLs and stored git diffs) is upstream-persisted; `full-conversation` is readable but is the only export surface found.
- Credit balances, plan state, and billing relationships are Totalum-account-level and not portable via VCaaS.
- The operator's single key is the identity of everything; there is no per-user Totalum identity to migrate *from*.

## 12. Migration Blockers and Recommended Priorities

**Blockers, hardest first:**

1. **The agent + sandbox engine** — no local equivalent exists; this is the product. Requires: an LLM agent loop (planner/editor), per-project containers/VMs with build+serve, file store, git commits for versions, and status/progress streams matching `agent/status` + `agent/progress` semantics.
2. **Hosting plane** — dev previews (`temporalDevelopmentProjectUrl` semantics, archive-snapshot recommendation protocol in `project-status.ts`) and production publishing to a CDN with custom-domain routing and the apex-redirect service.
3. **Database plane** — D1/Turso-equivalent with schema/rows/SQL/AI-query, backups, restore points, time-travel, undo-run, provider migration.
4. **Credits & metering** — every write path assumes upstream credit gates (`INSUFFICIENT_CREDITS`, per-endpoint costs). A replacement needs its own ledger or the UI's credit UX must be rewired.
5. **Contract surface** — 127 method+path combos, ~60 upstream error codes normalised in `vcaas-errors.ts`, wake protocol (`SERVER_NOT_READY` + `ensureServerActive` auto-start semantics), sanitizer-driven base64 write protocol, conversation paging window, `developmentUrlFieldToUse` recommendation protocol. These are undocumented-in-repo behaviours pinned by comments and tests.
6. **Tenancy** — must be built regardless (F-1/F-2); migration is the natural moment to make `projects ↔ user` real.
7. **Copied platform code** — many workspace components are verbatim from `totalum-platform`; confirm licence/provenance before relicensing as a Mavly-owned product (the open template is MIT; the platform itself was not inspected).

**Recommended priorities (evidence-based, ordered):**

| Priority | Action | Why first |
|---|---|---|
| P0 | Close F-1/F-2: session-gate `/api/*`; implement real `resolveVcaasContext`/`enforceProjectScope`; add `projects(owner_id)` table; wire guards into the catch-all, upload, source-code, env routes | Independent of Totalum migration; the app is unsafe on a public URL today |
| P0 | Fix F-4 (source-code fetch guard) and F-8 (backup download) | Small, local, high-value hardening |
| P1 | Freeze `src/lib/vcaas.ts` as the seam: generate an interface from the catalog; add contract tests with recorded fixtures; introduce an adapter indirection in `vcaas-server.ts` | Makes every later swap mechanical; the choke point already exists |
| P1 | Write an operational spec of upstream behaviours actually relied upon (error codes, credit costs, polling cadences, wake protocol, URL recommendation protocol) from the evidence in this repo | Prevents silent breakage when any component is replaced |
| P2 | Replace hosting/preview plane behind the `getPreviewUrl` seam | Smallest fully-isolated Totalum subsystem with a clean seam (`project-status.ts`) |
| P2 | Replace file store + rebuild + versions behind `files/*` + `rebuild/*` | Required before any local agent can operate on real projects |
| P3 | Replace agent/sandbox engine behind `agent/*` | The core; do last, with the most tests |
| P3 | Replace database plane behind `database/*` | Large but well-isolated by the v2 panels |
| P4 | Domains, mobile, payments, GitHub execution, analytics, cron | Niche, mostly account-configured; can stay on Totalum longest |
| P5 | Decommission: remove key, migrate surviving projects via export/GitHub, delete proxy | Only after P2-P4 |

## 13. Files Inspected and Areas That Could Not Be Verified

**Inspected (all under `src/` unless noted):**
- API routes (all 8): `api/config`, `api/preview/[projectId]/[[...path]]`, `api/vcaas/[...path]`, `api/vcaas/_shared`, `api/vcaas/env/[projectId]`, `api/vcaas/git-diff`, `api/vcaas/source-code/[projectId]`, `api/vcaas/upload/[projectId]`, `api/visual-edit/[projectId]/apply`.
- Totalum layer: `lib/vcaas.ts` (full), `lib/vcaas-server.ts` (full), `lib/vcaas-types.ts` (endpoint-relevant types), `lib/vcaas-errors.ts` (full).
- Workflow surfaces: `app/project/[projectId]/page.tsx` (polling, send, deploy, restore, wake, mount), `components/builder/BuilderDashboard.tsx` (launch/create/figma/upload), `components/workspace/use-server-wake.ts` (full), `DeployControl`, `VersionsModal`, `DiffViewer`, `CodePanel`, `LogsPanel`, `PathPicker`, `SecretsModal`, `GithubModal`, `FigmaModal`, `DomainModal`, `DomainBuyPanel`, `ProjectTransferDialogs`, `RunActivity`, `InsufficientCreditsModal`, `SetupBanners`, `credits/CreditsProvider`, `prompt/GithubPromptButton`, `settings/DomainManager`, `settings/DomainContactForm`, all `workspace/v2/*` and `workspace/database-v2/*` consumers of `vcaasApi`.
- Support libs: `lib/upload.ts`, `lib/project-status.ts`, `lib/project-slug.ts`, `lib/preview-health.ts`, `lib/visual-edit-agent.ts`, `lib/visual-edit-upgrade.ts`, `lib/site-analytics.ts`, `lib/run-progress.ts`, `lib/agent-progress.ts`, `lib/db-backups.ts`, `lib/project-operation.ts`, `lib/safe-url.ts` (referenced), `lib/api.ts`.
- Auth (cross-check only): `proxy.ts` (full), `lib/supabase/*`, `app/auth/*`, `lib/auth/*`, `supabase/migrations/01_create_user_profiles.sql`.
- Config/meta: `package.json`, `package-lock.json` (search), `next.config.ts`, `vercel.json`, `.env.example`, `.gitignore`, `AGENTS.md`, `README.md` (head), `AUDIT.md` (head), `ROUTE_AUDIT.md` (head), `tests/*` (Totalum references), `.github/` (asset only), `.aistudio/` (empty), `supabase/`.

**Could not be verified:**
- Live upstream route existence/semantics (no API calls permitted), including the `/backup-download/...` alias question.
- Contents of `.env.local` (deliberately not read).
- `totalum-platform` source (absent) — verbatim-copy claims rest on in-repo comments.
- Runtime behaviour of polling/wake/publish against a real project (static analysis only).
- The working tree was clean at audit start (`git status` empty at commit `bdc1b3e`); no delta was skipped.

## 14. Final Dependency Summary

### Counts

| Metric | Count | Notes |
|---|---|---|
| Unique confirmed endpoint **method + path** combinations | **127** | Inventory rows 1-43 + 45-128 (row 44 excluded as unused-via-catalog) |
| Unique confirmed endpoint **path templates** | **102** | Deduplicated across methods |
| Path templates defined in the catalog (incl. unused) | **110** | +8 unused-only templates (`/project-groups` ×2, `/webhooks` ×2, `/projects/credit-limits/at-limit`, `/domains/contacts/{id}/resend-verification`, `/usage`, `/projects/{id}/database/backups/{id}/download`) |
| Uncertain forwarded path outside the catalog | **1** | `GET /backup-download/{projectId}/{backupId}` (§9.2) |
| Internal Mavly routes that invoke Totalum | **7 of 8** | Catch-all, env, source-code, upload, git-diff (storage), preview, visual-edit apply; `/api/config` does not |
| Confirmed **direct** integrations (one upstream call per internal request, via catalog → catch-all or dedicated route) | **120** of the 127 method+path combos | Excludes the 7 server-composed routes' internals |
| Confirmed **indirect / server-composed** integrations | **7 internal routes** covering **13** upstream combos | Preview origin GET; visual-edit (tree/reads/writes/rebuild/probe); source-code (meta+archive); env; upload; git-diff storage fetch; probe write fidelity |
| Critical workflows depending on Totalum | **8 of 9** | A-H fully; I: auth is Supabase, authorization is absent (not "dependent" — "missing") |
| Catalog methods unused | **13** | §9.1 |
| Security findings by severity | **Critical 2 · High 2 · Medium 5 · Low 2 · Info 1 = 12** | F-1..F-12; F-8 and F-9 both Medium; F-10 and F-11 are the two Lows |

### The five most important dependencies to address first

1. **`POST /projects/launch` + `POST /projects/{id}/agent/start` + `GET .../agent/status`** — the generative core; without a replacement there is no product.
2. **The key-holding proxy pair (`lib/vcaas-server.ts` + `api/vcaas/[...path]`)** — the single choke point for key custody, path containment, and (when implemented) tenancy; every migration step funnels through it.
3. **Preview URL protocol (`GET /projects/{id}` → `developmentUrlFieldToUse`/`temporalDevelopmentProjectUrl` + `*.totalum-project.com` hosting)** — how every generated app is seen; also the visual editor's origin source.
4. **`POST /deployments/deploy` + `GET /deployments/status` + prod logs** — the publish pipeline and the only production-hosting dependency.
5. **The `database/*` v2 surface (schema/rows/sql/backups/restore/time-travel/undo-run)** — all persistent data of every generated app lives in Totalum-hosted D1/Turso and is not exportable through any endpoint found here.

### Prioritized migration plan (summary)

**P0 (now, independent of Totalum):** close the API auth gap (F-1/F-2), harden source-code fetch (F-4), fix backup download (F-8).
**P1:** freeze `vcaas.ts` as a tested seam; document the upstream contract actually relied upon.
**P2:** replace hosting/preview and files/rebuild/versions behind their existing seams.
**P3:** replace the agent/sandbox engine and the database plane.
**P4:** replace or retire domains, mobile, payments, GitHub execution, analytics, cron.
**P5:** decommission Totalum, remove the key, migrate residual projects via GitHub/export.

---

### Completion statement

This audit is complete and saved at `TOTALUM_API_DEPENDENCY_AUDIT.md`. **No application source file, configuration, environment variable, authentication setting, database schema, or deployment configuration was created, modified, deleted, moved, or renamed. No Totalum or production API was called. No secret was read or reproduced.** Areas that could not be inspected are listed in §13 (live upstream behaviour, `.env.local`, the `totalum-platform` source, and runtime verification). **Do not begin migration work until this report is approved.**
