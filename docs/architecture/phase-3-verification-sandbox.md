# Phase 3 — Isolated verification sandbox

Status: **implemented, disabled by default, not yet exercised against a live
provider or a real Supabase database in this repository.**

This document describes what the code actually does. It does not claim that a
project has been built successfully in an isolated sandbox.

---

## 1. What problem this solves

Phase 2 made generation durable: a run can be claimed, retried, resumed and
dead-lettered without the HTTP request owning it. A completed run ends with an
immutable snapshot in `project_snapshots` / `project_snapshot_files`.

Phase 3 answers the next question honestly:

> Does that snapshot actually install and build?

The answer comes from a **production build inside a managed microVM**, never
from the Mavly server and never from a mock. `passed` means the build command
exited 0. It does **not** mean the app was served, reached in a browser,
deployed or crawled.

### In scope

- One provider-neutral sandbox adapter with typed operations and timeouts.
- A re-validated, bounded upload of the immutable snapshot.
- A durable verification row, claimed by the existing generation worker.
- Detached install/build stages that span worker invocations.
- Leases, recovery, orphan cleanup and owner cancellation.
- Sanitized, bounded diagnostics and structured lifecycle events.
- A backward-compatible verification block in `agent/status`.

### Explicit non-goals

- Replacing or rewriting the Phase 2 queue, worker or scheduler.
- Running generated code on Mavly infrastructure.
- Full backend runtime hosting, arbitrary deployments, public preview URLs.
- Browser/health checks of a running app (deferred).
- An unbounded AI repair loop.
- A credits or billing engine.
- A general runtime-profile system. Exactly one profile exists today.

---

## 2. Provider decision

**Chosen: Vercel Sandbox (`@vercel/sandbox`).**

Evidence available in this repository and from the package's published types:

| Capability | Evidence | Status |
|---|---|---|
| Managed microVM isolation | Provider product | Assumed from the provider; not independently tested here |
| Create a sandbox with an explicit lifetime | `Sandbox.create({ timeout })` | Verified in the SDK types |
| Upload files | `sandbox.writeFiles([...])` | Verified in the SDK types |
| Detached command | `runCommand({ detached: true, signal })` | Verified. The SDK has no per-command timeout; the worker's stage deadline plus the sandbox lifetime bound it |
| Reconnect after a worker crash | `Sandbox.get({ name })` | Verified; reconnection is **by sandbox name**, not id. The SDK resolves credentials from the server environment |
| Delete / verify absence | `sandbox.delete()`; a 404 is treated as `absent` | Verified |
| Network firewall | `networkPolicy: { allow: { host: [] } }` | Verified in the SDK types |
| Auth | Vercel OIDC from the environment, or `token` + `teamId` + `projectId` | Verified in the SDK types |

Why not E2B: it would add a second account, credential set and dependency for
no demonstrated advantage, and the SDK is not installed here. `e2b.ts` is an
honest `not_implemented` adapter: selecting it fails configuration preflight
instead of silently falling back.

**Operator prerequisites that remain unverified:**

- Vercel plan/terms eligibility for Mavly-managed sandbox workloads.
- The account's maximum sandbox lifetime and concurrency limits (this design
  assumes an 18-minute session and one vCPU per verification).
- OIDC availability in the actual runtime, or a team-scoped access token.
- Current pricing. Cost accounting is **not** implemented: the provider does not
  return an authoritative per-build cost here, so no cost is reported.

---

## 3. Component map

```
generation worker tick (/api/generation/worker)
  └─ runGenerationWorkerOnce
       ├─ generation queue (unchanged Phase 2)
       └─ when the generation claim is EMPTY:
            runVerificationTick
              ├─ preflight: config + migration 17 + provider adapter
              ├─ recover never-ending rows (deadline / expired lease)
              ├─ bounded orphan cleanup
              ├─ claim ONE verification (SKIP LOCKED)
              ├─ new:       snapshot → validate → create → upload → start install
              └─ continue:  reconnect → read marker → start build / finish / wait
```

| File | Responsibility |
|---|---|
| `src/lib/sandbox/config.ts` | Opt-in flag, provider choice, cohort, credential presence. Server-only. |
| `src/lib/sandbox/state.ts` | Stage/status vocabulary, public mapping, budgets. |
| `src/lib/sandbox/policy.ts` | Snapshot re-validation, secret-path refusal, upload limits, fixed commands, egress, diagnostic redaction, failure classification. |
| `src/lib/sandbox/adapter.ts` | Provider-neutral contract, typed errors, bounded output, timeout race. |
| `src/lib/sandbox/vercel-sandbox.ts` | The real Vercel Sandbox adapter. |
| `src/lib/sandbox/e2b.ts` | `not_implemented`; never silently selected. |
| `src/lib/sandbox/provider.ts` | Configuration → adapter, with no fallback. |
| `src/lib/sandbox/verification.ts` | The durable tick: recover, clean, claim, advance, finalize. |
| `src/lib/sandbox/enqueue.ts` | Enqueue after a completed worker run; never fails the run. |
| `src/lib/sandbox/store.ts` | Typed RPC wrappers and the public read model. |
| `src/lib/runtime/*` | The one supported runtime profile (Next.js App Router) and manifest/lockfile validation. |
| `supabase/migrations/17_verification_sandbox.sql` | Table, RLS, grants, queue/lease/recovery/cleanup/cancel RPCs, schema marker. |
| `src/app/api/generation/worker/route.ts` | Returns the non-sensitive verification tick summary. |
| `src/lib/mavly/api.ts` | `agent/status` verification block; `agent/stop` cancels an in-flight verification. |

---

## 4. Data model

`public.project_verifications` — one row per generation run (`unique(run_id)`).

Key columns:

- `project_id`, `user_id`, `run_id`, `snapshot_id`, `source_hash`
- `status` (`queued` / `preparing` / `installing` / `building` / terminal)
- `attempt` / `max_attempts`
- `provider`, `sandbox_id` (opaque, worker-only)
- `exit_code`, `error_class`, `summary`, bounded `diagnostics` JSON
- `cleanup_complete`, `cleanup_attempts`, `partial`
- `trace_id`, `worker_id`, `lease_token`, `lease_expires_at`
- `enqueued_at`, `started_at`, `stage_started_at`, `deadline_at`, `finished_at`

Access:

- Users may `SELECT` only rows whose project they own, through `projects` RLS.
- The authenticated column grant excludes `user_id`, `sandbox_id`, `worker_id`,
  the lease fields and `cleanup_attempts`.
- Users have no `INSERT` / `UPDATE` / `DELETE`.
- All worker RPCs are executable only by `service_role`.
- `cancel_verification` is the one owner-facing mutation and verifies ownership
  inside the function.

Apply **after** migration 16. Additive and non-destructive; nothing in
`project_runs`, `project_files`, `project_snapshots` or hosting tables changes.

---

## 5. Lifecycle

```
queued ──claim──▶ preparing ──upload──▶ installing ──marker──▶ building ──marker──▶ terminal
   ▲                  │                     │                        │
   │                  │ tick died           │ tick died              │ tick died
   │                  ▼                     ▼                        ▼
   └─ recover (no sandbox, attempts left)   continue the SAME sandbox (never a second one)
```

- **Enqueue** happens only after a *worker* run reaches `completed`, with a
  ready snapshot belonging to that run and a matching hash. It is idempotent on
  `run_id`. Inline runs never enqueue (there is no durable worker to advance
  them).
- **Create** happens once per row. The sandbox reference is written to the row
  (`preparing`) before any uploaded file can execute.
- **Detached stages.** Install and build run detached, so a build can outlive a
  300-second worker invocation. The shell wrapper writes
  `.mavly/<stage>.exit` and `.mavly/<stage>.log`; a later tick reconnects by
  sandbox name and reads those markers. This is why no long HTTP request is
  required.
- **Release.** After starting a detached stage the tick releases its lease
  without ending the verification. The next tick reattaches with a new token.
- **Finalize.** The sandbox is destroyed, then the terminal write is fenced by
  the lease token. `complete_verification` is idempotent (`already_terminal`);
  cleanup failure is recorded as `cleanup_complete = false` and never replaces
  the build outcome.

---

## 6. Timeouts and budgets

| Bound | Value | Why |
|---|---|---|
| Sandbox lifetime | 18 min | Provider-enforced; outlives install + build |
| Install | 5 min | `npm ci` / `npm install` for a generated app |
| Build | 8 min | `next build` |
| Verification deadline | 20 min from first claim | Recovery stops a row even if a sandbox lives |
| Lease | 120 s per tick | Renewed before long provider calls |
| Worker tick budget | 200 s | Inside the route's 300 s `maxDuration` |
| Cleanup attempts | 5 | Durable, bounded orphan queue |

Timeouts are enforced at two layers: the adapter races every provider request
against a local timeout and aborts it, and a detached stage with no exit marker
after its budget (plus a 30-second grace) becomes `timed_out` on the next tick.
Because the provider SDK has no per-command timeout, the sandbox's 18-minute
lifetime is the backstop if no tick runs: deleting it (or the provider expiring
it) stops the detached command. A later tick that finds the sandbox absent
records `infrastructure_error`/`sandbox_not_found`, never a fabricated pass.

---

## 7. Security boundaries

1. **No local execution.** The only path that runs generated code is
   `adapter.startDetached`, which talks to the provider. There is no npm, Next
   or shell fallback on the Mavly host.
2. **Upload validation.** Before upload, every file is re-checked:
   - `sanitizeProjectPath` (relative, no traversal, no control characters, no
     `node_modules` / `.git` / `.next` / `.vercel`);
   - the reserved `.mavly` directory is refused;
   - `.env*` except `.env.example`, `.npmrc`, `.netrc`, `.git-credentials`,
     private keys and credential JSON files are refused;
   - case-insensitive duplicates are refused;
   - 80 files, 256 KiB per file, 1.5 MB total;
   - the computed SHA-256 must equal the hash recorded at enqueue.
3. **The manifest is data.** Only a normalized `next build` script is accepted;
   the binary is invoked directly (`./node_modules/.bin/next build`) so npm's
   `prebuild`/`postbuild` hooks cannot bypass the check. Workspaces, non-npm
   package managers and unsatisfiable `engines.node` are `unsupported_runtime`.
4. **Egress allowlist.** `registry.npmjs.org`, `fonts.googleapis.com`,
   `fonts.gstatic.com`. No wildcard.
5. **No credentials in the sandbox.** Uploads contain project text only. The
   environment is `NEXT_TELEMETRY_DISABLED` and `CI` (never `NODE_ENV=production`,
   which would make npm omit devDependencies); no service-role
   key, Vercel token or worker secret is injected, and provider credentials stay
   in the Mavly process.
6. **Service-role confinement.** The verification tick uses the existing
   service-role client created in `src/lib/supabase/worker.ts`; RLS is unchanged
   and the authenticated role cannot write worker-owned columns.
7. **Diagnostics are untrusted output.** ANSI/control characters are stripped;
   bearer/basic tokens, JWTs, GitHub/OpenAI/AWS tokens, npm auth lines,
   credential-bearing URLs and key/value secrets are redacted; only the tail is
   kept (80 lines, 400 chars/line, 6000 chars total).
8. **Admission caps** are enforced in SQL: one active verification per project,
   two per user, eight globally.

**Not implemented:** secret injection, secret scanning inside dependency code,
a dedicated verification-only database credential, and a per-build cost cap.

---

## 8. Observability

All events use the existing allowlisted structured logger
(`src/lib/observability/events.ts`), prefix `[verification]`:

`verification.enqueued`, `enqueue_skipped`, `enqueue_failed`, `claimed`,
`stage`, `completed`, `cleanup`, `recovered`, `unavailable`, `lease_lost`,
`error`.

Fields are restricted to: trace/run/project/verification/snapshot ids, worker
id, provider, stage, status, attempt counters, error class, reason, duration,
exit code and a cleanup flag. **No prompt, file content, credential or provider
body is ever logged.**

---

## 9. Public surface

`GET /api/vcaas/projects/{id}/agent/status` gains an optional `verification`
object when one exists for the latest run. It is read through the caller's
RLS-scoped client and omits the provider sandbox reference and internal row id.

`POST /api/vcaas/projects/{id}/agent/stop` also cancels an in-flight
verification for a completed run and answers
`{ verificationCancelled: true }` instead of `409 RUN_NOT_ACTIVE`.

There is no new route, no new public URL and no preview endpoint.

---

## 10. Known limitations

- **No live proof in this repository.** No test, build, migration or provider
  call was executed by the agent that wrote this. The provider's isolation,
  plan limits, pricing and network behaviour are assumptions until an operator
  runs the integration checklist.
- **One runtime only.** Next.js App Router with an exact `next build` script.
  Other shapes are reported as `unsupported_runtime`.
- **No preview/health check.** A passing build is not a running app.
- **No repair loop.** Diagnostics are actionable, but no automatic code fix is
  applied.
- **Verification yields to generation.** It advances only when the generation
  claim is empty, preserving Phase 2's order. Under constant generation load,
  verification waits; the scheduler cadence is the scaling knob.
- **Retry semantics.** A verification row gets at most two *new* claim attempts;
  continuation ticks do not consume attempts. The 20-minute deadline is the
  hard stop.
- **Cleanup is best-effort.** Five bounded attempts; a permanently failing
  provider leaves `cleanup_complete = false` for operator review. The sandbox
  lifetime still destroys the VM eventually.
- **Cleanup trusts the active provider.** Orphan cleanup runs through the
  currently configured adapter. A row whose `provider` differs from the active
  one is counted as an attempt and left after five; an operator must remove that
  sandbox through the provider it actually belongs to.
- **A stale `queued` row has no deadline yet.** `deadline_at` is set at the
  first claim, so a row enqueued just before the cohort shrinks or the flag is
  turned off stays `queued` indefinitely. It is inert, consumes no resources,
  and resumes if that project is brought back into the cohort.
- **Disabling the flag also stops recovery and cleanup.** The tick returns
  `unavailable` before those phases, so an in-flight sandbox is left to the
  provider's own lifetime and terminal rows keep `cleanup_complete = false`
  until the feature is enabled again. Drain before disabling (runbook §6).
- **Status visibility follows the current config.** `agent/status` only reads
  the verification block when the flag is on and the project is in the cohort.
  Turning the flag off hides existing rows from the UI; it does not delete them.

---

## 11. Rollout and rollback

Rollout is cohort-scoped and off by default; see the runbook. Rollback is
disabling the flag: no generation job, file, checkpoint, snapshot or hosting row
is touched, and queued verifications simply stop advancing. Migration 17 is
additive; leaving it installed is safe. Because disabling also stops cleanup,
drain in-flight rows first (runbook §6).
