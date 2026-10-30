# Runbook — managed Neon backends + generated-app data API

Applies to migrations **30** (registry/provisioning) and **35** (schema, gateway, rate limits),
the durable generation worker (migrations 16/32), and the `/api/app/v1/apps/*` routes.

> This runbook describes operator steps. It does not assert that any of them has been run.
> The repository's `AGENTS.md` forbids agents from running tests, typecheck, build, servers or
> browser checks.

## 1. Capability matrix

| Condition | Result |
|---|---|
| Flag off / project not in cohort | No database. The run reports a labelled prototype. |
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
MAVLY_MANAGED_BACKENDS_PROJECTS=<project-id,...>   # explicit, never "*"
NEON_API_KEY=
NEON_ORG_ID=org-...
NEON_REGION_ID=aws-us-east-1
MAVLY_MANAGED_BACKENDS_ENCRYPTION_KEY=<32 random bytes, base64>   # keep stable
MAVLY_APP_GATEWAY_ORIGIN=https://app.example.com                 # absolute https origin
MAVLY_MANAGED_BACKENDS_RPC_SECRET=<>=32 chars, no whitespace>     # keep stable
```

Plus a fully configured durable worker (`MAVLY_GENERATION_WORKER_ENABLED`, its secret, its
cohort, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`). The same project ids must be
in both the worker cohort and `MAVLY_MANAGED_BACKENDS_PROJECTS`.

Notes:

- `MAVLY_APP_GATEWAY_ORIGIN` must be the origin the generated browser code calls. For cookie
  transport it must be same-site with `*.mavly.xyz` (for example `https://app.mavly.xyz`).
  Cross-site deployments work with `Authorization: Bearer`.
- The RPC secret is never stored in plaintext. Changing it breaks existing `ready` backends
  until they are re-configured (retry a generation for that project).

## 3. Migrations

Apply in order, and only then enable the flags:

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
