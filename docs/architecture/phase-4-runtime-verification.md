# Phase 4 — Runtime verification, secure preview status and bounded AI repair

Status: **implemented in code, disabled by default, not exercised against a live
Vercel Sandbox, a real Supabase database or a real generated app in this
repository.** Nothing in this document is a claim that a runtime check passed.

This phase extends the Phase 3 isolated build sandbox. The Phase 3 baseline is
described in [`phase-3-verification-sandbox.md`](phase-3-verification-sandbox.md);
where the two disagree, this document and migration 19 are authoritative.

---

## 1. What changed

Phase 3 answered “does the production build exit 0?”. Phase 4 adds two
questions the build cannot answer:

1. **Does the validated production server start and answer a local request?**
2. **If it failed in source, may a bounded AI repair try one corrected
   snapshot?**

A passing build is still not a passing app. A passing runtime check is still not
a deployed app, a browser render, a correctness proof or a hosted preview.

### `passed` now means three separate things

1. `next build` exited `0` inside the provider microVM;
2. the fixed production runtime was launched under the validated profile;
3. a sandbox-local HTTP request to `127.0.0.1` returned a `2xx` or `3xx` status.

Both the tick and `complete_verification` enforce this: a terminal write of
`passed` without all three booleans is rejected with `PASSED_REQUIRES_RUNTIME`.
A successful build followed by a failed runtime is `failed`, never `passed`.

### Explicit non-goals

- Arbitrary runtime hosting or production deployment.
- Serving a generated app from a Mavly host.
- A public preview URL. **Preview remains unavailable** (see §5).
- A browser, crawler or network probe outside the microVM.
- Unlimited repair, self-improvement loops, new dependencies, new queue or
  scheduler.
- Credits, billing or a guessed cost model.
- Native mobile builds or a general runtime-profile platform.
- Provider switching. Vercel Sandbox remains the only real adapter.
- A broad UI redesign. Only new optional status fields are exposed.

---

## 2. Runtime verification

### 2.1 Supported profile

Exactly one profile: `next-app-router`.

- `package.json`, `app/layout.tsx`, `app/page.tsx`, npm only, no workspaces.
- Build script must normalize to exactly `next build`; the binary is invoked
  directly (`./node_modules/.bin/next build`) so generated
  `prebuild`/`postbuild` hooks cannot run.
- `start` may be absent or exactly `next start`. Any other start script is
  `unsupported_runtime`; it is **never executed**.
- The runtime command is profile-owned and fixed:
  `./node_modules/.bin/next start -H 127.0.0.1 -p 3000`.
- The port (`3000`) and health path (`/`) are constants, not manifest values.

Anything else returns a truthful `unsupported_runtime` result.

### 2.2 Durable stage flow

A verification remains one row advanced by ordinary worker ticks:

```
queued
  → preparing      snapshot revalidated, sandbox created, reference persisted
  → installing     detached npm install/ci; marker polled by later ticks
  → building       detached next build; marker polled
  → runtime_starting
                   detached next start (loopback); pid + exit marker written
  → health_checking
                   sandbox-local node request to 127.0.0.1:3000/
  → passed | failed | timed_out | …
```

The build is re-read from the sandbox on every continuation tick. Reaching
`runtime_starting` sets `build_passed = true` only because the build marker
already reported exit `0`.

The health request is a short `node -e` program executed by the provider. It:

- targets a constant host, fixed port and fixed path;
- has a 5-second request timeout (clamped 1–10 s);
- discards the response body;
- returns `status:<code>`, `timeout`, `error:<code>` or an unknown token.

No project value, request header from a user, external URL or crawler reaches
the check.

### 2.3 What each failure distinguishes

| Observation | Result |
|---|---|
| Build exit non-zero | `failed` / `build_failed`, `build_passed = false` |
| Runtime process exited non-zero with port/bind text | `failed` / `runtime_port_unavailable` |
| Runtime process exited non-zero otherwise | `failed` / `runtime_start_failed` |
| Runtime exited `0` before answering | `failed` / `runtime_exited` |
| Health answered `4xx`/`5xx` | `failed` / `health_check_failed` |
| No runtime readiness within 4 min + grace | `timed_out` / `timeout` |
| Sandbox disappeared or provider failed | `infrastructure_error` / typed class |
| Unsupported format or missing snapshot | `unsupported_runtime` / `configuration_error` |

`health_checked_at` records that a request was attempted. It is not a pass.
`runtime_started` means the runtime answered the health connection at all; a
non-2xx answer still counts as started but not healthy.

### 2.4 Budgets

| Bound | Value |
|---|---|
| Sandbox lifetime | 22 min |
| Install | 5 min |
| Build | 8 min |
| Runtime readiness | 4 min (+30 s poll grace) |
| One health request | 5 s |
| Verification deadline | 26 min from first claim |
| Lease | 120 s per tick |
| Worker verification share | 200 s (`TICK_BUDGET_MS`) |
| Cleanup | 30 s provider call, 5 durable attempts |
| New deadline after an applied repair | now + 20 min |

The sandbox lifetime is the provider-side backstop when no tick runs. Cleanup
failure is recorded as `cleanup_complete = false` and never replaces the build
or runtime outcome.

---

## 3. Snapshot and lease integrity

- The row stores `snapshot_id`/`source_hash` (the original) and
  `effective_snapshot_id`/`effective_source_hash` (the original or the newest
  repair). Every tick re-reads the effective snapshot and re-hashes it.
- A snapshot that is missing, not `ready`, belongs to another run, or no longer
  matches its hash is never uploaded or executed.
- A repair snapshot must be `kind = 'repair'`, `status = 'ready'`, belong to the
  same project **and the same run**, and match the hash passed to the RPC.
- Claims, stage notes, sandbox clearing, repair begin/finish and terminal writes
  are fenced by the row's lease token.
- A duplicate terminal write is `already_terminal` and reports the stored
  outcome.
- A live sandbox reference makes a row continuable; recovery reattaches to it
  instead of starting a second one.
- A `repairing` row is not resumable. If its worker disappears, recovery marks
  the repair `failed`/`repair_failed` and the verification terminal; it never
  spends a second attempt on an unknown state.

---

## 4. Bounded AI repair

Repair is **separately opt-in** and never implied by the sandbox flag:

```bash
MAVLY_VERIFICATION_REPAIR_ENABLED=1
MAVLY_VERIFICATION_MAX_REPAIRS=1     # 0..2, default 1
```

Repair also requires the generation provider to be configured (`isAiConfigured`,
currently FreeModel). The enqueue persists a bounded budget; every later tick may
only lower it.

### 4.1 Eligible failures

Only source-level failures:

- `build_failed`
- `runtime_start_failed`
- `health_check_failed`

Install, dependency resolution, port binding, timeouts, cancellation,
configuration, infrastructure and unsupported formats are **not** repairable.
Asking a model to edit source would not fix them truthfully.

### 4.2 Sequence

1. Renew the lease.
2. Destroy the failed sandbox and confirm the provider reports it gone.
3. If deletion is not confirmed, **do not repair**; write the original failure
   and leave the sandbox to the durable orphan queue.
4. Clear the sandbox reference through a fenced RPC.
5. `begin_verification_repair` inserts one `requested` row with
   `unique(verification_id, attempt)` and sets the verification to `repairing`.
6. Build a bounded context: diagnostic-named paths first, 12 files/24 KB.
7. Call the provider once: 90 s timeout, 8 000 output tokens, temperature 0.
8. Parse untrusted JSON; enforce allowlisted, existing, editable paths; at most
   5 files; 256 KiB per file; no empty, duplicate or unseen path.
9. Merge into the original file set; manifests, lockfiles, `.env*`, `.mavly`,
   credentials, new files and deletions are refused.
10. Require a changed SHA-256 and re-run the full upload validation.
11. Create a **new immutable** `repair` snapshot; the project files are not
    touched.
12. `finish_verification_repair('applied')` points the verification at that
    snapshot, resets the build attempt budget, clears the lease and requeues.
13. The next ticks rebuild and rerun the runtime and health checks. Only then
    can the row become `passed`.

A failed or rejected repair writes the original failure; it does not promote
the verification. The repair row keeps the attempt, model, token counts,
provider-reported cost and an allowlisted reason.

### 4.3 Duplicate and crash behavior

- A pending repair is cancelled when the owner cancels the verification.
- When a lease expires during `repairing`, recovery fails the attempt closed.
- The unique attempt key and the lease fence prevent two repairs for one
  attempt; the budget (1 default, hard cap 2) prevents an unbounded loop.
- A worker that loses its lease after creating a repair snapshot leaves an
  immutable, addressable snapshot for audit; it cannot make it the effective
  snapshot without a fenced finish.

### 4.4 Cost

No price is estimated. Repair cost is stored only when the provider reports a
valid `usage.costUsd`; otherwise `cost_usd = NULL` and `cost_known = false`.
Sandbox compute cost remains unknown and is not charged to any user; the credit
system is untouched.

---

## 5. Preview: unavailable on purpose

The provider can mint a public, unauthenticated URL for a sandbox port. Mavly
has no authenticated preview proxy, no per-request authorization at the provider
edge and no cookie/session mediation. Returning that URL would publish generated
code to anyone who learns it.

Therefore Phase 4 exposes only:

```json
{
  "preview": {
    "status": "unavailable",
    "reason": "No authenticated preview proxy is configured for this deployment.",
    "authenticated": false
  }
}
```

- No URL, domain, token or provider management reference is stored or returned.
- The database constraint permits only `unavailable` or `disabled`.
- `agent/status` remains the authorized read path; it omits the sandbox handle.
- **Prerequisite for a future preview:** an authenticated Mavly proxy that
  verifies project ownership on every request and reaches the sandbox through a
  server-side control plane, with no public provider URL. Until that exists,
  preview stays disabled. Do not “enable” it by returning `domain()`.

---

## 6. Data model (migration 19)

Additive to migration 17, applied after 17 (and 18 in file order). It preserves
RLS and grants.

`public.project_verifications` adds:

- `effective_snapshot_id`, `effective_source_hash`
- `build_passed`, `runtime_started`, `health_passed`
- `runtime_profile`, `runtime_port`, `runtime_exit_code`, `health_http_status`
- `runtime_started_at`, `runtime_finished_at`, `health_checked_at`
- `preview_status` (`unavailable`/`disabled`), `preview_reason`
- `repair_attempts` (0–2), `repair_max_attempts` (0–2), `repair_status`
- `repaired_snapshot_id`

`public.project_verification_repairs` is one row per attempt:

- FK to verification/project/run/snapshot; `attempt` 1–2;
  `unique(verification_id, attempt)`
- original snapshot/hash (not readable by authenticated users)
- repaired snapshot/hash, status `requested|applied|failed|rejected`
- model, prompt/completion tokens, `cost_usd`, `cost_known`, error class, summary
- RLS: owner may `SELECT` through the verification/project join; all writes are
  `service_role` RPCs.

`project_snapshots.kind` accepts `repair`.

`verification_schema_version()` returns **19**. The worker refuses to claim
verification work when the marker is missing or lower.

Authenticated readers still cannot see `user_id`, `sandbox_id`, `worker_id`, the
lease fields or `cleanup_attempts`. They gain only the new public result fields.

---

## 7. Security invariants

1. Generated code runs only inside the provider microVM. There is no local
   fallback.
2. The runtime binds `127.0.0.1`, inside the microVM. No port is registered with
   the provider and no ingress is created.
3. The health script is fixed text; no project, user or manifest value reaches
   its host, port or path.
4. The generated `start` script is validated but never executed.
5. Repair edits only existing, allowlisted source paths the model was shown;
   manifests, lockfiles, `.env*`, reserved markers and credentials are refused.
6. Repair output is bounded and revalidated; a repair is a new immutable
   snapshot, never an edit to `project_files`.
7. Provider credentials, sandbox references and the service-role key never enter
   a sandbox, a result, an event or a log.
8. Diagnostics are ANSI-free, redacted and bounded before persistence or a
   prompt; only the tail is kept.
9. Service-role use stays confined to the existing worker client and tick.
10. Admission remains 1 active per project, 2 per user, 8 global.

---

## 8. Observability and public surface

New allowlisted events: `verification.runtime`, `verification.health`,
`verification.repair`.

New allowlisted scalar fields: `runtimePort`, `healthHttpStatus`,
`repairAttempt`, `repairStatus`; repair events also carry `model`,
`promptTokens`, `completionTokens`, `costUsd`, `costKnown`. No prompt, file
content, response body, token or provider URL is logged.

The existing `agent/status` verification block gains:

- `buildPassed`, `runtimeStarted`, `healthPassed`, `healthChecked`
- `runtimeProfile`, `runtimePort`, `runtimeExitCode`, `healthHttpStatus`
- `runtimeStartedAt`, `runtimeFinishedAt`, `healthCheckedAt`
- `preview` (`status`, `reason`, `authenticated: false`)
- `repair` (`status`, `attempts`, `maxAttempts`, `snapshotId`)

The existing `status`/`stage`/`attempt` fields are unchanged in meaning; the new
in-flight stages surface as `status: "running"`. No route or public URL is
added.

---

## 9. Reliability summary

| Scenario | Behavior |
|---|---|
| Worker dies during install/build/runtime | Lease expires; recovery releases or requeues; the next tick reattaches to the same sandbox |
| Worker dies during repair | Recovery fails the attempt closed; no second repair |
| Duplicate tick finishes | `already_terminal`; stored outcome wins |
| Snapshot changed or wrong run | Never uploaded; `snapshot_mismatch`/`validation_failed` |
| Cleanup fails | Outcome preserved; `cleanup_complete = false`; durable bounded retry |
| Owner cancels | `cancelled`, pending repair `failed`, sandbox reference retained for cleanup |
| Deadline exceeded | `timed_out`; live sandbox left to the cleanup queue |
| Runtime already exited | `runtime_start_failed`, `runtime_port_unavailable` or `runtime_exited` |
| Health never answers | `timed_out` with `health_checked_at` recorded |
| Repair rejected | Original failure written; repair row records the reason |
| Repair applied | New snapshot becomes effective and the row is requeued |

---

## 10. Rollout

1. **Human prerequisites.** `npm install` must be run so `@vercel/sandbox` is
   present in `node_modules` and the lockfile; it is declared in `package.json`
   but was not installed in the environment that produced this code.
2. Apply migration `17_verification_sandbox.sql`, then
   `19_runtime_verification.sql`, through the normal migration workflow. Do not
   apply them from an agent session or as part of a production deploy here.
3. Confirm `verification_schema_version()` returns `19` before enabling.
4. Enable Phase 2 durable generation and confirm one worker run completes.
5. Enable the build sandbox for one disposable project in the cohort; confirm
   `passed` requires the runtime response, or a truthful failure.
6. Only then enable repair (`MAVLY_VERIFICATION_REPAIR_ENABLED=1`) with
   `MAVLY_VERIFICATION_MAX_REPAIRS=1`. Keep it off for the first runtime
   validation so a repair cannot mask a policy problem.
7. Validate isolation, egress, deletion, cancellation and durations manually;
   see the runbook.

Preview is not a rollout step: it remains unavailable.

## 11. Rollback

1. Set `MAVLY_VERIFICATION_REPAIR_ENABLED=0` (or unset it) and redeploy. Pending
   repairs become terminal through recovery/cancellation; no project file is
   touched.
2. Disable `MAVLY_VERIFICATION_SANDBOX_ENABLED` after draining; queued rows stay
   inert.
3. Leave migrations 17 and 19 installed. Both are additive; dropping the repair
   table or verification rows would destroy audit and cleanup history and is not
   a rollback.
4. Reverting application code is safe: Phase 3 columns remain readable, and the
   Phase 3 terminal rule (build only) will require its own code rollback if full
   Phase 4 is reverted. Do not mix a Phase 4 database with pre-Phase 3 code.

---

## 12. What is not proven

- No test, lint, typecheck, build, dev server, migration, provider call,
  deployment or browser check was run by the agent that wrote this.
- Phase 3 live operability was **not** confirmed. `@vercel/sandbox` is declared
  but absent from `node_modules` and `package-lock.json`, so even the existing
  provider adapter does not currently typecheck or bundle until the human runs
  `npm install`.
- The provider’s isolation, plan limits, OIDC behaviour, pricing and network
  enforcement remain operator assumptions.
- No generated app has been built, started or health-checked.
- The repair model has not been called; its ability to produce a valid,
  buildable change is unknown.
- Migration 19 has not been applied to any database. Its static invariants are
  tested; its runtime behavior is not.

See [`docs/runbooks/verification-sandbox.md`](../runbooks/verification-sandbox.md)
for the operator validation checklist.
