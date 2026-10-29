# Runbook — live runtime preview sandbox (Phase 13)

The live preview runs an existing React + Vite project's real Vite dev server in
an isolated E2B sandbox. It is **off by default**, **globally enabled once the
deployment flag is on**, and unrelated to the Phase 3/4 verification sandbox and
to production hosting.

## 1. Prerequisites

- Migration `34_runtime_sandboxes.sql` applied after 33.
- A server-only E2B API key with sandbox-create permission.
- An E2B template that provides **Node 20+ and npm on `PATH`**. The config default
  is `base`; if `base` lacks `npm`, set `MAVLY_RUNTIME_SANDBOX_TEMPLATE` to a
  template that does. The code does not install Node.
- `NEXT_PUBLIC_SUPABASE_URL` configured (already required by the app).
- The project is a **React + Vite** website project whose persisted files include
  `package.json` (react + vite), a root `index.html` with a local module entry,
  and that entry module. Android, Next.js, SvelteKit and other frameworks return
  `RUNTIME_SANDBOX_UNSUPPORTED` with an exact reason.
- For QA/Security evidence and the worker expiry sweep, the project must also be
  in the durable worker cohort and the deployment must have
  `SUPABASE_SERVICE_ROLE_KEY`.

There is **no per-project allowlist**. Ownership/RLS, the deployment flag, the
framework detector, the per-user sandbox cap and the lifetime/install limits are
the actual controls. `MAVLY_RUNTIME_SANDBOX_PROJECTS` is an optional temporary
restriction only.

## 2. Enable

```bash
MAVLY_RUNTIME_SANDBOX_ENABLED=1
E2B_API_KEY=...                    # server-only
# Optional: restrict to a named subset (empty or `*` = every eligible project)
# MAVLY_RUNTIME_SANDBOX_PROJECTS=
# Optional defaults:
# MAVLY_RUNTIME_SANDBOX_TEMPLATE=base
# MAVLY_RUNTIME_SANDBOX_PORT=5173
# MAVLY_RUNTIME_SANDBOX_MAX_LIFETIME_SECONDS=1800
# MAVLY_RUNTIME_SANDBOX_IDLE_SECONDS=600
# MAVLY_RUNTIME_SANDBOX_INSTALL_TIMEOUT_SECONDS=120
# MAVLY_RUNTIME_SANDBOX_STARTUP_TIMEOUT_SECONDS=60
# MAVLY_RUNTIME_SANDBOX_MAX_ACTIVE_PER_USER=2
# MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE=1
# MAVLY_RUNTIME_SANDBOX_QA_BUILD=1
```

A misconfigured deployment shows the static preview plus a truthful
`RUNTIME_SANDBOX_NOT_CONFIGURED` message; it never creates a sandbox.

## 3. Human-run smoke test

The repository's policy forbids the coding agent from running these. A human
operator must:

1. Open any owned React + Vite project in the workspace.
2. Press **Start live preview**.
3. Confirm the status moves through `Preparing`, `Copying project files`,
   `Installing dependencies`, `Starting Vite dev server`, then `Live sandbox
   runtime` — and only after readiness.
4. Open the **Logs** panel; confirm install/Vite output is visible and contains
   no `e2b_…`, `sk-…`, bearer token, JWT or URL.
5. Press **Restart**; confirm the old process is stopped, not duplicated.
6. Reload the page; confirm the same session is reused and no second install
   starts.
7. Press **Stop**; confirm the provider sandbox is deleted and a second Stop says
   stopped/already stopped.
8. With `MAVLY_RUNTIME_SANDBOX_QA_BUILD=1`, press **Build** on a ready session;
   confirm the check reports `passed`/`failed` from the actual command, and that
   a failed build is not shown as a passing preview.
9. In the database, confirm the row reaches `ready` only with
   `provider_sandbox_id`, `port` and `preview_url` set.

If a real start cannot be performed (no E2B key), report the feature as
**unverified**, not working.

## 4. Observability

Look for `[runtime-sandbox]` lines:

- `sandbox.created` — provider sandbox request accepted.
- `sandbox.sync.completed` — authoritative files copied (counts/bytes only).
- `sandbox.install.completed` / `sandbox.command.failed` — exit code and duration.
- `sandbox.server.started` — background Vite PID exists.
- `sandbox.ready` — readiness probe answered 2xx/3xx.
- `sandbox.start_failed` — a specific failure class.
- `sandbox.expired` — lifetime, idle or sweep expiry.
- `sandbox.stopped` — owner stop finalized.

The DB row carries `state`, `failure_code`, `failure_reason`, `install_ms`,
`startup_ms`, `command_count`, `diagnostics` (including `healthHttpStatus`,
`devPid`, `egressRestricted`) and bounded `logs`.

Suggested alerts:

- `sandbox.start_failed` rate above ~10% for an hour.
- `INSTALL_TIMEOUT`/`STARTUP_TIMEOUT` recurring for one project.
- `PROVIDER_RATE_LIMITED` or `not_configured` from the provider.
- `expire_runtime_sandboxes` errors in the worker tick.
- Active rows older than their lifetime (sweep not running).

## 5. Failure handling

| Symptom | Meaning | Action |
|---|---|---|
| `RUNTIME_SANDBOX_NOT_CONFIGURED` | flag/key/Supabase URL missing or invalid | fix configuration; nothing was created |
| `MIGRATION_REQUIRED` | migration 34 missing | apply it; start fails before provider work |
| `RUNTIME_SANDBOX_UNSUPPORTED` | not a supported React+Vite project | keep static preview; do not force-install Vite |
| `RUNTIME_SANDBOX_BUSY` | a start is already in flight for this project | wait; the route polls the same row |
| `PROVIDER_CREATE_FAILED` / `PROVIDER_RATE_LIMITED` | E2B rejected creation | check key/quota; retry by hand once, no automatic loop |
| `SYNC_INCOMPLETE` | required files exceeded limits or were excluded | inspect `diagnostics.skippedFiles`; raise limits only deliberately |
| `SYNC_FAILED` | provider write failed | check provider status; retry |
| `INSTALL_FAILED` | npm exited non-zero | read bounded logs; the project is likely missing/broken dependencies |
| `INSTALL_TIMEOUT` | install exceeded 420 s or the configured limit | investigate size/network; do not raise blindly |
| `DEV_SERVER_START_FAILED` | background command rejected | check template has Vite installed after npm install |
| `DEV_SERVER_EXITED` | Vite exited before readiness | read logs; often a syntax/config error |
| `STARTUP_TIMEOUT` | no 2xx/3xx within the startup limit | check `healthHttpStatus` and logs |
| `PREVIEW_HOST_INVALID` | provider returned a host Mavly will not embed | verify E2B domain/defaults |
| `EXPIRED` / `PROVIDER_EXPIRED` | lifetime elapsed or provider lost it | press Start; it rebuilds from persisted files |

A failure is terminal for that session. It never changes the generation run,
checkpoints, images, credits or deployment state.

## 6. Pause, drain and rollback

- **Pause new sandboxes**: unset `MAVLY_RUNTIME_SANDBOX_ENABLED` (or set an
  explicit restriction list). Existing rows stay readable; the workspace falls
  back to static.
- **Drain running sandboxes**: press Stop for each project, or let the worker's
  expiry sweep destroy them. The sweep is safe to run with the flag off only if
  you call it directly; the worker skips it when the flag is off.
- **Rollback the app**: unset the flag and redeploy the previous build. Migration
  34 is additive; leaving it applied is safe. Do not drop the table while rows
  are live.
- **Rotate the E2B key**: replace `E2B_API_KEY`, redeploy, then stop existing
  sandboxes. A sandbox created with the old key is still reachable only until it
  expires or is stopped.

## 7. Quotas and cost

- One active sandbox per project; 2 per user by default (1–5).
- Lifetime 1800 s by default (max 3600); idle 600 s.
- Sync 400 files / 256 KiB per file / 4 MiB total by default.
- Install 120 s, startup 60 s (fits the 300 s start route), build 240 s by default.
  Raising the install/startup limits can make the synchronous Start request time out
  on the serverless function before the sandbox reaches `ready`.
- E2B spend is infrastructure cost, separate from Mavly credits and image spend.
  There is no per-sandbox billing, price or credit settlement in this phase.
- Do not raise quotas to claim capacity for many concurrent users. The provider
  account's own limits apply and are unverified here.

## 8. Known limitations

- React + Vite only. No Next.js, backend server, database or arbitrary framework.
- Debug/preview only: no production build is implied by `ready`, and no
  deployment is authorized by a running preview.
- No sandbox writeback to `project_files`.
- The E2B preview host is public by URL unless the provider project configures
  otherwise; Mavly does not proxy it. Do not describe a preview as private.
- Sandbox expiry destroys installed dependencies; a restart reinstalls them.
- The full path has not been exercised live by the coding agent. Treat the first
  operator smoke test as the acceptance gate.
