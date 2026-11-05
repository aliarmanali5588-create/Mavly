# Runbook — full-stack production hosting (Phase 5)

Operator runbook for the opt-in path that deploys a verified generated Next.js
App Router snapshot to Vercel's native runtime. Read
`docs/architecture/phase-5-fullstack-hosting.md` first.

> This runbook is written for a human operator. Agent sessions in this repository
> must not run tests, builds, dev servers, browser probes or live provider calls.

## 1. Preconditions

- [ ] Phase 1–4 installed and working: migrations through `19`, static publish
      and verification available where expected.
- [ ] Migration `11` (project secrets) applied and
      `MAVLY_PROJECT_SECRETS_ENCRYPTION_KEY` (32 random bytes, base64) set.
- [ ] Vercel publishing configured: `MAVLY_VERCEL_DEPLOYMENTS_ENABLED=on`,
      `VERCEL_API_TOKEN`, Vercel project names are derived automatically from the authoritative Mavly project UUID (`mavly-<project-id>-<owner-hash>`) and are not operator-configurable.
- [ ] Wildcard DNS/TLS for `<project-id>.mavly.xyz` already points at Vercel
      (the same prerequisite as static publishing).
- [ ] You have a disposable Mavly account and a disposable generated project
      with at least one route handler (`app/api/.../route.ts`) and a passed
      Phase 3/4 verification.
- [ ] `npm install` has been run so `pg` is present (new in Phase 5).

## 2. Apply migration 20

```bash
supabase db push       # applies migrations/20_fullstack_hosting.sql in order
```

Verify:

```sql
select public.fullstack_hosting_schema_version();   -- 20
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'project_deployments'
   and column_name in ('deployment_kind','lifecycle','source_hash','deployment_attempt');
```

The migration is additive. Existing deployment rows become
`deployment_kind = 'static'` with `lifecycle = null`.

## 3. Enable the cohort

In the deployment environment (server-only):

```bash
MAVLY_FULLSTACK_HOSTING_ENABLED=on
MAVLY_FULLSTACK_HOSTING_PROJECTS=<disposable-project-id>
```

A missing prerequisite answers `503 BACKEND_NOT_CONFIGURED` with the exact
missing item. A wildcard cohort (`*`) is refused. Do not overlap a project with
`MAVLY_SHARED_HOSTING_PROJECTS`; the combination is refused because both claim
`<project-id>.mavly.xyz`.

> Vercel project names are deterministic (`mavly-<project-id>-<owner-hash>`) and not configurable. Mavly resolves provider projects by that owner-bound name and the stored Vercel project id; existing associations and deployed sites are preserved. Renaming a Vercel project outside Mavly can require operator recovery.

## 4. Smoke test (disposable tenant only)

1. **Verify the source.** Run the project's normal verification until
   `agent/status` reports a passed verification for the exact snapshot.
2. **Optional secrets.** Save one non-reserved secret (e.g. `API_KEY`,
   production). A first save before any Vercel project exists becomes
   `awaiting_project`; this is expected.
3. **Deploy.** Use the workspace Deploy control (`POST …/deployments/deploy`).
   Expected first-deploy behavior when a secret/database was saved before the
   provider project existed: the deploy creates the Vercel project, then fails
   with "Re-save the secrets / database connection, then deploy." Re-save those
   values and deploy again.
4. **Status.** Poll `GET …/deployments/status`. `success` requires Vercel
   `READY` **and** a verified Mavly domain. Until then it remains `deploying`
   with a step (`building` / `domain`).
5. **Server route.** Request the deployed app's `app/api/...` route at
   `https://<project-id>.mavly.xyz/...` and confirm the response comes from the
   deployment, not Mavly.
6. **Database (optional).** `PUT …/database/config` with a reachable Postgres
   URL. A bounded `select 1` runs before anything is stored. A private/loopback
   host, bad TLS, wrong credentials or a timeout returns a typed error and
   writes nothing. If a configuration row predates this check
   (`verified_at = null`), re-save it once before deploying a database-backed
   project.
7. **History.** `GET …/deployments/history` lists attempts; only `ready`
   attempts are rollback targets.
8. **Rollback.** `POST …/deployments/rollback` with a previous ready
   `attemptId`. It records `rolling_back`, calls Vercel Instant Rollback, and
   only settles `ready` once the target reports `READY` and the domain is
   verified.
9. **Takedown.** Unpublish (`POST …/deployments/unpublish`) detaches the Mavly
   domain, removes the project's production deployments (the ones the provider
   lists), and records `disabled`. It works even if the feature flag or the
   secrets key is turned off, as long as the Vercel token is configured.

## 5. Failure handling

| Symptom | Meaning | Action |
|---|---|---|
| `503 BACKEND_NOT_CONFIGURED` on deploy | Flag, cohort, Vercel config or secrets key missing | Fix the named prerequisite; no state was written |
| `409 … has no passed verification` | Snapshot hash has no Phase 3/4 pass | Verify the project, then deploy |
| `409 secrets/database not synced` | First deploy created the project; values were saved before it existed | Re-save the secret(s)/database connection, then deploy |
| `deployment_stalled` | No provider deployment id within 15 minutes | Redeploy; check Vercel API status |
| `deployment_project_missing` | The deterministic Vercel project no longer exists | Redeploy (creates it) or contact the operator |
| `domain` step never completes | DNS/certificate challenge pending | Confirm wildcard DNS/TLS; status re-checks at most once a minute |
| Status `error` after a redeploy | New attempt failed; previous deployment is still live | Read `errorDetails`; fix and redeploy |
| Takedown `409 could not find the hosting project` | Row may describe a live site but the deterministic project is missing | Do **not** assume down; inspect Vercel, then intervene |
| Database save `DATABASE_UNREACHABLE` | Live check failed | Fix host/credentials/TLS; nothing was persisted |

A failed attempt never overwrites the previous `vercel_deployment_id`; the last
known-good deployment keeps serving. The workspace reports the failed attempt
with `canUnpublish` when a live target may still exist.

## 6. Alerts and capacity

- Alert on a rising rate of `deployment_stalled`, `deployment_project_missing`,
  `domain_verification_failed`, or deploy `5xx`.
- Each full-stack deploy uploads a bounded snapshot (max 1,200 files, 12 MB
  total, 2 MB per file) and spends real Vercel build minutes. Keep the cohort
  explicit; there is no per-user build concurrency beyond the existing publish
  admission window.
- Database saves open one bounded connection (≤ ~7.5 s) per save. They are
  authenticated and project-scoped; no retry loop exists.

## 7. Pause / drain / rollback the feature

- **Pause new deploys:** unset `MAVLY_FULLSTACK_HOSTING_ENABLED` or remove the
  project from the cohort. Existing full-stack rows still report status and can
  still be rolled back or disabled. A deploy attempt for an existing full-stack
  row is refused, never downgraded to static.
- **Emergency takedown:** use the existing unpublish action. It needs the Vercel
  token, not the full-stack flag or the secrets key.
- **Revert the code:** redeploy the previous application build. Migration 20 is
  additive; keep it applied. Do not delete the attempt/env tables while any
  full-stack row exists.
- **Provider project retention:** takedown preserves the Vercel project, name
  and snapshot history so the project can be deployed again. It does not delete
  the project itself.

## 8. What remains human-verified

The repository's static tests do not exercise a real Vercel build, a secret
push, a real sandbox/microVM, an application database connection, or Supabase RLS
on the new tables. Before declaring Phase 5 production-ready, complete the
smoke test in §4 in a disposable environment and record the exact provider
responses. Do not enable the cohort for real customers before that passes.
