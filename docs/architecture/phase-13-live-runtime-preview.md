# Phase 13 — Live runtime preview sandbox (E2B)

Status: **implemented, off by default, and not executed against a live E2B
account in this repository.** The code, migration and unit tests exist; no real
sandbox, install, dev server or preview was created while writing it. See
“Unverified” at the end before treating any of it as production-ready.

This phase adds one capability: **for a generated React + Vite project, run the
real Vite development server in an isolated E2B sandbox and show it in the
workspace**, with bounded install/start/readiness steps, authenticated
diagnostics and real runtime evidence for QA, Security and Repair.

It does not replace the generation engine, the static preview, the verification
sandbox, hosting, images, credits or the seven-agent role mapping.

## 1. What is authoritative

| Concern | Authority |
|---|---|
| Project source | `project_files`, written only by `generateApp` |
| Generation job, lease, checkpoints | `project_runs` / `project_run_batches` |
| Browser preview | `/api/preview/{id}` (static) — unchanged |
| Verification (`passed`) | `project_verifications` (Phase 3/4) — unchanged |
| Live preview lifecycle | `project_runtime_sandboxes` (migration 34, this phase) |
| Provider key | server-only `E2B_API_KEY` |
| E2B sandbox filesystem | disposable copy, never authoritative |

The sandbox is a **runtime**, not a source of truth. Nothing the sandbox writes
(installed packages, caches, build output, edits) reaches `project_files`. If the
sandbox expires, it is rebuilt from the current persisted files.

## 2. Configuration and rollout

Off unless the deployment prerequisites are present:

```
MAVLY_RUNTIME_SANDBOX_ENABLED=1
E2B_API_KEY=<server-only key>
NEXT_PUBLIC_SUPABASE_URL=<project url>
# OPTIONAL temporary restriction; empty or `*` = every eligible project
# MAVLY_RUNTIME_SANDBOX_PROJECTS=<explicit project ids>
```

There is no per-project allowlist by default. Every project the caller owns is
eligible when the persisted files are a supported React + Vite app; ownership,
RLS, the framework detector and the per-user/lifetime limits are the controls.

Optional, bounded:

| Variable | Default | Range |
|---|---|---|
| `MAVLY_RUNTIME_SANDBOX_TEMPLATE` | `base` | E2B template name |
| `MAVLY_RUNTIME_SANDBOX_PORT` | `5173` | 1024–65535 |
| `MAVLY_RUNTIME_SANDBOX_MAX_LIFETIME_SECONDS` | `1800` | 120–3600 |
| `MAVLY_RUNTIME_SANDBOX_IDLE_SECONDS` | `600` | 60–lifetime |
| `MAVLY_RUNTIME_SANDBOX_INSTALL_TIMEOUT_SECONDS` | `120` | 30–420 |
| `MAVLY_RUNTIME_SANDBOX_STARTUP_TIMEOUT_SECONDS` | `60` | 20–180 |
| `MAVLY_RUNTIME_SANDBOX_MAX_FILES` | `400` | 10–1000 |
| `MAVLY_RUNTIME_SANDBOX_MAX_FILE_BYTES` | `262144` | 1024–2 MiB |
| `MAVLY_RUNTIME_SANDBOX_MAX_TOTAL_BYTES` | `4194304` | 16 KiB–16 MiB |
| `MAVLY_RUNTIME_SANDBOX_MAX_ACTIVE_PER_USER` | `2` | 1–5 |
| `MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE` | off | shares runtime evidence with QA/Security |
| `MAVLY_RUNTIME_SANDBOX_QA_BUILD` | off | enables the one approved `vite build` action |

A malformed limit is **rejected** (fallback used, `invalid_limit` reported), not
silently clamped to a different value. A half-configured deployment fails closed
with `RUNTIME_SANDBOX_NOT_CONFIGURED` and the workspace keeps the static preview.

Production runs are dispatched to the platform-wide durable worker, which is the
execution context for QA/Security evidence. Local and preview runs remain inline;
the runtime route itself does not depend on a worker project allowlist.

Migration **34** creates the table, RPCs, RLS and schema marker. It is additive
and safe to apply while the previous application version is live.

## 3. SDK and adapter

`package.json` pins `e2b@^2.62.0`; `package-lock.json` resolves `e2b@2.62.0`.
The SDK is loaded lazily by `src/lib/runtime-sandbox/provider.ts`, so tests and
deployments with the flag off never import it.

`src/lib/runtime-sandbox/e2b-provider.ts` is the only file that touches the SDK.
It implements the typed `RuntimeSandboxProvider` surface:

| Mavly operation | E2B SDK call (`2.62.0`) |
|---|---|
| create | `Sandbox.create({ template, timeoutMs, metadata, apiKey })` |
| connect | `Sandbox.connect(id, { apiKey, timeoutMs? })` |
| liveness | `sandbox.isRunning()` |
| write files | `sandbox.files.makeDir` + `files.write([{ path, data }])` |
| remove files | `sandbox.files.remove(path)` |
| run bounded command | `sandbox.commands.run(cmd, { cwd, timeoutMs })` |
| background server | `sandbox.commands.run(cmd + redirect, { background: true, timeoutMs: 0 })` → `pid` |
| process list / kill | `sandbox.commands.list()` / `commands.kill(pid)` |
| read log | `files.exists` + `files.read(path)` (text) |
| preview host | `sandbox.getHost(port)` |
| deny egress | `sandbox.updateNetwork({ denyOut: ["0.0.0.0/0"] })` |
| destroy | `sandbox.kill()` |

Every call is wrapped by `guard()`: a provider exception becomes one of
`not_found`, `timeout`, `rate_limited`, `invalid_input`, `not_configured` or
`provider_error` with a **fixed message**. Provider bodies, request URLs and the
API key never reach a route, the database or a log.

`Sandbox.connect` reuses a persisted sandbox by id. Mavly never keeps an SDK
object in memory across requests; every operation reconnects with the server key.

## 4. Lifecycle

```
provisioning → syncing → installing → starting → ready
                                      ↘ failed
any active state → stopping → stopped
any active state → expired
```

`ready` requires **all** of: a validated dev-server PID, a provider-reported port,
a server-validated E2B preview host, and a server-side request to that host
returning 2xx/3xx. A submitted command is never readiness.

The transition table exists twice and both reject the same jumps:

* `canTransitionRuntimeState` in `types.ts` (service);
* `runtime_sandbox_transition_allowed` in migration 34 (database).

`ready` is reachable only from `starting`; a terminal state is final and a late
provider response cannot resurrect it (`RUNTIME_SANDBOX_TERMINAL`).

One active row per project is enforced by a partial unique index plus a
transaction-scoped advisory lock in `begin_runtime_sandbox`. Two concurrent
Start clicks resolve to one row (the second is `RUNTIME_SANDBOX_BUSY`), never two
installs or two dev servers. A fresh start older than three minutes is abandoned
explicitly (row `failed`, `STALE_START`) rather than duplicated.

Reconnect is a GET: the owner-visible row holds the validated preview URL, port
and checks. Expiry is reconciled on read (`expires_at` elapsed → `expired`) and
by the worker's bounded `expire_runtime_sandboxes` sweep, which also destroys the
provider sandbox. Stop is idempotent: kill the recorded PID, destroy the sandbox,
finalize `stopped`; a second stop is `already_stopped`.

## 5. File synchronisation

`paths.ts` is the boundary:

* relative POSIX paths only; absolute paths, `..`, backslashes, NUL bytes and
  unsafe characters are refused;
* `.env*`, `.npmrc`, `.git`, `node_modules`, `.next`, build output, caches,
  lockfile-adjacent binaries, keys, keystores, APK/AAB and native libraries are
  excluded;
* per-file and total byte caps and a file-count cap are enforced;
* every skipped file is reported; a skipped `package.json`/`index.html` fails the
  start instead of producing an unexplainable Vite error;
* only paths Mavly previously synced are removed on resync, so a file the sandbox
  created is never deleted by accident.

The file list comes from `listFiles(projectId, client)` through the caller's RLS
client. The generated-source hash (`sha256` over sorted path+content) decides
reuse: a ready sandbox with the same hash is reused and its expiry extended; a
changed hash requires an explicit Restart, which stops and rebuilds. Sandbox
writeback is **not implemented**: source changes only enter through `generateApp`.

## 6. Supported projects and commands

Detection uses persisted files, not the planner's claim:

* the declared framework is classified **first**: `next`, `nuxt`,
  `@sveltejs/kit`, `astro`, `@remix-run/react`, `@angular/core` and any
  `next.config.*` file return `unsupported_framework` (naming the framework),
  not a misleading "missing vite" message. This includes the Next.js App Router
  sites Mavly itself generates;
* `package.json` parses and declares `react` **and** `vite`;
* only npm is supported; a yarn/pnpm/bun lockfile is refused;
* `index.html` exists and declares a local `<script type="module" src=...>`;
* that entry module exists.

Mavly never adds a dependency, rewrites `package.json` or converts a lockfile to
make a project eligible. A project that needs Vite must already declare it and
commit a consistent manifest; otherwise it is reported honestly and keeps the
static preview.

### The four states an absent root `package.json` can mean

A single "this project has no package.json at its root" sentence used to cover all
of them, which turned a transient or by-design state into a defect report. They
are now separate reasons, each with its own copy:

| State | Reason | Remedy |
|---|---|---|
| nothing saved yet (mid-generation, new project) | `no_project_files` | generate or import first |
| a static HTML project (`index.html` / `public/index.html`, no manifest) | `static_site` | use the static preview; no manifest is missing |
| a manifest that exists only under a subdirectory | `nested_package_json` (names the path) | move it to the root yourself; Mavly never moves files |
| a Node-shaped project with no root manifest | `missing_package_json` | add one; Mavly never generates or overwrites a manifest |

Detection reads exactly `project_files.path` and never rewrites a path, so an
absent root manifest really is absent from the saved files — the previous message
was a misdiagnosis of *which* state the project was in, not a wrong-root or
lost-write bug. Status was also a one-shot read: the workspace now re-reads it once
per finished run, so a status captured while the project was still empty can no
longer outlive the generation that filled it.

Unsupported projects return `RUNTIME_SANDBOX_UNSUPPORTED` with the exact reason;
the static preview remains.

Commands are fixed, server-generated, and never browser-supplied:

```
npm ci|install --ignore-scripts --no-audit --no-fund --no-progress
./node_modules/.bin/vite --host 0.0.0.0 --port <validated> --strictPort
./node_modules/.bin/vite build            (QA only, separately enabled)
```

`--ignore-scripts` is the security decision: lifecycle scripts (`preinstall`,
`install`, `postinstall`, `prepare`) from generated code never execute. The
tradeoff: a dependency that genuinely needs a native build step fails honestly
instead of running untrusted code. Package `scripts` are not executed at all;
the local Vite binary is invoked directly.

The adapter shell-quotes each argument as defence in depth. The HTTP route accepts
only `start`, `restart`, `stop` or `build`; there is no body field for a command,
path, port, environment variable or provider key.

## 7. Preview security

* The preview URL is constructed only in `previewUrlFromProvider`, from the
  provider's host, and only when it is a canonical `https://<label>.e2b.app`.
* A stored URL is re-validated on every read (`previewHostFromUrl`), so a forged
  row cannot become an iframe target.
* The iframe uses `sandbox="allow-scripts allow-same-origin allow-forms
  allow-popups allow-modals"` with `referrerPolicy="no-referrer"`: no top
  navigation, no downloads, no Mavly origin. `allow-same-origin` is the E2B
  origin's storage, not Mavly's.
* No E2B key, internal token or Mavly cookie is placed in the preview document.
* Egress is denied after dependency installation. The dev server needs inbound
  traffic only; if E2B refuses the update, the row records
  `egressRestricted: false` instead of claiming the stronger guarantee.

**Residual risk:** E2B preview hosts are publicly reachable by URL unless the
provider project is configured otherwise. The host label is unguessable but the
URL itself is not an authentication factor. Mavly does not proxy the preview
(no authenticated proxy exists), so a private preview is **not** claimed. Treat a
live preview URL as a secret. If a private preview is mandatory, leave
`MAVLY_RUNTIME_SANDBOX_ENABLED` off (or set an explicit
`MAVLY_RUNTIME_SANDBOX_PROJECTS` restriction); there is no per-project gate by
default.

## 8. Agent integration

The runtime row is read through `evidence.ts`, which maps recorded facts to four
explicit checks (`install`, `dev_server`, `readiness`, `build`). Nothing is
inferred from a state name alone.

⚠️ **Evidence is bound to the source it ran.** The row stores `source_hash`; the
orchestrator recomputes the current source hash and refuses a session from an
older revision (`runtimeEvidenceMatchesSource`). A stale preview is reported as
`unavailable`, never as a ready pass or a failure of the new code.

**Practical consequence:** because a generation usually changes files, a preview
started before that run is stale for the new output. QA therefore reports
`unavailable` (not a pass) unless the preview was started for exactly the files
the run produced. Re-running a prompt with no source changes, or previewing and
then asking for a follow-up, can produce a matching session. This is a deliberate
conservative limit, not a claim that every run gets runtime QA evidence.

* **Planner / UI-UX / Coding**: unchanged. `generateApp` remains the only writer.
* **QA** (`recordQa` in `orchestration/engine.ts`): when the durable row is in the
  multi-agent cohort, runtime preview is enabled for the project (global unless an
  operator set an explicit restriction), and
  `MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE` is on, QA reads the latest runtime row and
  adds `runtime-*` checks. A `ready` session alone leaves verification
  `pending`; `passed` requires the separately enabled approved build to have
  run and passed. A recorded runtime failure or failed build makes the QA task
  `failed`; it cannot be overridden by a static review.
* **Security**: the same evidence block is added to the advisory review; the
  deterministic scan still decides, and neither can authorize deployment.
* **Repair**: `runtimeRepairSummary` is passed to the **coding** context on a
  worker run as subordinate data. The Repair role itself remains a bounded
  diagnosis after a failed generation; any source change still flows through
  `generateApp`, then a Restart resynchronises the sandbox and re-checks.
* **Deployment**: unchanged. A running dev server, a passing build or a QA record
  is not an approval; the existing owner proposal gate still applies.

QA does not create a sandbox. Reading evidence never starts, restarts, installs
or spends provider time. The one approved QA build is an owner-triggered action
(`POST /api/runtime/{id} { action: "build" }`) and is off unless
`MAVLY_RUNTIME_SANDBOX_QA_BUILD` is set.

**Deliberate scope boundary:** the generation worker does **not** auto-start a
sandbox after every run. A live Vite install/start can take minutes, and doing it
inside the generation tick would compete with the queue and the run deadline.
The owner starts (or reconnects to) the preview from the workspace; a later QA or
Security review in a worker-dispatched run reads whatever that durable session
recorded. This means a fresh run's QA evidence is `unavailable` until a preview
has been started, and the projection says exactly that. It is not a silent pass.

## 9. Diagnostics and events

Terminal output is bounded (last 600 lines, 16 384 stored characters, 1 000 per
line) and redacted before persistence: ANSI escapes and control bytes are
stripped, `e2b_…`, `sk-…`, `npm_…`, JWTs, bearer tokens and URLs are replaced.
Environment variables are never captured. Logs are owner-visible through the
authenticated status route and are read on demand (`?logs=1`), not by a browser
poll that starts work.

Structured events reuse `src/lib/observability/events.ts`:
`sandbox.created`, `sandbox.sync.completed`, `sandbox.install.completed`,
`sandbox.server.started`, `sandbox.ready`, `sandbox.command.failed`,
`sandbox.start_failed`, `sandbox.expired`, `sandbox.stopped`,
`sandbox.unavailable`. Fields are allowlisted; `runtimeSandboxId` must be a UUID;
no prompt, file content, key or provider body is emitted.

Provider cost is **not** claimed. E2B usage is infrastructure spend separate from
Mavly credits and image cost. No credit rule, price or settlement changed.

## 10. Limits

| Limit | Where |
|---|---|
| Lifetime 120–3600 s; idle ≤ lifetime | config + DB `expires_at` |
| Active sandboxes per user | DB quota under advisory lock |
| 400 files / 256 KiB each / 4 MiB total (defaults) | `paths.ts` |
| Install ≤ 420 s, startup ≤ 180 s (defaults 120 + 60 fit the 300 s route budget) | config + provider timeout |
| Build ≤ 240 s | `runRuntimeBuildCheck` |
| 16 384 stored log chars | DB check + sanitizer |
| One active sandbox per project | partial unique index |
| Sweep ≤ 5 rows per worker tick | `worker.ts` |
| Build action requires a ready sandbox | service |

A timed-out command is recorded as `uncertain` in the sense that its side effects
are unknown; the sandbox is destroyed, not reused. There is no unbounded retry:
a failed start records a terminal `failed` row and the user may explicitly retry.

## 11. Unverified

This phase has **not** been exercised against a live E2B account, and the
repository's verification policy forbids the coding agent from running tests,
typechecks, builds or live probes. Therefore:

* No real sandbox was created.
* No real `npm` install, Vite start, readiness request or build ran.
* The E2B SDK calls are verified against `e2b@2.62.0`’s type definitions, not
  against the live API.
* Migration 34 has not been applied to a database.
* The workspace component has not been rendered in a browser.
* E2B rate limits, template contents, preview-host public-access defaults,
  `updateNetwork` availability and background-process behaviour are unverified.

The unit tests use a mocked provider and an in-memory store. They prove Mavly's
decisions (path safety, fixed commands, transition legality, readiness rules,
preview-host validation, cleanup), not the vendor's behaviour.

## 12. Rollout

1. Apply `supabase/migrations/34_runtime_sandboxes.sql`.
2. Confirm the E2B template provides Node 20+ and npm on `PATH`; if `base` does
   not, set `MAVLY_RUNTIME_SANDBOX_TEMPLATE` to one that does (this has not been
   verified against a live account).
3. Set the flag, `E2B_API_KEY` and Supabase URL in one deployment. A project
   list is optional and only narrows access; nothing else is per-project.
4. Open any owned React + Vite website project, press **Start live preview**, and
   watch the state move to `ready` only after the readiness probe.
5. Inspect the log panel; confirm no key or environment value appears.
6. Press **Stop**; confirm the provider sandbox is gone and a second Stop is a
   no-op.
7. Only then enable `MAVLY_RUNTIME_SANDBOX_QA_EVIDENCE` and/or
   `MAVLY_RUNTIME_SANDBOX_QA_BUILD`.

See `docs/runbooks/runtime-sandbox.md` for operator checks and failure handling.
