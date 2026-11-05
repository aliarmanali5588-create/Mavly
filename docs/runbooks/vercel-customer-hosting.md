# Runbook: Vercel customer frontend hosting

## Status

Vercel is the only customer-generated frontend hosting platform. AWS customer frontend
hosting (S3 + CloudFront KeyValueStore) was **removed**: its publisher, routing, worker,
eligibility code, SDK dependencies and environment variables no longer exist. An
AWS-published row is archived history. Publishing or unpublishing it answers
`503 HOSTING_PROVIDER_RETIRED`, and its recorded status is returned unchanged. No site is
switched silently, and no AWS site is claimed to be migrated or taken down.

The AWS **EC2 generation worker** is not part of this migration. Keep
`workers/aws-generation-worker.ts`, `infra/aws-generation-worker/` and `MAVLY_AWS_WORKER`
untouched.

## 1. Commercial prerequisite (blocking)

Mavly submits customer-generated sites to a Vercel account Mavly operates. That is hosting
on behalf of third parties, not ordinary single-team use. Before enabling production
publishing, the operator must confirm:

- Vercel's current terms permit this model for Mavly's account/plan;
- the account is enrolled in (or explicitly allowed under) **Vercel for Platforms**;
- the plan's project, domain and deployment limits cover the intended cohort;
- API rate limits are acceptable for the publication rate.

A Hobby or Pro plan is **not** assumed to be eligible. This repository does not grant that
permission, and no code change can. Until the confirmation exists, keep
`MAVLY_VERCEL_DEPLOYMENTS_ENABLED=false`.

## 2. Configuration

Server-only values. Never use a `NEXT_PUBLIC_` prefix and never commit real values.

| Variable | Meaning |
| --- | --- |
| `MAVLY_VERCEL_DEPLOYMENTS_ENABLED` | `1`/`true`/`yes`/`on` enables the Vercel path. |
| `VERCEL_API_TOKEN` | Access token for the account/team that owns customer projects. |
| `VERCEL_TEAM_ID` | Team that owns created projects; empty ⇒ the token's account. |

`VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` are also read by the **verification
sandbox**. `VERCEL_API_TOKEN` is the publishing credential and is a separate value.

These variables are read on the Mavly app server (publish/status/unpublish) and by the
generation worker's domain queue. They are never sent to a browser.

## 3. Database

Apply `supabase/migrations/63_vercel_customer_frontend_hosting.sql` after migration 62.
It is additive:

- adds `project_deployments.hosting_migration_state` (`vercel`, `aws_retained`,
  `migrated`; NULL for shared/legacy rows);
- marks existing `provider = 'aws'` rows `aws_retained` and `provider = 'vercel'` rows
  `vercel` — no provider is changed;
- adds a partial unique index on `vercel_deployment_id` and a `(provider, status)` index;
- adds `public.vercel_customer_hosting_schema_version()` returning `63`.

It never deletes a deployment, version, file, domain, project or customer row. A duplicate
`vercel_deployment_id` makes the migration stop with
`VERCEL_HOSTING_DUPLICATE_DEPLOYMENT_ID` before any index is created; resolve the duplicate
rows first.

Rollback: drop the two indexes, the check constraint, the column and the marker function.
No data is destroyed, and existing AWS rows remain valid.

Then apply `supabase/migrations/65_retire_aws_frontend_hosting.sql` after 64. It adds
`aws_frontend_hosting_retirement_schema_version()` and settles AWS publication attempts
that can never finish (`queued`/`building`/`unpublishing`) as `error` with code
`aws_hosting_retired`. It deletes no row, changes no `provider`, and leaves a previously
`ready` AWS publication exactly as recorded. Migrations 51/56/61 stay applied with their
functions intact but uncalled.

## 4. DNS

`mavly.xyz` (root) and `*.mavly.xyz` (wildcard) are Mavly-owned platform DNS. The wildcard
routes every project hostname to Vercel's edge; it is **not** attached to each Vercel
project.

Vercel attaches a hostname per project. For each generated site:

1. Mavly attaches `<project-id>.mavly.xyz` to that site's own Vercel project.
2. Vercel verifies the domain.
3. Vercel issues the certificate.

If `mavly.xyz` uses external DNS, the wildcard needs a `CNAME` for `*` pointing at the
target Vercel shows in **Domains → `mavly.xyz`**, plus the `_acme-challenge` delegation
Vercel requires for wildcard certificate issuance. If the domain uses Vercel nameservers,
Vercel manages those records.

**Do not rewrite the root records or move the platform's nameservers as part of a customer
publish.** DNS changes are operator actions; this repository never edits DNS.

## 5. Verification (manual)

Run after the operator has enabled the flags in a non-production deployment:

```bash
npx tsc --noEmit
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm test
npm run lint
npm run build && npm start
```

Then, for one disposable project:

1. Publish a generated static site. Confirm the response is not `503`.
2. `GET …/deployments/status` until the deployment is terminal. Confirm `url` is present.
3. Confirm `<project-id>.mavly.xyz` resolves and serves that site.
4. Confirm `mavly_domain_status = verified` only after an HTTPS request succeeds.
5. Confirm `project_deployments` has `provider = 'vercel'`, the Vercel project/deployment
   ids, and `hosting_migration_state = 'vercel'`.
6. Republish changed source; confirm the same hostname serves the new bytes.
7. Attempt a publish as a different user; confirm `403`.
8. Unpublish; confirm the Mavly hostname and production deployments stop serving.
9. Confirm the AWS EC2 generation worker still processes generation jobs. For an archived
   `provider = 'aws'` row, confirm `GET …/deployments/status` returns its recorded state
   and that publish/unpublish answer `503 HOSTING_PROVIDER_RETIRED` without changing it.

## 6. Failure handling

| Symptom | Meaning |
| --- | --- |
| `503 BACKEND_NOT_CONFIGURED` | Flag or `VERCEL_API_TOKEN` missing. |
| `503 HOSTING_PROVIDER_RETIRED` | The row is an archived AWS publication. Its history is kept and it must be migrated to Vercel explicitly. For unpublish this also means the site was **not** reported as down. |
| `HOSTING_MIGRATION_REQUIRED` | The row's provider cannot be changed implicitly. Migrate it explicitly. |
| Domain `pending` after publish | Deployment is ready but the hostname is not verified yet. Certificate issuance is asynchronous. |
| Domain `error` | Verification failed or the hostname belongs to another project. Check the recorded `mavly_domain_error`. |
| Publish `409` | Another publish/unpublish holds the single deployment slot. |

A failed publish never marks a site live. `ready` requires the provider to report `READY`
**and** the hostname to be verified; the two are tracked independently.

## 7. Migrating an archived AWS site (explicit, one project at a time)

There is no bulk migration, no automated provider switch and no retained AWS publish path.
This deployment cannot republish, verify or take down an AWS site. With owner consent, an
operator must:

1. Keep the AWS site and its route live while the replacement is prepared. Do not delete
   the AWS publication history or the deployment row.
2. Publish the same source on Vercel **outside this row's publish path** (for example a
   new project row or a reviewed service-role procedure), and verify the Vercel hostname is
   attached, verified and serving over HTTPS.
3. Only then change the deployment row to `provider = 'vercel'` and
   `hosting_migration_state = 'migrated'`. Migration 51's trigger refuses an authenticated
   provider change (`AWS_DEPLOYMENT_PROVIDER_IMMUTABLE`), so this is a reviewed service-role
   action, never a browser operation.
4. Keep the old AWS route until the Vercel hostname is proven, then remove the AWS route as
   a separate approved infrastructure change.
5. Never describe a site as migrated, retired or taken down until the Vercel replacement is
   verified and the AWS route is actually gone.

## 8. Custom-domain registry (implemented, unverified)

The canonical `<project-id>.mavly.xyz` address is attached and verified by the publish
path itself and does not depend on the domain registry. The Phase 62 registry (aliases and
customer custom domains) claims a job only for a project with an ACTIVE
`project_published_versions` row. The Vercel static publish path now records the exact
bytes it shipped as an immutable version and activates it through migration 64's
`activate_vercel_publication`, so a registry job is no longer refused with
`DOMAIN_PROJECT_NOT_PUBLISHED` for a published Vercel project.

That version write is best-effort **after** the site is live: a storage or migration
failure logs a warning and never turns a successful publish into a failure. Its only
consequence is that domain jobs keep refusing until a later publish records a version.

Not verified live: no Vercel deployment, domain attach, DNS propagation, certificate or
custom-domain activation has been exercised. See
[`../architecture/phase-17-domain-publishing.md`](../architecture/phase-17-domain-publishing.md).
