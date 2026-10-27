# Runbook — verification sandbox

The isolated verification sandbox is **off by default**. This runbook is for the
operator who chooses to enable it for a small project cohort.

Phase 4 extends the Phase 3 build with a loopback runtime start, a sandbox-local
health check and a separately opt-in bounded AI repair. It assumes the
architecture in
[`docs/architecture/phase-4-runtime-verification.md`](../architecture/phase-4-runtime-verification.md);
the [Phase 3 document](../architecture/phase-3-verification-sandbox.md) remains
the baseline and provider decision. Where they disagree, Phase 4 and migration
19 are authoritative.

---

## 1. Prerequisites

- Phase 2 durable generation worker is enabled and healthy.
- A human has run `npm install`, so `@vercel/sandbox` is present in
  `node_modules` and the lockfile. It is declared in `package.json` but has not
  been installed by the agent that wrote this code.
- Migration 17 applied **after** migration 16, then migration 19 applied
  **after** 17.
- A Vercel account/team eligible for Sandbox workloads, with either:
  - `VERCEL_OIDC_TOKEN` available to the worker runtime, or
  - `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
- The plan's maximum sandbox lifetime is at least 22 minutes (the design uses a
  22-minute session inside a 26-minute deadline).
- An explicit list of project ids. There is no `*` and no default cohort.
- For repair only: a configured generation model (`OPENROUTER_API_KEY`) and the
  separate repair flag below.

Apply the migrations with your normal process. Do **not** apply them as part of
a production deploy from an agent session.

```bash
# example only — use your migration workflow
# psql "$DATABASE_URL" -f supabase/migrations/17_verification_sandbox.sql
# psql "$DATABASE_URL" -f supabase/migrations/19_runtime_verification.sql
```

`verification_schema_version()` must return `19`. The worker refuses to claim
verification work otherwise.

---

## 2. Enable

```bash
MAVLY_VERIFICATION_SANDBOX_ENABLED=1
MAVLY_VERIFICATION_SANDBOX_PROVIDER=vercel        # e2b is not implemented
MAVLY_VERIFICATION_SANDBOX_PROJECTS=alpha-app,beta-app

# Keep repair OFF for the first runtime validation:
MAVLY_VERIFICATION_REPAIR_ENABLED=0
MAVLY_VERIFICATION_MAX_REPAIRS=0

# exactly one auth shape:
VERCEL_OIDC_TOKEN=...                             # or:
VERCEL_TOKEN=...
VERCEL_TEAM_ID=...
VERCEL_PROJECT_ID=...

# already required by the Phase 2 worker:
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
MAVLY_GENERATION_WORKER_ENABLED=1
MAVLY_GENERATION_WORKER_SECRET=...                # >= 32 chars
MAVLY_GENERATION_WORKER_PROJECTS=...
```

Configuration is all-or-nothing. If any prerequisite is missing the tick emits
`verification.unavailable` and claims nothing; generation is unaffected.

Repair is **separately opt-in**: it never makes the sandbox configuration ready
and never implies verification. `MAVLY_VERIFICATION_MAX_REPAIRS` is clamped to
`0..2`, defaults to `1` when repair is enabled, and `0` disables repair even if
the flag is on.

**Order matters:** enable the Phase 2 worker first, confirm one generation
completes, then enable verification for the same cohort. Verification only
enqueues after a *worker* run completes.

---

## 3. Verify the first run

Run the worker endpoint once (the scheduler's usual call):

```bash
curl -sS -X POST "$MAVLY_APP_URL/api/generation/worker" \
  -H "Authorization: Bearer $MAVLY_GENERATION_WORKER_SECRET"
```

Expected progression across several calls (verification runs only when no
generation job is ready):

1. `{"ok":true,"status":"empty","verification":{"status":"advanced","reason":"installing"}}`
2. `... "reason":"building"`
3. `... "reason":"runtime_starting"`
4. `... "reason":"health_checking"`
5. `... "status":"completed","outcome":"passed"` (or a truthful failure)

Then read the status endpoint as the project owner:

```bash
curl -sS "$MAVLY_APP_URL/api/vcaas/projects/alpha-app/agent/status" \
  -H "Cookie: <session>"
```

`verification.status` must move `pending → running → passed|failed|…`. A missing
`verification` object means none was enqueued (feature off, outside cohort, or
the run had no usable snapshot).

`passed` requires **all three** of `buildPassed`, `runtimeStarted` and
`healthPassed`. A successful build with a failed runtime is `failed`, never
`passed`. `preview.status` is expected to be `unavailable`; no provider URL is
returned. `repair.status` should be `none` while repair is off.

---

## 4. Enable bounded repair (only after runtime validation)

After the first cohort passes runtime/health without repair:

```bash
MAVLY_VERIFICATION_REPAIR_ENABLED=1
MAVLY_VERIFICATION_MAX_REPAIRS=1                  # 0..2; start at 1
```

- Only `build_failed`, `runtime_start_failed` and `health_check_failed` are
  eligible. Install, dependency, port, timeout, infrastructure,
  configuration and unsupported-runtime failures are not.
- A repair destroys the failed sandbox first, then creates a new immutable
  `repair` snapshot. `project_files` is never edited.
- The next ticks rebuild, restart and recheck. The verification cannot pass
  without those new checks.
- Never raise the value above 2 and never enable repair to hide a policy,
  dependency or infrastructure problem.

---

## 5. Log events and alerts

Every lifecycle line is JSON with a `[verification]` prefix. Suggested alerts:

| Event | Meaning | Action |
|---|---|---|
| `verification.enqueue_failed` | Store error after a completed run | Check Supabase availability; the run is still complete |
| `verification.unavailable` | Misconfiguration or migration missing | Fix the reported `reason`; nothing was claimed |
| `verification.claim_failed` | Claim RPC error | Check database health and migration 19 |
| `verification.error` | Reconnect/marker/complete/release failure | Inspect `reason`; rows recover on the next tick |
| `verification.lease_lost` | Another tick or a cancellation won | Expected occasionally; repeated lines indicate slow ticks |
| `verification.runtime` | Runtime start/exit observation | Inspect `stage`, `runtimePort`, `runtimeExitCode`; never contains output |
| `verification.health` | Health request observation | Inspect `healthHttpStatus`; a non-2xx/3xx is a real failure |
| `verification.repair` | Bounded repair decision | Inspect `repairStatus`, model/token/cost fields; prompts and file contents are never logged |
| `verification.cleanup` with `status=failed` | Sandbox not confirmed deleted | Check provider access; the row stays in the cleanup queue |
| `verification.recovered` | Deadline or expired lease handled | `timed_out`/`released`/`requeued` are expected under crashes |

There is no metrics vendor. These lines are the source for thresholds.

---

## 6. Inspect state

Read-only SQL (service role, never in an application route):

```sql
select id, project_id, run_id, status, attempt, max_attempts,
       build_passed, runtime_started, health_passed,
       runtime_profile, runtime_port, runtime_exit_code, health_http_status,
       repair_status, repair_attempts, repair_max_attempts,
       provider, exit_code, error_class, cleanup_complete,
       enqueued_at, started_at, stage_started_at, deadline_at, finished_at
from public.project_verifications
order by enqueued_at desc
limit 50;

-- in-flight rows
select count(*) from public.project_verifications where finished_at is null;

-- repair attempts (never select prompt or file content)
select id, verification_id, attempt, status, model,
       prompt_tokens, completion_tokens, cost_usd, cost_known,
       error_class, started_at, finished_at
from public.project_verification_repairs
order by started_at desc
limit 50;

-- durable orphans needing cleanup
select id, project_id, sandbox_id, cleanup_attempts
from public.project_verifications
where finished_at is not null
  and cleanup_complete = false
  and sandbox_id is not null;
```

Never print `sandbox_id` into a ticket or chat; it is an opaque provider handle.

---

## 7. Pause and drain

**Pause new verifications:** unset `MAVLY_VERIFICATION_SANDBOX_ENABLED` (or set
it to `0`) and redeploy. Queued rows remain; nothing advances. Generation and the
Phase 2 worker continue.

**Pause repair first, if only repair is suspect:** unset
`MAVLY_VERIFICATION_REPAIR_ENABLED`. Pending repairs become terminal through
cancellation or recovery; no project file is touched. Existing build/runtime
verification still runs.

⚠️ **Disabling the sandbox also stops recovery and orphan cleanup**, because the
tick returns `unavailable` before those phases. An in-flight sandbox is then
bounded only by the provider's lifetime, and terminal rows keep
`cleanup_complete = false` until the feature is enabled again. Rows that were
enqueued but never claimed have no deadline at all and stay `queued` (inert, no
resources) until the project is brought back into the cohort.

**Drain:** leave the flag on until `finished_at is null` reaches zero **and** the
orphan query in §6 returns no rows, then turn it off. Verifications advance only
on empty generation ticks, so allow scheduler time.

**Cancel one:** the owner can call `agent/stop`; a terminal run with an
in-flight verification returns `{ "verificationCancelled": true }`. A pending
repair is marked failed without promoting the verification.

---

## 8. Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `unsupported_runtime` | Not a Next.js App Router project, missing `app/layout.tsx`/`app/page.tsx`, no exact `next build`, a non-exact `start` script, workspaces, or unsupported `engines.node` | Change the project or leave it unverified; never loosen the profile to "make it pass" |
| `snapshot_mismatch` | Snapshot content no longer hashes to the recorded value | Treat as tampering; do not retry by editing the row |
| `dependency_resolution_failed` | Registry cannot resolve a declared dependency | Fix the generated `package.json`; egress is intentionally limited to npm and Google Fonts |
| `install_failed` / `build_failed` | The project genuinely does not install/build | Read sanitized diagnostics; this is a real result |
| `runtime_start_failed` | `next start` exited non-zero before answering | Inspect runtime diagnostics; the generated `start` script is never executed |
| `runtime_port_unavailable` | Runtime could not bind `127.0.0.1:3000` | Treat as a runtime/environment problem; not repairable via source |
| `runtime_exited` | Runtime exited `0` before answering | Inspect diagnostics; readiness was not reached |
| `health_check_failed` | The local request returned `4xx`/`5xx` | Inspect diagnostics; the app started but is not serving `/` successfully |
| `repair_failed` / `repair_unavailable` | The bounded repair failed or could not run | The original failure is preserved; this is not a pass |
| `timed_out` | Install > 5 min, build > 8 min, runtime readiness > 4 min, or the 26-min deadline | Inspect diagnostics; raise limits only with a matching provider lifetime |
| `sandbox_not_found` | Provider killed the sandbox (lifetime) or it was deleted | Check the provider console; outcome is unknown by design |
| `configuration_error` | Missing/mismatched credentials, unsupported provider, snapshot gone | Fix configuration; nothing was executed |
| `infrastructure_error` | Provider rejection, missing marker, interrupted state | Inspect events; a later row can be re-verified by the next generation run |
| `PASSED_REQUIRES_RUNTIME` in logs | A terminal write tried to mark `passed` without build+runtime+health | A code/policy bug; do not bypass it in SQL |
| `preview.status = "unavailable"` | Expected: no authenticated preview proxy | Not a failure; no URL exists to expose |
| `cleanup_complete = false` | Delete not confirmed | Five bounded retries; the provider lifetime also destroys the VM |

---

## 9. Rollback

1. Disable repair: unset `MAVLY_VERIFICATION_REPAIR_ENABLED` or set it to `0`,
   then redeploy. No project file is touched.
2. Disable `MAVLY_VERIFICATION_SANDBOX_ENABLED` **after draining** (§7).
3. Leave migrations 17 and 19 installed. Both are additive and unused when
   disabled. Do not drop `project_verifications` or
   `project_verification_repairs`: they preserve audit and cleanup state.
4. Reverting to Phase 3 application code leaves the migration 19 columns
   readable, but the Phase 3 `passed` rule is build-only. Do not mix a Phase 4
   database with pre-Phase 3 code, and do not revert the `passed` rule while
   runtime/health columns are populated.
5. Generation jobs, files, checkpoints, snapshots and hosting rows are never
   modified by verification. No data migration is needed.

---

## 10. Cost and capacity

- One vCPU per sandbox, one sandbox per row, caps 1/2/8 (project/user/global).
- A sandbox is deleted on every terminal path; the 22-minute provider lifetime
  is the backstop. An applied repair gets a fresh 20-minute deadline window but
  still uses one sandbox at a time.
- No authoritative sandbox compute cost is available, so none is reported. Use
  the provider's own usage reporting.
- Repair cost is recorded only when the provider returns a valid
  `usage.costUsd`; otherwise it stays unknown (`cost_known = false`). No user is
  charged and the credit system is untouched.
- Raise the admission caps only after measuring real install/build/runtime
  durations and provider concurrency. `MAX_ACTIVE_GLOBAL = 8` is deliberate.

---

## 11. Manual validation checklist

Nothing in this repository has executed the provider path. Before relying on it:

1. Run `npm install`, then the human-run typecheck/test/lint/build commands.
2. Run the first verification against a disposable project and a disposable
   Vercel team.
3. Confirm the sandbox is genuinely isolated (no access to Mavly env or
   Supabase service-role credentials).
4. Confirm the egress allowlist blocks an unlisted host from inside the build.
5. Confirm a passing build starts the runtime and answers the health request;
   force a runtime failure and confirm the result is `failed`, never `passed`.
6. Confirm the sandbox is deleted after pass, fail and timeout.
7. Confirm cancellation during a build and during `runtime_starting` leaves no
   live sandbox.
8. Enable repair once and confirm: a new immutable `repair` snapshot exists,
   `project_files` is unchanged, the rebuild/recheck runs, the unique attempt
   key prevents duplicates, and a failed repair preserves the original failure.
9. Confirm `agent/status` returns `preview.status = "unavailable"` with no URL,
   domain or provider handle.
10. Record the real durations and adjust the budgets only with measurements.

---

## 12. What this runbook cannot promise

Nothing in this repository has executed the provider path, and the agent that
wrote this did not run tests, typechecks, builds, migrations, provider calls or
browser checks.

- Phase 3 live operability was **not** confirmed. `@vercel/sandbox` is declared
  in `package.json` but absent from `node_modules` and `package-lock.json` until
  a human runs `npm install`.
- The provider's isolation, plan limits, OIDC behaviour, pricing and network
  enforcement remain operator assumptions.
- No generated app has been built, started or health-checked.
- The repair model has not been called; its ability to produce a valid,
  buildable change is unknown.
- Migration 19 has not been applied to any database. Its static invariants are
  tested; its runtime behaviour is not.
