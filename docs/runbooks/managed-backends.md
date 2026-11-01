# Runbook — managed Neon backends + generated-app data API

Applies to migrations **30** (registry/provisioning), **35** (schema, gateway, rate limits) and
**37** (enrollment registry + cohort authorization), the durable generation worker
(migrations 16/32), and the `/api/app/v1/apps/*` routes.

> This runbook describes operator steps. It does not assert that any of them has been run.
> The repository's `AGENTS.md` forbids agents from running tests, typecheck, build, servers or
> browser checks.

## 1. Capability matrix

| Condition | Result |
|---|---|
| Flag off / project not enrolled | No database. The run reports a labelled prototype with the enrollment reason. |
| Enrolled but `pending` (outside rollout / at capacity) | No database. The run reports the exact reason; the next evaluation may approve it. |
| Enrollment `revoked` / `suspended` | No database. Outranks every policy path; existing data is never deleted. |
| Required but operator prerequisites missing | No database created; the stage reports `blocked` (`platform_configuration_incomplete`) and the run continues as a labelled prototype. |
| Inline (non-worker) run | No provisioning; run reports why. |
| Worker run, valid data model | Provision → migrate → verify → gateway → `ready`. |
| Provisioned, schema failed | Stage reports `blocked` (`configuration_<code>`); database and rows kept, app is a labelled prototype, a retry can finish the backend. |
| `ready` but gateway flags later removed | Gateway returns 404; the registry row and data remain. |

## 2. Required configuration

Server-only unless noted.

```bash
MAVLY_MANAGED_BACKENDS_ENABLED=true
MAVLY_NEON_AGENT_PLAN_APPROVED=true          # only after Neon confirms enrollment
NEON_API_KEY=
NEON_ORG_ID=org-...
NEON_REGION_ID=aws-us-east-1
MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY=<32 random bytes, base64>   # keep stable
MAVLY_APP_GATEWAY_ORIGIN=https://app.example.com                 # absolute https origin
MAVLY_MANAGED_BACKENDS_RPC_SECRET=<>=32 chars, no whitespace>     # keep stable

# ── Enrollment (migration 37). Leave MODE unset for the legacy static list. ──
MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE=disabled   # disabled|internal|allowlisted|percentage|general_availability
MAVLY_MANAGED_BACKENDS_INTERNAL_PROJECTS=         # for `internal`
MAVLY_MANAGED_BACKENDS_ROLLOUT_PERCENT=           # 0-99, required for `percentage`
MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT=              # >=16 chars, server-only, treat as permanent
MAVLY_MANAGED_BACKENDS_MAX_ACTIVE_PROVISIONS=5    # 1-50

# LEGACY ONLY: an authorization source while MODE is unset. Once MODE is set this
# list becomes the `allowlisted` cohort and authorizes nothing on its own.
MAVLY_MANAGED_BACKENDS_PROJECTS=
```

Plus a deployed Render Background Worker and the existing server-side worker prerequisites
(`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `OPENROUTER_API_KEY`). Production
generation dispatch itself has no project allowlist.

**Authorization precedence.** If `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE` is unset, the
deployment is on the legacy static list and `MAVLY_MANAGED_BACKENDS_PROJECTS` is the only
authorization. If it is set to any value — including `disabled` — the enrollment registry in
Supabase is authoritative and the static list no longer authorizes anything. An empty list is
never unrestricted access, and `*` is refused in both modes.

Notes:

- `MAVLY_APP_GATEWAY_ORIGIN` must be the origin the generated browser code calls. For cookie
  transport it must be same-site with `*.mavly.xyz` (for example `https://app.mavly.xyz`).
  Cross-site deployments work with `Authorization: Bearer`.
- The RPC secret is never stored in plaintext. Changing it breaks existing `ready` backends
  until they are re-configured (retry a generation for that project).

## 3. Migrations

Apply in order, and only then enable the flags:

## 3a. Enrollment registry (migration 37)

Migration 37 adds the trusted, database-backed registry that decides **whether a project may
receive a managed backend at all**. It replaces the need to paste every eligible project UUID
into `MAVLY_MANAGED_BACKENDS_PROJECTS`.

### The two state machines are separate

| Enrollment (migration 37) | Backend lifecycle (migrations 30/35) |
|---|---|
| `not_enrolled` (no row) | `not_required` |
| `pending` | `pending_approval` |
| `approved` | `provisioning` → `provisioned` → `configuring` → `ready` |
| `rejected` | `failed` |
| `revoked` | `outcome_unknown` |
| `suspended` | `cleanup_pending` |

Enrollment answers *"is this project allowed to have a database?"*. Lifecycle answers *"what is
the state of the database it has?"*. They are never merged: a project can be `approved` with no
database yet, or have a `ready` database and later be `suspended`. **An approved enrollment is
never reported as a ready backend.**

### Cohort rollout

Roll out in this order and stop at the first stage that misbehaves:

| Stage | `ENROLLMENT_MODE` | Notes |
|---|---|---|
| 0 | `disabled` | No automatic enrollment. The safe default when the variable is set. |
| 1 | `internal` | Only `MAVLY_MANAGED_BACKENDS_INTERNAL_PROJECTS`. |
| 2 | `allowlisted` | Only `MAVLY_MANAGED_BACKENDS_PROJECTS`. |
| 3 | `percentage` | Deterministic slice; needs `ROLLOUT_PERCENT` and `ROLLOUT_SALT`. |
| 4 | `general_availability` | Every policy-passing project, capacity-bounded. |

`general_availability` is never a default and must be chosen explicitly.

**Admission is `bucket < percent`.** The bucket is
`sha256(salt ‖ project_id ‖ project_created_at) mod 100`, so:

- repeated evaluation returns the same bucket (no flapping);
- raising 10 → 25 admits exactly buckets 10–24 and reassigns nobody;
- lowering the percentage stops **new** admissions and **grandfathers** every already-approved
  project, so a working database is never yanked by a rollout change;
- a recreated project (same slug, new `created_at`) is a different rollout subject.

Changing `MAVLY_MANAGED_BACKENDS_ROLLOUT_SALT` reshuffles every bucket. Treat it as permanent.

### Administrative controls

Authority is `public.current_user_is_admin()` (migration 18), evaluated for the caller's own
session. There is no client-supplied admin flag and no public enrollment endpoint.

```bash
# Read status + audit history (admin session cookie required)
GET  /api/adminsh/enrollment?projectId=<slug>

# Act
POST /api/adminsh/enrollment
{ "projectId": "<slug>", "action": "approve|reject|suspend|revoke|resume", "reason": "..." }
```

| Action | Effect | Deletes data? |
|---|---|---|
| `approve` | Creates or approves the enrollment. | No |
| `reject` | Sticky refusal; the policy cannot re-approve it. | No |
| `suspend` | Stops future provisioning and reconfiguration. | No |
| `revoke` | Stops future provisioning and reconfiguration. | **No** |
| `resume` | Returns a **suspended** enrollment to `pending` for re-evaluation. | No |

`resume` deliberately refuses a **revoked** enrollment: revocation is deliberate and needs an
explicit `approve`. Every action is written to the append-only audit table.

### Emergency suspension

To stop all managed database activity immediately, in this order:

1. Set `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE=disabled` and redeploy. This stops new
   enrollment; existing `ready` backends keep serving their data gateway.
2. For a single project, `POST` `action: "suspend"`. The worker's execution-time gate refuses
   provisioning and schema configuration on the next attempt.
3. To stop the data API for a project as well, remove `MAVLY_APP_GATEWAY_ORIGIN` or the RPC
   secret; the gateway then returns 404 while the registry row and data remain.

**Nothing in this procedure deletes a Neon project or a customer row.**

### Revocation semantics

Revocation stops **future** provisioning and reconfiguration. It does not delete the Neon
project, the schema, the rows, or the `project_managed_backends` registry row. A revoked project
keeps whatever database it already had; it simply cannot create or reconfigure one.

### Recovery procedures

| Symptom | Meaning | Action |
|---|---|---|
| `enrollment_missing` | No row and the registry is authoritative. | Check the mode; `approve` the project or let the policy enroll it. |
| `outside_rollout_percentage` | Bucket ≥ percent. | Raise the percentage, or `approve` explicitly. |
| `capacity_reached` | At `MAX_ACTIVE_PROVISIONS`. | Wait for in-flight provisions to settle, or raise the ceiling (1–50). |
| `policy_version_mismatch` | Row decided under an older policy. | Re-run a generation; the policy re-evaluates and re-stamps. |
| `incarnation_mismatch` | The row belongs to a deleted-and-recreated project. | Expected. The new incarnation enrolls independently. |
| `platform_not_ready` | The registry is missing or prerequisites are incomplete. | Apply migration 37 / complete the config. |

### Migration sequence

Apply **after 35**. Additive and non-destructive; it can be applied while the previous
application version is live. It creates two tables, their RPCs, and redefines
`mark_managed_backend_create_started` and `begin_managed_backend_configuration` with unchanged
signatures plus an enrollment guard.

To migrate off the static allowlist without downtime:

1. Apply migration 37.
2. Keep `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE` **unset**. Behavior is unchanged; the static
   list still authorizes.
3. Set `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE=allowlisted` with the same projects still in
   `MAVLY_MANAGED_BACKENDS_PROJECTS`. Verify a generation still provisions.
4. Move to `percentage` (or `internal`) and then widen. Remove the static list whenever you like;
   once the mode is set it authorizes nothing.

### Migration 38 — strict authorization rollout

Migration 38 is additive and non-destructive. Applying it does **not** change behavior: the
control row defaults to `strict_authorization = false`, which preserves migration 37's
conditional guard exactly. Strict mode is a **database fact**, not an environment variable,
because the enforcement lives in SQL where an env var cannot be read.

Run the sequence below in order. Do not skip step 4; it is the gate that makes step 6 safe.

| # | Step | Command / check | Pass condition |
|---|---|---|---|
| 1 | Pre-migration audit | `GET /api/adminsh/enrollment?op=coverage` | `totalBackends` matches the registry count you expect; note `uncoveredBackends` |
| 2 | Apply migration | `supabase db push` (or the SQL editor) with `38_...sql` | No error; `select 38 $$;` marker present |
| 3 | Backfill **dry run** | `POST /api/adminsh/enrollment` `{"op":"backfill"}` | `dryRun: true`; review `rejected` and `rejectedReasons` |
| 4 | Backfill **apply** | `POST` `{"op":"backfill","dryRun":false}` | `inserted + promoted` equals the dry run's `eligible` |
| 5 | Coverage verification | `GET ?op=coverage` | `uncoveredBackends = 0` and `readyForStrict = true` |
| 6 | Enable strict | `POST` `{"op":"strict-on"}` | `strictAuthorization: true`; refuses if step 5 failed |
| 7 | Internal cohort test | One internal project, full generation | Backend reaches `ready`; gateway serves |
| 8 | Controlled rollout | Widen `MAVLY_MANAGED_BACKENDS_ENROLLMENT_MODE` | Each step's failure rate unchanged |
| 9 | Emergency rollback | `POST` `{"op":"strict-off"}` | Strict off; legacy allowlist still authorizes |

**Step 3 is not optional.** `backfillEnrollments` defaults to a dry run at both the wrapper and
the SQL layer, so a mistyped command reports counts instead of writing rows. Read the
`rejectedReasons` histogram before applying: `backfill_project_missing` means a registry row
outlived its project, and `backfill_incarnation_mismatch` means a slug was reused and the row
belongs to a previous incarnation. Both are correctly refused rather than inherited, but both
deserve an operator's eyes.

**Step 5 is the gate.** `set_managed_backend_strict_authorization` refuses to enable while any
live backend lacks an enrollment row, so a caller cannot strand a database by flipping the
switch early. If it refuses, the message names the uncovered count.

**Step 9 is always available.** Turning strict off restores migration 37's conditional behavior
immediately and authorizes nothing new. It never deletes an enrollment row, a backend row, a
Neon project or a customer table, so it is safe to use as a first response to an incident.

⚠️ **Do not enable general availability as part of this rollout.** Steps 7 and 8 are a cohort
test and a controlled widening, not a GA switch.

### Rollback

Dropping migration 37's objects returns the deployment to the static allowlist. It never deletes
a Neon project, a customer row, or a `project_managed_backends` record. Set the enrollment mode
back to unset **before** dropping the objects, or provisioning will fail closed.

### Known limitations

- Enrollment decisions are recorded in Supabase; there is no external metrics vendor. The
  `managed_backend.enrollment.*` log lines are the metric source.
- There is no UI for the admin actions; they are HTTP endpoints behind the existing admin gate.
- The capacity counter is a live count of `provisioning`/`configuring` rows, not a queue.
- No live end-to-end verification of enrollment → provisioning → gateway has been performed.


1. `30_managed_backends.sql` (registry + provisioning RPCs)
2. `35_managed_backend_runtime.sql` (lifecycle, ledger mirror, gateway RPCs, rate windows)

`35` is additive: it extends the status check constraint, adds columns and tables, and
redefines `claim_managed_backend` with the same signature so the previous application version
keeps working. Verify:

```sql
select public.managed_backend_schema_version();  -- 35
```

## 4. Neon account requirements (external)

- Neon Agent Plan enrollment: an **active Scale plan** and **explicit Neon team approval**.
  Provisioning must stay off until this is confirmed in writing.
- An organization id and a region id that the API key can create projects in.
- The platform creates one Neon project per Mavly project with bounded quotas
  (`active_time_seconds 360000`, `logical_size_bytes 1 GiB`, `data_transfer_bytes 5 GiB`,
  0.25–2 CU autoscaling). Do not raise these without a capacity review.

## 5. First-run acceptance (manual, operator-run)

1. Put one test project id in both cohorts and enable the flags.
2. From the workspace, submit a prompt that clearly needs persistence, e.g.
   *"a task list where tasks are saved and survive a reload"*.
3. Confirm in the run:
   - the structured event `managed_backend.stage` carries `status`
     `not_required` | `blocked` | `ready`;
   - the completion message says the tables were created and verified;
   - `agent/status` contains `managedBackend.state = "ready"`, the table list and
     `capabilities.persistentCrud = true`.
4. Confirm the registry:

```sql
select project_id, status, migration_step_count, schema_verified_at,
       runtime_verified_at, gateway_configured_at, last_step, error_code
  from public.project_managed_backends
 where project_id = '<project-id>';
```

5. Confirm the customer database (using the operator's own Neon access, **not** by printing the
   connection URI):

```sql
select name, checksum, applied_at from mavly_schema_migrations order by applied_at;
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;
```

6. Exercise the gateway with the end user's own session (never with a database credential):

```bash
BASE=https://app.example.com/api/app/v1/apps/<project-id>

curl -sS -X POST "$BASE/auth/signup" \
  -H 'content-type: application/json' \
  -H 'origin: https://<project-id>.mavly.xyz' \
  -d '{"email":"test@example.com","password":"correct horse battery staple"}'

# use the returned data.token
curl -sS "$BASE/data/<resource>?limit=20" -H "authorization: Bearer <token>"
curl -sS -X POST "$BASE/data/<resource>" -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"<field>":"value"}'
```

Expected: `201` on create, the row in the list, the same row after a reload (a new request),
and `401 authentication_required` without a token. `404` for another project's record.

## 6. Failure handling

| Code | Meaning | Action |
|---|---|---|
| `MANAGED_BACKEND_CONFIGURATION_REQUIRED` | flags/cohort partially configured | finish §2; no database was created |
| `NEON_PROVISIONING_OUTCOME_UNKNOWN` | create may have succeeded | do not retry blindly; the next attempt reconciles by the derived name |
| `NEON_PROJECT_AMBIGUOUS` | >1 project matches the derived name | reconcile in the Neon console; Mavly stops |
| `SCHEMA_APPLY_FAILED` | a step failed (SQLSTATE recorded) | inspect the recorded `last_step`; the run is atomic, so a retry re-applies from a clean state |
| `SCHEMA_VERIFICATION_FAILED` | read-back mismatch | treat as drift; do not edit the model to hide it |
| `NEON_CONNECTION_UNAVAILABLE` | post-migration probe failed | check Neon status/quotas; retry is safe |
| `MANAGED_BACKEND_BUSY` | another lease is active | retry shortly |

`failed` never deletes the database or rows. `cleanup_pending` only records intent.

A backend failure does **not** discard the user's generation. The stage records the sanitized
reason in the `managed_backend.stage` event and in the run's completion message, forces the
app to an explicitly labelled prototype (`managedBackend.state = "failed"`,
`capabilities.persistentCrud = false`), and lets the code batches finish. Nothing claims
persistent data works, and the next eligible run retries provisioning/configuration without
starting over. An unexpected exception inside the stage still fails the run, because that is a
Mavly bug rather than a backend decision.

## 7. Pause / drain / rollback

- **Pause provisioning:** unset `MAVLY_MANAGED_BACKENDS_ENABLED` (or remove the project from the
  cohort). Existing `ready` rows are untouched; new runs report a labelled prototype.
- **Pause the gateway:** unset `MAVLY_APP_GATEWAY_ORIGIN`. The public route answers `404`; the
  database and its data are untouched. This *does* break any app already calling it.
- **Roll back application code:** migration 35 is additive and the previous version ignores the
  new columns; `claim_managed_backend` keeps its signature. The new public routes can be
  removed without touching data.
- **Do not** delete a Neon project to "roll back" a generation. There is no automatic deletion,
  and existing customer rows would be lost.

## 8. Limits and capacity

- Per-project gateway limits (fixed in SQL): 240 reads, 60 writes, 20 auth attempts per minute.
- One `pg` client per gateway request, 5 s connect/statement timeout. This is suitable for
  low-volume apps; it is not a connection-pooling tier. Capacity claims beyond the existing
  worker limits (2 runs/user, 8 global) are unsupported.
- Schema runs: 15 s per statement, bounded slice of the run's remaining time, ≤ 64 steps.

## 9. Ownership, retention and data lifecycle

- A registry row is bound to one project incarnation (`project_id`, `project_created_at`), so a
  reused project slug cannot inherit a previous database.
- Deleting a Mavly project does **not** delete its Neon project. Rows are retained so a future
  ownership-verified cleanup can find the resource.
- There is no automatic backup/restore here; use Neon's own retention/PITR.
- Deleting customer data requires a reviewed, owner-approved procedure; nothing in this
  repository performs it.

## 10. Known gaps

- No approved hosting runtime for generated Next.js server code in this repository, so the
  gateway cannot be exercised from a published generated app today
  (see `docs/architecture/phase-14-managed-backend-runtime.md` §9).
- No password reset (no email transport).
- No live verification of Neon, the gateway, migrations or the generated app has been
  performed by an agent.
