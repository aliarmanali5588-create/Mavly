# Runbook — verification sandbox

The isolated verification sandbox is **off by default**. This runbook is for the
operator who chooses to enable it for a small project cohort.

It assumes the architecture in
`docs/architecture/phase-3-verification-sandbox.md`.

---

## 1. Prerequisites

- Phase 2 durable generation worker is enabled and healthy.
- Migration 17 applied **after** migration 16.
- A Vercel account/team eligible for Sandbox workloads, with either:
  - `VERCEL_OIDC_TOKEN` available to the worker runtime, or
  - `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
- The plan's maximum sandbox lifetime is at least 20 minutes (the design uses an
  18-minute session inside a 20-minute deadline).
- An explicit list of project ids. There is no `*` and no default cohort.

Apply the migration with your normal process. Do **not** apply it as part of a
production deploy from an agent session.

```bash
# example only — use your migration workflow
# psql "$DATABASE_URL" -f supabase/migrations/17_verification_sandbox.sql
```

`verification_schema_version()` must return `17`. The worker refuses to claim
verification work otherwise.

---

## 2. Enable

```bash
MAVLY_VERIFICATION_SANDBOX_ENABLED=1
MAVLY_VERIFICATION_SANDBOX_PROVIDER=vercel        # e2b is not implemented
MAVLY_VERIFICATION_SANDBOX_PROJECTS=alpha-app,beta-app

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

**Order matters:** enable the Phase 2 worker first, confirm one generation
completes, then enable verification for the same cohort. Verification only
enqueues after a *worker* run completes.

---

## 3. Verify the first build

Run the worker endpoint once (the scheduler's usual call):

```bash
curl -sS -X POST "$MAVLY_APP_URL/api/generation/worker" \
  -H "Authorization: Bearer $MAVLY_GENERATION_WORKER_SECRET"
```

Expected progression across several calls (verification runs only when no
generation job is ready):

1. `{"ok":true,"status":"empty","verification":{"status":"advanced","reason":"installing"}}`
2. `... "reason":"building"`
3. `... "status":"completed","outcome":"passed"` (or a truthful failure)

Then read the status endpoint as the project owner:

```bash
curl -sS "$MAVLY_APP_URL/api/vcaas/projects/alpha-app/agent/status" \
  -H "Cookie: <session>"
```

`verification.status` must move `pending → running → passed|failed|…`. A missing
`verification` object means none was enqueued (feature off, outside cohort, or
the run had no usable snapshot).

---

## 4. Log events and alerts

Every lifecycle line is JSON with a `[verification]` prefix. Suggested alerts:

| Event | Meaning | Action |
|---|---|---|
| `verification.enqueue_failed` | Store error after a completed run | Check Supabase availability; the run is still complete |
| `verification.unavailable` | Misconfiguration or migration missing | Fix the reported `reason`; nothing was claimed |
| `verification.claim_failed` | Claim RPC error | Check database health and migration 17 |
| `verification.error` | Reconnect/marker/complete/release failure | Inspect `reason`; rows recover on the next tick |
| `verification.lease_lost` | Another tick or a cancellation won | Expected occasionally; repeated lines indicate slow ticks |
| `verification.cleanup` with `status=failed` | Sandbox not confirmed deleted | Check provider access; the row stays in the cleanup queue |
| `verification.recovered` | Deadline or expired lease handled | `timed_out`/`released`/`requeued` are expected under crashes |

There is no metrics vendor. These lines are the source for thresholds.

---

## 5. Inspect state

Read-only SQL (service role, never in an application route):

```sql
select id, project_id, run_id, status, attempt, max_attempts,
       provider, exit_code, error_class, cleanup_complete,
       enqueued_at, started_at, stage_started_at, deadline_at, finished_at
from public.project_verifications
order by enqueued_at desc
limit 50;

-- in-flight rows
select count(*) from public.project_verifications where finished_at is null;

-- durable orphans needing cleanup
select id, project_id, sandbox_id, cleanup_attempts
from public.project_verifications
where finished_at is not null
  and cleanup_complete = false
  and sandbox_id is not null;
```

Never print `sandbox_id` into a ticket or chat; it is an opaque provider handle.

---

## 6. Pause and drain

**Pause new verifications:** unset `MAVLY_VERIFICATION_SANDBOX_ENABLED` (or set
it to `0`) and redeploy. Queued rows remain; nothing advances. Generation and the
Phase 2 worker continue.

⚠️ **Disabling also stops recovery and orphan cleanup**, because the tick
returns `unavailable` before those phases. An in-flight sandbox is then bounded
only by the provider's lifetime, and terminal rows keep `cleanup_complete =
false` until the feature is enabled again. Rows that were enqueued but never
claimed have no deadline at all and stay `queued` (inert, no resources) until
the project is brought back into the cohort.

**Drain:** leave the flag on until `finished_at is null` reaches zero **and** the
orphan query in §5 returns no rows, then turn it off. Verifications advance only
on empty generation ticks, so allow scheduler time.

**Cancel one:** the owner can call `agent/stop`; a terminal run with an
in-flight verification returns `{ "verificationCancelled": true }`.

---

## 7. Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `unsupported_runtime` | Not a Next.js App Router project, missing `app/layout.tsx`/`app/page.tsx`, no exact `next build`, workspaces, or unsupported `engines.node` | Change the project or leave it unverified; never loosen the profile to "make it pass" |
| `snapshot_mismatch` | Snapshot content no longer hashes to the enqueued value | Treat as tampering; do not retry by editing the row |
| `dependency_resolution_failed` | Registry cannot resolve a declared dependency | Fix the generated `package.json`; egress is intentionally limited to npm and Google Fonts |
| `install_failed` / `build_failed` | The project genuinely does not install/build | Read sanitized diagnostics; this is a real result |
| `timed_out` | Install > 5 min, build > 8 min, or the 20-min deadline | Inspect diagnostics; raise limits only with a matching provider lifetime |
| `sandbox_not_found` | Provider killed the sandbox (lifetime) or it was deleted | Check the provider console; outcome is unknown by design |
| `configuration_error` | Missing/mismatched credentials, unsupported provider, snapshot gone | Fix configuration; nothing was executed |
| `infrastructure_error` | Provider rejection, missing marker, interrupted `preparing` state | Inspect events; a later row can be re-verified by the next generation run |
| `cleanup_complete = false` | Delete not confirmed | Five bounded retries; the provider lifetime also destroys the VM |

---

## 8. Rollback

1. Disable `MAVLY_VERIFICATION_SANDBOX_ENABLED` and redeploy.
2. Leave migration 17 installed. It is additive and unused when disabled.
3. If a rollback of application code is required, revert the Phase 3 commits.
   Do not drop `project_verifications`: it preserves history and cleanup state.
4. Generation jobs, files, checkpoints, snapshots and hosting rows are never
   modified by verification. No data migration is needed.

---

## 9. Cost and capacity

- One vCPU per sandbox, one sandbox per row, caps 1/2/8 (project/user/global).
- A sandbox is deleted on every terminal path; the 18-minute provider lifetime
  is the backstop.
- No authoritative per-build cost is available, so none is reported. Use the
  provider's own usage reporting.
- Raise the admission caps only after measuring real build durations and
  provider concurrency. `MAX_ACTIVE_GLOBAL = 8` is deliberate.

---

## 10. What this runbook cannot promise

Nothing in this repository has executed the provider path. Before relying on it:

1. Run the first build against a disposable project and a disposable Vercel
   team.
2. Confirm the sandbox is genuinely isolated (no access to Mavly env or
   Supabase service-role credentials).
3. Confirm the egress allowlist blocks an unlisted host from inside the build.
4. Confirm the sandbox is deleted after pass, fail and timeout.
5. Confirm cancellation during a build leaves no live sandbox.
6. Record the real durations and adjust the budgets only with measurements.
